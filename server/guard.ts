import type { MiddlewareHandler } from 'hono';
import { DEV_PORT, PORT } from './config.ts';

// The board is only meant for the browser on this machine. These checks stop other websites from driving it:
// - Host must be a loopback name, which defeats DNS rebinding (a rebound attacker domain keeps its own Host).
// - Mutating requests need JSON plus a custom header. Browsers can't send either cross-origin without a CORS
//   preflight, and this server never approves one. Origin, when present, must be the board itself.
const PORTS = [PORT, DEV_PORT];
const HOSTS = ['localhost', '127.0.0.1'].flatMap((h) => PORTS.map((p) => `${h}:${p}`));
const ORIGINS = HOSTS.map((h) => `http://${h}`);

export const localOnly: MiddlewareHandler = async (c, next) => {
  const host = c.req.header('host')?.toLowerCase();
  if (!host || !HOSTS.includes(host)) return c.json({ error: 'Forbidden host' }, 403);

  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (origin && !ORIGINS.includes(origin.toLowerCase())) return c.json({ error: 'Forbidden origin' }, 403);
    if (c.req.header('x-tcc') !== '1') return c.json({ error: 'Missing X-TCC header' }, 403);
    const type = c.req.header('content-type')?.split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return c.json({ error: 'Content-Type must be application/json' }, 403);
  }
  await next();
};
