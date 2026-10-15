export interface Option { label: string; detail?: string }
export interface Checkpoint { summary: string; details?: string; options: Option[]; done?: boolean }
export interface Subtask { title: string; prompt: string }
export interface Split { rationale: string; subtasks: Subtask[] }
export interface Permission {
  id: string; toolName: string; input: Record<string, unknown>;
  /** Rule "Always allow" would save; null when the call can't safely be always-allowed. */
  alwaysKey: string | null;
}

export type Status =
  | 'queued' | 'running' | 'needs_input' | 'split_proposed' | 'split'
  | 'limited' | 'failed' | 'done' | 'discarded';

export interface Task {
  id: number;
  projectSlug: string;
  parentId: number | null;
  title: string;
  description: string;
  status: Status;
  model: string;
  sessionId: string | null;
  worktree: string | null;
  branch: string | null;
  checkpoint: Checkpoint | null;
  split: Split | null;
  queuedPrompt: string | null;
  error: string | null;
  retryAt: number | null;
  costUsd: number;
  lastActivity: string | null;
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
}

export type MergeResult =
  | { ok: true; target: string }
  | { ok: false; target: string; reason: 'dirty' | 'detached' | 'in_progress' | 'conflicts' | 'error'; conflicts: string[]; files: string[]; message: string };

export interface TaskEvent { id: number; task_id: number; ts: number; kind: string; text: string }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  projects: () => call<Project[]>('GET', '/api/projects'),
  pickFolder: () => call<{ path: string | null }>('POST', '/api/pick-folder').then((r) => r.path),
  addProject: (p: { name: string; path: string; defaultModel: string; permissionMode: string }) =>
    call<Project>('POST', '/api/projects', p),
  updateProject: (slug: string, p: Partial<Project>) => call<Project>('PATCH', `/api/projects/${slug}`, p),
  tasks: (slug: string) => call<Task[]>('GET', `/api/projects/${slug}/tasks`),
  createTask: (slug: string, t: { title: string; description: string; model: string }) =>
    call<Task>('POST', `/api/projects/${slug}/tasks`, t),
  events: (id: number) => call<TaskEvent[]>('GET', `/api/tasks/${id}/events`),
  reply: (id: number, text: string) => call('POST', `/api/tasks/${id}/reply`, { text }),
  approveSplit: (id: number, subtasks: Subtask[]) => call('POST', `/api/tasks/${id}/split/approve`, { subtasks }),
  stop: (id: number) => call('POST', `/api/tasks/${id}/stop`),
  retry: (id: number) => call('POST', `/api/tasks/${id}/retry`),
  done: (id: number) => call('POST', `/api/tasks/${id}/done`),
  discard: (id: number) => call('POST', `/api/tasks/${id}/discard`),
  openTerminal: (id: number) => call('POST', `/api/tasks/${id}/open-terminal`),
  merge: (id: number) => call<MergeResult>('POST', `/api/tasks/${id}/merge`),
  permission: (id: string, decision: 'allow' | 'always' | 'deny') => call('POST', `/api/permissions/${id}`, { decision }),
};

// ---------- live stream ----------

export type StreamMessage =
  | { type: 'task'; task: Task }
  | { type: 'event'; event: TaskEvent }
  | { type: 'status'; running: number; maxConcurrent: number };

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

export const MODELS = ['sonnet', 'opus', 'haiku'];
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'manual', 'plan', 'bypassPermissions'];

/** The agent reported done=true and is waiting for your final review; Mark done / Merge moves it to Done. */
export const agentDone = (t: Task) => t.status === 'needs_input' && Boolean(t.checkpoint?.done) && t.permissions.length === 0;

export const needsAttention = (t: Task) =>
  t.permissions.length > 0 || (t.status === 'needs_input' && !agentDone(t)) || t.status === 'split_proposed' || t.status === 'failed';
