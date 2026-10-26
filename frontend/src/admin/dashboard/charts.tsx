import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * Hand-drawn SVG charts for the admin dashboard (no chart package). The only arithmetic in the browser is value / largest value, to size a bar:
 * there are no axis ticks, no sums, no averages, no splits of money. Every number you read is a figure the server sent, already formatted by
 * the caller (`shown`). Every chart has a table with the same data, a chart is announced with a title and a summary, nothing moves (so there is
 * nothing to switch off under reduced motion), and everything is token-coloured and scales down to 320 px.
 */
export interface Bar {
  key: string;
  /** short text for under a bar: "Oct 26" */
  label: string;
  value: number;
  /** the server's figure as text: "₱349.00" */
  shown: string;
  /** one sentence about this bar, for the "look at one" line */
  detail: string;
  /** a second, separate figure for the same period (drawn as a lighter outlined bar beside this one, never added to it) */
  pending?: { value: number; shown: string };
}

/** The size of a bar as a percentage of the largest one. */
const pct = (value: number, largest: number): number => (largest > 0 ? (value / largest) * 100 : 0);

export function ChartCard({ title, note, link, children, testId }: { title: string; note?: string; link?: { to: string; label: string }; children: ReactNode; testId?: string }) {
  return (
    <section className="min-w-0 border border-tan bg-cream p-4 sm:p-5" data-testid={testId}>
      <h2 className="text-2xl">{title}</h2>
      {note && <p className="mt-1 text-sm text-muted">{note}</p>}
      <div className="mt-3">{children}</div>
      {link && (
        <p className="mt-2">
          <Link to={link.to} className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4" data-testid="card-link">
            {link.label} →
          </Link>
        </p>
      )}
    </section>
  );
}

/** The same data as text, for people who cannot see the chart (and anyone who prefers numbers). */
export function DataTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: ReactNode[][] }) {
  return (
    <details className="mt-3" data-testid="chart-table">
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium underline underline-offset-4">Show as a table</summary>
      <div className="overflow-x-auto">
        <table className="mt-2 w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-brown-dark text-muted">
              {columns.map((c) => (
                <th key={c} scope="col" className="px-2 py-1.5 font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-tan">
                {row.map((cell, j) =>
                  j === 0 ? (
                    <th key={j} scope="row" className="px-2 py-1.5 font-medium">
                      {cell}
                    </th>
                  ) : (
                    <td key={j} className="px-2 py-1.5">
                      {cell}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * Vertical bars, one per period. The bars are SVG shapes; the month names are text under them in a grid of the same number of columns, thinned
 * when there are many. A "look at one" selector (a native select, so it works by touch and keyboard at any width) shows the chosen bar's detail.
 */
export function ColumnChart({ title, summary, bars }: { title: string; summary: string; bars: Bar[] }) {
  const id = useId();
  const [at, setAt] = useState('');
  const n = bars.length;
  const largest = Math.max(0, ...bars.flatMap((b) => [b.value, b.pending?.value ?? 0]));
  const twin = bars.some((b) => b.pending !== undefined);
  const step = n > 24 ? 6 : n > 12 ? 3 : n > 6 ? 2 : 1;
  const chosen = bars.find((b) => b.key === at);
  return (
    <div>
      <svg role="img" aria-labelledby={`${id}-t`} viewBox={`0 0 ${n * 10} 100`} preserveAspectRatio="none" className="h-44 w-full" data-testid="column-chart">
        <title id={`${id}-t`}>{`${title}. ${summary}`}</title>
        <line x1="0" x2={n * 10} y1="100" y2="100" className="stroke-tan" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {bars.map((b, i) => {
          const h = b.value > 0 ? Math.max(pct(b.value, largest), 1.5) : 0;
          const p = b.pending && b.pending.value > 0 ? Math.max(pct(b.pending.value, largest), 1.5) : 0;
          const width = twin ? 3.6 : 8;
          return (
            <g key={b.key}>
              <rect x={i * 10 + 1} y={100 - h} width={width} height={h} className={b.key === at ? 'fill-sage-dark stroke-ink' : 'fill-sage-dark'} strokeWidth={b.key === at ? 3 : 0} vectorEffect="non-scaling-stroke">
                <title>{`${b.label}: ${b.shown}`}</title>
              </rect>
              {b.pending && p > 0 && (
                <rect x={i * 10 + 5.4} y={100 - p} width={width} height={p} className="fill-cream stroke-sage-dark" strokeWidth="2" strokeDasharray="4 3" vectorEffect="non-scaling-stroke">
                  <title>{`${b.label}, delivered and awaiting confirmation: ${b.pending.shown}`}</title>
                </rect>
              )}
            </g>
          );
        })}
      </svg>
      <ol className="grid text-center text-xs text-muted" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }} aria-hidden="true">
        {bars.map((b, i) => (
          <li key={b.key} className="min-w-0">
            {i % step === 0 ? <span className="block truncate">{b.label}</span> : <span className="block">&nbsp;</span>}
            {n <= 6 && <span className={`block truncate font-medium text-ink ${n > 3 ? 'max-sm:hidden' : ''}`}>{b.shown}</span>}
          </li>
        ))}
      </ol>
      {twin && (
        <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" data-testid="chart-legend">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-3 bg-sage-dark" /> Earned (closed)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-3 border-2 border-dashed border-sage-dark bg-cream" /> Delivered, awaiting confirmation (not earnings)
          </span>
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-pick`} className="text-sm font-medium">
          Look at one month
        </label>
        <select id={`${id}-pick`} value={at} onChange={(e) => setAt(e.target.value)} className="min-h-11 border border-brown-dark bg-paper px-2 py-1 text-base">
          <option value="">Choose…</option>
          {bars.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </select>
      </div>
      <p role="status" className="mt-1 min-h-6 text-sm text-ink" data-testid="chart-pick">
        {chosen ? chosen.detail : ''}
      </p>
    </div>
  );
}

/** Horizontal bars, one per row: the label and the server's figure are text; the bar under them is a small SVG. */
export function BarRows({ bars, testId }: { bars: Bar[]; testId?: string }) {
  const largest = Math.max(0, ...bars.map((b) => b.value));
  return (
    <ul className="space-y-3" data-testid={testId}>
      {bars.map((b) => (
        <li key={b.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 break-words">{b.label}</span>
            <span className="shrink-0 font-semibold text-ink">{b.shown}</span>
          </div>
          <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="mt-1 h-2 w-full" aria-hidden="true">
            <rect x="0" y="0" width="100" height="6" className="fill-paper-warm" />
            <rect x="0" y="0" width={b.value > 0 ? Math.max(pct(b.value, largest), 1.5) : 0} height="6" className="fill-sage-dark" />
          </svg>
        </li>
      ))}
    </ul>
  );
}

/** "Oct 26" for 2026-10. */
export function monthShort(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return y && m ? new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit' }).format(new Date(y, m - 1, 15)) : month;
}
/** "October 2026" for 2026-10. */
export function monthLong(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return y && m ? new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 15)) : month;
}
