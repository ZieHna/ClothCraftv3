import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { DssForecastRow, DssHistoryRow, DssStatus } from '../../api/adminDss';
import { KindBadge } from './RunBanner';
import { methodLabel, monthText, rangeText, STOCKOUT_TEXT, unitsText, weekText } from './forecastText';

const HEIGHT = 260;
const MARGIN = { l: 38, r: 10, t: 12, b: 30 };
const DEFAULT_WIDTH = 640;

/** The chart's own width in pixels (so the text in it stays at a readable size on a phone), kept up to date when the window changes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const measure = () => {
      const measured = ref.current?.getBoundingClientRect().width ?? 0;
      if (measured > 0) setWidth(Math.max(260, Math.floor(measured)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return { ref, width };
}

/** A round upper limit for the vertical axis. Only the largest value is used, to scale the picture. */
function axisMax(largest: number): number {
  if (!(largest > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(largest));
  return [1, 2, 2.5, 5, 10].map((m) => m * step).find((m) => m >= largest) ?? largest;
}

interface Props {
  history: DssHistoryRow[] | null;
  rows: DssForecastRow[];
  /** "Total", "Women Tee" ... for the heading and the table caption */
  subject: string;
  simulated: boolean;
  /** why the history is missing, in the engine's words */
  historyStatus: DssStatus | null;
}

/**
 * The weekly units a forecast was trained on, the forecast, and its 80 % and 95 % ranges, as inline SVG, with "Show as a table" for the same numbers.
 * A stock-out week is drawn as a square with a cross AND listed as "Stock-out week" in the table: shape and words, never colour alone. The badge
 * (REAL DATA / SIMULATED DATA) is in the heading and again in the table caption, so a copy of either one still says what it is.
 * The parent gives this a new `key` for each subject, so the chart/table choice starts on the chart for a new subject.
 */
export function ForecastChart({ history, rows, subject, simulated, historyStatus }: Props) {
  const ids = useId();
  const { ref, width } = useWidth();
  const [asTable, setAsTable] = useState(false);
  const past = history ?? [];
  const n = past.length + rows.length;
  const top = axisMax(Math.max(0, ...past.map((p) => p.units), ...rows.map((r) => r.hi95 ?? r.yhat)));
  const plotW = width - MARGIN.l - MARGIN.r;
  const plotH = HEIGHT - MARGIN.t - MARGIN.b;
  const x = (i: number) => MARGIN.l + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v: number) => MARGIN.t + plotH - (v / top) * plotH;
  const point = (i: number, v: number) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  const first = past.length; // the index of the first forecast week

  const band = (lo: 'lo80' | 'lo95', hi: 'hi80' | 'hi95') => {
    const upper: string[] = [];
    const lower: string[] = [];
    rows.forEach((r, k) => {
      const l = r[lo];
      const h = r[hi];
      if (l === null || h === null) return;
      upper.push(point(first + k, h));
      lower.unshift(point(first + k, l));
    });
    return upper.length >= 2 ? [...upper, ...lower].join(' ') : null;
  };
  const band95 = band('lo95', 'hi95');
  const band80 = band('lo80', 'hi80');
  const line = past.map((p, i) => point(i, p.units)).join(' ');
  const forecastLine = rows.map((r, k) => point(first + k, r.yhat)).join(' ');
  const censored = past.map((p, i) => ({ p, i })).filter(({ p }) => p.censored);
  const labelFractions = width < 420 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const labelAt = Array.from(new Set(labelFractions.map((f) => Math.round(f * (n - 1)))));
  const days = [...past.map((p) => p.weekStart), ...rows.map((r) => r.weekStart)];
  const ticks = [0, top / 2, top];
  const divider = x(first) - plotW / (2 * Math.max(n - 1, 1));
  const method = Array.from(new Set(rows.map((r) => r.method)));
  const stockoutWeeks = censored.length;
  const statusLine = historyStatus && (history === null || history.length === 0);

  return (
    <section aria-labelledby={`${ids}-h`} className="min-w-0" data-testid="forecast-chart">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${ids}-h`} className="flex flex-wrap items-center gap-2 text-xl">
          <KindBadge simulated={simulated} /> <span>Units a week: {subject}</span>
        </h3>
        <button type="button" className="btn btn-secondary" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)} data-testid="chart-toggle">
          {asTable ? 'Show as a chart' : 'Show as a table'}
        </button>
      </div>
      <p className="mt-1 text-sm text-muted" data-testid="forecast-method">
        Forecast method for these weeks: {method.length ? method.map(methodLabel).join(', ') : '—'}.
      </p>
      {statusLine && (
        <p className="mt-1 text-sm text-ink" role="note" data-testid="history-status">
          {historyStatus.message ?? historyStatus.code}
        </p>
      )}

      {!asTable && (
        <div ref={ref} className="mt-2 w-full min-w-0">
          <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-labelledby={`${ids}-t ${ids}-d`} className="block max-w-full" data-testid="chart-svg">
            <title id={`${ids}-t`}>Weekly units: {subject}</title>
            <desc id={`${ids}-d`}>
              {`${past.length} weeks of actual units, then ${rows.length} weeks of forecast with 80% and 95% ranges.${stockoutWeeks > 0 ? ` ${stockoutWeeks} stock-out weeks are marked with a crossed square.` : ''} The numbers are in the table: use Show as a table.`}
            </desc>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={MARGIN.l} x2={width - MARGIN.r} y1={y(t)} y2={y(t)} className="stroke-tan" strokeWidth={1} />
                <text x={MARGIN.l - 6} y={y(t) + 4} textAnchor="end" className="fill-muted" fontSize={12}>
                  {unitsText(t)}
                </text>
              </g>
            ))}
            {rows.length > 0 && past.length > 0 && <line x1={divider} x2={divider} y1={MARGIN.t} y2={MARGIN.t + plotH} className="stroke-brown" strokeWidth={1} strokeDasharray="2 3" />}
            {band95 && <polygon points={band95} className="fill-brown opacity-15" data-testid="band95" />}
            {band80 && <polygon points={band80} className="fill-brown opacity-30" data-testid="band80" />}
            {past.length > 1 && <polyline points={line} fill="none" className="stroke-ink" strokeWidth={1.75} strokeLinejoin="round" />}
            {rows.length > 0 && <polyline points={forecastLine} fill="none" className="stroke-sage-dark" strokeWidth={2.25} strokeDasharray="6 4" />}
            {rows.map((r, k) => (
              <circle key={r.weekStart} cx={x(first + k)} cy={y(r.yhat)} r={3} className="fill-sage-dark" />
            ))}
            {censored.map(({ p, i }) => (
              <g key={p.weekStart} data-testid="stockout-marker" transform={`translate(${x(i).toFixed(1)} ${y(p.units).toFixed(1)})`}>
                <rect x={-5.5} y={-5.5} width={11} height={11} className="fill-cream stroke-brown-dark" strokeWidth={1.5} />
                <path d="M-3.5 -3.5L3.5 3.5M-3.5 3.5L3.5 -3.5" className="stroke-brown-dark" strokeWidth={1.5} />
              </g>
            ))}
            {labelAt.map((i) => (
              <text key={i} x={x(i)} y={HEIGHT - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="fill-muted" fontSize={12}>
                {monthText(days[i])}
              </text>
            ))}
          </svg>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm" aria-label="Chart key" data-testid="chart-key">
            <li className="flex items-center gap-2">
              <svg width="26" height="10" aria-hidden="true">
                <line x1="0" x2="26" y1="5" y2="5" className="stroke-ink" strokeWidth={2} />
              </svg>
              Actual units
            </li>
            <li className="flex items-center gap-2">
              <svg width="26" height="10" aria-hidden="true">
                <line x1="0" x2="26" y1="5" y2="5" className="stroke-sage-dark" strokeWidth={2.25} strokeDasharray="6 4" />
              </svg>
              Forecast
            </li>
            <li className="flex items-center gap-2">
              <svg width="18" height="12" aria-hidden="true">
                <rect width="18" height="12" className="fill-brown opacity-30" />
              </svg>
              80% range
            </li>
            <li className="flex items-center gap-2">
              <svg width="18" height="12" aria-hidden="true">
                <rect width="18" height="12" className="fill-brown opacity-15" />
              </svg>
              95% range
            </li>
            {stockoutWeeks > 0 && (
              <li className="flex items-center gap-2">
                <svg width="14" height="14" aria-hidden="true">
                  <rect x="1.5" y="1.5" width="11" height="11" className="fill-cream stroke-brown-dark" strokeWidth={1.5} />
                  <path d="M3.5 3.5L10.5 10.5M3.5 10.5L10.5 3.5" className="stroke-brown-dark" strokeWidth={1.5} />
                </svg>
                Stock-out week (sales understated)
              </li>
            )}
          </ul>
        </div>
      )}

      {asTable && (
        <div className="mt-2" data-testid="chart-table">
          <div className="max-h-96 overflow-y-auto border border-tan" tabIndex={0} role="region" aria-label={`Weekly units table: ${subject}`}>
            <table className="w-full table-fixed border-collapse text-xs sm:text-sm">
              <caption className="border-b border-tan bg-paper p-2 text-left">
                <KindBadge simulated={simulated} /> <span className="font-medium">Weekly units: {subject}</span>
                <span className="block text-muted">Units a week. The ranges are where the sales should fall 80% and 95% of the time.</span>
              </caption>
              <thead className="sticky top-0 bg-paper-warm text-left">
                <tr>
                  <th scope="col" className="w-[26%] p-1.5 font-semibold">
                    Week from
                  </th>
                  <th scope="col" className="w-[28%] p-1.5 font-semibold">
                    Units
                  </th>
                  <th scope="col" className="w-[23%] p-1.5 font-semibold">
                    80% range
                  </th>
                  <th scope="col" className="w-[23%] p-1.5 font-semibold">
                    95% range
                  </th>
                </tr>
              </thead>
              <tbody>
                {past.map((p) => (
                  <tr key={p.weekStart} className="border-t border-tan align-top" data-testid="table-row-actual">
                    <th scope="row" className="p-1.5 text-left font-normal">
                      {weekText(p.weekStart)}
                    </th>
                    <td className="p-1.5">
                      Actual {unitsText(p.units)}
                      {p.censored && (
                        <span className="mt-0.5 block font-medium text-brown-dark" data-testid="table-stockout">
                          {STOCKOUT_TEXT}
                        </span>
                      )}
                    </td>
                    <td className="p-1.5">—</td>
                    <td className="p-1.5">—</td>
                  </tr>
                ))}
                {rows.map((r) => (
                  <tr key={r.weekStart} className="border-t border-tan bg-paper align-top" data-testid="table-row-forecast">
                    <th scope="row" className="p-1.5 text-left font-normal">
                      {weekText(r.weekStart)}
                    </th>
                    <td className="p-1.5">Forecast {unitsText(r.yhat)}</td>
                    <td className="p-1.5">{rangeText(r.lo80, r.hi80)}</td>
                    <td className="p-1.5">{rangeText(r.lo95, r.hi95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
