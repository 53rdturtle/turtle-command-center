import { randomUUID } from 'node:crypto';
import { LIMIT_RETRY_MS, MAX_CONCURRENT, PORT } from './config.ts';
import {
  addEvent, db, getProject, getTask, lastEvent, updateTask,
  type Checkpoint, type ProjectRow, type SplitProposal, type TaskRow,
} from './db.ts';
import { CliRunner, type AgentRunner, type RunHandle } from './runner.ts';
import { createWorktree, discardWorktree, mergeTaskBranch, saveAndRemoveWorktree } from './worktree.ts';

const runner: AgentRunner = new CliRunner();
const running = new Map<number, RunHandle>();

// ---------- live updates ----------

type Listener = (msg: unknown) => void;
const listeners = new Set<Listener>();
export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const broadcast = (msg: unknown) => listeners.forEach((fn) => fn(msg));

function emitTask(id: number) {
  const task = getTask(id);
  if (task) broadcast({ type: 'task', task: toDto(task) });
}
function emitEvent(taskId: number, kind: string, text: string) {
  const event = addEvent(taskId, kind, text);
  broadcast({ type: 'event', event });
}

// ---------- permissions ----------

export interface PermissionRequest {
  id: string;
  taskId: number;
  toolName: string;
  input: Record<string, unknown>;
}
interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}
const pendingPermissions = new Map<string, PermissionRequest & { resolve: (d: PermissionDecision) => void }>();

const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'WebSearch', 'WebFetch', 'Task', 'Agent',
]);

/** Key used for "always allow": Bash rules are scoped to the command's first word. */
function allowKey(toolName: string, input: Record<string, unknown>) {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return `Bash:${input.command.trim().split(/\s+/)[0]}`;
  }
  return toolName;
}

export function requestPermission(taskId: number, toolName: string, input: Record<string, unknown>) {
  const task = getTask(taskId);
  const project = task && getProject(task.project_id);
  const alwaysAllow: string[] = project ? JSON.parse(project.always_allow) : [];
  if (READ_ONLY_TOOLS.has(toolName) || toolName.startsWith('mcp__tcc__') || alwaysAllow.includes(allowKey(toolName, input))) {
    return Promise.resolve<PermissionDecision>({ behavior: 'allow', updatedInput: input });
  }
  return new Promise<PermissionDecision>((resolve) => {
    const id = randomUUID();
    pendingPermissions.set(id, { id, taskId, toolName, input, resolve });
    emitTask(taskId);
  });
}

export function answerPermission(id: string, decision: 'allow' | 'always' | 'deny', message?: string) {
  const req = pendingPermissions.get(id);
  if (!req) return false;
  pendingPermissions.delete(id);
  if (decision === 'always') {
    const task = getTask(req.taskId)!;
    const project = getProject(task.project_id)!;
    const list = new Set<string>(JSON.parse(project.always_allow));
    list.add(allowKey(req.toolName, req.input));
    db.prepare('UPDATE projects SET always_allow = ? WHERE id = ?').run(JSON.stringify([...list]), project.id);
  }
  req.resolve(decision === 'deny'
    ? { behavior: 'deny', message: message || 'The user denied this action.' }
    : { behavior: 'allow', updatedInput: req.input });
  emitTask(req.taskId);
  return true;
}

function denyAllFor(taskId: number) {
  for (const [id, req] of pendingPermissions) {
    if (req.taskId === taskId) {
      pendingPermissions.delete(id);
      req.resolve({ behavior: 'deny', message: 'Task was stopped.' });
    }
  }
}

// ---------- DTO ----------

export function toDto(t: TaskRow) {
  const project = getProject(t.project_id);
  return {
    id: t.id,
    projectSlug: project?.slug,
    parentId: t.parent_id,
    title: t.title,
    description: t.description,
    status: t.status,
    model: t.model,
    sessionId: t.started ? t.session_id : null,
    worktree: t.worktree,
    branch: t.branch,
    checkpoint: t.checkpoint ? (JSON.parse(t.checkpoint) as Checkpoint) : null,
    split: t.split ? (JSON.parse(t.split) as SplitProposal) : null,
    queuedPrompt: t.status === 'queued' || t.status === 'limited' ? t.pending_prompt : null,
    error: t.error,
    retryAt: t.retry_at,
    costUsd: t.cost_usd,
    lastActivity: t.status === 'running' ? (lastEvent(t.id)?.text ?? null) : null,
    permissions: [...pendingPermissions.values()]
      .filter((p) => p.taskId === t.id)
      .map(({ id, toolName, input }) => ({ id, toolName, input })),
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

// ---------- agent instructions ----------

function systemPrompt(task: TaskRow) {
  return `You were dispatched from Turtle Command Center, a board where the user supervises several agents at once. The user does NOT read your transcript; they only see what you report through the command-center tools.

Rules:
- You are working in ${task.branch ? `an isolated git worktree on branch \`${task.branch}\`. Commit your work there when a meaningful chunk is complete.` : 'the project directory.'}
- EVERY turn must end with exactly one call to report_checkpoint (or propose_split), after which you stop and wait.
- The summary is 2-6 short sentences or bullets in markdown. Lead with the outcome or the decision you need.
- Options are 1-4 concrete next steps the user can pick with one click. Each option's label is sent back to you verbatim as the user's reply, so make it self-contained. Put your recommendation first and end its label with "(Recommended)".
- Decide small things yourself. Ask before large, risky, or irreversible choices.
- On your first turn, investigate (read the code, reproduce the problem, check constraints) and report findings plus a proposed plan. Don't make large changes before the user picks a direction, unless the task is trivial.
- If the task is clearly too big for one session, with parts that can proceed independently in parallel, call propose_split with self-contained subtask prompts instead of report_checkpoint.
- When the task is finished, call report_checkpoint with done=true and summarize what changed.`;
}

function initialPrompt(task: TaskRow) {
  let prompt = `Task: ${task.title}`;
  if (task.description.trim()) prompt += `\n\n${task.description.trim()}`;
  if (task.parent_id) {
    const parent = getTask(task.parent_id);
    const cp = parent?.checkpoint ? (JSON.parse(parent.checkpoint) as Checkpoint) : null;
    prompt = `This is a subtask split from the larger task "${parent?.title}".` +
      (cp ? `\n\nWhat the parent session found so far:\n${cp.summary}` : '') +
      `\n\n${prompt}\n\nStay within the scope of this subtask; other subtasks are being handled in parallel.`;
  }
  return prompt;
}

// ---------- scheduler ----------

/** Puts a prompt in line for the task's session; multiple queued prompts are combined. */
function enqueue(taskId: number, prompt: string) {
  const task = getTask(taskId)!;
  const combined = task.status === 'queued' && task.pending_prompt ? `${task.pending_prompt}\n\n${prompt}` : prompt;
  updateTask(taskId, { status: 'queued', pending_prompt: combined, error: null, retry_at: null });
  emitTask(taskId);
  pump();
}

function pump() {
  while (running.size < MAX_CONCURRENT) {
    const next = db.prepare(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY updated_at LIMIT 1`).get() as TaskRow | undefined;
    if (!next) return;
    start(next).catch((err) => {
      running.delete(next.id);
      updateTask(next.id, { status: 'failed', error: String(err?.message ?? err) });
      emitTask(next.id);
      pump();
    });
  }
}

async function start(task: TaskRow) {
  const project = getProject(task.project_id)!;
  updateTask(task.id, { status: 'running', checkpoint: null, split: null });
  running.set(task.id, { done: new Promise(() => {}), stop: () => {} }); // reserve the slot while the worktree is created

  if (!task.worktree) {
    const parent = task.parent_id ? getTask(task.parent_id) : undefined;
    const wt = await createWorktree(project.path, project.slug, task.id, task.title, parent?.branch ?? 'HEAD');
    updateTask(task.id, { worktree: wt.path, branch: wt.branch });
  }
  const fresh = getTask(task.id)!;
  const prompt = fresh.pending_prompt ?? initialPrompt(fresh);
  const sessionId = fresh.session_id ?? randomUUID();
  updateTask(task.id, { session_id: sessionId, pending_prompt: null });
  emitEvent(task.id, 'user', prompt);
  emitTask(task.id);

  const handle = runner.run(
    {
      taskId: task.id,
      cwd: fresh.worktree!,
      prompt,
      sessionId,
      resume: Boolean(fresh.started),
      model: fresh.model,
      permissionMode: project.permission_mode,
      mcpUrl: `http://127.0.0.1:${PORT}/mcp/${task.id}`,
      systemPrompt: systemPrompt(fresh),
    },
    (e) => {
      if (e.kind === 'session') updateTask(task.id, { session_id: e.sessionId, started: 1 });
      else emitEvent(task.id, e.kind, e.text);
      emitTask(task.id);
    },
  );
  running.set(task.id, handle);

  const result = await handle.done;
  running.delete(task.id);
  denyAllFor(task.id);
  finish(task.id, prompt, result);
  pump();
}

function finish(taskId: number, prompt: string, result: Awaited<RunHandle['done']>) {
  const task = getTask(taskId)!;
  const cost = task.cost_usd + result.costUsd;
  if (result.resultText) emitEvent(taskId, result.isError ? 'error' : 'result', result.resultText);

  if (task.status !== 'running') {
    // Stopped by the user; stop() already set the final status.
    updateTask(taskId, { cost_usd: cost, started: result.sessionId ? 1 : task.started });
  } else if (result.usageLimited) {
    updateTask(taskId, {
      status: 'limited',
      cost_usd: cost,
      retry_at: Date.now() + LIMIT_RETRY_MS,
      pending_prompt: task.started ? 'You were interrupted by a usage limit. Continue where you left off.' : prompt,
      error: result.resultText,
    });
  } else if (result.isError) {
    updateTask(taskId, { status: 'failed', cost_usd: cost, error: result.resultText });
  } else if (task.split) {
    updateTask(taskId, { status: 'split_proposed', cost_usd: cost });
  } else if (task.checkpoint) {
    updateTask(taskId, { status: 'needs_input', cost_usd: cost });
  } else {
    // The agent ended its turn without reporting; surface its final message instead.
    const checkpoint: Checkpoint = { summary: result.resultText || '_The agent ended its turn without a summary._', options: [] };
    updateTask(taskId, { status: 'needs_input', cost_usd: cost, checkpoint: JSON.stringify(checkpoint) });
  }
  emitTask(taskId);
}

// Retry tasks whose usage-limit cool-down has passed.
setInterval(() => {
  const due = db.prepare(`SELECT id FROM tasks WHERE status = 'limited' AND retry_at <= ?`).all(Date.now()) as { id: number }[];
  for (const { id } of due) {
    updateTask(id, { status: 'queued', retry_at: null });
    emitTask(id);
  }
  if (due.length) pump();
}, 60_000);

/** Sessions that were running when the server stopped get resumed. */
export function recoverOnStartup() {
  const stale = db.prepare(`SELECT * FROM tasks WHERE status = 'running'`).all() as unknown as TaskRow[];
  for (const t of stale) {
    updateTask(t.id, {
      status: 'queued',
      pending_prompt: t.started ? 'The command center restarted while you were working. Continue where you left off.' : t.pending_prompt,
    });
  }
  pump();
}

// ---------- tool callbacks from the agent (via MCP) ----------

export function recordCheckpoint(taskId: number, cp: Checkpoint) {
  updateTask(taskId, { checkpoint: JSON.stringify(cp) });
  emitEvent(taskId, 'checkpoint', cp.summary);
}

export function recordSplit(taskId: number, split: SplitProposal) {
  updateTask(taskId, { split: JSON.stringify(split) });
  emitEvent(taskId, 'split', `${split.rationale}\n\n${split.subtasks.map((s) => `- ${s.title}`).join('\n')}`);
}

// ---------- user actions ----------

export function createTask(project: ProjectRow, input: { title: string; description?: string; model?: string; parentId?: number }) {
  const now = Date.now();
  const r = db.prepare(`INSERT INTO tasks (project_id, parent_id, title, description, status, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`)
    .run(project.id, input.parentId ?? null, input.title, input.description ?? '', input.model || project.default_model, now, now);
  const id = Number(r.lastInsertRowid);
  emitTask(id);
  pump();
  return getTask(id)!;
}

export function reply(taskId: number, text: string) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.status === 'running') throw new Error('Task is running; wait for its checkpoint or stop it first');
  enqueue(taskId, text);
}

export function approveSplit(taskId: number, subtasks: { title: string; prompt: string }[]) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  const project = getProject(task.project_id)!;
  updateTask(taskId, { status: 'split' });
  emitEvent(taskId, 'user', `Approved split into ${subtasks.length} subtasks.`);
  emitTask(taskId);
  return subtasks.map((s) =>
    createTask(project, { title: s.title, description: s.prompt, model: task.model, parentId: taskId }));
}

export function stop(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  const checkpoint: Checkpoint = { summary: 'Stopped by you. Reply to continue the session.', options: [{ label: 'Continue where you left off.' }] };
  updateTask(taskId, { status: 'needs_input', checkpoint: JSON.stringify(checkpoint), pending_prompt: null, retry_at: null });
  denyAllFor(taskId);
  running.get(taskId)?.stop();
  emitTask(taskId);
}

export async function markDone(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (running.has(taskId)) stop(taskId);
  const project = getProject(task.project_id)!;
  if (task.branch && task.worktree) await saveAndRemoveWorktree(project.path, task.worktree, taskId);
  updateTask(taskId, { status: 'done', worktree: task.branch ? null : task.worktree });
  emitTask(taskId);
}

export async function merge(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (!task.branch || !task.worktree) throw new Error('This task has no branch to merge');
  if (running.has(taskId)) throw new Error('Task is running; wait for its checkpoint or stop it first');
  const project = getProject(task.project_id)!;
  const result = await mergeTaskBranch(project.path, task.worktree, task.branch, taskId, `Merge task #${taskId}: ${task.title}`);
  if (result.ok) {
    updateTask(taskId, { status: 'done', worktree: null, branch: null });
    emitEvent(taskId, 'user', `Merged \`${task.branch}\` into \`${result.target}\`.`);
    emitTask(taskId);
  }
  return result;
}

export async function discard(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (running.has(taskId)) stop(taskId);
  const project = getProject(task.project_id)!;
  if (task.branch && task.worktree) await discardWorktree(project.path, task.worktree, task.branch);
  updateTask(taskId, { status: 'discarded', worktree: null });
  broadcast({ type: 'removed', id: taskId });
}

export function retry(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  enqueue(taskId, task.pending_prompt ?? (task.started ? 'Please try again.' : initialPrompt(task)));
}

export const runningCount = () => running.size;
