import type { RunTotals } from './api.ts';

export const kTokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

/** Tokens the runs actually added: every turn re-reads the whole context from cache, so cache reads
 *  grow with turns × context size and would swamp the label while weighing little against usage limits. */
export const freshTokens = (u: RunTotals) => u.inputTokens + u.outputTokens + u.cacheCreationTokens;

/** e.g. "45s", "12m", "1h 05m". */
export function duration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Tooltip lines explaining the label's number. */
export const usageBreakdown = (u: RunTotals) => [
  `${kTokens(freshTokens(u))} tokens: ${kTokens(u.inputTokens)} input, ${kTokens(u.outputTokens)} output, ` +
    `${kTokens(u.cacheCreationTokens)} cache write`,
  `plus ${kTokens(u.cacheReadTokens)} cache read (context re-read each turn; cheap against limits)`,
  `${u.turns} turn${u.turns === 1 ? '' : 's'}, ${duration(u.durationMs)} of agent time`,
];
