import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { MAX_CONCURRENT, PORT } from './config.ts';
import { db, getProjectBySlug, listEvents, listProjects, listTasks, type ProjectRow } from './db.ts';
import { localOnly } from './guard.ts';
import { pickFolder } from './pickFolder.ts';
import {
  accountsDto, addAccount, answerPermission, approveSplit, clearAccountLimit, createTask, removeAccount, diff, discard, markDone, recoverOnStartup,
  merge, mergeable, openInTerminal, reply, retry, runningCount, stop, subscribe, toDto,
} from './tasks.ts';
import { currentBranch, getRemote, slugify } from './worktree.ts';

const app = new Hono();

app.onError((err, c) => c.json({ error: err.message }, 400));
app.use('/api/*', localOnly);

const projectDto = async (p: ProjectRow) => ({
  currentBranch: await currentBranch(p.path),
  slug: p.slug, name: p.name, path: p.path, remote: p.remote,
  defaultModel: p.default_model, permissionMode: p.permission_mode, alwaysAllow: JSON.parse(p.always_allow),
});

// ---------- projects ----------

app.get('/api/projects', async (c) => c.json(await Promise.all(listProjects().map(projectDto))));

app.post('/api/projects', async (c) => {
  const { name, path, defaultModel, permissionMode } = await c.req.json();
  if (!name?.trim() || !path?.trim()) throw new Error('Name and path are required');
  const absPath = resolve(path.trim());
  if (!existsSync(absPath) || !statSync(absPath).isDirectory()) throw new Error(`Not a directory: ${absPath}`);
  let slug = slugify(name);
  while (getProjectBySlug(slug)) slug += '-2';
  db.prepare(`INSERT INTO projects (slug, name, path, remote, default_model, permission_mode, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(slug, name.trim(), absPath, await getRemote(absPath), defaultModel || 'sonnet', permissionMode || 'acceptEdits', Date.now());
  return c.json(await projectDto(getProjectBySlug(slug)!));
});

app.patch('/api/projects/:slug', async (c) => {
  const project = getProjectBySlug(c.req.param('slug'));
  if (!project) return c.json({ error: 'Project not found' }, 404);
  const body = await c.req.json();
  db.prepare('UPDATE projects SET default_model = ?, permission_mode = ?, always_allow = ? WHERE id = ?').run(
    body.defaultModel ?? project.default_model,
    body.permissionMode ?? project.permission_mode,
    body.alwaysAllow ? JSON.stringify(body.alwaysAllow) : project.always_allow,
    project.id,
  );
  return c.json(await projectDto(getProjectBySlug(project.slug)!));
});

// ---------- accounts ----------
// Tokens never leave the server; the UI only sees names and limit state.

app.get('/api/accounts', (c) => c.json(accountsDto()));

app.post('/api/accounts', async (c) => {
  const { name, token } = await c.req.json();
  if (!name?.trim()) throw new Error('Name is required');
  if (!token?.trim() || /\s/.test(token.trim())) throw new Error('Paste the token printed by `claude setup-token`');
  addAccount(name.trim(), token.trim());
  return c.json(accountsDto());
});

app.delete('/api/accounts/:id', (c) => (removeAccount(Number(c.req.param('id'))), c.json(accountsDto())));
app.post('/api/accounts/:id/clear-limit', (c) => (clearAccountLimit(Number(c.req.param('id'))), c.json(accountsDto())));

app.post('/api/pick-folder', async (c) => c.json({ path: await pickFolder() }));

// ---------- tasks ----------

app.get('/api/projects/:slug/tasks', (c) => {
  const project = getProjectBySlug(c.req.param('slug'));
  if (!project) return c.json({ error: 'Project not found' }, 404);
  return c.json(listTasks(project.id).map(toDto));
});

app.post('/api/projects/:slug/tasks', async (c) => {
  const project = getProjectBySlug(c.req.param('slug'));
  if (!project) return c.json({ error: 'Project not found' }, 404);
  const { title, description, model } = await c.req.json();
  if (!title?.trim()) throw new Error('Title is required');
  return c.json(toDto(createTask(project, { title: title.trim(), description, model })));
});

const taskId = (c: { req: { param: (k: string) => string } }) => Number(c.req.param('id'));

app.get('/api/tasks/:id/events', (c) => c.json(listEvents(taskId(c))));
app.get('/api/tasks/:id/diff', async (c) => c.json(await diff(taskId(c))));

app.post('/api/tasks/:id/reply', async (c) => {
  const { text } = await c.req.json();
  if (!text?.trim()) throw new Error('Reply is empty');
  reply(taskId(c), text.trim());
  return c.json({ ok: true });
});

app.post('/api/tasks/:id/split/approve', async (c) => {
  const { subtasks } = await c.req.json();
  if (!Array.isArray(subtasks) || subtasks.length === 0) throw new Error('No subtasks');
  return c.json(approveSplit(taskId(c), subtasks).map(toDto));
});

app.post('/api/tasks/:id/stop', async (c) => (await stop(taskId(c)), c.json({ ok: true })));
app.post('/api/tasks/:id/retry', (c) => (retry(taskId(c)), c.json({ ok: true })));
app.post('/api/tasks/:id/done', async (c) => (await markDone(taskId(c)), c.json({ ok: true })));
app.post('/api/tasks/:id/discard', async (c) => (await discard(taskId(c)), c.json({ ok: true })));
app.post('/api/tasks/:id/open-terminal', async (c) => (await openInTerminal(taskId(c)), c.json({ ok: true })));
app.get('/api/tasks/:id/mergeable', async (c) => c.json({ mergeable: await mergeable(taskId(c)) }));
app.post('/api/tasks/:id/merge', async (c) => c.json(await merge(taskId(c))));

app.post('/api/permissions/:id', async (c) => {
  const { decision, message } = await c.req.json();
  if (!answerPermission(c.req.param('id'), decision, message)) throw new Error('Permission request is no longer pending');
  return c.json({ ok: true });
});

app.get('/api/status', (c) => c.json({ running: runningCount(), maxConcurrent: MAX_CONCURRENT }));

// ---------- live updates ----------

app.get('/api/stream', (c) =>
  streamSSE(c, async (stream) => {
    const unsubscribe = subscribe((msg) => {
      stream.writeSSE({ data: JSON.stringify(msg) }).catch(() => {});
    });
    stream.onAbort(() => { unsubscribe(); });
    while (!stream.aborted) {
      await stream.writeSSE({ event: 'status', data: JSON.stringify({ running: runningCount(), maxConcurrent: MAX_CONCURRENT }) });
      await stream.sleep(5000);
    }
  }));


// ---------- built web UI (production) ----------

const dist = resolve(import.meta.dirname, '../web/dist');
if (existsSync(dist)) {
  app.use('/assets/*', serveStatic({ root: dist }));
  app.get('*', async (c) => c.html(await readFile(resolve(dist, 'index.html'), 'utf8')));
}

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  console.log(`🐢 Turtle Command Center API on http://localhost:${PORT}`);
  recoverOnStartup().catch((err) => console.error('[tasks] startup recovery failed:', err));
});

