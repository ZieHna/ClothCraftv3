import { useId, useState } from 'react';
import { Link } from 'react-router';
import {
  getDssBacktest,
  getDssForecast,
  getDssForecastKeys,
  getDssOverview,
  getDssRestock,
  getDssRun,
  type DssForecastKey,
  type DssForecastLevel,
  type DssRestockRow,
  type DssRunSummary,
} from '../../api/adminDss';
import { LoadingRegion, SkeletonBlock } from '../../components/skeleton/Skeleton';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { AccuracyTable } from './AccuracyTable';
import { DssEmpty } from './DssEmpty';
import { ForecastChart } from './ForecastChart';
import { ForecastMeaning } from './ForecastMeaning';
import { accuracyFacts, forecastFacts } from './forecastInsight';
import { buildRecommendations } from './recommendationRules';
import { Recommendations } from './Recommendations';
import { RunBanner } from './RunBanner';
import { useDss } from './useDss';

const OVERVIEW_ERROR = 'Could not load the DSS overview.';
const FORECAST_ERROR = 'Could not load the forecast.';
const BACKTEST_ERROR = 'Could not load the accuracy figures.';
const KEYS_ERROR = 'Could not load the list to choose from.';
const RESTOCK_ERROR = 'Could not load the stock figures.';
/** Every restock row of a run (a few pages of 100), for the recommendations. */
async function loadAllRestock(runId: string, signal: AbortSignal): Promise<DssRestockRow[]> {
  const rows: DssRestockRow[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const { data } = await getDssRestock({ run: runId, page }, signal);
    rows.push(...data.rows);
    if (rows.length >= data.total || data.rows.length === 0) break;
  }
  return rows;
}
const loadOverview = async (signal: AbortSignal) => (await getDssOverview(signal)).data;

const LEVELS: { level: DssForecastLevel; label: string }[] = [
  { level: 'total', label: 'Total' },
  { level: 'garment_type', label: 'Garment type' },
  { level: 'product', label: 'Product' },
];

type RestockLoad = ReturnType<typeof useDss<DssRestockRow[]>>;

/** An error with the way out: the server's sentence and a Retry button. */
function ErrorWithRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" data-testid="dss-error">
      <p className="font-medium text-brown-dark">{message}</p>
      <button type="button" className="btn btn-primary mt-2" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/**
 * Forecast and DSS, Forecast tab (B8 S5b). One block for the latest REAL run and, only if one exists, one for the latest SIMULATED run. Each block has its
 * own level selector and its own badge, and asks the server for its own run by id, so the two are never mixed. This page only draws what the server sends.
 */
export function ForecastPage() {
  const overview = useDss(loadOverview, OVERVIEW_ERROR);
  const gate = useSkeletonGate(overview.state.phase === 'loading' && !overview.hadData, { immediate: overview.state.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });
  const data = overview.data;
  return (
    <section className="mx-auto max-w-7xl px-4 py-6 sm:py-8" data-testid="dss-forecast">
      <h1 className="text-4xl sm:text-5xl">Forecast and DSS: Forecast</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Weekly units sold, what the DSS expects for the next eight weeks, and how well that kind of forecast has done on past weeks. Real and simulated figures are always kept apart.
      </p>
      <div className="mt-6" aria-busy={overview.state.phase === 'loading'}>
        {gate !== 'content' && (
          <LoadingRegion gate={gate} label="Loading the forecast…" className="grid gap-4" data-testid="dss-loading">
            <SkeletonBlock className="h-96 w-full" />
          </LoadingRegion>
        )}
        {gate === 'content' && overview.state.phase === 'error' && <ErrorWithRetry message={overview.state.message} onRetry={overview.reload} />}
        {gate === 'content' && data && (
          <div className="grid gap-6">
            {data.real ? (
              <ForecastBlock title="Real data" run={data.real} />
            ) : (
              <DssEmpty title="No DSS run yet. Press Run now to start one." testId="empty-real">
                The forecast appears once a real run has finished. <Link to="/admin/dss" className="underline">Go to the Overview</Link> to start one.
              </DssEmpty>
            )}
            {data.simulated && <ForecastBlock title="Simulated data (demonstration)" run={data.simulated} />}
          </div>
        )}
      </div>
    </section>
  );
}

/** One run's forecast: its banner, the level selector, then the chart and the accuracy for the thing chosen. */
function ForecastBlock({ title, run }: { title: string; run: DssRunSummary }) {
  const ids = useId();
  const restock = useDss((signal) => loadAllRestock(run.id, signal), RESTOCK_ERROR);
  const [level, setLevel] = useState<DssForecastLevel>('total');
  return (
    <section aria-labelledby={`${ids}-h`} className="min-w-0 border border-tan bg-cream p-4 sm:p-5" data-testid={`forecast-${run.kind}`}>
      <h2 id={`${ids}-h`} className="text-2xl">
        {title}
      </h2>
      <div className="mt-3">
        <RunBanner run={run} />
      </div>
      {run.state === 'failed' ? (
        <p role="alert" className="mt-3 font-medium text-brown-dark">
          This run failed, so it has no forecast.
        </p>
      ) : (
        <>
          <fieldset className="mt-4">
            <legend className="text-sm font-medium">Show the forecast for</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {LEVELS.map((l) => (
                <label
                  key={l.level}
                  className={`inline-flex min-h-11 cursor-pointer items-center gap-2 border px-3 text-sm focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink ${level === l.level ? 'border-ink bg-ink text-cream' : 'border-tan bg-paper text-ink'}`}
                >
                  <input type="radio" name={`${ids}-level`} className="size-4" checked={level === l.level} onChange={() => setLevel(l.level)} />
                  {l.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-4">
            {level === 'total' ? (
              <ForecastView key={`${run.id}-total`} run={run} level="total" subject="Total" restock={restock} />
            ) : (
              <KeyPicker key={`${run.id}-${level}`} run={run} level={level} restock={restock} />
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Garment type: a list to pick from. Product: the same with a search box. The first one is chosen until the person chooses another. */
function KeyPicker({ run, level, restock }: { run: DssRunSummary; level: 'garment_type' | 'product'; restock: RestockLoad }) {
  const ids = useId();
  const keys = useDss(async (signal) => (await getDssForecastKeys({ run: run.id, level }, signal)).data.keys, KEYS_ERROR);
  const [picked, setPicked] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const gate = useSkeletonGate(keys.state.phase === 'loading' && !keys.hadData, { immediate: keys.state.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });
  const noun = level === 'product' ? 'product' : 'garment type';

  if (gate !== 'content') {
    return (
      <LoadingRegion gate={gate} label={`Loading the ${noun} list…`} className="grid gap-3" data-testid="keys-loading">
        <SkeletonBlock className="h-24 w-full" />
      </LoadingRegion>
    );
  }
  if (keys.state.phase === 'error') return <ErrorWithRetry message={keys.state.message} onRetry={keys.reload} />;
  const list: DssForecastKey[] = keys.data ?? [];
  if (list.length === 0) {
    return (
      <DssEmpty title={`No ${noun} has a forecast in this run.`} testId="keys-empty">
        The run made no forecast at this level.
      </DssEmpty>
    );
  }
  const chosen = list.find((k) => k.key === picked) ?? list[0];
  const needle = search.trim().toLowerCase();
  const shown = needle ? list.filter((k) => k.label.toLowerCase().includes(needle)) : list;

  return (
    <div>
      {level === 'garment_type' ? (
        <div>
          <label htmlFor={`${ids}-type`} className="block text-sm font-medium">
            Garment type
          </label>
          <select id={`${ids}-type`} className="mt-1 min-h-11 w-full max-w-xs border border-tan bg-paper px-3 text-sm" value={chosen.key} onChange={(e) => setPicked(e.target.value)} data-testid="key-select">
            {list.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div>
          <label htmlFor={`${ids}-search`} className="block text-sm font-medium">
            Search products
          </label>
          <input id={`${ids}-search`} type="search" className="mt-1 min-h-11 w-full max-w-xs border border-tan bg-paper px-3 text-sm" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" data-testid="key-search" />
          <p className="mt-1 text-sm text-muted" role="status" aria-live="polite">
            {shown.length === 0 ? 'No product matches that search.' : `${shown.length} of ${list.length} products. Showing: ${chosen.label}.`}
          </p>
          <ul className="mt-1 max-h-48 max-w-xs overflow-y-auto border border-tan" aria-label="Products" data-testid="key-list">
            {shown.map((k) => (
              <li key={k.key} className="border-b border-tan last:border-b-0">
                <button
                  type="button"
                  aria-pressed={k.key === chosen.key}
                  onClick={() => setPicked(k.key)}
                  className={`flex min-h-11 w-full items-center px-3 text-left text-sm ${k.key === chosen.key ? 'bg-ink text-cream' : 'bg-paper text-ink hover:bg-paper-warm'}`}
                >
                  {k.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-4">
        <ForecastView key={`${run.id}-${level}-${chosen.key}`} run={run} level={level} itemKey={chosen.key} subject={chosen.label} restock={restock} />
      </div>
    </div>
  );
}

/** The chart and the accuracy for one run, level and key. Each part loads, fails and retries by itself. */
function ForecastView({ run, level, itemKey, subject, restock }: { run: DssRunSummary; level: DssForecastLevel; itemKey?: string; subject: string; restock: RestockLoad }) {
  const forecast = useDss(async (signal) => (await getDssForecast({ run: run.id, level, key: itemKey }, signal)).data, FORECAST_ERROR);
  const backtest = useDss(async (signal) => (await getDssBacktest({ run: run.id, level, key: itemKey }, signal)).data, BACKTEST_ERROR);
  const detail = useDss(async (signal) => (await getDssRun(run.id, signal)).data, 'Could not load the run detail.');
  const gate = useSkeletonGate(forecast.state.phase === 'loading' && !forecast.hadData, { immediate: forecast.state.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });
  const f = forecast.data;
  const b = backtest.data;
  const facts = f ? forecastFacts(f.rows, f.history) : null;
  const accuracy = b && b.rows.length > 0 ? accuracyFacts(b.rows) : null;
  const settled = gate === 'content' && backtest.state.phase !== 'loading' && restock.state.phase !== 'loading';

  return (
    <div className="grid gap-6" data-testid="forecast-view" data-run-kind={run.kind}>
      <div aria-busy={forecast.state.phase === 'loading'}>
        {gate !== 'content' && (
          <LoadingRegion gate={gate} label="Loading the forecast…" className="grid gap-3" data-testid="forecast-loading">
            <SkeletonBlock className="h-80 w-full" />
          </LoadingRegion>
        )}
        {gate === 'content' && forecast.state.phase === 'error' && <ErrorWithRetry message={forecast.state.message} onRetry={forecast.reload} />}
        {gate === 'content' && f && f.rows.length === 0 && (
          <DssEmpty title={f.dataStatus?.message ?? (f.dataStatus ? f.dataStatus.code : `No forecast for ${subject} in this run.`)} testId={f.dataStatus ? 'forecast-status' : 'forecast-empty'}>
            {f.dataStatus ? 'The DSS could not make a forecast here.' : 'The run has no forecast rows for this choice.'}
          </DssEmpty>
        )}
        {gate === 'content' && f && f.rows.length > 0 && (
          <ForecastChart key={`${run.id}-${level}-${itemKey ?? 'total'}`} history={f.history} rows={f.rows} subject={subject} simulated={run.simulated} historyStatus={f.historyStatus} />
        )}
      </div>
      {gate === 'content' && facts && f && (
        <ForecastMeaning key={`meaning-${run.id}-${level}-${itemKey ?? 'total'}`} facts={facts} level={level} subject={subject} simulated={run.simulated} wape={accuracy?.chosen?.wape ?? null} />
      )}
      <div aria-busy={backtest.state.phase === 'loading'}>
        {backtest.state.phase === 'loading' && !b && <p className="text-sm text-muted">Loading the accuracy figures…</p>}
        {backtest.state.phase === 'error' && <ErrorWithRetry message={backtest.state.message} onRetry={backtest.reload} />}
        {b && b.rows.length === 0 && (
          <DssEmpty title={`No accuracy figures for ${subject}.`} testId="accuracy-empty">
            The backtest has no rows for this choice, so there is nothing to compare the forecast with.
          </DssEmpty>
        )}
        {b && b.rows.length > 0 && <AccuracyTable rows={b.rows} subject={subject} simulated={run.simulated} chosenMethod={detail.data?.run.selection?.chosen ?? null} />}
      </div>
      {facts && settled && (
        <Recommendations
          items={buildRecommendations({ level, subject, itemKey, facts, accuracy, restock: restock.state.phase === 'ready' ? restock.state.data : null })}
          subject={subject}
          simulated={run.simulated}
        />
      )}
      {facts && !settled && gate === 'content' && <p className="text-sm text-muted">Working out the recommended actions…</p>}
    </div>
  );
}
