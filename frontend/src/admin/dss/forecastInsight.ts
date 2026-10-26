import type { DssBacktestRow, DssForecastLevel, DssForecastRow, DssHistoryRow } from '../../api/adminDss';
import { methodLabel, percentText, signedPercentText, unitsText, weekText } from './forecastText';

/**
 * The plain-words reading of a forecast (S5c). Everything here is worked out from the rows the server sent for the view on screen: the weekly forecast,
 * its ranges, the weeks it was trained on and the backtest. Nothing is stored or invented; only units are added or averaged (never money), and a
 * figure that is missing stays missing. The rules that turn numbers into words are stated in the words themselves ("more than 15% above ...").
 */

/** The forecast is called rising or falling when it is this far (as a fraction) from the recent average of actual weekly units. */
export const TREND_BAND = 0.15;
/** How many of the latest actual weeks the forecast is compared with. */
export const RECENT_WEEKS = 8;

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const meanIfAll = (values: (number | null)[]) => (values.length > 0 && values.every((v): v is number => v !== null) ? (mean(values as number[]) as number) : null);

export type Trend = 'up' | 'down' | 'stable' | 'unknown';

export interface ForecastFacts {
  weeks: number;
  firstWeek: string;
  lastWeek: string;
  /** the average weekly forecast over the horizon */
  weeklyAvg: number;
  /** the average of the weekly range bounds over the horizon; null when any week has none */
  lo80: number | null;
  hi80: number | null;
  lo95: number | null;
  hi95: number | null;
  /** the highest weekly upper 80% bound, for "a busy week may reach" */
  peakHi80: number | null;
  /** the forecast for all the weeks together (a sum of units) */
  totalUnits: number;
  recentAvg: number | null;
  recentWeeks: number;
  /** forecast average / recent average - 1, as a fraction; null when there is no recent average above zero */
  change: number | null;
  trend: Trend;
  historyWeeks: number;
  /** weeks of history with no sale at all */
  zeroWeeks: number;
  stockoutWeeks: number;
  methods: string[];
  flags: string[];
}

/** Null when there is no forecast to describe. */
export function forecastFacts(rows: DssForecastRow[], history: DssHistoryRow[] | null): ForecastFacts | null {
  if (rows.length === 0) return null;
  const past = history ?? [];
  const weeklyAvg = mean(rows.map((r) => r.yhat)) as number;
  const recent = past.slice(-RECENT_WEEKS);
  const recentAvg = mean(recent.map((p) => p.units));
  const change = recentAvg !== null && recentAvg > 0 ? weeklyAvg / recentAvg - 1 : null;
  const trend: Trend = change === null ? (recentAvg === 0 && weeklyAvg === 0 ? 'stable' : 'unknown') : change > TREND_BAND ? 'up' : change < -TREND_BAND ? 'down' : 'stable';
  const hi80s = rows.map((r) => r.hi80);
  return {
    weeks: rows.length,
    firstWeek: rows[0].weekStart,
    lastWeek: rows[rows.length - 1].weekStart,
    weeklyAvg,
    lo80: meanIfAll(rows.map((r) => r.lo80)),
    hi80: meanIfAll(hi80s),
    lo95: meanIfAll(rows.map((r) => r.lo95)),
    hi95: meanIfAll(rows.map((r) => r.hi95)),
    peakHi80: hi80s.every((v): v is number => v !== null) ? Math.max(...(hi80s as number[])) : null,
    totalUnits: rows.reduce((a, r) => a + r.yhat, 0),
    recentAvg,
    recentWeeks: recent.length,
    change,
    trend,
    historyWeeks: past.length,
    zeroWeeks: past.filter((p) => p.units === 0).length,
    stockoutWeeks: past.filter((p) => p.censored).length,
    methods: Array.from(new Set(rows.map((r) => r.method))),
    flags: Array.from(new Set(rows.flatMap((r) => r.flags))),
  };
}

/** What the thing being forecast is called in a sentence: "ClothCraft", "garment type CROP", "Baby Hoodie". */
export function subjectName(level: DssForecastLevel, subject: string): string {
  return level === 'total' ? 'ClothCraft' : level === 'garment_type' ? `the ${subject} garment type` : subject;
}
const unitWord = (level: DssForecastLevel) => (level === 'total' ? 'garments' : 'units');

/** "about 15 units", "less than 1 unit (about 1 every 5 weeks)": a tiny weekly figure is easier to read as a gap between sales. */
export function expectedText(weekly: number, level: DssForecastLevel): string {
  if (weekly > 0 && weekly < 1) return `less than one ${level === 'total' ? 'garment' : 'unit'} a week (about one every ${Math.max(2, Math.round(1 / weekly))} weeks)`;
  return `about ${unitsText(weekly)} ${unitWord(level)} a week`;
}

export const periodText = (f: ForecastFacts) => `${weekText(f.firstWeek)} to ${weekText(f.lastWeek)} (the next ${f.weeks === 1 ? 'week' : `${f.weeks} weeks`})`;

export function trendText(f: ForecastFacts): string {
  if (f.change === null || f.recentAvg === null) {
    return f.trend === 'stable' ? 'There were no sales in the latest weeks and none are expected, so the forecast is flat.' : 'There are no recent sales to compare with, so the direction cannot be judged.';
  }
  const pct = `${Math.round(Math.abs(f.change) * 100)}%`;
  const base = f.recentWeeks === 1 ? `last week's figure of ${unitsText(f.recentAvg)} a week` : `the last ${f.recentWeeks} weeks' average of ${unitsText(f.recentAvg)} a week`;
  if (f.trend === 'up') return `Sales are expected to rise: the forecast is ${pct} above ${base}.`;
  if (f.trend === 'down') return `Sales are expected to fall: the forecast is ${pct} below ${base}.`;
  return `Sales are expected to stay about the same: the forecast is within ${Math.round(TREND_BAND * 100)}% of ${base}.`;
}

export function rangeSentence(f: ForecastFacts): string | null {
  if (f.lo80 === null || f.hi80 === null) return null;
  const wide = f.lo95 !== null && f.hi95 !== null ? ` and between ${unitsText(f.lo95)} and ${unitsText(f.hi95)} in 19 weeks out of 20 (the 95% range)` : '';
  return `In a typical week the shaded bands say sales could land between ${unitsText(f.lo80)} and ${unitsText(f.hi80)} units in 8 weeks out of 10 (the 80% range)${wide}.`;
}

/** The business meaning, from the direction and the size of the range. */
export function meaningText(f: ForecastFacts, level: DssForecastLevel, simulated: boolean): string {
  const need = `Over ${f.weeks} weeks that is about ${unitsText(f.totalUnits)} ${unitWord(level)} in all`;
  const peak = f.peakHi80 !== null ? `, and a busy week could reach about ${unitsText(f.peakHi80)}` : '';
  const move =
    f.trend === 'up'
      ? 'Because sales are rising, check that stock and the next purchase orders keep up before demand arrives.'
      : f.trend === 'down'
        ? 'Because sales are falling, think twice before buying or making more than this pace needs.'
        : 'Because sales look steady, stock, production and purchasing can follow the usual pace.';
  const note = simulated ? ' These are simulated figures: they show how the method works, not real sales.' : '';
  return `${need}${peak}. ${move} Use it as a guide for inventory, production planning and purchasing, not as an order.${note}`;
}

// ------------------------------------------------------------------------------------------------------------------ accuracy

export interface AccuracyFacts {
  chosen: DssBacktestRow | null;
  /** the method with the lowest WAPE among those scored on the most weeks, other than the "chosen" mix */
  best: DssBacktestRow | null;
  /** the most weeks any method was scored on */
  mostWeeks: number;
}

export function accuracyFacts(rows: DssBacktestRow[]): AccuracyFacts {
  const chosen = rows.find((r) => r.policy === 'chosen') ?? null;
  const mostWeeks = Math.max(0, ...rows.map((r) => r.n));
  const candidates = rows.filter((r) => r.policy !== 'chosen' && r.n === mostWeeks && r.wape !== null);
  const best = candidates.length ? candidates.reduce((a, b) => ((b.wape as number) < (a.wape as number) ? b : a)) : null;
  return { chosen, best, mostWeeks };
}

/** Bias is within this many percentage points of zero: "no clear lean". */
export const BIAS_CLOSE = 5;
/** A coverage within this many points of its target is "close". */
export const COVERAGE_CLOSE = 3;

export function coverageSentence(label: '80%' | '95%', held: number | null): string | null {
  if (held === null) return null;
  const target = label === '80%' ? 80 : 95;
  const shown = percentText(held);
  if (Math.abs(held - target) <= COVERAGE_CLOSE) return `The ${label} range held ${shown} of the time in the backtest, close to the ${target}% it aims for.`;
  if (held < target) {
    return `The ${label} range held only ${shown} of the time in the backtest, below the ${target}% it aims for: real sales fell outside it more often than intended, so treat the band as a little narrower than it looks. Past results do not guarantee future ones.`;
  }
  return `The ${label} range held ${shown} of the time in the backtest, above the ${target}% it aims for: the band was a little wider than it needed to be. Past results do not guarantee future ones.`;
}

export function accuracySentences(rows: DssBacktestRow[]): string[] {
  const { chosen, best, mostWeeks } = accuracyFacts(rows);
  const out: string[] = [];
  if (chosen) {
    if (chosen.wape !== null) {
      out.push(`Across ${chosen.n} backtest checks (each one a forecast week compared with what really sold), the forecast misses added up to ${percentText(chosen.wape)} of the units that actually sold (WAPE). That is a total across all the checks, not the error of every single week.`);
    } else {
      out.push('The size of the forecast misses could not be measured here, because nothing sold in the weeks checked.');
    }
    if (chosen.mae !== null) out.push(`On average a week’s forecast was ${unitsText(chosen.mae)} units away from what sold (MAE).`);
    if (chosen.bias !== null) {
      const sign = signedPercentText(chosen.bias);
      if (chosen.bias <= -BIAS_CLOSE) out.push(`The forecast leans low: its bias is ${sign}, so across the backtest it was lower than what actually sold (it under-predicts). Plan for a little more than it says.`);
      else if (chosen.bias >= BIAS_CLOSE) out.push(`The forecast leans high: its bias is ${sign}, so across the backtest it was higher than what actually sold (it over-predicts). Be careful not to over-buy on it.`);
      else out.push(`The forecast shows no clear lean: its bias is ${sign}, within ${BIAS_CLOSE} points of zero.`);
    }
    for (const s of [coverageSentence('80%', chosen.cov80), coverageSentence('95%', chosen.cov95)]) if (s) out.push(s);
  }
  if (best) {
    const same = chosen && chosen.wape !== null && best.wape !== null && Math.abs(chosen.wape - best.wape) < 0.05;
    out.push(
      `Among the methods checked on all ${mostWeeks} forecast weeks, ${methodLabel(best.policy)} has the lowest WAPE (${percentText(best.wape)}, MAE ${unitsText(best.mae)}).` +
        (chosen && !same && chosen.wape !== null && best.wape !== null && chosen.wape > best.wape
          ? ' The DSS picks its method by how products do one by one, so for this view another method can score a little better.'
          : ''),
    );
  }
  return out;
}
