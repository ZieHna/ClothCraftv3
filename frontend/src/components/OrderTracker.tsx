import type { OrderTracking, TrackingStepId } from '../api/types';
import { formatWhen, STEP_LABEL } from '../lib/orderText';

const ORDER: TrackingStepId[] = ['received', 'shipped', 'on_delivery', 'delivered'];

/**
 * The customer's four steps (step 11). Each says in words whether it is done, the step the order is at now (aria-current="step"), or
 * still to come, with an icon beside the words (never colour alone), and the time it was reached. A closed order shows step 4 as done
 * and says how it was closed. No step promises a date.
 */
export function OrderTracker({ tracking }: { tracking: OrderTracking }) {
  const at = tracking.current ? ORDER.indexOf(tracking.current) : -1;
  return (
    <ol aria-label="Order progress" className="mt-4 grid gap-0 sm:grid-cols-4 sm:gap-3" data-testid="order-tracker">
      {tracking.steps.map((s, i) => {
        const closed = !!tracking.closedAt && i === 3;
        const kind = i < at || closed ? 'done' : i === at ? 'now' : 'next';
        const words = kind === 'done' ? 'Done' : kind === 'now' ? 'Now' : 'Still to come';
        return (
          <li
            key={s.step}
            aria-current={i === at ? 'step' : undefined}
            data-testid="tracker-step"
            data-step={s.step}
            data-kind={kind}
            className={`relative flex gap-3 pb-4 sm:flex-col sm:gap-2 sm:border-t-4 sm:pt-3 sm:pb-0 ${kind === 'next' ? 'sm:border-tan' : 'sm:border-sage-dark'}`}
          >
            {/* the line joining the steps on a phone (decoration only) */}
            {i < 3 && <span aria-hidden="true" className={`absolute top-8 bottom-0 left-[0.9375rem] w-0.5 sm:hidden ${i < at ? 'bg-sage-dark' : 'bg-tan'}`} />}
            <StepIcon kind={kind} />
            <div className="min-w-0">
              <p className={`font-semibold leading-snug ${kind === 'next' ? 'text-muted' : 'text-ink'}`}>{STEP_LABEL[s.step]}</p>
              <p className="text-sm text-muted">
                <span className={kind === 'now' ? 'font-semibold text-sage-dark' : ''}>{words}</span>
                {kind !== 'next' && (s.reachedAt ? <> · {formatWhen(s.reachedAt)}</> : <> · time not recorded</>)}
              </p>
              {closed && (
                <p className="text-sm text-muted" data-testid="tracker-closed">
                  {tracking.closedBy === 'customer' ? 'You confirmed you received it' : 'Closed automatically'}
                  {tracking.closedAt && ` · ${formatWhen(tracking.closedAt)}`}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StepIcon({ kind }: { kind: 'done' | 'now' | 'next' }) {
  const ring = kind === 'next' ? 'border-tan bg-paper' : 'border-sage-dark';
  return (
    <span aria-hidden="true" className={`relative z-10 inline-flex size-8 shrink-0 items-center justify-center rounded-full border-2 ${ring} ${kind === 'done' ? 'bg-sage-dark text-cream' : 'bg-cream text-sage-dark'}`}>
      {kind === 'done' && (
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      )}
      {kind === 'now' && <span className="size-3 rounded-full bg-sage-dark" />}
    </span>
  );
}
