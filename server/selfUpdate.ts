import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { db } from './db.ts';
import { pauseMerges } from './tasks.ts';

/**
 * "Update board": when this server runs from the stable copy under scripts/serve.mjs, it can move itself to the
 * main checkout's HEAD (where tasks get merged). The launcher does the update while the server is stopped.
 */

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const UPDATE_EXIT_CODE = 75; // keep in sync with scripts/serve.mjs
const STARTED_AT = Date.now();
let updating = false;

const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', ['-C', cwd, ...args], { windowsHide: true })).stdout.trim();

async function mainCheckout() {
  const list = await git(ROOT, 'worktree', 'list', '--porcelain');
  return resolve(list.split('\n')[0].replace(/^worktree /, ''));
}

export async function boardVersion() {
  const base = { startedAt: STARTED_AT, current: await git(ROOT, 'rev-parse', '--short', 'HEAD').catch(() => null) };
  const main = await mainCheckout().catch(() => null);
  // Only the stable copy under the launcher can update itself; `npm run dev` in the main checkout already is the latest.
  if (process.env.TCC_LAUNCHER !== '1' || !main || main.toLowerCase() === ROOT.toLowerCase()) {
    return { ...base, canUpdate: false as const };
  }
  const latest = await git(main, 'rev-parse', 'HEAD');
  const counts = db.prepare(`SELECT
      COUNT(*) FILTER (WHERE merge_state = 'merging') AS merging,
      COUNT(*) FILTER (WHERE merge_state IN ('queued', 'conflicted')) AS queued
    FROM tasks`).get() as { merging: number; queued: number };
  return {
    ...base,
    canUpdate: true as const,
    behind: Number(await git(ROOT, 'rev-list', '--count', `HEAD..${latest}`)),
    updating,
    merges: counts,
    /** Why the last update was rolled back, if it was. */
    lastError: process.env.TCC_UPDATE_ERROR || null,
  };
}

/** Lets the merge in progress finish (queued ones wait for the new version), then exits for the launcher to update. */
export async function startUpdate() {
  const version = await boardVersion();
  if (!version.canUpdate) throw new Error('This board is not running from the stable copy (npm start there), so it cannot update itself');
  if (updating) return;
  updating = true;
  pauseMerges().then(() => setTimeout(() => process.exit(UPDATE_EXIT_CODE), 200));
}
