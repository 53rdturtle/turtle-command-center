// Shared by scripts/stable.mjs (create/update the stable copy) and scripts/serve.mjs (update between restarts).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const npm = (args, cwd) => execFileSync('npm', args, { cwd, stdio: 'inherit', shell: true });

/** The repo's main worktree: where the board merges tasks, so its HEAD is the latest version. */
export const mainCheckout = (cwd) => resolve(git(['worktree', 'list', '--porcelain'], cwd).split('\n')[0].replace(/^worktree /, ''));

const readLock = (dir) => (existsSync(resolve(dir, 'package-lock.json')) ? readFileSync(resolve(dir, 'package-lock.json'), 'utf8') : null);

/** Moves a checkout to `ref` (detached), installs dependencies if they changed, and builds the UI. */
export function updateTo(dir, ref) {
  if (git(['status', '--porcelain'], dir)) throw new Error(`${dir} has local changes; commit or discard them there first.`);
  const lockBefore = readLock(dir);
  git(['checkout', '--quiet', '--detach', ref], dir);
  // A real install, never a link to another checkout's node_modules: removing a worktree on Windows deletes through links.
  if (lockBefore !== readLock(dir) || !existsSync(resolve(dir, 'node_modules'))) npm(['ci', '--no-audit', '--no-fund'], dir);
  npm(['run', 'build'], dir);
}
