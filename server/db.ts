import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

mkdirSync(DATA_DIR, { recursive: true });
export const DB_PATH = join(DATA_DIR, 'tcc.db');
export const db = new DatabaseSync(DB_PATH);

// Agent-side MCP processes (server/mcp-stdio.mjs) write to this database too.
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 10000;
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  remote TEXT,
  default_model TEXT NOT NULL DEFAULT 'sonnet',
  permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
  always_allow TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  parent_id INTEGER REFERENCES tasks(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  session_id TEXT,
  started INTEGER NOT NULL DEFAULT 0,
  worktree TEXT,
  branch TEXT,
  checkpoint TEXT,
  split TEXT,
  pending_prompt TEXT,
  error TEXT,
  retry_at INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_task ON events(task_id, id);
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_permissions ON permissions(task_id, status);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT, -- from \`claude setup-token\`; NULL runs on whatever account the CLI is logged in to
  limited_until INTEGER, -- hit a usage limit; skipped until then
  created_at INTEGER NOT NULL
);
`);

if (!db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) {
  db.prepare('INSERT INTO accounts (name, token, created_at) VALUES (?, NULL, ?)').run('CLI login', Date.now());
}

// Columns added after v0.1.
const taskColumns = new Set((db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name));
for (const [name, type] of [
  ['rev', 'INTEGER NOT NULL DEFAULT 0'], // bumped on every change so the server can poll for updates
  ['run_ref', 'TEXT'], // the live agent process (JSON from AgentRunner.start)
  ['run_offset', 'INTEGER NOT NULL DEFAULT 0'], // bytes of the run's output log already processed
  ['run_prompt', 'TEXT'], // prompt of the current run, for retrying after a usage limit
  ['merge_state', 'TEXT'], // 'resolving' while the agent resolves merge conflicts; the board then finishes the merge
  ['merge_attempts', 'INTEGER NOT NULL DEFAULT 0'], // automatic conflict-resolution rounds for the current merge
  ['account_id', 'INTEGER'], // account of the current (or last) run
  ['context_tokens', 'INTEGER'], // tokens in the session's context as of its latest model call
  ['context_window', 'INTEGER'], // the model's context window size, reported when a run ends
] as const) {
  if (!taskColumns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
}
db.exec('CREATE INDEX IF NOT EXISTS tasks_by_rev ON tasks(rev)');

export type TaskStatus =
  | 'queued' | 'running' | 'needs_input' | 'split_proposed' | 'split'
  | 'limited' | 'failed' | 'done' | 'discarded';

export interface Checkpoint {
  summary: string;
  details?: string;
  options: { label: string; detail?: string }[];
  done?: boolean;
}
export interface SplitProposal {
  rationale: string;
  subtasks: { title: string; prompt: string }[];
}

export interface ProjectRow {
  id: number; slug: string; name: string; path: string; remote: string | null;
  default_model: string; permission_mode: string; always_allow: string; created_at: number;
}
export interface TaskRow {
  id: number; project_id: number; parent_id: number | null; title: string; description: string;
  status: TaskStatus; model: string; session_id: string | null; started: number;
  worktree: string | null; branch: string | null; checkpoint: string | null; split: string | null;
  pending_prompt: string | null; error: string | null; retry_at: number | null; cost_usd: number;
  created_at: number; updated_at: number;
  rev: number; run_ref: string | null; run_offset: number; run_prompt: string | null;
  merge_state: 'resolving' | null; merge_attempts: number; account_id: number | null;
  context_tokens: number | null; context_window: number | null;
}
export interface AccountRow { id: number; name: string; token: string | null; limited_until: number | null; created_at: number }
export interface EventRow { id: number; task_id: number; ts: number; kind: string; text: string }
export interface PermissionRow {
  id: string; task_id: number; tool_name: string; input: string;
  status: 'pending' | 'allow' | 'always' | 'deny'; message: string | null; created_at: number;
}

export const getProject = (id: number) =>
  db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
export const getProjectBySlug = (slug: string) =>
  db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as ProjectRow | undefined;
export const listProjects = () =>
  db.prepare('SELECT * FROM projects ORDER BY name').all() as unknown as ProjectRow[];

export const getTask = (id: number) =>
  db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
export const listTasks = (projectId: number) =>
  db.prepare(`SELECT * FROM tasks WHERE project_id = ? AND status != 'discarded' ORDER BY id`)
    .all(projectId) as unknown as TaskRow[];
export const tasksWithStatus = (status: TaskStatus) =>
  db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY updated_at').all(status) as unknown as TaskRow[];

/** Every write goes through here (or the equivalent in mcp-stdio.mjs) so `rev` always moves forward. */
export function updateTask(id: number, fields: Partial<TaskRow>) {
  const keys = Object.keys(fields);
  const sets = [...keys.map((k) => `${k} = ?`), 'updated_at = ?', 'rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM tasks)'].join(', ');
  const values = [...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null), Date.now(), id];
  db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...(values as (string | number | null)[]));
}

/** Bookkeeping that the board doesn't display, so it doesn't bump `rev`. */
export const setRunOffset = (id: number, offset: number) =>
  db.prepare('UPDATE tasks SET run_offset = ? WHERE id = ?').run(offset, id);

export function addEvent(taskId: number, kind: string, text: string) {
  db.prepare('INSERT INTO events (task_id, ts, kind, text) VALUES (?, ?, ?, ?)').run(taskId, Date.now(), kind, text);
}
export const listEvents = (taskId: number) =>
  db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id').all(taskId) as unknown as EventRow[];
export const lastEvent = (taskId: number) =>
  db.prepare(`SELECT * FROM events WHERE task_id = ? AND kind IN ('assistant','tool') ORDER BY id DESC LIMIT 1`)
    .get(taskId) as EventRow | undefined;

/** Accounts in failover order: runs use the first one that isn't cooling down from a usage limit. */
export const listAccounts = () => db.prepare('SELECT * FROM accounts ORDER BY id').all() as unknown as AccountRow[];
export const getAccount = (id: number) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;

export const pendingPermissions = (taskId: number) =>
  db.prepare(`SELECT * FROM permissions WHERE task_id = ? AND status = 'pending' ORDER BY created_at`)
    .all(taskId) as unknown as PermissionRow[];
export const getPermission = (id: string) =>
  db.prepare('SELECT * FROM permissions WHERE id = ?').get(id) as PermissionRow | undefined;
