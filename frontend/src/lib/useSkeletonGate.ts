import { useEffect, useRef, useState } from 'react';
import { MIN_SKELETON_MS, SHOW_DELAY_MS } from './skeletonTiming';

/**
 * What a loading page should show right now:
 *  - 'content'  the real thing (not loading; or loaded and the skeleton, if it was ever shown, has been up long enough);
 *  - 'wait'     loading, but not for SHOW_DELAY_MS yet: render the skeleton INVISIBLY, so the page already has its final size;
 *  - 'skeleton' loading, and past the delay (or held for its minimum time after the data arrived): render the skeleton visibly.
 *
 * The rule (see lib/skeletonTiming.ts for the numbers):
 *  - Data ready before the delay: 'wait' for a moment, then 'content'. No skeleton was ever visible.
 *  - Data ready on the first render (cached): 'content' at once, no state change.
 *  - Once the skeleton has been visible, 'skeleton' lasts at least minMs counted from its first appearance, even if the data came sooner.
 *  - `immediate` (an error, an empty result) skips that minimum: those must not make anybody wait.
 *
 * Hand-off from a lazy route's Suspense fallback (RouteFallback passes `fallback: true`) to the page it was standing in for: while the
 * fallback is on screen, or within a moment of it going, the page that takes over and starts its own loading begins already visible, and its
 * minimum counts from the FIRST appearance. Without it the delay would run twice and the page would flash blank between the two skeletons.
 * Only a fallback hands over: a visitor who clicks away from a page whose skeleton is up gets the next page's normal rule (no skeleton at
 * all if its data is quick).
 */
export type Gate = 'content' | 'wait' | 'skeleton';

interface Options {
  /** the loading is over because of an error or an empty answer: show that now, with no minimum */
  immediate?: boolean;
  /** this is a lazy route's Suspense fallback: the page that replaces it carries on from it (see above) */
  fallback?: boolean;
  delayMs?: number;
  minMs?: number;
}

// ---- the hand-off: how many route FALLBACKS are visible right now, when the first of them appeared, and when the last one left. A page that
// starts loading while one is up, or within GRACE_MS of the last one leaving (the page that takes over registers a moment AFTER the
// fallback it replaces is gone), carries on from it.
const GRACE_MS = 100;
let visible = 0;
let since = 0;
let goneAt: number | null = null;
function skeletonShown(): number {
  const now = Date.now();
  if (visible === 0 && !(goneAt !== null && now - goneAt >= 0 && now - goneAt <= GRACE_MS)) since = now;
  visible += 1;
  goneAt = null;
  return since;
}
function skeletonGone(): void {
  visible = Math.max(0, visible - 1);
  if (visible === 0) goneAt = Date.now();
}
/** Tests only: forget every skeleton (a test that ends with one on screen must not hand it over to the next test). */
export function resetSkeletonHandoff(): void {
  visible = 0;
  since = 0;
  goneAt = null;
}
function handedOver(): number | null {
  if (visible > 0) return since;
  const gap = goneAt === null ? -1 : Date.now() - goneAt;
  return gap >= 0 && gap <= GRACE_MS ? since : null;
}

export function useSkeletonGate(loading: boolean, { immediate = false, fallback = false, delayMs = SHOW_DELAY_MS, minMs = MIN_SKELETON_MS }: Options = {}): Gate {
  // has this load's skeleton become visible?
  const [shown, setShown] = useState(() => loading && (delayMs === 0 || handedOver() !== null));
  const [, tick] = useState(0);
  const shownAt = useRef<number | null>(null);
  const registered = useRef(false);

  const reveal = () => {
    if (!registered.current) {
      registered.current = true;
      // a fallback registers itself for the hand-off; a page takes the first appearance of the fallback it replaces, if there was one
      shownAt.current = fallback ? skeletonShown() : (handedOver() ?? Date.now());
    }
    setShown(true);
  };
  const release = () => {
    if (registered.current) {
      registered.current = false;
      if (fallback) skeletonGone();
    }
    shownAt.current = null;
    setShown(false);
  };

  // loading starts: after the delay, show the skeleton (at once if a skeleton is already on screen, or the delay is 0)
  useEffect(() => {
    if (!loading) return;
    if (shown) {
      if (!registered.current) reveal(); // began visible: count it
      return;
    }
    const timer = setTimeout(reveal, delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // loading ends: leave when the minimum is over (at once if it never showed, or `immediate`)
  useEffect(() => {
    if (loading || !shown) return;
    const left = immediate || shownAt.current === null ? 0 : minMs - Math.max(0, Date.now() - shownAt.current);
    if (left <= 0) {
      release();
      return;
    }
    const timer = setTimeout(() => {
      release();
      tick((n) => n + 1);
    }, left);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, immediate, shown]);

  useEffect(
    () => () => {
      if (registered.current && fallback) skeletonGone();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (loading) return shown ? 'skeleton' : delayMs === 0 ? 'skeleton' : 'wait';
  if (!shown) return 'content';
  if (immediate) return 'content';
  const elapsed = shownAt.current === null ? Infinity : Date.now() - shownAt.current;
  return elapsed >= 0 && elapsed < minMs ? 'skeleton' : 'content';
}
