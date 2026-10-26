import { useId, useMemo, useState, type MouseEvent } from 'react';
import type { SupplyLine } from '../../api/suppliers';
import { pesos } from './supplierText';
import { Cell, control, EDITING_ROW, lineName } from './supplierUi';

type SortKey = 'garment' | 'size' | 'color' | 'cost';
type Sort = { key: SortKey; dir: 'asc' | 'desc' } | null;

const SORT_LABEL: Record<SortKey, string> = { garment: 'Garment type', size: 'Size', color: 'Colour', cost: 'Unit cost' };
/** Sizes in their real order; any size not listed goes after these, alphabetically. */
const SIZE_ORDER = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL'];
const ARROW = { asc: '▲', desc: '▼', none: '↕' } as const;

const text = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const sizeRank = (name: string): number => {
  const at = SIZE_ORDER.indexOf(name.trim().toUpperCase());
  return at < 0 ? Number.POSITIVE_INFINITY : at;
};

/** Compares two lines for `key`, ascending. Ties return 0, so the sort (stable) keeps the order the server sent. */
function compare(a: SupplyLine, b: SupplyLine, key: SortKey, dir: 1 | -1): number {
  if (key === 'cost') return a.unitCost < b.unitCost ? -dir : a.unitCost > b.unitCost ? dir : 0; // the server's number, compared as it is
  if (key === 'size') {
    const ra = sizeRank(a.size.name);
    const rb = sizeRank(b.size.name);
    if (ra === rb) return ra === Number.POSITIVE_INFINITY ? dir * text.compare(a.size.name, b.size.name) : 0;
    if (ra === Number.POSITIVE_INFINITY) return 1; // an unknown size is last, whichever way the list runs
    if (rb === Number.POSITIVE_INFINITY) return -1;
    return ra < rb ? -dir : dir;
  }
  const pick = (l: SupplyLine) => (key === 'garment' ? l.garmentType.name : l.color.name);
  return dir * text.compare(pick(a), pick(b));
}

/** A line matches when EVERY word of the search is somewhere in its garment type, size or colour (any case, parts of words count). Never the cost. */
function matches(line: SupplyLine, words: string[]): boolean {
  const haystack = `${line.garmentType.name} ${line.size.name} ${line.color.name}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/**
 * The supply lines of one supplier, with a search box and sortable columns. Everything runs in the browser on the lines the page already
 * has: the search and the sort live only here (not in the address, not stored), so they stay applied after a save or a remove.
 * The line being changed keeps its mark whatever the search or the sort does with it.
 */
export function SupplyLinesTable({ lines, currentId, onChange, onRemove }: {
  lines: SupplyLine[];
  /** the line whose form is open, if any */
  currentId: string | null;
  onChange: (line: SupplyLine) => (event: MouseEvent<HTMLElement>) => void;
  onRemove: (line: SupplyLine) => void;
}) {
  const ids = useId();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>(null);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const found = lines.filter((l) => matches(l, words));
    if (!sort) return found;
    return [...found].sort((a, b) => compare(a, b, sort.key, sort.dir === 'asc' ? 1 : -1));
  }, [lines, query, sort]);

  if (lines.length === 0) return <p data-testid="lines-empty">No supply lines yet. A restock can only ask for the garments a supplier has a line for.</p>;

  // header click: ascending, then descending, then back to the order the server sent
  const cycle = (key: SortKey) =>
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));
  const clear = () => setQuery('');
  const hiddenCurrent = currentId !== null && lines.some((l) => l.id === currentId) && !shown.some((l) => l.id === currentId);
  const ariaSort = (key: SortKey) => (sort?.key !== key ? 'none' : sort.dir === 'asc' ? 'ascending' : 'descending');

  // a plain function, not a component: a component made inside render would be a new one each time and drop the focus from the button just pressed
  const head = (sortKey: SortKey, label: string) => (
    <th key={sortKey} scope="col" aria-sort={ariaSort(sortKey)} className="px-3 py-1 font-semibold">
      <span className="md:hidden">{label}</span>
      <button type="button" onClick={() => cycle(sortKey)} className="inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap font-semibold max-md:hidden" data-testid={`sort-${sortKey}`}>
        {label}
        <span aria-hidden="true" className={sort?.key === sortKey ? 'text-ink' : 'text-muted'}>
          {ARROW[sort?.key === sortKey ? sort.dir : 'none']}
        </span>
      </button>
    </th>
  );
  const plain = (h: string) => (
    <th key={h} scope="col" className="px-3 py-2 font-semibold">
      {h}
    </th>
  );

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div>
          <label htmlFor={`${ids}-q`} className="block text-sm font-medium">
            Search supply lines
          </label>
          <input id={`${ids}-q`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. hoodie black" maxLength={100} className={control} data-testid="lines-search" />
        </div>
        {query && (
          <button type="button" className="btn btn-secondary" onClick={clear} data-testid="lines-clear">
            Clear
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3 md:hidden" data-testid="lines-sort-mobile">
        <div>
          <label htmlFor={`${ids}-sort`} className="block text-sm font-medium">
            Sort by
          </label>
          <select
            id={`${ids}-sort`}
            value={sort?.key ?? ''}
            onChange={(e) => setSort(e.target.value ? { key: e.target.value as SortKey, dir: sort?.dir ?? 'asc' } : null)}
            className={control}
          >
            <option value="">Default order</option>
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn btn-secondary disabled:opacity-60"
          disabled={!sort}
          onClick={() => setSort((s) => (s ? { key: s.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : s))}
          aria-label={sort ? `Direction: ${sort.dir === 'asc' ? 'ascending' : 'descending'}. Change` : 'Direction (choose a sort first)'}
        >
          {sort ? (sort.dir === 'asc' ? '▲ Ascending' : '▼ Descending') : '▲ Ascending'}
        </button>
      </div>

      <p role="status" className="mt-3 text-sm text-muted" data-testid="lines-count">
        Showing {shown.length} of {lines.length} lines
      </p>
      {hiddenCurrent && (
        <p className="mt-1 text-sm font-medium text-ink" data-testid="lines-hidden-note">
          The line being changed is hidden by your search.
        </p>
      )}

      {shown.length === 0 ? (
        <p className="mt-3" data-testid="lines-nomatch">
          No supply lines match.{' '}
          <button type="button" className="underline underline-offset-4" onClick={clear}>
            Clear
          </button>
        </p>
      ) : (
        <table className="mt-3 block w-full text-left md:table" data-testid="lines-table">
          <caption className="sr-only">Supply lines</caption>
          <thead className="sr-only md:not-sr-only md:table-header-group">
            <tr className="border-b border-brown-dark text-sm text-muted">
              {head('garment', 'Garment type')}
              {head('size', 'Size')}
              {head('color', 'Colour')}
              {head('cost', 'Unit cost (VAT included)')}
              {['VAT', 'Net', 'Actions'].map(plain)}
            </tr>
          </thead>
          <tbody className="block space-y-3 md:table-row-group md:space-y-0">
            {shown.map((l) => {
              const current = l.id === currentId;
              return (
                <tr
                  key={l.id}
                  data-testid="line-row"
                  aria-current={current ? 'true' : undefined}
                  className={`block border border-tan p-3 md:table-row md:border-0 md:border-b md:p-0 ${current ? EDITING_ROW : 'bg-cream md:bg-transparent'}`}
                >
                  <Cell label="Garment type">
                    <span>
                      {l.garmentType.name}
                      {current && <span className="ml-2 text-sm font-semibold text-ink">(being changed)</span>}
                    </span>
                  </Cell>
                  <Cell label="Size">{l.size.name}</Cell>
                  <Cell label="Colour">{l.color.name}</Cell>
                  <Cell label="Unit cost (VAT included)">
                    <span className="font-semibold text-ink">{pesos(l.unitCost)}</span>
                  </Cell>
                  <Cell label="VAT">{pesos(l.unitCostVat)}</Cell>
                  <Cell label="Net">{pesos(l.unitCostNet)}</Cell>
                  <Cell label="Actions">
                    <span className="flex flex-wrap justify-end gap-2 md:justify-start">
                      <button type="button" className="btn btn-secondary btn-small" onClick={onChange(l)} aria-label={`Change ${lineName(l)}`}>
                        Change
                      </button>
                      <button type="button" className="btn btn-secondary btn-small" onClick={() => onRemove(l)} aria-label={`Remove ${lineName(l)}`}>
                        Remove
                      </button>
                    </span>
                  </Cell>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
