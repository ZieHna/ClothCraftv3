/**
 * Step B: every number that decides WHEN a loading skeleton shows lives here, and nowhere else.
 *
 * VITE_SKELETON_INSTANT=1 (an environment variable read when the app is BUILT or when Vitest starts) makes all three delays 0: a skeleton
 * is shown at once and gone at once. It is set for the unit tests (vite.config.ts) and for the build the existing real-mode scripts run
 * against, so they never wait for a skeleton. scripts/check-skeleton.mjs runs against the normal build, with the real numbers.
 */
const instant = import.meta.env.VITE_SKELETON_INSTANT === '1';

/** Data that arrives sooner than this shows no skeleton at all. */
export const SHOW_DELAY_MS = instant ? 0 : 150;
/** Once a skeleton has appeared on a shop page, it stays at least this long, so it never flickers. */
export const MIN_SKELETON_MS = instant ? 0 : 600;
/** The same, for the staff dashboard (a working tool: shorter). */
export const STAFF_MIN_SKELETON_MS = instant ? 0 : 300;
/** The fade-in of a new page (src/index.css .page-fade uses the same number). */
export const PAGE_FADE_MS = 180;
