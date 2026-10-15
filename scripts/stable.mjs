// Creates or updates the stable copy of the board: a detached worktree of the current branch with its own
// node_modules and built UI. Run the board you use from there (`npm start`), so merging changes into this
// checkout never restarts it. Usage: npm run stable
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const stable = process.env.TCC_STABLE_DIR ?? `${repo}-stable`;
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: cmd === 'npm' });
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const target = git(['rev-parse', '--short', 'HEAD']);
let lockBefore = null;
if (!existsSync(stable)) {
  run('git', ['worktree', 'add', '--detach', stable, 'HEAD'], repo);
} else {
  if (git(['status', '--porcelain'], stable)) {
    console.error(`${stable} has local changes; commit or discard them there first.`);
    process.exit(1);
  }
  lockBefore = readFileSync(resolve(stable, 'package-lock.json'), 'utf8');
  run('git', ['checkout', '--detach', target], stable);
}

// A real install, never a link to this checkout's node_modules: removing a worktree on Windows deletes through links.
const lockChanged = lockBefore !== readFileSync(resolve(stable, 'package-lock.json'), 'utf8');
if (lockChanged || !existsSync(resolve(stable, 'node_modules'))) run('npm', ['ci', '--no-audit', '--no-fund'], stable);
run('npm', ['run', 'build'], stable);

console.log(`\nStable board is at ${target} in ${stable}.`);
console.log(`Start it there with: npm start   (if it's already running, stop it with Ctrl+C first; running agents keep going)`);
