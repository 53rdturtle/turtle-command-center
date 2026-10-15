import type { RunTotals } from './api.ts';

export const kTokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

export const totalTokens = (u: RunTotals) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;

/** e.g. "45s", "12m", "1h 05m". */
export function duration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Tooltip lines. Cache reads dominate the total but weigh far less against usage limits than fresh input and output. */
export const usageBreakdown = (u: RunTotals) => [
  `${kTokens(totalTokens(u))} tokens: ${kTokens(u.inputTokens)} input, ${kTokens(u.outputTokens)} output, ` +
    `${kTokens(u.cacheCreationTokens)} cache write, ${kTokens(u.cacheReadTokens)} cache read`,
  `${u.turns} turn${u.turns === 1 ? '' : 's'}, ${duration(u.durationMs)} of agent time`,
];
