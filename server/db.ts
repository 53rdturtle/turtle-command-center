import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(join(DATA_DIR, 'tcc.db'));

db.exec(`
PRAGMA journal_mode = WAL;
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
`);

export type TaskStatus =
  | 'queued' | 'running' | 'needs_input' | 'split_proposed' | 'split'
  | 'limited' | 'failed' | 'done' | 'discarded';

export interface Checkpoint {
  summary: string;
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
}
export interface EventRow { id: number; task_id: number; ts: number; kind: string; text: string }

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

export function updateTask(id: number, fields: Partial<TaskRow>) {
  const keys = Object.keys(fields);
  const sets = [...keys.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ');
  const values = [...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null), Date.now(), id];
  db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...(values as (string | number | null)[]));
}

export function addEvent(taskId: number, kind: string, text: string): EventRow {
  const ts = Date.now();
  const r = db.prepare('INSERT INTO events (task_id, ts, kind, text) VALUES (?, ?, ?, ?)').run(taskId, ts, kind, text);
  return { id: Number(r.lastInsertRowid), task_id: taskId, ts, kind, text };
}
export const listEvents = (taskId: number) =>
  db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id').all(taskId) as unknown as EventRow[];
export const lastEvent = (taskId: number) =>
  db.prepare(`SELECT * FROM events WHERE task_id = ? AND kind IN ('assistant','tool') ORDER BY id DESC LIMIT 1`)
    .get(taskId) as EventRow | undefined;
