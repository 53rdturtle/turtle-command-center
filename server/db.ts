import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, DEFAULT_MAX_CONCURRENT } from './config.ts';

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
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT, -- from \`claude setup-token\`; NULL runs on whatever account the CLI is logged in to
  limited_until INTEGER, -- hit a usage limit; skipped until then
  created_at INTEGER NOT NULL
);
-- One row per finished run that reported its usage. The task's totals add up the same numbers.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  log TEXT UNIQUE NOT NULL, -- the run's output log; a run re-read after a restart is recorded only once
  ended_at INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  turns INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  cost_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_by_project ON runs(project_id, ended_at);
CREATE TABLE IF NOT EXISTS task_templates (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, title)
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
  ['merge_state', 'TEXT'], // place in the merge queue: 'queued', 'merging', or 'resolving' while the agent resolves conflicts
  ['merge_attempts', 'INTEGER NOT NULL DEFAULT 0'], // automatic conflict-resolution rounds for the current merge
  ['account_id', 'INTEGER'], // account of the current (or last) run
  ['merge_queued_at', 'INTEGER'], // when Merge was clicked; the merge queue goes in this order
  ['merge_failure', 'TEXT'], // why the last merge didn't land (JSON MergeFailure), until dismissed or retried
  ['context_tokens', 'INTEGER'], // tokens in the session's context as of its latest model call
  ['context_window', 'INTEGER'], // the model's context window size, reported when a run ends
  // Totals over every run that reported its usage (see the runs table).
  ['input_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['output_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['cache_read_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['cache_creation_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['turns', 'INTEGER NOT NULL DEFAULT 0'],
  ['duration_ms', 'INTEGER NOT NULL DEFAULT 0'], // wall time the agent spent running
] as const) {
  if (!taskColumns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
}
db.exec('CREATE INDEX IF NOT EXISTS tasks_by_rev ON tasks(rev)');

const accountColumns = new Set((db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]).map((c) => c.name));
for (const [name, type] of [
  ['usage', 'TEXT'], // last subscription usage the CLI reported (JSON AccountUsage)
  ['usage_at', 'INTEGER'], // when it was reported
] as const) {
  if (!accountColumns.has(name)) db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${type}`);
}

const projectColumns = new Set((db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name));
if (!projectColumns.has('try_command')) db.exec('ALTER TABLE projects ADD COLUMN try_command TEXT'); // "Try it" button; NULL opens a plain shell

export type TaskStatus =
  | 'queued' | 'running' | 'needs_input' | 'split_proposed' | 'split'
  | 'limited' | 'failed' | 'done' | 'discarded';

/** A board button an agent can offer as a checkpoint option; clicking it does the action instead of replying. */
export type BoardAction = 'merge' | 'done' | 'discard';
export interface Checkpoint {
  summary: string;
  details?: string;
  options: { label: string; detail?: string; action?: BoardAction }[];
  done?: boolean;
}
export interface SplitProposal {
  rationale: string;
  subtasks: { title: string; prompt: string; recommended?: boolean }[];
}

export interface ProjectRow {
  id: number; slug: string; name: string; path: string; remote: string | null;
  default_model: string; permission_mode: string; always_allow: string; created_at: number;
  try_command: string | null;
}
export interface TaskRow {
  id: number; project_id: number; parent_id: number | null; title: string; description: string;
  status: TaskStatus; model: string; session_id: string | null; started: number;
  worktree: string | null; branch: string | null; checkpoint: string | null; split: string | null;
  pending_prompt: string | null; error: string | null; retry_at: number | null; cost_usd: number;
  created_at: number; updated_at: number;
  rev: number; run_ref: string | null; run_offset: number; run_prompt: string | null;
  merge_state: MergeState | null; merge_attempts: number; account_id: number | null;
  merge_queued_at: number | null; merge_failure: string | null;
  context_tokens: number | null; context_window: number | null;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number;
  turns: number; duration_ms: number;
}
export type MergeState = 'queued' | 'merging' | 'resolving';
export type MergeFailureReason = 'dirty' | 'detached' | 'in_progress' | 'conflicts' | 'error';
/** `reason` and `files` are missing on failures stored before they existed. */
export interface MergeFailure { target: string; reason?: MergeFailureReason; conflicts: string[]; files?: string[]; message: string }
export interface AccountRow {
  id: number; name: string; token: string | null; limited_until: number | null; created_at: number;
  usage: string | null; usage_at: number | null;
}
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

export interface TemplateRow { id: number; project_id: number; title: string; description: string; created_at: number }
export const listTemplates = (projectId: number) =>
  db.prepare('SELECT * FROM task_templates WHERE project_id = ? ORDER BY title COLLATE NOCASE').all(projectId) as unknown as TemplateRow[];
/** Saving under an existing title replaces that template's description. */
export const saveTemplate = (projectId: number, title: string, description: string) =>
  db.prepare(`INSERT INTO task_templates (project_id, title, description, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, title) DO UPDATE SET description = excluded.description`).run(projectId, title, description, Date.now());
export const deleteTemplate = (projectId: number, id: number) =>
  db.prepare('DELETE FROM task_templates WHERE id = ? AND project_id = ?').run(id, projectId);

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

export function getMaxConcurrent() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'max_concurrent'`).get() as { value: string } | undefined;
  return row ? Number(row.value) : DEFAULT_MAX_CONCURRENT;
}
export const saveMaxConcurrent = (n: number) =>
  db.prepare(`INSERT INTO settings (key, value) VALUES ('max_concurrent', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(String(n));
