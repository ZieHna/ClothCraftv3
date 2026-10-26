import { useEffect, useId } from 'react';
import { getDssOverview, getDssRuns, type DssRunSummary } from '../../api/adminDss';
import { LoadingRegion, SkeletonBlock } from '../../components/skeleton/Skeleton';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate, type Gate } from '../../lib/useSkeletonGate';
import { DssEmpty } from './DssEmpty';
import { ageText, durationText, formatWhen, humanise, partText, TRIGGER_LABEL } from './dssText';
import { KindBadge, RunBanner, StaleBadge } from './RunBanner';
import { RunProgress } from './RunProgress';
import { useDss } from './useDss';
import { useRunNow, type RunNowState } from './useRunNow';

const OVERVIEW_ERROR = 'Could not load the DSS overview.';
const RUNS_ERROR = 'Could not load the runs.';
const loadOverview = async (signal: AbortSignal) => (await getDssOverview(signal)).data;
const loadRuns = async (signal: AbortSignal) => (await getDssRuns({ kind: 'all', pageSize: 10 }, signal)).data;

/** The sentence under the Run now button for each state of a request. Shown (not just announced) so the reason a button is off is always visible. */
function statusText(state: RunNowState): string | null {
  switch (state.phase) {
    case 'starting':
    case 'queued':
    case 'running':
      return null; // the indicator beside the button says it (RunProgress)
    case 'done':
      return 'DSS run completed successfully. The new run is shown below.';
    case 'idle':
      return null; // a run someone else started: the indicator beside the button says so (RunProgress)
    case 'failed':
    case 'error':
      return `${state.message ?? 'The run failed.'} You can press Run now to try again.`;
    default:
      return state.message; // conflict / timeout / unknown: the server's sentence, or ours
  }
}

/**
 * Forecast and DSS, Overview (B8 S5a). Two blocks that are never merged: the latest REAL run and the latest SIMULATED run (a demonstration bundle
 * imported in Odoo), each labelled with the SIMULATED DATA / REAL DATA badge and the run's standing notice. Under them the run list, and the one
 * action here: Run now, which asks for a new REAL run. Everything shown comes from the server; this page only draws it.
 */
export function OverviewPage() {
  const ids = useId();
  const overview = useDss(loadOverview, OVERVIEW_ERROR);
  const runs = useDss(loadRuns, RUNS_ERROR);
  const runNow = useRunNow({
    onFinished: () => {
      overview.reload();
      runs.reload();
    },
    onConflict: () => overview.reload(), // learn which request is already going
  });

  // A request that is already queued or running (started by someone else, by the weekly job, or before this page was opened) is followed too.
  const queue = overview.data?.queue ?? null;
  const { follow, busy } = runNow;
  const followedId = runNow.state.requestId;
  useEffect(() => {
    if (queue?.requestId && !busy && queue.requestId !== followedId) follow(queue.requestId, queue.state === 'running' ? 'running' : 'queued');
  }, [queue?.requestId, queue?.state, busy, followedId, follow]);

  const gate = useSkeletonGate(overview.state.phase === 'loading' && !overview.hadData, { immediate: overview.state.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });
  const data = overview.data;
  const weeklyRunning = queue !== null && queue.requestId === null; // the weekly job has no request id to follow
  const reason = statusText(runNow.state);

  return (
    <section className="mx-auto max-w-7xl px-4 py-6 sm:py-8" data-testid="dss-overview">
      <h1 className="text-4xl sm:text-5xl">Forecast and DSS: Overview</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        What the decision-support module worked out from the shop&apos;s orders and stock. Real and simulated figures are always kept apart.
      </p>

      <section className="mt-6 border border-tan bg-cream p-4 sm:p-5" aria-labelledby={`${ids}-run`} data-testid="run-now-card">
        <h2 id={`${ids}-run`} className="text-2xl">
          Make a new real run
        </h2>
        <p className="mt-1 text-sm text-muted">Run now works out a new real run from today&apos;s shop data. A simulated run cannot be made here: it is a demonstration bundle imported in Odoo.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={runNow.start} disabled={runNow.busy || weeklyRunning} aria-describedby={`${ids}-why`} data-testid="run-now-button">
            {runNow.busy ? 'Running…' : 'Run now'}
          </button>
          <RunProgress phase={runNow.state.phase} weeklyRunning={weeklyRunning} />
          {weeklyRunning && (
            <button type="button" className="btn btn-secondary" onClick={overview.reload} data-testid="run-now-check">
              Check again
            </button>
          )}
        </div>
        <p id={`${ids}-why`} role="status" aria-live="polite" className="mt-2 min-h-6 text-sm text-ink" data-testid="run-now-status" data-phase={runNow.state.phase}>
          {reason}
        </p>
      </section>

      <div className={`mt-6 ${overview.state.phase === 'loading' && overview.hadData ? 'opacity-60' : ''}`} aria-busy={overview.state.phase === 'loading'}>
        {gate !== 'content' && <OverviewSkeleton gate={gate} />}
        {gate === 'content' && overview.state.phase === 'error' && (
          <div role="alert">
            <p className="font-medium text-brown-dark">{overview.state.message}</p>
            <button type="button" className="btn btn-primary mt-3" onClick={overview.reload}>
              Try again
            </button>
          </div>
        )}
        {gate === 'content' && data && (
          <div className="grid gap-4 lg:grid-cols-2">
            <RunBlock kind="real" title="Real data" run={data.real} />
            <RunBlock kind="simulated" title="Simulated data (demonstration)" run={data.simulated} />
          </div>
        )}
      </div>

      <section className="mt-8" aria-labelledby={`${ids}-runs`} data-testid="runs-list">
        <h2 id={`${ids}-runs`} className="text-2xl">
          Recent runs
        </h2>
        {runs.state.phase === 'loading' && !runs.hadData && <p className="mt-2 text-sm text-muted">Loading the runs…</p>}
        {runs.state.phase === 'error' && (
          <div role="alert" className="mt-2">
            <p className="font-medium text-brown-dark">{runs.state.message}</p>
            <button type="button" className="btn btn-secondary btn-small mt-2" onClick={runs.reload}>
              Try again
            </button>
          </div>
        )}
        {runs.data && (runs.data.runs.length === 0 ? <div className="mt-2"><DssEmpty title="No runs yet" testId="runs-empty">Press Run now to make the first one.</DssEmpty></div> : (
          <>
            <p className="mt-1 text-sm text-muted">
              The latest {runs.data.runs.length} of {runs.data.total}, newest first. Each run says whether it is real or simulated.
            </p>
            <ul className="mt-2 border-t border-tan">
              {runs.data.runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </ul>
          </>
        ))}
      </section>
    </section>
  );
}

/** One of the two labelled blocks. An empty one says why, in plain words. */
function RunBlock({ kind, title, run }: { kind: 'real' | 'simulated'; title: string; run: DssRunSummary | null }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0 border border-tan bg-cream p-4 sm:p-5" data-testid={`block-${kind}`}>
      <h2 id={id} className="text-2xl">
        {title}
      </h2>
      <div className="mt-3">
        {run === null ? (
          kind === 'real' ? (
            <DssEmpty title="No DSS run yet. Press Run now to start one." testId="empty-real">
              The real block fills in once a run has finished.
            </DssEmpty>
          ) : (
            <DssEmpty title="No simulated run in this database." testId="empty-simulated">
              A simulated run is a demonstration bundle imported in Odoo by an administrator. It cannot be made or imported here.
            </DssEmpty>
          )
        ) : (
          <div className="space-y-3">
            <RunBanner run={run} />
            {run.state === 'failed' && (
              <p role="alert" className="font-medium text-brown-dark">
                This run failed.
              </p>
            )}
            <div>
              <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <KindBadge simulated={run.simulated} /> Counts from this run
              </p>
              <dl className="mt-2 grid grid-cols-3 gap-3" data-testid={`counts-${kind}`}>
                <Stat label="Order now" value={run.headline.orderNow} />
                <Stat label="Critical alerts" value={run.headline.alertsCritical} />
                <Stat label="Warning alerts" value={run.headline.alertsWarning} />
              </dl>
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <Fact label="Forecast" value={partText(run.headline.forecastStatus)} />
                <Fact label="Segments" value={partText(run.headline.segmentsStatus)} />
                <Fact label="Sales trend" value={run.headline.trend ? humanise(run.headline.trend) : '—'} />
                <Fact label="Took" value={durationText(run.durationS)} />
                {run.requestedByName && <Fact label="Requested by" value={run.requestedByName} />}
              </dl>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-tan bg-paper p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-3xl font-semibold text-ink">{value}</dd>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="inline text-muted">{label}: </dt>
      <dd className="inline">{value}</dd>
    </div>
  );
}

/** A row in the run list. The badge is in the row, so a simulated run's numbers are never seen without it. */
function RunRow({ run }: { run: DssRunSummary }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-tan py-2 text-sm" data-testid="run-row" data-kind={run.kind}>
      <KindBadge simulated={run.simulated} />
      <span className="font-medium">{run.state === 'failed' ? 'Failed' : 'Done'}</span>
      <span>{formatWhen(run.finishedAt)}</span>
      <span className="text-muted">
        {TRIGGER_LABEL[run.trigger] ?? run.trigger}, {ageText(run.ageDays)}
      </span>
      {run.state === 'done' && (
        <span>
          Order now {run.headline.orderNow}, critical {run.headline.alertsCritical}, warning {run.headline.alertsWarning}
        </span>
      )}
      {run.stale && <StaleBadge />}
    </li>
  );
}

function OverviewSkeleton({ gate }: { gate: Exclude<Gate, 'content'> }) {
  return (
    <LoadingRegion gate={gate} label="Loading the DSS overview…" className="grid gap-4 lg:grid-cols-2" data-testid="dss-loading">
      <SkeletonBlock className="h-72 w-full" />
      <SkeletonBlock className="h-72 w-full" />
    </LoadingRegion>
  );
}
