import { useSyncExternalStore } from 'react';

/** Compact elapsed time: "just now", "12m", "3h", "2d". */
export const elapsed = (ms: number, now = Date.now()) => {
  const min = Math.round((now - ms) / 60_000);
  return min < 1 ? 'just now' : min < 60 ? `${min}m` : min < 48 * 60 ? `${Math.round(min / 60)}h` : `${Math.round(min / 1440)}d`;
};

export const ago = (ms: number, now = Date.now()) => {
  const e = elapsed(ms, now);
  return e === 'just now' ? e : `${e} ago`;
};

// One interval for the whole page, started while anything is subscribed.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Current time, re-rendering the caller once a minute off a single shared timer. */
export const useNow = () => useSyncExternalStore(subscribe, () => now);
