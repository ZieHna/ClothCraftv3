/**
 * Plain-words meanings of the terms on the Forecast tab. Each was checked against the engine (addons/clothcraft_dss/engine/forecast.py and methods.py):
 * errors are e = forecast - actual, WAPE = sum|e| / sum(actual), bias = sum(e) / sum(actual) so a NEGATIVE bias means the forecast was lower than what sold,
 * ETS here is "additive error, additive damped trend, no seasonality", Croston is the Syntetos-Boylan version. Display text only.
 */
export interface Term {
  /** the word as the page shows it */
  term: string;
  /** what it stands for, when it is an abbreviation */
  full?: string;
  text: string;
}

export const TERMS = {
  dss: { term: 'DSS', full: 'Decision Support System', text: 'Uses the shop’s own orders and stock to help you decide what to do. It suggests; you decide.' },
  horizon: { term: 'Forecast horizon', text: 'How many weeks ahead the forecast looks. Here it is the next 8 weeks.' },
  range80: { term: '80% range', text: 'The shaded band closest to the line. Real sales should land inside it about 8 weeks in 10, if the method’s assumptions hold. It is not a promise.' },
  range95: { term: '95% range', text: 'The wider, lighter band. Real sales should land inside it about 19 weeks in 20, if the method’s assumptions hold.' },
  stockout: { term: 'Stock-out week', text: 'A week the item sold out. Sales that week were limited by stock, so the units understate what people wanted.' },
  backtest: { term: 'Backtest', text: 'A check run on the past: the forecast is made as if from a few weeks earlier, then compared with what really sold.' },
  baseline: { term: 'Baseline', text: 'A very simple rule (repeat last week, or average the last 4 weeks) that any forecast should beat to be worth using.' },
  wape: { term: 'WAPE', full: 'Weighted Absolute Percentage Error', text: 'All the misses added up, as a share of everything that sold. Lower is better. It is a total, not the error of each week.' },
  mae: { term: 'MAE', full: 'Mean Absolute Error', text: 'The average miss, in units a week. Lower is better.' },
  bias: { term: 'Bias', text: 'Whether the forecast leans low or high. Below zero means it was lower than what sold (under-predicts); above zero, higher (over-predicts).' },
  held: { term: '80% / 95% held', text: 'How often real sales fell inside the range in the backtest. It should be close to 80% and 95%.' },
  weeksScored: { term: 'Weeks scored', text: 'How many forecast weeks the method was checked on in the backtest. The same real week can be checked more than once, at different distances ahead.' },
  ets: { term: 'ETS', full: 'Error, Trend, Seasonality', text: 'Smooths past sales and carries a gently fading trend forward. In ClothCraft it has no seasonal pattern, because there is not yet enough history for one.' },
  croston: { term: 'Croston', full: 'Croston’s method', text: 'Made for items that sell now and then. It estimates how big a typical sale is and how many weeks pass between sales.' },
} satisfies Record<string, Term>;

export type TermKey = keyof typeof TERMS;

/** A short sentence for a method code, for the line that says which method made the forecast. Unknown codes have none. */
export const METHOD_GLOSS: Record<string, string> = {
  ets: 'Smooths past sales and carries a fading trend forward, with no seasonal pattern.',
  croston: 'For items that sell now and then: the size of a typical sale and the gap between sales.',
  ma4: 'The average of the last 4 weeks.',
  naive: 'The last week repeated.',
  snaive: 'The same week a year earlier.',
  bottom_up: 'Added up from the forecasts of the products inside it.',
  group_share: 'Too few weeks with sales: a share of its garment type’s forecast.',
};
