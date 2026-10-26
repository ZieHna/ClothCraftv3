import type { DssBacktestRow } from '../../api/adminDss';
import { humanise } from './dssText';

/** Words and display formats for the Forecast tab. Display only: the figures come from the server; nothing here is a forecast, a money sum or a statistic. */

const METHOD: Record<string, string> = {
  chosen: 'Chosen by the DSS',
  ets: 'Exponential smoothing (ETS)',
  ets_croston: 'ETS with Croston for slow sellers',
  croston: 'Croston (slow, uneven sales)',
  ma4: '4-week average',
  naive: 'Repeat last week',
  snaive: 'Same week last year',
  bottom_up: 'Sum of the product forecasts',
  group_share: 'A share of its group forecast',
  override: 'Backtest override',
};
export const methodLabel = (code: string) => METHOD[code] ?? humanise(code);

/** The baselines every method is compared with. Anything else in the backtest is a forecasting method. */
export const BASELINES = ['naive', 'ma4', 'snaive'];
const ORDER = ['chosen', 'ets_croston', 'ets', 'croston', 'ma4', 'naive', 'snaive'];
export const byPolicyOrder = (a: DssBacktestRow, b: DssBacktestRow) => (ORDER.indexOf(a.policy) + 1 || 99) - (ORDER.indexOf(b.policy) + 1 || 99);

const week = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
const monthYear = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short', year: '2-digit' });
const parse = (day: string) => new Date(`${day}T00:00:00Z`);
/** "26 Oct 2026" for a week's first day (YYYY-MM-DD). */
export const weekText = (day: string) => (Number.isNaN(parse(day).getTime()) ? day : week.format(parse(day)));
/** "Oct 26" for an axis label. */
export const monthText = (day: string) => (Number.isNaN(parse(day).getTime()) ? day : monthYear.format(parse(day)));

/** Units with at most one decimal; the dash for a figure the engine could not make. */
export function unitsText(value: number | null): string {
  return value === null ? '—' : String(Math.round(value * 10) / 10);
}
export function percentText(value: number | null): string {
  return value === null ? '—' : `${(Math.round(value * 10) / 10).toFixed(1)}%`;
}
/** A signed percent, with a real minus sign, for the bias. */
export function signedPercentText(value: number | null): string {
  if (value === null) return '—';
  const rounded = Math.round(value * 10) / 10;
  return `${rounded < 0 ? '−' : rounded > 0 ? '+' : ''}${Math.abs(rounded).toFixed(1)}%`;
}
export const rangeText = (lo: number | null, hi: number | null) => (lo === null || hi === null ? '—' : `${unitsText(lo)} to ${unitsText(hi)}`);

/** A bias this far from zero (in percent) is said out loud. */
export const BIAS_SAID_AT = 5;
export type BiasLean = 'under' | 'over' | 'level' | 'unknown';
export function biasLean(bias: number | null): BiasLean {
  if (bias === null) return 'unknown';
  return bias <= -BIAS_SAID_AT ? 'under' : bias >= BIAS_SAID_AT ? 'over' : 'level';
}

export const STOCKOUT_TEXT = 'Stock-out week: the item ran out, so the units understate the demand';
export const SIMULATED_ACCURACY_TEXT = 'Demonstrates the method only, not real-world accuracy.';
