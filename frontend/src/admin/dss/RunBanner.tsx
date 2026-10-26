import type { DssRunRef } from '../../api/adminDss';
import { ageText, formatWhen, REAL_BADGE, SIMULATED_BADGE, TRIGGER_LABEL } from './dssText';

/**
 * The badge that says whether figures are real or simulated. It is TEXT (with a different outline and fill), never colour alone, and it prints.
 * Every list or block of simulated figures has one beside it.
 */
export function KindBadge({ simulated }: { simulated: boolean }) {
  return (
    <span
      data-testid="kind-badge"
      data-simulated={simulated}
      className={`inline-block whitespace-nowrap px-2 py-0.5 text-xs font-semibold uppercase tracking-widest ${simulated ? 'border-2 border-dashed border-ink bg-ink text-cream' : 'border border-ink text-ink'}`}
    >
      {simulated ? SIMULATED_BADGE : REAL_BADGE}
    </span>
  );
}

export function StaleBadge() {
  return (
    <span data-testid="stale-badge" className="inline-block whitespace-nowrap border border-brown-dark px-2 py-0.5 text-xs font-semibold uppercase tracking-widest text-brown-dark">
      Stale
    </span>
  );
}

/**
 * What every DSS screen says about the run it shows: real or simulated, the server's standing notice word for word (a simulated run: "Simulated
 * data: demonstrates the method, not real-world accuracy."; a run more than 8 days old also says how old), the day the figures are as of, when it
 * finished, who started it, the engine version and the rule that decided which orders count as Closed. Nothing is worked out here.
 */
export function RunBanner({ run }: { run: DssRunRef }) {
  return (
    <div className={`p-3 ${run.simulated ? 'border-2 border-dashed border-ink bg-paper-warm' : 'border border-tan bg-paper'}`} data-testid="run-banner" data-kind={run.kind}>
      <p className="flex flex-wrap items-center gap-2">
        <KindBadge simulated={run.simulated} />
        {run.stale && <StaleBadge />}
      </p>
      {run.notice && (
        <p className="mt-2 text-sm font-medium text-ink" data-testid="run-notice">
          {run.notice}
        </p>
      )}
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="inline text-muted">Figures as of </dt>
          <dd className="inline" data-testid="run-asof">
            {run.asOf ?? '—'}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted">Finished </dt>
          <dd className="inline">
            {formatWhen(run.finishedAt)}, {ageText(run.ageDays)}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted">Trigger </dt>
          <dd className="inline">{TRIGGER_LABEL[run.trigger] ?? run.trigger}</dd>
        </div>
        <div>
          <dt className="inline text-muted">Engine </dt>
          <dd className="inline">{run.engineVersion ?? '—'}</dd>
        </div>
        {run.closedRuleText && (
          <div className="sm:col-span-2">
            <dt className="inline text-muted">Closed orders: </dt>
            <dd className="inline" data-testid="run-closed-rule">
              {run.closedRuleText}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
