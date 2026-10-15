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

/**
 * Opens a new terminal window in `cwd` with `env` added to its environment, running `command`
 * (a shell command line, kept open afterwards) or just a shell when it's empty.
 */
export function openShellTerminal(cwd: string, title: string, command: string | null, env: Record<string, string>) {
  switch (process.platform) {
    case 'win32': {
      // `start` passes our environment on to the new window. cmd strips the outer quotes of `/k "..."` and runs the rest.
      const safeTitle = title.replace(/["%^&|<>]/g, '');
      const line = `/c start "${safeTitle}" /D "${cwd}" cmd /k${command ? ` "${command}"` : ''}`;
      return launch('cmd.exe', [line], { windowsVerbatimArguments: true, env });
    }
    case 'darwin': {
      // Terminal.app starts a fresh login shell, so the environment has to be part of the script.
      const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
      const exports = Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`).join('; ');
      const sh = `cd ${q(cwd)}; ${exports}${command ? `; ${command}` : ''}`;
      const script = `tell application "Terminal" to do script "${sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\ntell application "Terminal" to activate`;
      return launch('osascript', ['-e', script]);
    }
    default: {
      const args = command ? ['-e', 'sh', '-c', `${command}; exec "\${SHELL:-sh}"`] : [];
      return launch('x-terminal-emulator', args, { cwd, env });
    }
  }
}

function launch(cmd: string, args: string[], opts: { cwd?: string; windowsVerbatimArguments?: boolean; env?: Record<string, string> } = {}) {
  return new Promise<void>((resolve, reject) => {
    const env = opts.env && { ...process.env, ...opts.env };
    const child = spawn(cmd, args, { ...opts, env, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', (err) => reject(new Error(`Could not open a terminal: ${err.message}`)));
    child.once('spawn', () => (child.unref(), resolve()));
  });
}
