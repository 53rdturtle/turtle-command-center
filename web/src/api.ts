/** merge / done / discard options run the board's own action instead of replying to the agent. */
export interface Option { label: string; detail?: string; action?: 'merge' | 'done' | 'discard' }
export interface Checkpoint { summary: string; details?: string; options: Option[]; done?: boolean }
export interface Subtask { title: string; prompt: string; recommended?: boolean }
export interface Split { rationale: string; subtasks: Subtask[] }
export interface Permission {
  id: string; toolName: string; input: Record<string, unknown>;
  /** Rule "Always allow" would save; null when the call can't safely be always-allowed. */
  alwaysKey: string | null;
}

export type Status =
  | 'queued' | 'running' | 'needs_input' | 'split_proposed' | 'split'
  | 'limited' | 'failed' | 'done' | 'discarded';

/** Tokens, turns and wall time consumed by finished runs. */
export interface RunTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
  durationMs: number;
}

export interface Task {
  id: number;
  projectSlug: string;
  parentId: number | null;
  title: string;
  description: string;
  status: Status;
  model: string;
  /** Account of the current or last run; null when there is only one account. */
  account: string | null;
  sessionId: string | null;
  worktree: string | null;
  branch: string | null;
  checkpoint: Checkpoint | null;
  split: Split | null;
  queuedPrompt: string | null;
  error: string | null;
  /** Place in the merge queue: waiting, merging now, conflicted and waiting its turn to resolve, or the agent is resolving conflicts first. */
  mergeState: 'queued' | 'merging' | 'conflicted' | 'resolving' | null;
  /** 1-based place in line while queued, 0 while merging, otherwise null. */
  mergePosition: number | null;
  /** Why the last merge didn't land; cleared on dismiss or the next merge. */
  mergeFailure: MergeFailure | null;
  retryAt: number | null;
  /** API-equivalent cost of the task's runs; a subscription isn't billed per token. */
  costUsd: number;
  /** Totals over the task's finished runs. */
  usage: RunTotals;
  /** Tokens in the session's context as of its latest model call. */
  contextTokens: number | null;
  /** The model's context window; known once a run has finished. */
  contextWindow: number | null;
  lastActivity: string | null;
  /** Counts over all subtasks, including discarded ones (which the board doesn't list). */
  subtasks: { total: number; done: number; discarded: number } | null;
  permissions: Permission[];
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  slug: string;
  name: string;
  path: string;
  remote: string | null;
  defaultModel: string;
  permissionMode: string;
  alwaysAllow: string[];
  currentBranch: string | null;
  /** Run by "Try it" in the task's worktree; empty opens a plain shell there. */
  tryCommand: string;
  suggestedTryCommand: string;
}

/** Fraction used (0-1); resetsAt is null once the window has reset since it was reported. */
export interface UsageWindow { utilization: number; resetsAt: number | null }
export interface AccountUsage { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; reportedAt: number }
/** Environment "Try it" gave the terminal: free ports and a sandbox data dir, so a copy of this app can't clash with the board. */
export interface TryEnv { TCC_PORT: string; TCC_DEV_PORT: string; TCC_DATA_DIR: string }

export interface Account {
  id: number;
  name: string;
  /** False for the account the `claude` CLI is logged in to. */
  usesToken: boolean;
  /** The account new runs start on. */
  active: boolean;
  limitedUntil: number | null;
  /** Last usage the CLI reported during a run on this account; null until one has run. */
  usage: AccountUsage | null;
  running: number;
}

/** `reason` and `files` are missing on failures stored before they existed. */
export type SyncResult =
  | { ok: true; target: string; commits: number }
  | { ok: false; target: string; conflicts: string[]; message: string };

export interface MergeFailure {
  target: string;
  reason?: 'dirty' | 'detached' | 'in_progress' | 'conflicts' | 'error';
  conflicts: string[];
  /** Modified files, when reason is 'dirty' */
  files?: string[];
  message: string;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  /** null when cut off by the server's size cap */
  patch: string | null;
}

export interface TaskDiff { target: string; base: string; files: DiffFile[]; additions: number; deletions: number; truncated: boolean }

export interface TaskTemplate { id: number; title: string; description: string }

/** A file in the task's worktree (or the project folder once it's gone); images load from fileRawUrl. */
export type TaskFile =
  | { path: string; size: number; kind: 'image' | 'binary' }
  | { path: string; size: number; kind: 'text'; text: string; truncated: boolean };
export const fileRawUrl = (id: number, path: string) => `/api/tasks/${id}/file/raw?path=${encodeURIComponent(path)}`;

export interface TaskEvent { id: number; task_id: number; ts: number; kind: string; text: string }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    // The server rejects mutating requests without these (see server/guard.ts).
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json', 'x-tcc': '1' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export type BoardVersion = { startedAt: number; current: string | null } & (
  | { canUpdate: false }
  | {
      canUpdate: true;
      /** Commits in the main checkout that this board doesn't run yet. */
      behind: number;
      updating: boolean;
      merges: { merging: number; queued: number };
      lastError: string | null;
    }
);

export const api = {
  boardVersion: () => call<BoardVersion>('GET', '/api/board-version'),
  updateBoard: () => call('POST', '/api/board-update'),
  projects: () => call<Project[]>('GET', '/api/projects'),
  uploadImage: (dataUrl: string) => call<{ path: string; name: string }>('POST', '/api/images', { dataUrl }),
  pickFolder: () => call<{ path: string | null }>('POST', '/api/pick-folder').then((r) => r.path),
  addProject: (p: { name: string; path: string; defaultModel: string; permissionMode: string }) =>
    call<Project>('POST', '/api/projects', p),
  updateProject: (slug: string, p: Partial<Project>) => call<Project>('PATCH', `/api/projects/${slug}`, p),
  tryProject: (slug: string) => call<TryEnv>('POST', `/api/projects/${slug}/try`),
  accounts: () => call<Account[]>('GET', '/api/accounts'),
  addAccount: (a: { name: string; token: string }) => call<Account[]>('POST', '/api/accounts', a),
  removeAccount: (id: number) => call<Account[]>('DELETE', `/api/accounts/${id}`),
  clearAccountLimit: (id: number) => call<Account[]>('POST', `/api/accounts/${id}/clear-limit`),
  tasks: (slug: string) => call<Task[]>('GET', `/api/projects/${slug}/tasks`),
  createTask: (slug: string, t: { title: string; description: string; model: string }) =>
    call<Task>('POST', `/api/projects/${slug}/tasks`, t),
  templates: (slug: string) => call<TaskTemplate[]>('GET', `/api/projects/${slug}/templates`),
  saveTemplate: (slug: string, t: { title: string; description: string }) =>
    call<TaskTemplate[]>('POST', `/api/projects/${slug}/templates`, t),
  deleteTemplate: (slug: string, id: number) => call<TaskTemplate[]>('DELETE', `/api/projects/${slug}/templates/${id}`),
  events: (id: number) => call<TaskEvent[]>('GET', `/api/tasks/${id}/events`),
  diff: (id: number) => call<TaskDiff>('GET', `/api/tasks/${id}/diff`),
  file: (id: number, path: string) => call<TaskFile>('GET', `/api/tasks/${id}/file?path=${encodeURIComponent(path)}`),
  reply: (id: number, text: string, model?: string) => call('POST', `/api/tasks/${id}/reply`, { text, model }),
  approveSplit: (id: number, subtasks: Subtask[]) => call('POST', `/api/tasks/${id}/split/approve`, { subtasks }),
  stop: (id: number) => call('POST', `/api/tasks/${id}/stop`),
  retry: (id: number) => call('POST', `/api/tasks/${id}/retry`),
  done: (id: number) => call('POST', `/api/tasks/${id}/done`),
  discard: (id: number) => call('POST', `/api/tasks/${id}/discard`),
  openTerminal: (id: number) => call('POST', `/api/tasks/${id}/open-terminal`),
  tryIt: (id: number) => call<TryEnv>('POST', `/api/tasks/${id}/try`),
  /** Whether the branch has work to merge, and how many commits the checkout's branch has that it lacks. */
  mergeable: (id: number) => call<{ mergeable: boolean; behind: number }>('GET', `/api/tasks/${id}/mergeable`),
  sync: (id: number) => call<SyncResult>('POST', `/api/tasks/${id}/sync`),
  merge: (id: number) => call('POST', `/api/tasks/${id}/merge`),
  cancelMerge: (id: number) => call('POST', `/api/tasks/${id}/merge/cancel`),
  dismissMergeFailure: (id: number) => call('POST', `/api/tasks/${id}/merge/dismiss`),
  permission: (id: string, decision: 'allow' | 'always' | 'deny') => call('POST', `/api/permissions/${id}`, { decision }),
  setMaxConcurrent: (maxConcurrent: number) =>
    call<{ running: number; maxConcurrent: number }>('PATCH', '/api/settings', { maxConcurrent }),
};

// ---------- live stream ----------

export type StreamMessage =
  | { type: 'task'; task: Task }
  | { type: 'event'; event: TaskEvent }
  | {
    type: 'status'; running: number; maxConcurrent: number; accounts: Account[];
    /** Per project slug, what runs finished since local midnight consumed. */
    usageToday: Record<string, RunTotals & { runs: number }>;
  };

type Handler = (m: StreamMessage) => void;
const handlers = new Set<Handler>();
let source: EventSource | null = null;

export function onStream(fn: Handler) {
  handlers.add(fn);
  if (!source) {
    source = new EventSource('/api/stream');
    source.onmessage = (e) => handlers.forEach((h) => h(JSON.parse(e.data)));
    source.addEventListener('status', (e) =>
      handlers.forEach((h) => h({ type: 'status', ...JSON.parse((e as MessageEvent).data) })));
  }
  return () => {
    handlers.delete(fn);
  };
}

export const MODELS = ['haiku', 'sonnet', 'opus'];
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'manual', 'plan', 'bypassPermissions'];

/** The agent reported done=true and is waiting for your final review; Mark done / Merge moves it to Done. */
export const agentDone = (t: Task) =>
  t.status === 'needs_input' && Boolean(t.checkpoint?.done) && t.permissions.length === 0 && !t.mergeState && !t.mergeFailure;

export const needsAttention = (t: Task) =>
  t.permissions.length > 0 || Boolean(t.mergeFailure) ||
  (t.status === 'needs_input' && !t.checkpoint?.done && !t.mergeState) || t.status === 'split_proposed' || t.status === 'failed';
