import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { DATA_DIR } from './config.ts';
import type { MergeFailureReason } from './db.ts';

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
 * nothing is merged, leaving the user's checkout as it was.
 */
export async function mergeTaskBranch(repo: string, worktree: string, branch: string, taskId: number, message: string): Promise<MergeResult> {
  const target = (await currentBranch(repo)) ?? 'HEAD';
  const blocker = await checkoutBlocker(repo);
  if (blocker) return { ok: false, target, ...blocker };
  if ((await git(worktree, 'status', '--porcelain')) !== '') {
    await git(worktree, 'add', '-A');
    await git(worktree, 'commit', '-m', `tcc: uncommitted work from task #${taskId}`);
  }
  // Find conflicts in memory first. A conflicting `git merge` writes conflict markers into the checkout, and when
  // the project is this app, that restarts the dev server before the merge can be aborted or reported.
  try {
    await git(repo, 'merge-tree', '--write-tree', '--name-only', 'HEAD', branch);
  } catch (err: any) {
    // Exit code 1 means conflicts. stdout is the tree id, the conflicted paths, a blank line, then git's messages.
    if (err.code !== 1) throw err;
    const [files, messages = ''] = String(err.stdout).split(/\r?\n\r?\n/);
    return { ok: false, target, reason: 'conflicts', conflicts: files.split(/\r?\n/).slice(1).filter(Boolean), files: [], message: messages.trim() };
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

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  /** Unified diff for this file; null when it was cut off by the size cap. */
  patch: string | null;
}

export interface TaskDiff {
  target: string;
  base: string;
  files: DiffFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

const DIFF_CAP = 500 * 1024;

/**
 * What the task changed relative to its merge base with the main checkout's branch,
 * including uncommitted and untracked files. Untracked files are staged into a throwaway
 * copy of the index so the agent's real index is never touched.
 */
export async function taskDiff(repo: string, worktree: string): Promise<TaskDiff> {
  if (!existsSync(worktree)) throw new Error(`Worktree ${worktree} no longer exists`);
  const target = (await currentBranch(repo)) ?? 'HEAD';
  const targetSha = await git(repo, 'rev-parse', 'HEAD');
  const base = await git(worktree, 'merge-base', 'HEAD', targetSha);

  const indexPath = resolve(worktree, await git(worktree, 'rev-parse', '--git-path', 'index'));
  const tmp = mkdtempSync(join(tmpdir(), 'tcc-diff-'));
  const tmpIndex = join(tmp, 'index');
  try {
    if (existsSync(indexPath)) copyFileSync(indexPath, tmpIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const run = async (...args: string[]) =>
      (await exec('git', ['-C', worktree, ...args], { windowsHide: true, env, maxBuffer: 256 * 1024 * 1024 })).stdout;
    await run('add', '-A');
    const diffArgs = ['diff', '--cached', '-M', '--no-color', '--no-ext-diff', base];
    const [nameStatus, numstat, patch] = await Promise.all([
      run(...diffArgs, '--name-status', '-z'),
      run(...diffArgs, '--numstat', '-z'),
      run(...diffArgs),
    ]);

    const files: DiffFile[] = [];
    const ns = nameStatus.split('\0');
    for (let i = 0; i < ns.length && ns[i]; ) {
      const status = ns[i++];
      if (status.startsWith('R') || status.startsWith('C')) files.push({ status: status[0], oldPath: ns[i++], path: ns[i++], additions: null, deletions: null, patch: null });
      else files.push({ status, path: ns[i++], additions: null, deletions: null, patch: null });
    }
    // numstat -z: "add\tdel\tpath\0", or "add\tdel\t\0old\0new\0" for renames; same order as name-status.
    const nm = numstat.split('\0');
    for (let i = 0, f = 0; i < nm.length && nm[i] && f < files.length; f++) {
      const [add, del, path] = nm[i++].split('\t');
      if (!path) i += 2;
      files[f].additions = add === '-' ? null : Number(add);
      files[f].deletions = del === '-' ? null : Number(del);
    }

    const chunks = patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
    let size = 0;
    let truncated = false;
    // Over the cap, skip the oversized file but keep going so smaller files still show.
    chunks.forEach((chunk, i) => {
      if (!files[i]) return;
      if (size + chunk.length > DIFF_CAP) {
        truncated = true;
      } else {
        size += chunk.length;
        files[i].patch = chunk;
      }
    });

    return {
      target, base, files, truncated,
      additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
