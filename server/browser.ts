import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

let cached: string | null | undefined;

/**
 * A Chromium browser agents can run headless to look at the app they're testing: Chrome first (the user's browser),
 * Edge as a fallback (it ships with Windows). Null when neither is found.
 */
export function findBrowser(): string | null {
  if (cached === undefined) cached = candidates().find((p) => p && existsSync(p)) ?? null;
  return cached;
}

function candidates(): (string | null)[] {
  switch (process.platform) {
    case 'win32': {
      const dirs = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
      return [
        appPath('HKCU', 'chrome.exe'), appPath('HKLM', 'chrome.exe'),
        ...dirs.map((d) => join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')),
        appPath('HKLM', 'msedge.exe'),
        ...dirs.map((d) => join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      ];
    }
    case 'darwin':
      return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
    default:
      return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'].map(which);
  }
}

/** Where Windows' "App Paths" registry key says an executable lives (installers register Chrome and Edge there). */
function appPath(hive: 'HKCU' | 'HKLM', exe: string) {
  try {
    const out = execFileSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1].trim().replace(/^"|"$/g, '') ?? null;
  } catch {
    return null;
  }
}

function which(bin: string) {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}
