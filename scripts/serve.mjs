// `npm start`: runs the board and restarts it after an "Update board" click. The server exits with
// UPDATE_EXIT_CODE once no merge is running; this moves the checkout to the main checkout's HEAD, installs and
// builds, then starts it again. If that fails, it goes back to the previous version and reports why.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { git, mainCheckout, updateTo } from './update.mjs';

const UPDATE_EXIT_CODE = 75; // keep in sync with server/selfUpdate.ts
const root = resolve(import.meta.dirname, '..');
let updateError = '';

function start() {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, TCC_LAUNCHER: '1', TCC_UPDATE_ERROR: updateError },
  });
  child.on('exit', (code) => {
    if (code !== UPDATE_EXIT_CODE) process.exit(code ?? 1);
    updateError = '';
    const previous = git(['rev-parse', 'HEAD'], root);
    try {
      const target = git(['rev-parse', 'HEAD'], mainCheckout(root));
      console.log(`\n[update] ${previous.slice(0, 7)} -> ${target.slice(0, 7)}`);
      updateTo(root, target);
    } catch (err) {
      updateError = String(err?.message ?? err).slice(0, 2000);
      console.error(`[update] failed, going back to ${previous.slice(0, 7)}:`, updateError);
      try {
        updateTo(root, previous);
      } catch (err2) {
        console.error('[update] restoring the previous version failed too:', err2);
      }
    }
    start();
  });
}

start();
