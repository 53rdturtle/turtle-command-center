import { existsSync, openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { getProject, getTask } from './db.ts';

// Files an agent mentions in its reports (e.g. `docs/plan.md`), opened from the board. They're read
// from the task's worktree, or the project's checkout once the worktree is gone (merged or done).

const MAX_TEXT = 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
};

/** Resolves a path an agent wrote (relative, absolute, or with a `:line` suffix) to a file inside the task's folder. */
function locate(taskId: number, raw: string) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  const project = getProject(task.project_id)!;
  const root = task.worktree && existsSync(task.worktree) ? task.worktree : project.path;
  const path = (raw ?? '').trim().replace(/:\d+(?::\d+|-\d+)?$/, '');
  if (!path) throw new Error('No path given');
  const candidates = isAbsolute(path) ? [path] : [resolve(root, path)];
  // An absolute path into the old worktree still means the same file in the project's checkout.
  if (isAbsolute(path) && task.worktree && root !== task.worktree) {
    const rel = relative(task.worktree, path);
    if (!rel.startsWith('..') && !isAbsolute(rel)) candidates.push(resolve(root, rel));
  }
  const realRoot = realpathSync(root);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const rel = relative(realRoot, realpathSync(file));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${raw} is outside this task's folder`);
    if (rel.split(/[\\/]/)[0] === '.git') throw new Error('Files inside .git are not shown');
    if (!statSync(file).isFile()) throw new Error(`${raw} is not a file`);
    return { file, rel: rel.replaceAll('\\', '/'), size: statSync(file).size };
  }
  throw new Error(`${path} doesn't exist in this task's ${root === task.worktree ? 'worktree' : 'project folder'}`);
}

function readHead(file: string, max: number) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(max, statSync(file).size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export type TaskFile =
  | { path: string; size: number; kind: 'image' }
  | { path: string; size: number; kind: 'binary' }
  | { path: string; size: number; kind: 'text'; text: string; truncated: boolean };

export function taskFile(taskId: number, raw: string): TaskFile {
  const { file, rel, size } = locate(taskId, raw);
  if (IMAGE_TYPES[extname(file).toLowerCase()]) return { path: rel, size, kind: 'image' };
  const head = readHead(file, MAX_TEXT);
  if (head.subarray(0, 8000).includes(0)) return { path: rel, size, kind: 'binary' };
  return { path: rel, size, kind: 'text', text: head.toString('utf8'), truncated: size > MAX_TEXT };
}

export function taskImage(taskId: number, raw: string) {
  const { file, size } = locate(taskId, raw);
  const type = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!type) throw new Error('Not an image');
  if (size > MAX_IMAGE) throw new Error('Image is larger than 20 MB');
  return { bytes: readHead(file, MAX_IMAGE), type };
}
