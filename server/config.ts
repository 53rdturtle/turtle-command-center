import { homedir } from 'node:os';
import { join } from 'node:path';

// `npm run dev` gets its own port and data, so developing the board never restarts or shares a database with
// the board you use, which runs from a separate stable copy (`npm run stable`). npm sets this for both dev processes.
const DEV = process.env.npm_lifecycle_event === 'dev';

export const PORT = Number(process.env.TCC_PORT ?? (DEV ? 7778 : 7777));
// Vite dev server port; the API accepts it as an Origin for requests proxied from it (see vite.config.ts).
export const DEV_PORT = 5173;
export const DATA_DIR = process.env.TCC_DATA_DIR ?? join(homedir(), DEV ? '.turtle-cc-dev' : '.turtle-cc');
// Pro plan usage limits are shared across every session. The board can override this (settings table).
export const DEFAULT_MAX_CONCURRENT = Number(process.env.TCC_MAX_CONCURRENT ?? 5);
export const CLAUDE_BIN = process.env.TCC_CLAUDE_BIN ?? 'claude';
// How long to wait before retrying a task that hit a usage limit.
export const LIMIT_RETRY_MS = 30 * 60 * 1000;
