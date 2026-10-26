import type { RunNowPhase } from './useRunNow';

/**
 * What the server is really doing, in words. The API exposes no stages of a run (only queued, running, done or failed), so there is one honest message per
 * state and nothing that pretends to know which step the engine is on.
 */
export const PROGRESS_TEXT: Partial<Record<RunNowPhase, string>> = {
  starting: 'Sending your request to the server…',
  queued: 'Request queued. Waiting for the server to start the run…',
  running: 'Running DSS analysis on the shop’s real data…',
};
export const WEEKLY_TEXT = 'The weekly run is in progress…';

/**
 * The thinking indicator beside the Run now button: a spinner and a sentence, shown from the moment the button is pressed until the run really ends
 * (the page's polling decides that, not a timer). The spinner stops turning for people who ask for reduced motion; the sentence is what carries the meaning.
 * Nothing is drawn when no run is going.
 */
export function RunProgress({ phase, weeklyRunning }: { phase: RunNowPhase; weeklyRunning: boolean }) {
  const text = PROGRESS_TEXT[phase] ?? (weeklyRunning ? WEEKLY_TEXT : null);
  if (!text) return null;
  return (
    <p role="status" aria-live="polite" className="flex min-w-0 items-center gap-2.5 text-sm text-ink" data-testid="run-progress" data-phase={weeklyRunning && !PROGRESS_TEXT[phase] ? 'weekly' : phase}>
      <svg className="size-5 shrink-0 animate-spin text-sage-dark motion-reduce:animate-none" viewBox="0 0 24 24" fill="none" aria-hidden="true" data-testid="run-spinner">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
        <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span className="min-w-0">{text}</span>
    </p>
  );
}
