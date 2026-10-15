import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DATA_DIR } from './config.ts';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { windowsHide: true });
  return stdout.trim();
}

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';

export async function isGitRepoWithCommits(path: string) {
  try {
    await git(path, 'rev-parse', '--verify', 'HEAD');
    return true;
  } catch {
    return false;
  }
}

export async function getRemote(path: string) {
  try {
    return await git(path, 'remote', 'get-url', 'origin');
  } catch {
    return null;
  }
}

/**
 * Gives each task its own worktree + branch so parallel agents never edit the same files.
 * Falls back to the repo itself when it isn't a git repo with at least one commit.
 */
export async function createWorktree(repo: string, projectSlug: string, taskId: number, title: string, baseRef = 'HEAD') {
  if (!(await isGitRepoWithCommits(repo))) return { path: repo, branch: null };
  const name = `${taskId}-${slugify(title)}`;
  const branch = `tcc/${name}`;
  const dir = join(DATA_DIR, 'worktrees', projectSlug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  await git(repo, 'worktree', 'add', '-b', branch, path, baseRef);
  return { path, branch };
}

/** Commits anything left uncommitted so removing the worktree never loses work. */
export async function saveAndRemoveWorktree(repo: string, path: string, taskId: number) {
  if ((await git(path, 'status', '--porcelain')) !== '') {
    await git(path, 'add', '-A');
    await git(path, 'commit', '-m', `tcc: uncommitted work from task #${taskId}`);
  }
  await git(repo, 'worktree', 'remove', '--force', path);
}

export async function discardWorktree(repo: string, path: string, branch: string) {
  await git(repo, 'worktree', 'remove', '--force', path).catch(() => {});
  await git(repo, 'branch', '-D', branch).catch(() => {});
}
