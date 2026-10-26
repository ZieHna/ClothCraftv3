import { describe, expect, it } from 'vitest';
import type { DssBacktestRow, DssForecastRow, DssHistoryRow, DssRestockRow } from '../../api/adminDss';
import { accuracyFacts, forecastFacts } from './forecastInsight';
import { buildRecommendations, rowsForView } from './recommendationRules';

const fr = (yhat: number, flags: string[] = []): DssForecastRow => ({ weekStart: '2026-10-26', h: 1, yhat, lo80: yhat * 0.8, hi80: yhat * 1.2, lo95: yhat * 0.6, hi95: yhat * 1.5, method: 'croston', flags, censored: false });
const hist = (units: number[], censored = false): DssHistoryRow[] => units.map((u, i) => ({ weekStart: `2026-09-${String(1 + i).padStart(2, '0')}`, units: u, censored: censored && i === 0 }));
const bt = (over: Partial<DssBacktestRow> = {}): DssBacktestRow => ({ level: 'total', key: 'total', policy: 'chosen', horizon: 'all', weeks: 'all', n: 90, nWithInterval: 90, mae: 5, wape: 20, bias: 1, cov80: 80, cov95: 95, chosen: true, ...over });
const rr = (over: Partial<DssRestockRow>): DssRestockRow => ({
  productId: '1', productTemplateId: '10', sku: 'S', product: 'Tee', garmentType: 'TEE', size: 'M', color: 'Black', onHand: 5, reserved: 0, free: 5, incoming: 0,
  weeklyDemand: 2, daysLeft: null, leadDays: 7, suggestedQty: 0, orderNow: false, stockoutBeforeArrival: false, urgency: 'ok', ...over,
});
const ids = (list: ReturnType<typeof buildRecommendations>) => list.map((r) => r.id);

describe('recommendations follow the data', () => {
  const facts = forecastFacts([fr(10), fr(10), fr(10), fr(10)], hist([8, 8, 8, 8]))!;
  const good = accuracyFacts([bt()]);

  it('has nothing to say without a forecast', () => {
    expect(buildRecommendations({ level: 'total', subject: 'Total', facts: null, accuracy: good, restock: [] })).toEqual([]);
  });

  it('says the stock figures are missing instead of guessing, when they could not be loaded', () => {
    const out = buildRecommendations({ level: 'total', subject: 'Total', facts, accuracy: good, restock: null });
    const inv = out.find((r) => r.id === 'inventory')!;
    expect(inv.tone).toBe('needs-info');
    expect(inv.reason).toContain('could not be loaded');
    expect(ids(out)).not.toContain('restock');
  });

  it('asks for a restock check when the stock covers fewer weeks than the forecast', () => {
    const out = buildRecommendations({ level: 'total', subject: 'Total', facts, accuracy: good, restock: [rr({ free: 20, incoming: 10 })] });
    const inv = out.find((r) => r.id === 'inventory')!;
    expect(inv.tone).toBe('attention');
    expect(inv.observation).toContain('30 units');
    expect(inv.observation).toContain('3 weeks');
    expect(inv.action).toContain('restock soon');
  });

  it('is content when the stock covers the horizon', () => {
    const out = buildRecommendations({ level: 'total', subject: 'Total', facts, accuracy: good, restock: [rr({ free: 500 })] });
    expect(out.find((r) => r.id === 'inventory')!.tone).toBe('info');
  });

  it('lists variants flagged to order now, without ordering anything', () => {
    const rows = [rr({ urgency: 'order_now', orderNow: true, daysLeft: 6, suggestedQty: 14, product: 'Women Tee' }), rr({ productId: '2', urgency: 'ok' })];
    const r = buildRecommendations({ level: 'total', subject: 'Total', facts, accuracy: good, restock: rows }).find((x) => x.id === 'restock')!;
    expect(r.tone).toBe('attention');
    expect(r.observation).toContain('Women Tee');
    expect(r.observation).toContain('14 suggested');
    expect(r.action).toContain('Nothing has been ordered');
  });

  it('names the fastest sellers on a total, and only on a total or a garment type', () => {
    const rows = [
      rr({ productTemplateId: '1', product: 'A', weeklyDemand: 9 }), rr({ productId: '2', productTemplateId: '2', product: 'B', weeklyDemand: 5 }),
      rr({ productId: '3', productTemplateId: '3', product: 'C', weeklyDemand: 1 }),
    ];
    const total = buildRecommendations({ level: 'total', subject: 'Total', facts, accuracy: good, restock: rows });
    expect(total.find((r) => r.id === 'high-demand')!.observation).toMatch(/^The products with the highest expected sales are A \(9 a week.*B \(5 a week.*C \(1 a week/);
    expect(ids(buildRecommendations({ level: 'product', subject: 'A', itemKey: '1', facts, accuracy: good, restock: rows }))).not.toContain('high-demand');
  });

  it('flags slow-moving stock beyond 26 weeks of the expected pace, for the selected product only', () => {
    const rows = [rr({ productTemplateId: '1', product: 'Slow', weeklyDemand: 0.1, free: 40 }), rr({ productId: '2', productTemplateId: '2', product: 'Fast', weeklyDemand: 10, free: 20 })];
    const one = buildRecommendations({ level: 'product', subject: 'Slow', itemKey: '1', facts, accuracy: good, restock: rows });
    expect(one.find((r) => r.id === 'slow-moving')!.observation).toContain('Slow, 40 units for 400 weeks');
    expect(one.find((r) => r.id === 'slow-moving')!.observation).not.toContain('Fast');
    const fast = buildRecommendations({ level: 'product', subject: 'Fast', itemKey: '2', facts, accuracy: good, restock: rows });
    expect(ids(fast)).not.toContain('slow-moving');
  });

  it('uses only the rows of the selected view', () => {
    const rows = [rr({ garmentType: 'TEE', productTemplateId: '1' }), rr({ productId: '2', garmentType: 'HOOD', productTemplateId: '2' })];
    expect(rowsForView(rows, 'total')).toHaveLength(2);
    expect(rowsForView(rows, 'garment_type', 'HOOD').map((r) => r.productTemplateId)).toEqual(['2']);
    expect(rowsForView(rows, 'product', '1').map((r) => r.garmentType)).toEqual(['TEE']);
    expect(buildRecommendations({ level: 'product', subject: 'X', itemKey: '99', facts, accuracy: good, restock: rows }).find((r) => r.id === 'inventory')!.tone).toBe('needs-info');
  });

  it('warns when the past accuracy is weak, leaning or its range too narrow, and says when there is no backtest', () => {
    const weak = buildRecommendations({ level: 'total', subject: 'Total', facts, accuracy: accuracyFacts([bt({ wape: 45, bias: -20, cov80: 70 })]), restock: [] }).find((r) => r.id === 'reliability')!;
    expect(weak.tone).toBe('attention');
    expect(weak.observation).toContain('WAPE, above 30%');
    expect(weak.observation).toContain('leans low');
    expect(weak.observation).toContain('held only 70.0%');
    expect(buildRecommendations({ level: 'total', subject: 'Total', facts, accuracy: null, restock: [] }).find((r) => r.id === 'reliability')!.tone).toBe('needs-info');
    expect(buildRecommendations({ level: 'total', subject: 'Total', facts, accuracy: good, restock: [] }).find((r) => r.id === 'reliability')!.tone).toBe('info');
  });

  it('suggests better data for a thin, stocked-out or on-and-off series', () => {
    const f = forecastFacts([fr(1, ['not_enough_history', 'intermittent'])], hist([0, 1, 0, 0, 2], true))!;
    const d = buildRecommendations({ level: 'product', subject: 'Baby Dress', itemKey: '1', facts: f, accuracy: good, restock: [] }).find((r) => r.id === 'data')!;
    expect(d.observation).toContain('too few weeks with a sale');
    expect(d.observation).toContain('1 of its 5 weeks');
    expect(d.observation).toContain('on and off');
    expect(ids(buildRecommendations({ level: 'total', subject: 'Total', facts, accuracy: good, restock: [] }))).not.toContain('data');
  });

  it('the production card never claims to know capacity, and leans with the trend', () => {
    const up = forecastFacts([fr(20), fr(20)], hist([8, 8, 8, 8]))!;
    const p = buildRecommendations({ level: 'total', subject: 'Total', facts: up, accuracy: good, restock: [] }).find((r) => r.id === 'production')!;
    expect(p.action).toContain('a little above');
    expect(p.reason).toContain('does not hold your production capacity');
  });
});
