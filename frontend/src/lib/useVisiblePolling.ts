import { useEffect, useRef } from 'react';

/** The longest wait between two tries after errors (the wait doubles after each failure, from `every`, up to this). */
export const MAX_BACKOFF_MS = 10 * 60 * 1000;

/**
 * Light polling for a screen someone is looking at (step 11): `refresh` runs every `every` ms, but ONLY while the tab is visible, and
 * at once when the tab becomes visible again or the window regains focus. It never runs twice at the same time. While `paused()` says
 * so (a drag in progress, a dialog open), a due refresh waits for the next turn instead of running. `refresh` resolves true when it
 * worked; after a failure the wait doubles (up to MAX_BACKOFF_MS) and goes back to `every` after the next success.
 * The refresh itself decides what to show: it should leave the screen alone when nothing changed (no flicker, no lost focus).
 */
export function useVisiblePolling(refresh: () => Promise<boolean>, { every, enabled, paused }: { every: number; enabled: boolean; paused?: () => boolean }) {
  const latest = useRef(refresh);
  latest.current = refresh;
  const isPaused = useRef(paused);
  isPaused.current = paused;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = every;
    let running = false;
    let stopped = false;
    const visible = () => document.visibilityState === 'visible';
    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && visible()) timer = setTimeout(() => void tick(), delay);
    };
    const tick = async () => {
      if (stopped || running) return;
      if (isPaused.current?.()) {
        schedule();
        return;
      }
      running = true;
      let ok = false;
      try {
        ok = await latest.current();
      } catch {
        ok = false;
      }
      running = false;
      delay = ok ? every : Math.min(delay * 2, MAX_BACKOFF_MS);
      schedule();
    };
    const wake = () => {
      if (!visible()) {
        clearTimeout(timer);                // hidden: nothing runs until the tab is back
        return;
      }
      clearTimeout(timer);
      void tick();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [enabled, every]);
}
