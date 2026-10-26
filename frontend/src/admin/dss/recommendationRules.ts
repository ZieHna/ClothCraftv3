import type { DssForecastLevel, DssRestockRow } from '../../api/adminDss';
import { expectedText, trendText, type AccuracyFacts, type ForecastFacts } from './forecastInsight';
import { percentText, signedPercentText, unitsText } from './forecastText';

/**
 * "Recommended actions based on the forecast" (S5c). Every card is worked out from the data of the view on screen: the forecast, the weeks it was trained on,
 * the backtest and the run's restock rows. A card appears only when the data supports it; when a figure the advice needs is not held (production capacity,
 * supplier lead times for making garments, stock figures that failed to load) the card says what is missing. Nothing is ordered or changed from here.
 * The rules and their limits are written into the sentences (for example "more than 26 weeks of stock at the expected pace").
 */
export type Tone = 'attention' | 'info' | 'needs-info';

export interface Recommendation {
  id: string;
  title: string;
  observation: string;
  action: string;
  reason: string;
  tone: Tone;
}

export interface RecommendationInput {
  level: DssForecastLevel;
  subject: string;
  /** the product template id or the garment type code; undefined for the total */
  itemKey?: string;
  facts: ForecastFacts | null;
  accuracy: AccuracyFacts | null;
  /** every restock row of the run, or null when they could not be loaded */
  restock: DssRestockRow[] | null;
}

/** More stock than this many weeks of the expected pace counts as slow-moving. */
export const SLOW_COVER_WEEKS = 26;
/** A WAPE above this (in percent) is called weak. */
export const WEAK_WAPE = 30;
/** An 80% range that held less than this share of the time is called too narrow. */
export const NARROW_80 = 77;

interface ProductLine {
  key: string;
  name: string;
  weekly: number;
  free: number;
  incoming: number;
}

export function rowsForView(rows: DssRestockRow[], level: DssForecastLevel, itemKey?: string): DssRestockRow[] {
  if (level === 'total') return rows;
  return rows.filter((r) => (level === 'garment_type' ? r.garmentType === itemKey : r.productTemplateId === itemKey));
}

function productLines(rows: DssRestockRow[]): ProductLine[] {
  const by = new Map<string, ProductLine>();
  for (const r of rows) {
    const line = by.get(r.productTemplateId) ?? { key: r.productTemplateId, name: r.product, weekly: 0, free: 0, incoming: 0 };
    line.weekly += r.weeklyDemand ?? 0;
    line.free += r.free;
    line.incoming += r.incoming;
    by.set(r.productTemplateId, line);
  }
  return Array.from(by.values());
}

const names = (lines: ProductLine[]) => lines.map((l) => l.name).join(', ');
const variantName = (r: DssRestockRow) => [r.product, r.size, r.color].filter(Boolean).join(' ');
const weeksText = (stock: number, weekly: number) => (weekly > 0 ? `${unitsText(stock / weekly)} weeks` : 'no expected sales');

export function buildRecommendations(input: RecommendationInput): Recommendation[] {
  const { level, subject, itemKey, facts, accuracy, restock } = input;
  const out: Recommendation[] = [];
  if (!facts) return out;
  const view = restock ? rowsForView(restock, level, itemKey) : null;
  const expected = expectedText(facts.weeklyAvg, level);

  // ---- inventory planning
  if (view === null) {
    out.push({
      id: 'inventory', title: 'Inventory planning', tone: 'needs-info',
      observation: `Expected sales are ${expected}.`,
      action: 'Compare your current stock with that pace yourself.',
      reason: 'The stock and restock figures for this run could not be loaded, so the DSS cannot compare them with the forecast here. Reload the page to try again.',
    });
  } else if (view.length === 0) {
    out.push({
      id: 'inventory', title: 'Inventory planning', tone: 'needs-info',
      observation: `Expected sales are ${expected}.`,
      action: 'Compare your stock with that pace yourself.',
      reason: 'This run holds no stock figures for this selection, so the DSS cannot say how long stock will last.',
    });
  } else {
    const stock = view.reduce((a, r) => a + r.free + r.incoming, 0);
    const cover = facts.weeklyAvg > 0 ? stock / facts.weeklyAvg : null;
    const short = cover !== null && cover < facts.weeks;
    out.push({
      id: 'inventory', title: 'Inventory planning', tone: short ? 'attention' : 'info',
      observation: `Expected sales are ${expected}. Free stock plus stock already on order is ${unitsText(stock)} units across all sizes and colours, which is ${weeksText(stock, facts.weeklyAvg)} at that pace.`,
      action: short
        ? `Check whether to restock soon: this stock covers fewer weeks than the ${facts.weeks}-week forecast.`
        : `Stock covers the ${facts.weeks}-week forecast at the expected pace, so this forecast alone does not call for more stock.`,
      reason: facts.peakHi80 !== null ? `A busy week could reach about ${unitsText(facts.peakHi80)}, so the cushion matters more than the average does. Stock by size and colour can still run short even when the total looks fine.` : 'Stock by size and colour can still run short even when the total looks fine.',
    });
  }

  // ---- production planning
  const peak = facts.peakHi80 !== null ? ` Busy weeks could reach about ${unitsText(facts.peakHi80)}.` : '';
  out.push({
    id: 'production', title: 'Production and purchasing', tone: 'info',
    observation: `${trendText(facts)} Expected sales are ${expected}.${peak}`,
    action:
      facts.trend === 'up'
        ? 'Consider planning production and purchasing a little above the expected pace.'
        : facts.trend === 'down'
          ? 'Consider holding production and purchasing at or below the expected pace.'
          : 'Consider planning production and purchasing at about the expected pace.',
    reason: 'It keeps what you make and buy close to what is likely to sell. ClothCraft does not hold your production capacity or the time it takes to make garments, so check this against them before you commit.',
  });

  // ---- restocking
  if (view && view.length > 0) {
    const flagged = view.filter((r) => r.urgency === 'order_now' || r.urgency === 'stockout_before_arrival');
    const plan = view.filter((r) => r.urgency === 'plan');
    const examples = flagged.slice(0, 3).map((r) => `${variantName(r)} (${r.daysLeft !== null ? `about ${unitsText(r.daysLeft)} days of stock left` : 'no run-out date'}, ${r.suggestedQty} suggested)`);
    out.push({
      id: 'restock', title: 'Restocking', tone: flagged.length > 0 ? 'attention' : 'info',
      observation: flagged.length > 0
        ? `${flagged.length} variant${flagged.length === 1 ? ' is' : 's are'} flagged to order now or to run out before a new order could arrive${plan.length ? `, and ${plan.length} more to plan for` : ''}. For example: ${examples.join('; ')}.`
        : `No variant here is flagged to order now or to run out before a new order could arrive${plan.length ? `; ${plan.length} to plan for` : ''}.`,
      action: flagged.length > 0 ? 'Review these in Stocks, Restocks, and approve the restocks you agree with. Nothing has been ordered.' : 'No restock is needed from the DSS right now.',
      reason: 'The DSS compares each variant’s stock, stock on order and expected demand with its supplier’s delivery time, so you see a shortage before the shelf is empty.',
    });
  }

  // ---- high-demand and slow-moving products (a total or a garment type holds several products; a single product is judged on its own)
  if (view && view.length > 0) {
    const lines = productLines(view);
    if (level !== 'product') {
      const selling = lines.filter((l) => l.weekly > 0).sort((a, b) => b.weekly - a.weekly);
      if (selling.length >= 2) {
        const top = selling.slice(0, 3);
        out.push({
          id: 'high-demand', title: 'High-demand products', tone: 'info',
          observation: `The products with the highest expected sales are ${top.map((l) => `${l.name} (${unitsText(l.weekly)} a week, ${unitsText(l.free + l.incoming)} units in stock or on order)`).join(', ')}.`,
          action: `Check the stock of ${names(top)} first.`,
          reason: 'They sell fastest, so a shortage there costs the most sales.',
        });
      }
    }
    const slow = lines
      .filter((l) => l.free + l.incoming > 0 && (l.weekly === 0 || (l.free + l.incoming) / l.weekly > SLOW_COVER_WEEKS))
      .sort((a, b) => (b.weekly === 0 ? Infinity : (b.free + b.incoming) / b.weekly) - (a.weekly === 0 ? Infinity : (a.free + a.incoming) / a.weekly));
    if (slow.length > 0) {
      const top = slow.slice(0, 3);
      out.push({
        id: 'slow-moving', title: 'Slow-moving stock', tone: 'attention',
        observation: `${level === 'product' ? subject : names(top)} ${level === 'product' || top.length === 1 ? 'holds' : 'hold'} more than ${SLOW_COVER_WEEKS} weeks of stock at the expected pace: ${top.map((l) => `${l.name}, ${unitsText(l.free + l.incoming)} units for ${weeksText(l.free + l.incoming, l.weekly)}`).join('; ')}${slow.length > top.length ? `; ${slow.length - top.length} more` : ''}.`,
        action: 'Review this stock before producing or buying more of it.',
        reason: 'Stock that sells slowly ties up money and space that faster items could use.',
      });
    }
  }

  // ---- forecast reliability
  if (!accuracy || !accuracy.chosen) {
    out.push({
      id: 'reliability', title: 'How far to trust it', tone: 'needs-info',
      observation: 'There are no backtest results for this selection.',
      action: 'Treat the forecast as a rough guide only.',
      reason: 'Without a backtest there is no evidence of how well this kind of forecast has done on past weeks.',
    });
  } else {
    const c = accuracy.chosen;
    const concerns: string[] = [];
    if (c.wape !== null && c.wape > WEAK_WAPE) concerns.push(`its misses add up to ${percentText(c.wape)} of the units sold (WAPE, above ${WEAK_WAPE}%)`);
    if (c.bias !== null && c.bias <= -5) concerns.push(`it leans low (bias ${signedPercentText(c.bias)})`);
    if (c.bias !== null && c.bias >= 5) concerns.push(`it leans high (bias ${signedPercentText(c.bias)})`);
    if (c.cov80 !== null && c.cov80 < NARROW_80) concerns.push(`the 80% range held only ${percentText(c.cov80)} of the time`);
    if (facts.lo80 !== null && facts.hi80 !== null && facts.hi80 - facts.lo80 >= facts.weeklyAvg) concerns.push('the 80% range is as wide as the forecast itself');
    out.push({
      id: 'reliability', title: 'How far to trust it', tone: concerns.length ? 'attention' : 'info',
      observation: concerns.length ? `On past weeks, ${concerns.join('; ')}.` : `On past weeks the forecast did reasonably: WAPE ${percentText(c.wape)}, bias ${signedPercentText(c.bias)}, and its ranges held about as often as intended.`,
      action: concerns.length ? 'Treat the forecast as a rough guide. Use the upper edge of the range when running out would cost more than having a little extra, and compare it with real sales every week.' : 'It is reasonable to use it as a guide, while still comparing it with real sales every week.',
      reason: 'A forecast that has been wrong by a lot, or always in one direction, should carry less weight in your decisions.',
    });
  }

  // ---- data improvement
  const dataNotes: string[] = [];
  if (facts.flags.includes('not_enough_history')) dataNotes.push('it has too few weeks with a sale to forecast on its own, so the forecast is a share of its garment type’s');
  if (facts.stockoutWeeks > 0) dataNotes.push(`${facts.stockoutWeeks} of its ${facts.historyWeeks} weeks of history were stock-out weeks, when sales were limited by stock`);
  if (facts.flags.includes('intermittent')) dataNotes.push('it sells on and off, with many weeks of no sales, so a weekly forecast is rough');
  if (dataNotes.length) {
    out.push({
      id: 'data', title: 'Better data', tone: 'attention',
      observation: `For ${subject}: ${dataNotes.join('; ')}.`,
      action: 'Keep recording every sale, keep items in stock where you can, and revisit the forecast as more weeks of sales are collected.',
      reason: 'ClothCraft cannot see sales it lost while an item was out of stock, so demand is understated for items that sell out. More history makes the forecast steadier.',
    });
  }
  return out;
}

