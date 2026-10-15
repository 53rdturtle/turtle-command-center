// Creates or updates the stable copy of the board: a detached worktree of the current branch with its own
// node_modules and built UI. Run the board you use from there (`npm start`), so merging changes into this
// checkout never restarts it. After the first time, the board's "Update board" button does this for you.
// Usage: npm run stable
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { git, updateTo } from './update.mjs';

const repo = resolve(import.meta.dirname, '..');
const stable = process.env.TCC_STABLE_DIR ?? `${repo}-stable`;
const target = git(['rev-parse', 'HEAD'], repo);

if (!existsSync(stable)) git(['worktree', 'add', '--detach', stable, target], repo);
updateTo(stable, target);

console.log(`\nStable board is at ${target.slice(0, 7)} in ${stable}.`);
console.log(`Start it there with: npm start   (if it's already running, stop it with Ctrl+C first; running agents keep going)`);
