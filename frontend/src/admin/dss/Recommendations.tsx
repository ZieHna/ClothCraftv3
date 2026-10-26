import { useId } from 'react';
import { KindBadge } from './RunBanner';
import type { Recommendation, Tone } from './recommendationRules';

const TONE_LABEL: Record<Tone, string> = { attention: 'Needs attention', info: 'For your information', 'needs-info': 'More information needed' };
const TONE_BORDER: Record<Tone, string> = { attention: 'border-2 border-ink', info: 'border border-tan', 'needs-info': 'border-2 border-dashed border-brown-dark' };

/**
 * "Recommended actions based on the forecast": each card has what the data shows, what to consider doing and why. Decision support only: nothing here places an
 * order or changes stock, and a card limited by missing data says so. The tone is a word and a border style, never colour alone.
 */
export function Recommendations({ items, subject, simulated }: { items: Recommendation[]; subject: string; simulated: boolean }) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className="min-w-0" data-testid="recommendations">
      <h3 id={`${id}-h`} className="flex flex-wrap items-center gap-2 text-xl">
        <KindBadge simulated={simulated} /> <span>Recommended actions based on the forecast: {subject}</span>
      </h3>
      <p className="mt-1 text-sm text-muted">
        Worked out from this view&apos;s forecast, past sales, accuracy and stock. They are suggestions only: nothing is ordered or changed until you decide.
        {simulated ? ' These are simulated figures, so the advice shows how the method works, not what to do in the shop.' : ''}
      </p>
      {items.length === 0 ? (
        <p className="mt-2 text-sm" data-testid="recommendations-empty">
          There is not enough data in this selection to suggest anything.
        </p>
      ) : (
        <ul className="mt-3 grid gap-3 lg:grid-cols-2">
          {items.map((r) => (
            <li key={r.id} className={`min-w-0 bg-paper p-3 ${TONE_BORDER[r.tone]}`} data-testid="recommendation" data-id={r.id} data-tone={r.tone}>
              <p className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-display text-lg font-semibold">{r.title}</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-brown-dark">{TONE_LABEL[r.tone]}</span>
              </p>
              <dl className="mt-1 space-y-1.5 text-sm">
                <div>
                  <dt className="inline font-semibold">What the data shows: </dt>
                  <dd className="inline">{r.observation}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">Recommended action: </dt>
                  <dd className="inline">{r.action}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">Why: </dt>
                  <dd className="inline">{r.reason}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
