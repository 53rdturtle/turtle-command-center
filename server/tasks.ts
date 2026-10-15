import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { LIMIT_RETRY_MS, MAX_CONCURRENT } from './config.ts';
import {
  addEvent, db, DB_PATH, getAccount, getPermission, getProject, getTask, lastEvent, listAccounts, pendingPermissions,
  setRunOffset, tasksWithStatus, updateTask,
  type AccountRow, type Checkpoint, type EventRow, type MergeFailure, type ProjectRow, type SplitProposal, type TaskRow,
} from './db.ts';
import { CliRunner, type AgentRunner, type RunRef, type RunResult } from './runner.ts';
import { openResumeTerminal } from './openTerminal.ts';
import {
  createWorktree, currentBranch, discardWorktree, hasWorkToMerge, mergeTaskBranch, restoreWorktree, saveAndRemoveWorktree, taskDiff,
  wasMerged,
} from './worktree.ts';

/**
 * Agent runs are detached processes and the database is the source of truth, so this server can
 * restart at any time: on startup it re-attaches to runs that are still going.
 */

const runner: AgentRunner = new CliRunner();
const attached = new Map<number, { detach(): void }>();

// ---------- live updates ----------
// Agent-side MCP processes write to the database directly, so changes are picked up by polling
// `tasks.rev` and `events.id` rather than emitted at each write site.

type Listener = (msg: unknown) => void;
const listeners = new Set<Listener>();
export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let lastRev = (db.prepare('SELECT COALESCE(MAX(rev), 0) AS r FROM tasks').get() as { r: number }).r;
let lastEventId = (db.prepare('SELECT COALESCE(MAX(id), 0) AS i FROM events').get() as { i: number }).i;

setInterval(() => {
  const tasks = db.prepare('SELECT * FROM tasks WHERE rev > ? ORDER BY rev').all(lastRev) as unknown as TaskRow[];
  const events = db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(lastEventId) as unknown as EventRow[];
  for (const event of events) {
    lastEventId = event.id;
    listeners.forEach((fn) => fn({ type: 'event', event }));
  }
  for (const task of tasks) {
    lastRev = Math.max(lastRev, task.rev);
    const dto = toDto(task);
    listeners.forEach((fn) => fn({ type: 'task', task: dto }));
  }
}, 250);

// ---------- permissions ----------
// The agent's MCP process inserts requests and polls for the answer; we only record decisions.

const MULTI_COMMAND_TOOLS = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'python3', 'py', 'cargo', 'go', 'docker', 'gh',
]);
// Tools that run another command: a rule only ever covers the exact command line.
const WRAPPER_TOOLS = new Set(['bash', 'sh', 'env', 'sudo', 'xargs', 'eval', 'exec', 'pwsh', 'powershell', 'cmd']);

/**
 * The "Always allow" rule a tool call would create, or null when none should be offered.
 * Keep identical to allowKey in server/mcp-stdio.mjs.
 * Bash rules are scoped to the command's first word, or first two for multi-command tools
 * (so allowing `git status` doesn't allow `git push`). Commands with shell control or
 * substitution never get a rule: `cd x && rm -rf ~` must not ride on a `cd` rule.
 */
export function allowKey(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName !== 'Bash' || typeof input.command !== 'string') return toolName;
  const command = input.command.trim();
  if (!command || /[&|;<>`\n\r]|\$\(/.test(command)) return null;
  const words = command.split(/\s+/);
  const tool = words[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  if (words[0].includes('=') || WRAPPER_TOOLS.has(tool)) return `Bash:${words.join(' ')}`;
  if (!MULTI_COMMAND_TOOLS.has(tool)) return `Bash:${words[0]}`;
  // `git -C dir push` or bare `git`: no safe subcommand to scope on, so match exactly.
  if (words.length < 2 || words[1].startsWith('-')) return `Bash:${words.join(' ')}`;
  return `Bash:${words[0]} ${words[1]}`;
}

export function answerPermission(id: string, decision: 'allow' | 'always' | 'deny', message?: string) {
  const req = getPermission(id);
  if (!req || req.status !== 'pending') return false;
  if (decision === 'always') {
    const task = getTask(req.task_id)!;
    const project = getProject(task.project_id)!;
    const key = allowKey(req.tool_name, JSON.parse(req.input));
    const rules = new Set<string>(JSON.parse(project.always_allow));
    // No safe rule for this call (e.g. a chained Bash command): treat as a one-off allow.
    if (key) rules.add(key);
    db.prepare('UPDATE projects SET always_allow = ? WHERE id = ?').run(JSON.stringify([...rules]), project.id);
  }
  db.prepare(`UPDATE permissions SET status = ?, message = ? WHERE id = ? AND status = 'pending'`)
    .run(decision, message ?? null, id);
  updateTask(req.task_id, {});
  return true;
}

function denyPending(taskId: number, message: string) {
  db.prepare(`UPDATE permissions SET status = 'deny', message = ? WHERE task_id = ? AND status = 'pending'`).run(message, taskId);
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
    // Only worth showing once there is more than one account to fail over between.
    account: t.account_id && listAccounts().length > 1 ? (getAccount(t.account_id)?.name ?? null) : null,
    sessionId: t.started ? t.session_id : null,
    worktree: t.worktree,
    branch: t.branch,
    checkpoint: t.checkpoint ? (JSON.parse(t.checkpoint) as Checkpoint) : null,
    split: t.split ? (JSON.parse(t.split) as SplitProposal) : null,
    queuedPrompt: t.status === 'queued' || t.status === 'limited' ? t.pending_prompt : null,
    error: t.error,
    mergeState: t.merge_state,
    mergePosition: mergePosition(t),
    mergeFailure: t.merge_failure ? (JSON.parse(t.merge_failure) as MergeFailure) : null,
    retryAt: t.retry_at,
    costUsd: t.cost_usd,
    lastActivity: t.status === 'running' ? (lastEvent(t.id)?.text ?? null) : null,
    permissions: pendingPermissions(t.id).map((p) => {
      const input = JSON.parse(p.input);
      return { id: p.id, toolName: p.tool_name, input, alwaysKey: allowKey(p.tool_name, input) };
    }),
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
- The summary is a TL;DR for someone glancing at a busy board: 2-3 plain sentences (max 350 characters, no bullets) saying what you found or did and what you need from them. Put evidence, file paths and caveats in details; the user opens it only when they want more.
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
      (cp ? `\n\nWhat the parent session found so far:\n${cp.summary}${cp.details ? `\n\n${cp.details}` : ''}` : '') +
      `\n\n${prompt}\n\nStay within the scope of this subtask; other subtasks are being handled in parallel.`;
  }
  return prompt;
}

// ---------- accounts ----------

/** The first account, in failover order, that isn't cooling down from a usage limit. */
function availableAccount(): AccountRow | undefined {
  const now = Date.now();
  return listAccounts().find((a) => !a.limited_until || a.limited_until <= now);
}

/** When the next limited account frees up. */
const nextAccountReset = () => Math.min(...listAccounts().map((a) => a.limited_until ?? Date.now()));

/** Usage-limit messages from the API sometimes end in the reset time as `|<unix seconds>`. */
function limitResetAt(message: string) {
  const epoch = Number(message.match(/\|(\d{10})\b/)?.[1]);
  return epoch * 1000 > Date.now() ? epoch * 1000 : Date.now() + LIMIT_RETRY_MS;
}

export function accountsDto() {
  const now = Date.now();
  return listAccounts().map((a) => ({
    id: a.id,
    name: a.name,
    usesToken: Boolean(a.token),
    limitedUntil: a.limited_until && a.limited_until > now ? a.limited_until : null,
    running: (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'running' AND account_id = ?`).get(a.id) as { n: number }).n,
  }));
}

export function addAccount(name: string, token: string) {
  db.prepare('INSERT INTO accounts (name, token, created_at) VALUES (?, ?, ?)').run(name, token, Date.now());
  pump(); // tasks parked for lack of an account can go now
}

export function removeAccount(id: number) {
  if (listAccounts().length <= 1) throw new Error('Keep at least one account');
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id); // its running tasks finish on the token they started with
}

/** For when you know the limit has reset (or was a false alarm). */
export function clearAccountLimit(id: number) {
  db.prepare('UPDATE accounts SET limited_until = NULL WHERE id = ?').run(id);
  for (const t of tasksWithStatus('limited')) updateTask(t.id, { status: 'queued', retry_at: null });
  pump();
}

// ---------- scheduler ----------

const runningCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'`).get() as { n: number }).n;
export { runningCount };

/** Puts a prompt in line for the task's session; multiple queued prompts are combined. */
function enqueue(taskId: number, prompt: string) {
  const task = getTask(taskId)!;
  const combined = task.status === 'queued' && task.pending_prompt ? `${task.pending_prompt}\n\n${prompt}` : prompt;
  updateTask(taskId, { status: 'queued', pending_prompt: combined, error: null, retry_at: null });
  pump();
}

function pump() {
  while (runningCount() < MAX_CONCURRENT) {
    const next = tasksWithStatus('queued')[0];
    if (!next) return;
    const account = availableAccount();
    if (!account) {
      // Every account is out of usage: park the queue until the first one resets.
      const retryAt = nextAccountReset();
      for (const t of tasksWithStatus('queued')) updateTask(t.id, { status: 'limited', retry_at: retryAt });
      return;
    }
    updateTask(next.id, { status: 'running', checkpoint: null, split: null, error: null, account_id: account.id });
    start(next, account).catch((err) => {
      updateTask(next.id, { status: 'failed', error: String(err?.message ?? err), run_ref: null });
      pump();
    });
  }
}

async function start(task: TaskRow, account: AccountRow) {
  const project = getProject(task.project_id)!;
  if (!task.worktree) {
    const parent = task.parent_id ? getTask(task.parent_id) : undefined;
    const wt = await createWorktree(project.path, project.slug, task.id, task.title, parent?.branch ?? 'HEAD');
    updateTask(task.id, { worktree: wt.path, branch: wt.branch });
  } else {
    const state = await ensureWorktree(task);
    if (state === 'merged') return;
    if (state === 'gone') throw new Error(`This task's worktree and branch are gone (${task.worktree}), so its session can't continue here.`);
  }
  const fresh = getTask(task.id)!;
  if (fresh.status !== 'running') return; // stopped while the worktree was being created
  const prompt = fresh.pending_prompt ?? initialPrompt(fresh);
  const sessionId = fresh.session_id ?? randomUUID();

  const ref = runner.start({
    taskId: task.id,
    cwd: fresh.worktree!,
    prompt,
    sessionId,
    resume: Boolean(fresh.started),
    model: fresh.model,
    permissionMode: project.permission_mode,
    dbPath: DB_PATH,
    systemPrompt: systemPrompt(fresh),
    oauthToken: account.token,
  });
  updateTask(task.id, { session_id: sessionId, pending_prompt: null, run_prompt: prompt, run_ref: JSON.stringify(ref), run_offset: 0 });
  addEvent(task.id, 'user', prompt);
  attach(task.id);
}

/** Follows a run's output until it exits. Safe to call again after a server restart. */
function attach(taskId: number) {
  const task = getTask(taskId)!;
  const ref = JSON.parse(task.run_ref!) as RunRef;
  attached.get(taskId)?.detach();
  attached.set(taskId, runner.attach(ref, task.run_offset, {
    onEvent: (e) => {
      if (e.kind === 'session') updateTask(taskId, { session_id: e.sessionId, started: 1 });
      else {
        addEvent(taskId, e.kind, e.text);
        updateTask(taskId, {}); // refresh the card's activity line
      }
    },
    onProgress: (offset) => setRunOffset(taskId, offset),
    onExit: (result) => {
      attached.delete(taskId);
      finish(taskId, result);
      pump();
    },
  }));
}

function finish(taskId: number, result: RunResult) {
  const task = getTask(taskId)!;
  denyPending(taskId, 'The agent run ended.');
  const base = { cost_usd: task.cost_usd + result.costUsd, run_ref: null };
  if (result.resultText && !(task.status !== 'running' && result.interrupted)) {
    addEvent(taskId, result.isError ? 'error' : 'result', result.resultText);
  }

  if (task.status !== 'running') {
    // Stopped by the user; stop() already set the final status.
    updateTask(taskId, base);
  } else if (result.usageLimited) {
    const limited = task.account_id ? getAccount(task.account_id) : undefined;
    if (limited) db.prepare('UPDATE accounts SET limited_until = ? WHERE id = ?').run(limitResetAt(result.resultText), limited.id);
    const pending_prompt = task.started ? 'You were interrupted by a usage limit. Continue where you left off.' : task.run_prompt;
    const fallback = availableAccount();
    if (fallback) {
      // Sessions are stored locally, not per account, so the next account resumes the same session.
      updateTask(taskId, { ...base, status: 'queued', retry_at: null, pending_prompt, error: null });
      addEvent(taskId, 'user', `${limited?.name ?? 'The account'} hit its usage limit; continuing on ${fallback.name}.`);
    } else {
      updateTask(taskId, { ...base, status: 'limited', retry_at: nextAccountReset(), pending_prompt, error: result.resultText });
    }
  } else if (result.isError) {
    updateTask(taskId, { ...base, status: 'failed', error: result.resultText });
  } else if (task.split) {
    updateTask(taskId, { ...base, status: 'split_proposed' });
  } else if (task.checkpoint) {
    updateTask(taskId, { ...base, status: 'needs_input' });
  } else {
    // The agent ended its turn without reporting; surface its final message instead.
    const checkpoint: Checkpoint = { summary: result.resultText || '_The agent ended its turn without a summary._', options: [] };
    updateTask(taskId, { ...base, status: 'needs_input', checkpoint: JSON.stringify(checkpoint) });
  }
  continueMerge(taskId);
}

// Retry tasks whose usage-limit cool-down has passed.
setInterval(() => {
  const due = db.prepare(`SELECT id FROM tasks WHERE status = 'limited' AND retry_at <= ?`).all(Date.now()) as { id: number }[];
  for (const { id } of due) updateTask(id, { status: 'queued', retry_at: null });
  if (due.length) pump();
}, 60_000);

/** Re-attaches to runs that kept going while the server was down. */
/**
 * Makes sure a task's worktree exists on disk. A merge removes it, and the server can be killed partway
 * through one (merging changes to this app restarts the dev server). A task found already merged is marked done.
 */
async function ensureWorktree(task: TaskRow): Promise<'ok' | 'merged' | 'gone'> {
  if (!task.worktree || !task.branch || existsSync(task.worktree)) return 'ok';
  const project = getProject(task.project_id)!;
  if (await wasMerged(project.path, task.id)) {
    await discardWorktree(project.path, task.worktree, task.branch); // finish the cleanup the merge started
    updateTask(task.id, { status: 'done', worktree: null, branch: null, error: null, merge_state: null, merge_queued_at: null });
    addEvent(task.id, 'user', `Merged \`${task.branch}\` (the server restarted before it could record that).`);
    return 'merged';
  }
  return (await restoreWorktree(project.path, task.worktree, task.branch)) ? 'ok' : 'gone';
}

/** Repairs tasks left pointing at a removed worktree, e.g. by a merge the server didn't live to record. */
async function repairWorktrees() {
  const rows = db.prepare(`SELECT * FROM tasks WHERE worktree IS NOT NULL AND branch IS NOT NULL
    AND status NOT IN ('running', 'done', 'discarded')`).all() as unknown as TaskRow[];
  for (const t of rows) {
    if (existsSync(t.worktree!)) continue;
    try {
      if ((await ensureWorktree(t)) === 'gone') {
        updateTask(t.id, { status: 'failed', error: `This task's worktree and branch are gone (${t.worktree}).` });
      }
    } catch (err) {
      console.error(`[tasks] repairing the worktree of task #${t.id}:`, err);
    }
  }
}

export async function recoverOnStartup() {
  await repairWorktrees();
  // A merge the server didn't live to finish goes again (if it landed, repairWorktrees already marked the task done,
  // and if only the cleanup was cut short, merging again is a no-op that finishes it).
  db.prepare(`UPDATE tasks SET merge_state = 'queued' WHERE merge_state = 'merging'`).run();
  // A conflict-resolving run that ended while the server was down: finish (or drop) its merge.
  for (const t of tasksWithStatus('needs_input')) if (t.merge_state === 'resolving') continueMerge(t.id);
  for (const t of tasksWithStatus('running')) {
    if (t.run_ref) {
      attach(t.id); // if the process has since exited, attach finishes it from its log
    } else {
      // The server stopped between claiming the task and launching the agent.
      updateTask(t.id, { status: 'queued' });
    }
  }
  pump();
  const queued = db.prepare(`SELECT DISTINCT project_id FROM tasks WHERE merge_state = 'queued'`).all() as { project_id: number }[];
  for (const { project_id } of queued) pumpMerges(project_id);
}

// ---------- user actions ----------

export function createTask(project: ProjectRow, input: { title: string; description?: string; model?: string; parentId?: number }) {
  const now = Date.now();
  const r = db.prepare(`INSERT INTO tasks (project_id, parent_id, title, description, status, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`)
    .run(project.id, input.parentId ?? null, input.title, input.description ?? '', input.model || project.default_model, now, now);
  const id = Number(r.lastInsertRowid);
  updateTask(id, {});
  pump();
  return getTask(id)!;
}

export function reply(taskId: number, text: string) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.status === 'running') throw new Error('Task is running; wait for its checkpoint or stop it first');
  if (task.merge_state === 'merging') throw new Error('This task is being merged right now');
  leaveMergeQueue(task); // the work is about to change; merge again once the agent reports back
  enqueue(taskId, text);
}

export function approveSplit(taskId: number, subtasks: { title: string; prompt: string }[]) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  const project = getProject(task.project_id)!;
  updateTask(taskId, { status: 'split' });
  addEvent(taskId, 'user', `Approved split into ${subtasks.length} subtasks.`);
  return subtasks.map((s) =>
    createTask(project, { title: s.title, description: s.prompt, model: task.model, parentId: taskId }));
}

export async function stop(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  const checkpoint: Checkpoint = { summary: 'Stopped by you. Reply to continue the session.', options: [{ label: 'Continue where you left off.' }] };
  updateTask(taskId, { status: 'needs_input', checkpoint: JSON.stringify(checkpoint), pending_prompt: null, retry_at: null });
  denyPending(taskId, 'Task was stopped.');
  if (task.run_ref) await runner.stop(JSON.parse(task.run_ref) as RunRef);
}

export async function markDone(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.merge_state === 'merging') throw new Error('This task is being merged right now');
  if (task.status === 'running') await stop(taskId);
  leaveMergeQueue(task);
  const project = getProject(task.project_id)!;
  if (task.branch && task.worktree) await saveAndRemoveWorktree(project.path, task.worktree, taskId);
  updateTask(taskId, { status: 'done', worktree: task.branch ? null : task.worktree });
}

/** Automatic resolve-and-retry rounds per Merge click before the board asks you instead. */
const MAX_MERGE_ATTEMPTS = 2;

// ---------- merge queue ----------
// Merges into a project's checkout run one at a time: two at once would fight over the index, and each merge's
// conflict check has to see the previous one's result. The queue lives in the database so it survives restarts
// (merging changes to this app restarts the server).

/** Projects with a merge in progress. */
const merging = new Set<number>();

/** Puts the task in its project's merge queue. */
export function merge(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (!task.branch || !task.worktree) throw new Error('This task has no branch to merge');
  if (task.status === 'running' || task.status === 'queued' || task.status === 'limited') throw new Error('Task is running; wait for its checkpoint or stop it first');
  if (task.merge_state) throw new Error('This task is already in the merge queue');
  updateTask(taskId, { merge_state: 'queued', merge_queued_at: Date.now(), merge_attempts: 0, merge_failure: null });
  pumpMerges(task.project_id);
  return { ok: true };
}

/** Takes the task out of the merge queue, if it hasn't started merging yet. */
export function cancelMerge(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.merge_state !== 'queued') throw new Error('This task is not waiting in the merge queue');
  updateTask(taskId, { merge_state: null, merge_queued_at: null });
}

export function dismissMergeFailure(taskId: number) {
  updateTask(taskId, { merge_failure: null });
}

/** Drops the task's place in the merge queue (and any stale failure), e.g. when its work changes or ends. */
function leaveMergeQueue(task: TaskRow) {
  if (task.merge_state === 'merging') return; // already landing
  if (task.merge_state || task.merge_failure) updateTask(task.id, { merge_state: null, merge_queued_at: null, merge_failure: null });
}

/** 1-based place in line for queued tasks (the one merging now is 0); null when not waiting. */
function mergePosition(task: TaskRow) {
  if (task.merge_state === 'merging') return 0;
  if (task.merge_state !== 'queued') return null;
  return 1 + (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND merge_state = 'queued' AND merge_queued_at < ?`)
    .get(task.project_id, task.merge_queued_at) as { n: number }).n;
}

const nextInMergeQueue = (projectId: number) =>
  db.prepare(`SELECT * FROM tasks WHERE project_id = ? AND merge_state = 'queued' ORDER BY merge_queued_at, id LIMIT 1`)
    .get(projectId) as TaskRow | undefined;

/** Merges the project's queued tasks in order, one at a time. */
async function pumpMerges(projectId: number) {
  if (merging.has(projectId)) return;
  merging.add(projectId);
  try {
    for (let task = nextInMergeQueue(projectId); task; task = nextInMergeQueue(projectId)) {
      updateTask(task.id, { merge_state: 'merging' });
      try {
        await attemptMerge(task.id);
      } catch (err: any) {
        const target = (await currentBranch(getProject(projectId)!.path).catch(() => null)) ?? 'HEAD';
        failMerge(task.id, { target, conflicts: [], message: String(err?.message ?? err) });
      }
    }
  } finally {
    merging.delete(projectId);
  }
}

function failMerge(taskId: number, failure: MergeFailure) {
  updateTask(taskId, { merge_state: null, merge_queued_at: null, merge_failure: JSON.stringify(failure) });
}

/**
 * Merges the task branch; on conflicts, hands them to the task's own agent, which knows what its change is for.
 * Once it reports done, `continueMerge` puts the task back in the queue.
 */
async function attemptMerge(taskId: number) {
  const task = getTask(taskId)!;
  if (!task.branch || !task.worktree) throw new Error('This task has no branch to merge');
  if (task.status === 'running' || task.status === 'queued' || task.status === 'limited') {
    throw new Error('The agent started working again before the merge; merge once it reports back');
  }
  const project = getProject(task.project_id)!;
  const result = await mergeTaskBranch(project.path, task.worktree, task.branch, taskId, `Merge task #${taskId}: ${task.title}`);
  if (result.ok) {
    updateTask(taskId, { status: 'done', worktree: null, branch: null, merge_state: null, merge_queued_at: null, merge_failure: null });
    addEvent(taskId, 'user', `Merged \`${task.branch}\` into \`${result.target}\`.`);
    return;
  }
  if (!result.conflicts.length || task.merge_attempts >= MAX_MERGE_ATTEMPTS) {
    failMerge(taskId, { target: result.target, conflicts: result.conflicts, message: result.message });
    return;
  }
  updateTask(taskId, { merge_state: 'resolving', merge_attempts: task.merge_attempts + 1 });
  addEvent(taskId, 'user', `Merging into \`${result.target}\` conflicts in ${result.conflicts.join(', ')}; asked the agent to resolve them.`);
  enqueue(taskId, resolveConflictsPrompt(result.target, result.conflicts));
}

function resolveConflictsPrompt(target: string, conflicts: string[]) {
  return `The user clicked Merge, but your branch conflicts with \`${target}\`, which has moved on since you branched. Conflicting files: ${conflicts.join(', ')}.

Bring your branch up to date in your worktree:
1. Run \`git merge ${target}\`.
2. Resolve each conflict so that both your change and the other side's intent survive. To understand the other side, read the "Merge task #N" commits on ${target} that touched these files (\`git log ${target} --merges -- <file>\`); each message says what that task was for.
3. Run the project's checks (typecheck, tests) and fix anything the merge broke.
4. Commit the merge.

Then call report_checkpoint with done=true and a one-line summary of how you resolved it; the board will merge your branch automatically. If a conflict needs a product decision (the two sides want different behavior), don't guess: report with done=false and give the user options.`;
}

/** Called when a conflict-resolving run ends: back into the queue if the agent says it's resolved, otherwise leave it to the user. */
function continueMerge(taskId: number) {
  const task = getTask(taskId)!;
  // A usage-limited run resumes later, on this account or the next.
  if (task.merge_state !== 'resolving' || task.status === 'limited' || task.status === 'queued') return;
  const cp = task.checkpoint ? (JSON.parse(task.checkpoint) as Checkpoint) : null;
  if (task.status !== 'needs_input' || !cp?.done) {
    updateTask(taskId, { merge_state: null, merge_queued_at: null });
    return;
  }
  // It keeps its original place in line.
  updateTask(taskId, { merge_state: 'queued' });
  pumpMerges(task.project_id);
}

export async function mergeable(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (!task.branch || !task.worktree || !existsSync(task.worktree)) return false;
  return hasWorkToMerge(getProject(task.project_id)!.path, task.worktree, task.branch);
}

export async function diff(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (!task.branch || !task.worktree) throw new Error('This task has no worktree to diff');
  return taskDiff(getProject(task.project_id)!.path, task.worktree);
}

export async function discard(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.merge_state === 'merging') throw new Error('This task is being merged right now');
  if (task.status === 'running') await stop(taskId);
  leaveMergeQueue(task);
  const project = getProject(task.project_id)!;
  if (task.branch && task.worktree) await discardWorktree(project.path, task.worktree, task.branch);
  updateTask(taskId, { status: 'discarded', worktree: null });
}

/** Hands the session to an interactive terminal; stops the board's run first so two processes don't share it. */
export async function openInTerminal(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (!task.started || !task.session_id || !task.worktree) throw new Error('This task has no session to resume');
  if (task.merge_state === 'merging') throw new Error('This task is being merged right now');
  leaveMergeQueue(task);
  if (task.status === 'running' || task.status === 'queued' || task.status === 'limited') await stop(taskId);
  await openResumeTerminal(task.worktree, task.session_id, `#${taskId} ${task.title}`);
  addEvent(taskId, 'user', 'Opened the session in a terminal.');
}

export function retry(taskId: number) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.merge_state === 'merging') throw new Error('This task is being merged right now');
  leaveMergeQueue(task);
  enqueue(taskId, task.pending_prompt ?? (task.started ? 'Your previous run ended unexpectedly. Continue where you left off.' : initialPrompt(task)));
}
