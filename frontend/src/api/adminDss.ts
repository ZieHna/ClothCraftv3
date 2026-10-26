import { apiGet, apiSend } from './client';
import type { ApiResponse } from './types';

/**
 * The decision-support routes (B8 S4, S5a), read-only plus one POST: /api/admin/dss/..., the admin cookie only (real service; the frozen mock has
 * none of it). Reference: backend/README.md, "DSS API". Everything is worked out in Odoo; the page displays it. Numbers arrive with up to 4 decimals,
 * ratios as percentages (WAPE 49.65 means 49.65 %). A real run and a simulated run are never mixed in one answer: only /overview returns both, as two
 * blocks. Ids are strings. S5a uses /overview, /runs and the two Run now routes; S5b adds the forecast, its keys, the backtest and one run's detail; the other routes arrive with their screens.
 *
 *   404 not_found     "No DSS run yet. Press Run now to start one." (a kind with no finished run) or No DSS run "12"
 *   409 run_failed    the run asked for failed: its message
 *   409 run_in_progress   Run now while a request is queued or an attempt is running
 */
export type DssKind = 'real' | 'simulated';

/** The run a figure belongs to; it comes with every DSS answer so a screen can always say what it is showing. */
export interface DssRunRef {
  id: string;
  kind: DssKind;
  /** true for an imported bundle: the numbers demonstrate the method, not real-world accuracy */
  simulated: boolean;
  /** the standing text for a simulated run; with an age sentence added when the run is stale; null for a fresh real run */
  notice: string | null;
  /** the day the figures are as of (Manila), YYYY-MM-DD */
  asOf: string | null;
  engineVersion: string | null;
  /** which "Closed" rule priced the money */
  closedRule: string | null;
  closedRuleText: string | null;
  trigger: 'cron' | 'manual' | 'import';
  finishedAt: string | null;
  ageDays: number | null;
  /** more than 8 days old */
  stale: boolean;
}

export interface DssRunSummary extends DssRunRef {
  state: 'done' | 'failed';
  startedAt: string | null;
  durationS: number | null;
  requestedByName: string | null;
  headline: {
    orderNow: number;
    alertsCritical: number;
    alertsWarning: number;
    /** the engine's own status words: "ok" when the part ran, otherwise why not (for example "not_enough_history"); null when the run has no such part */
    forecastStatus: string | null;
    segmentsStatus: string | null;
    trend: string | null;
  };
}

export type DssRequestState = 'queued' | 'running' | 'done' | 'failed' | 'unknown';
/** A Run now request: its id is the cron trigger's. `runId` exists once the run has started. `detail` is a failed run's message. */
export interface DssRunRequest {
  requestId: string | null;
  state: DssRequestState;
  runId: string | null;
  detail: string | null;
}

export interface DssOverview {
  /** the latest finished real run, or null */
  real: DssRunSummary | null;
  /** the latest finished simulated run (imported in Odoo), or null */
  simulated: DssRunSummary | null;
  /** the request being served right now, or null */
  queue: DssRunRequest | null;
}

export interface DssRuns {
  runs: DssRunSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export const getDssOverview = (signal?: AbortSignal) => apiGet<DssOverview>('/admin/dss/overview', {}, signal);

export const getDssRuns = (query: { kind?: DssKind | 'all'; state?: 'done' | 'failed' | 'all'; pageSize?: number } = {}, signal?: AbortSignal) =>
  apiGet<DssRuns>('/admin/dss/runs', { kind: query.kind, state: query.state, pageSize: query.pageSize === undefined ? undefined : String(query.pageSize) }, signal);

/** Run now: only queues the request (the run itself is made by Odoo's cron). 202 { requestId, state: 'queued' }; 409 run_in_progress. Takes no body. */
export const startRunNow = (signal?: AbortSignal): Promise<ApiResponse<{ requestId: string; state: 'queued' }>> => apiSend('POST', '/admin/dss/run-now', {}, {}, signal);

export const getRunRequest = (requestId: string, signal?: AbortSignal) => apiGet<DssRunRequest>(`/admin/dss/run-now/${encodeURIComponent(requestId)}`, {}, signal);

// ---- S5b: the forecast and its backtest. Shapes confirmed with read-only GETs against the pack API (a real run), not copied from the README.

export type DssForecastLevel = 'total' | 'garment_type' | 'product';

/** What the engine says about a table it could not fill, for example { code: 'not_enough_history', message: ... }. Shown as it comes. */
export interface DssStatus {
  code: string;
  message: string | null;
}

/** One choice for the level selector. `key` is the id to ask with (a product's template id as a string, a garment type's code); `label` is for people. */
export interface DssForecastKey {
  level: DssForecastLevel;
  key: string;
  label: string;
}

/** One forecast week. All numbers are units per week; an interval the engine could not make is null. `method` is the method that made THIS row. */
export interface DssForecastRow {
  weekStart: string;
  /** weeks ahead, 1 to 8 */
  h: number;
  yhat: number;
  lo80: number | null;
  hi80: number | null;
  lo95: number | null;
  hi95: number | null;
  method: string;
  /** the engine's own tags, for example intermittent, not_enough_history, override, interval_pool_bucket */
  flags: string[];
  censored: boolean;
}

/** One week the forecast was trained on. `censored`: the item was out of stock that week, so the units understate the demand. */
export interface DssHistoryRow {
  weekStart: string;
  units: number;
  censored: boolean;
}

export interface DssForecast {
  run: DssRunRef;
  level: DssForecastLevel;
  key: string;
  /** why `rows` is empty (the engine's sentence), otherwise null */
  dataStatus: DssStatus | null;
  rows: DssForecastRow[];
  /** null when the history cannot be given (a garment type whose mapping is not proven), with the reason in historyStatus */
  history: DssHistoryRow[] | null;
  historyStatus: DssStatus | null;
}

/** One backtest result. wape, bias, cov80, cov95 are PERCENTS (49.65 = 49.65 %); mae is units per week; bias below 0 means the forecast was lower than what sold. */
export interface DssBacktestRow {
  level: DssForecastLevel;
  key: string;
  /** chosen (what the forecast uses), a method (ets, ets_croston, croston ...) or a baseline (naive, ma4, snaive) */
  policy: string;
  /** 'all' or '1' to '8' */
  horizon: string;
  /** 'all' weeks or 'uncensored' (stock-out weeks left out) */
  weeks: string;
  n: number;
  nWithInterval: number;
  mae: number | null;
  wape: number | null;
  bias: number | null;
  /** null when the method makes no interval */
  cov80: number | null;
  cov95: number | null;
  chosen: boolean;
}

export interface DssBacktest {
  run: DssRunRef;
  rows: DssBacktestRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** The part of a run's detail S5b needs: which method the backtest chose. */
export interface DssRunDetail {
  run: DssRunSummary & {
    selection: { chosen?: string | null; bestBaseline?: string | null; modelBeatsBaseline?: boolean | null; wape?: Record<string, number> } | null;
  };
}

export const getDssForecastKeys = (query: { run: string; level: 'product' | 'garment_type' }, signal?: AbortSignal) =>
  apiGet<{ run: DssRunRef; level: DssForecastLevel; keys: DssForecastKey[] }>('/admin/dss/forecast/keys', { run: query.run, level: query.level }, signal);

/** `key` is left out for the total. */
export const getDssForecast = (query: { run: string; level: DssForecastLevel; key?: string }, signal?: AbortSignal) =>
  apiGet<DssForecast>('/admin/dss/forecast', { run: query.run, level: query.level, key: query.key }, signal);

/** Every method and baseline over all horizons and all weeks, for one level and key. */
export const getDssBacktest = (query: { run: string; level: DssForecastLevel; key?: string }, signal?: AbortSignal) =>
  apiGet<DssBacktest>('/admin/dss/backtest', { run: query.run, level: query.level, key: query.key, horizon: 'all', weeks: 'all', pageSize: '100' }, signal);

export const getDssRun = (runId: string, signal?: AbortSignal) => apiGet<DssRunDetail>(`/admin/dss/runs/${encodeURIComponent(runId)}`, {}, signal);

// ---- S5c: the restock rows the recommendations read (only the fields the Forecast tab uses; the Restock tab has its own screen later).

/** One variant's stock and restock position in a run. Units are units; `weeklyDemand` is the forecast per week (daily x 7); days are days. A figure that does not exist is null. */
export interface DssRestockRow {
  productId: string;
  /** the product's template id: the same id the forecast uses as its product key */
  productTemplateId: string;
  sku: string;
  product: string;
  garmentType: string;
  size: string | null;
  color: string | null;
  onHand: number;
  reserved: number;
  free: number;
  incoming: number;
  weeklyDemand: number | null;
  daysLeft: number | null;
  leadDays: number | null;
  suggestedQty: number;
  orderNow: boolean;
  stockoutBeforeArrival: boolean;
  /** stockout_before_arrival, order_now, plan, ok or no_forecast, as the engine says it */
  urgency: string;
}

export interface DssRestock {
  run: DssRunRef;
  rows: DssRestockRow[];
  counts: { stockoutBeforeArrival: number; orderNow: number; plan: number; ok: number; noForecast: number };
  total: number;
  page: number;
  pageSize: number;
}

export const getDssRestock = (query: { run: string; page?: number }, signal?: AbortSignal) =>
  apiGet<DssRestock>('/admin/dss/restock', { run: query.run, pageSize: '100', page: String(query.page ?? 1) }, signal);
