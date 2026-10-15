import { spawn } from 'node:child_process';
import { CLAUDE_BIN } from './config.ts';

/**
 * Opens a new terminal window on the machine running the server, in `cwd`, running `claude --resume`.
 * Only meaningful while the server runs locally.
 */
export function openResumeTerminal(cwd: string, sessionId: string, title: string) {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error('Invalid session id');
  switch (process.platform) {
    case 'win32': {
      // Build the command line ourselves: Node's argument quoting doesn't match what `start` and `cmd /k` expect.
      // `cmd /k ""bin" args"` survives cmd's quote stripping even when the bin path has spaces.
      const safeTitle = title.replace(/["%^&|<>]/g, '');
      const line = `/c start "${safeTitle}" /D "${cwd}" cmd /k ""${CLAUDE_BIN}" --resume ${sessionId}"`;
      return launch('cmd.exe', [line], { windowsVerbatimArguments: true });
    }
    case 'darwin': {
      const sh = `cd '${cwd.replace(/'/g, `'\\''`)}' && ${CLAUDE_BIN} --resume ${sessionId}`;
      const script = `tell application "Terminal" to do script "${sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\ntell application "Terminal" to activate`;
      return launch('osascript', ['-e', script]);
    }
    default:
      return launch('x-terminal-emulator', ['-e', CLAUDE_BIN, '--resume', sessionId], { cwd });
  }
}

function launch(cmd: string, args: string[], opts: { cwd?: string; windowsVerbatimArguments?: boolean } = {}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', (err) => reject(new Error(`Could not open a terminal: ${err.message}`)));
    child.once('spawn', () => (child.unref(), resolve()));
  });
}
