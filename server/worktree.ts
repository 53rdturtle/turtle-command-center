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

export async function currentBranch(repo: string) {
  try {
    return await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  } catch {
    return null;
  }
}

/** Whether merging would bring anything in: commits the checkout lacks, or uncommitted edits (merge commits those first). */
export async function hasWorkToMerge(repo: string, worktree: string, branch: string) {
  if ((await git(worktree, 'status', '--porcelain')) !== '') return true;
  return Number(await git(repo, 'rev-list', '--count', `HEAD..${branch}`)) > 0;
}

export type MergeResult =
  | { ok: true; target: string }
  | { ok: false; target: string; conflicts: string[]; message: string };

/**
 * Merges a task branch into whatever branch the main checkout is on.
 * On conflicts the merge is aborted, leaving the user's checkout as it was.
 */
export async function mergeTaskBranch(repo: string, worktree: string, branch: string, taskId: number, message: string): Promise<MergeResult> {
  if ((await git(worktree, 'status', '--porcelain')) !== '') {
    await git(worktree, 'add', '-A');
    await git(worktree, 'commit', '-m', `tcc: uncommitted work from task #${taskId}`);
  }
  const target = (await currentBranch(repo)) ?? 'HEAD';
  try {
    await git(repo, 'merge', '--no-ff', '-m', message, branch);
  } catch (err: any) {
    const conflicts = (await git(repo, 'diff', '--name-only', '--diff-filter=U').catch(() => ''))
      .split('\n').filter(Boolean);
    if (conflicts.length) await git(repo, 'merge', '--abort').catch(() => {});
    const detail = String(err.stderr || err.stdout || err.message).trim();
    return { ok: false, target, conflicts, message: detail };
  }
  await git(repo, 'worktree', 'remove', '--force', worktree);
  await git(repo, 'branch', '-d', branch).catch(() => {});
  return { ok: true, target };
}

/** Whether a "Merge task #N" commit made by mergeTaskBranch is in the checkout's history. */
export async function wasMerged(repo: string, taskId: number) {
  return (await git(repo, 'log', '-1', '--format=%H', `--grep=^Merge task #${taskId}:`, 'HEAD').catch(() => '')) !== '';
}

/** Re-creates a task's worktree at its old path from its branch. False if the branch is gone. */
export async function restoreWorktree(repo: string, path: string, branch: string) {
  try {
    await git(repo, 'rev-parse', '--verify', `refs/heads/${branch}`);
  } catch {
    return false;
  }
  await git(repo, 'worktree', 'prune');
  await git(repo, 'worktree', 'add', path, branch);
  return true;
}

export async function discardWorktree(repo: string, path: string, branch: string) {
  await git(repo, 'worktree', 'remove', '--force', path).catch(() => {});
  await git(repo, 'branch', '-D', branch).catch(() => {});
}
