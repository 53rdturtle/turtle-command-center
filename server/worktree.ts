import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
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

export type MergeFailureReason = 'dirty' | 'detached' | 'in_progress' | 'conflicts' | 'error';

export type MergeResult =
  | { ok: true; target: string }
  | { ok: false; target: string; reason: MergeFailureReason; conflicts: string[]; files: string[]; message: string };

const IN_PROGRESS: [string, string][] = [
  ['MERGE_HEAD', 'a merge'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
];

/** Why the main checkout can't safely take a merge right now, or null if it can. */
async function checkoutBlocker(repo: string): Promise<Omit<Extract<MergeResult, { ok: false }>, 'ok' | 'target'> | null> {
  for (const [name, what] of IN_PROGRESS) {
    if (existsSync(resolve(repo, await git(repo, 'rev-parse', '--git-path', name)))) {
      return { reason: 'in_progress', conflicts: [], files: [], message: `Your checkout is in the middle of ${what}. Finish or abort it first.` };
    }
  }
  if ((await currentBranch(repo)) === 'HEAD') {
    return { reason: 'detached', conflicts: [], files: [], message: 'Your checkout has a detached HEAD. Check out a branch first.' };
  }
  // Not via git(): trimming would eat the leading status column of the first line.
  const { stdout } = await exec('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no'], { windowsHide: true });
  const files = stdout.split('\n').filter(Boolean).map((line) => line.slice(3).replace(/^.* -> /, ''));
  if (files.length) {
    return { reason: 'dirty', conflicts: [], files, message: 'Your checkout has uncommitted changes. Commit or stash them first.' };
  }
  return null;
}

/**
 * Merges a task branch into whatever branch the main checkout is on.
 * Refuses if that checkout is dirty, detached or mid-operation; on conflicts
 * the merge is aborted, leaving the user's checkout as it was.
 */
export async function mergeTaskBranch(repo: string, worktree: string, branch: string, taskId: number, message: string): Promise<MergeResult> {
  const target = (await currentBranch(repo)) ?? 'HEAD';
  const blocker = await checkoutBlocker(repo);
  if (blocker) return { ok: false, target, ...blocker };
  if ((await git(worktree, 'status', '--porcelain')) !== '') {
    await git(worktree, 'add', '-A');
    await git(worktree, 'commit', '-m', `tcc: uncommitted work from task #${taskId}`);
  }
  try {
    await git(repo, 'merge', '--no-ff', '-m', message, branch);
  } catch (err: any) {
    const conflicts = (await git(repo, 'diff', '--name-only', '--diff-filter=U').catch(() => ''))
      .split('\n').filter(Boolean);
    if (conflicts.length) await git(repo, 'merge', '--abort').catch(() => {});
    const detail = String(err.stderr || err.stdout || err.message).trim();
    return { ok: false, target, reason: conflicts.length ? 'conflicts' : 'error', conflicts, files: [], message: detail };
  }
  await git(repo, 'worktree', 'remove', '--force', worktree);
  await git(repo, 'branch', '-d', branch).catch(() => {});
  return { ok: true, target };
}

export async function discardWorktree(repo: string, path: string, branch: string) {
  await git(repo, 'worktree', 'remove', '--force', path).catch(() => {});
  await git(repo, 'branch', '-D', branch).catch(() => {});
}
