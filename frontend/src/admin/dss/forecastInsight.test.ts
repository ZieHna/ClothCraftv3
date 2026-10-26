import { describe, expect, it } from 'vitest';
import type { DssBacktestRow, DssForecastRow, DssHistoryRow } from '../../api/adminDss';
import { accuracyFacts, accuracySentences, expectedText, forecastFacts, meaningText, trendText } from './forecastInsight';

const fr = (weekStart: string, yhat: number, over: Partial<DssForecastRow> = {}): DssForecastRow => ({
  weekStart, h: 1, yhat, lo80: yhat - 4, hi80: yhat + 6, lo95: yhat - 7, hi95: yhat + 10, method: 'bottom_up', flags: [], censored: false, ...over,
});
const hist = (units: number[], censoredAt: number[] = []): DssHistoryRow[] => units.map((u, i) => ({ weekStart: `2026-0${1 + Math.floor(i / 5)}-${String(1 + (i % 5) * 7).padStart(2, '0')}`, units: u, censored: censoredAt.includes(i) }));
const bt = (policy: string, over: Partial<DssBacktestRow> = {}): DssBacktestRow => ({
  level: 'total', key: 'total', policy, horizon: 'all', weeks: 'all', n: 90, nWithInterval: 90, mae: 5.3, wape: 45.1, bias: -19.7, cov80: 75.6, cov95: 85.6, chosen: policy === 'chosen', ...over,
});

describe('forecastFacts', () => {
  const rows = [fr('2026-10-26', 14), fr('2026-11-02', 16)];

  it('averages the forecast and its ranges, sums the units, and finds the busiest week', () => {
    const f = forecastFacts(rows, hist([10, 10, 10, 10, 10, 10, 10, 10]))!;
    expect(f.weeklyAvg).toBe(15);
    expect(f.totalUnits).toBe(30);
    expect([f.lo80, f.hi80, f.lo95, f.hi95]).toEqual([11, 21, 8, 25]);
    expect(f.peakHi80).toBe(22);
    expect(f.recentAvg).toBe(10);
    expect(f.change).toBeCloseTo(0.5);
    expect(f.trend).toBe('up');
    expect(trendText(f)).toContain("50% above the last 8 weeks' average of 10 a week");
  });

  it('calls it stable inside the 15% band and falling below it', () => {
    expect(forecastFacts(rows, hist([14, 15, 16, 15, 14, 16, 15, 15]))!.trend).toBe('stable');
    expect(forecastFacts(rows, hist([30, 30, 30, 30, 30, 30, 30, 30]))!.trend).toBe('down');
  });

  it('has no range numbers when any week lacks one, and no trend without recent sales', () => {
    const f = forecastFacts([fr('2026-10-26', 14), fr('2026-11-02', 16, { lo80: null, hi80: null })], hist([0, 0, 0]))!;
    expect([f.lo80, f.hi80, f.peakHi80]).toEqual([null, null, null]);
    expect(f.trend).toBe('unknown');
    expect(trendText(f)).toContain('no recent sales to compare');
  });

  it('counts stock-out weeks and has nothing for no forecast', () => {
    expect(forecastFacts(rows, hist([5, 6, 7, 8], [1, 3]))!.stockoutWeeks).toBe(2);
    expect(forecastFacts([], hist([1]))).toBeNull();
  });
});

describe('sentences', () => {
  it('reads a tiny weekly figure as a gap between sales, and names the view', () => {
    expect(expectedText(0.2, 'product')).toBe('less than one unit a week (about one every 5 weeks)');
    expect(expectedText(15.04, 'total')).toBe('about 15 garments a week');
    expect(expectedText(3.5, 'garment_type')).toBe('about 3.5 units a week');
  });

  it('says what it means for the business, from the direction, and marks simulated figures', () => {
    const f = forecastFacts([fr('2026-10-26', 14), fr('2026-11-02', 16)], hist([10, 10, 10, 10]))!;
    expect(meaningText(f, 'total', false)).toContain('sales are rising');
    expect(meaningText(f, 'total', false)).toContain('about 22');
    expect(meaningText(f, 'total', true)).toContain('simulated figures');
    expect(meaningText(f, 'total', false)).not.toContain('simulated');
  });
});

describe('accuracy sentences', () => {
  const rows = [bt('chosen'), bt('ets_croston', { wape: 44.2, mae: 5.2, bias: -1.6, cov80: 72.2, cov95: 81.1 }), bt('naive', { wape: 64.7 }), bt('snaive', { n: 14, wape: 76.4 })];

  it('picks the best method only among those scored on the most weeks, and never the chosen mix or a short-history method', () => {
    const a = accuracyFacts(rows);
    expect(a.best?.policy).toBe('ets_croston');
    expect(a.mostWeeks).toBe(90);
  });

  it('explains WAPE as a total, a negative bias as under-prediction, and a short range', () => {
    const text = accuracySentences(rows).join(' ');
    expect(text).toContain('misses added up to 45.1% of the units that actually sold (WAPE)');
    expect(text).toContain('not the error of every single week');
    expect(text).toContain('bias is −19.7%');
    expect(text).toContain('under-predicts');
    expect(text).toContain('held only 75.6% of the time in the backtest, below the 80%');
    expect(text).toContain('Past results do not guarantee future ones');
    expect(text).toContain('ETS with Croston for slow sellers has the lowest WAPE (44.2%');
  });

  it('says a positive bias over-predicts and a small one has no lean', () => {
    expect(accuracySentences([bt('chosen', { bias: 12 })]).join(' ')).toContain('over-predicts');
    expect(accuracySentences([bt('chosen', { bias: 2, cov80: 80, cov95: 95 })]).join(' ')).toContain('no clear lean');
    expect(accuracySentences([bt('chosen', { bias: 2, cov80: 80, cov95: 95 })]).join(' ')).toContain('close to the 80%');
  });

  it('does not invent a score when nothing sold', () => {
    expect(accuracySentences([bt('chosen', { wape: null, bias: null, mae: null, cov80: null, cov95: null })]).join(' ')).toContain('could not be measured');
  });
});
