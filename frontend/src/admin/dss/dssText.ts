/** Words and display formats for the DSS screens. Display only: nothing here works out a figure. */

export const REAL_BADGE = 'REAL DATA';
export const SIMULATED_BADGE = 'SIMULATED DATA';

export const TRIGGER_LABEL: Record<string, string> = { cron: 'Weekly schedule', manual: 'Run now', import: 'Imported bundle' };

const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
/** "26 Oct 2026, 14:07" in Manila time, for an ISO time from the server. */
export function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${when.format(date)} (Manila)`;
}

/** The server's whole-day age as words. */
export function ageText(days: number | null): string {
  if (days === null) return 'age unknown';
  if (days === 0) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** "not_enough_history" as "Not enough history": the engine's own status words, made readable (no wording of ours is added). */
export function humanise(code: string): string {
  const text = code.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A part's status for display: "ok" as OK, a reason such as "not_enough_history" as words, nothing as a dash. */
export function partText(code: string | null): string {
  return code === null ? '—' : code === 'ok' ? 'OK' : humanise(code);
}

/** How long a run took, as the server measured it. */
export function durationText(seconds: number | null): string {
  return seconds === null ? '—' : `${seconds} s`;
}
