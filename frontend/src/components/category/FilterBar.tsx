import { useEffect, useState } from 'react';
import type { CatalogueList } from '../../api/types';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { formatMoney } from '../../lib/format';

export interface Filters {
  q: string;
  type: string;
  min: string;
  max: string;
  stock: boolean;
}

interface Props {
  /** the filter values in the URL */
  filters: Filters;
  /** the choices the server offered with the last response (types for this group, price bounds). Null until the first response. */
  facets: Pick<CatalogueList, 'garmentTypes' | 'priceBounds' | 'currency'> | null;
  /** write changes to the URL. `replace` is for typing (so Back does not step through every letter). */
  onChange: (changes: Partial<Filters>, options?: { replace?: boolean }) => void;
  onClear: () => void;
}

/** A text field that shows what the viewer types at once, but writes it to the URL only after a short pause. */
function useUrlText(urlValue: string, commit: (value: string) => void, delay = 400) {
  const [value, setValue] = useState(urlValue);
  useEffect(() => setValue(urlValue), [urlValue]); // the URL changed from outside (Back, Clear): follow it
  useEffect(() => {
    if (value === urlValue) return;
    const timer = window.setTimeout(() => commit(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, urlValue, commit, delay]);
  return [value, setValue] as const;
}

const field = 'mt-1 block w-full border border-brown-dark bg-cream px-3 py-2 text-base text-ink placeholder:text-muted';
const labelText = 'text-sm font-medium text-ink';

export function FilterBar({ filters, facets, onChange, onClear }: Props) {
  const [q, setQ] = useUrlText(filters.q, (value) => onChange({ q: value }, { replace: true }));

  // price: both boxes are checked together, and nothing is written to the URL while the minimum is above the maximum
  const [min, setMin] = useState(filters.min);
  const [max, setMax] = useState(filters.max);
  useEffect(() => setMin(filters.min), [filters.min]);
  useEffect(() => setMax(filters.max), [filters.max]);
  const priceError = min !== '' && max !== '' && Number(min) > Number(max) ? 'The minimum is above the maximum.' : '';
  useEffect(() => {
    if (priceError || (min === filters.min && max === filters.max)) return;
    const timer = window.setTimeout(() => onChange({ min, max }, { replace: true }), 500);
    return () => window.clearTimeout(timer);
  }, [min, max, priceError, filters.min, filters.max, onChange]);

  // the select and the checkbox answer at once; the URL (and so `filters`) catches up a moment later and they follow it
  const [type, setType] = useState(filters.type);
  const [stock, setStock] = useState(filters.stock);
  useEffect(() => setType(filters.type), [filters.type]);
  useEffect(() => setStock(filters.stock), [filters.stock]);

  const activeOther = [filters.type !== '', filters.min !== '' || filters.max !== '', filters.stock].filter(Boolean).length;
  const anyFilter = filters.q !== '' || activeOther > 0;
  const bounds = facets?.priceBounds;
  const currency = facets?.currency ?? 'PHP';

  // On a phone only the search box is always shown; the other filters sit in a disclosure that starts open when a link
  // arrives with some of them already set. From 640px up everything is laid out in the open.
  const wide = useMediaQuery('(min-width: 640px)');
  const [open, setOpen] = useState(activeOther > 0);

  const typeField = (
    <label className="block">
      <span className={labelText}>Garment type</span>
      <select value={type} onChange={(event) => { setType(event.target.value); onChange({ type: event.target.value }); }} className={field}>
        <option value="">All types</option>
        {facets?.garmentTypes.map((type) => (
          <option key={type.code} value={type.code}>
            {type.name} ({type.count})
          </option>
        ))}
      </select>
    </label>
  );
  const priceFields = (
    <>
      <label className="block">
        <span className={labelText}>Lowest price</span>
        <input type="number" inputMode="decimal" min={0} step="any" value={min} onChange={(event) => setMin(event.target.value)} aria-invalid={priceError ? true : undefined} aria-describedby="price-help" placeholder={bounds ? String(bounds.min) : ''} className={field} />
      </label>
      <label className="block">
        <span className={labelText}>Highest price</span>
        <input type="number" inputMode="decimal" min={0} step="any" value={max} onChange={(event) => setMax(event.target.value)} aria-invalid={priceError ? true : undefined} aria-describedby="price-help" placeholder={bounds ? String(bounds.max) : ''} className={field} />
      </label>
    </>
  );
  const stockField = (
    <label className="flex min-h-11 cursor-pointer items-center gap-2 self-end">
      <input type="checkbox" checked={stock} onChange={(event) => { setStock(event.target.checked); onChange({ stock: event.target.checked }); }} className="size-5 accent-sage-dark" />
      <span className={labelText}>In stock only</span>
    </label>
  );
  const help = (
    <p id="price-help" className={`text-sm ${priceError ? 'font-medium text-brown-dark' : 'text-muted'}`} role={priceError ? 'alert' : undefined}>
      {priceError || (bounds ? `Prices in this group run from ${formatMoney(bounds.min, currency)} to ${formatMoney(bounds.max, currency)}.` : 'Prices are in Philippine pesos.')}
    </p>
  );

  return (
    <form role="search" aria-label="Filter products" onSubmit={(event) => event.preventDefault()} className="stitched border border-tan bg-cream p-4 sm:p-5">
      <div className="relative z-10 grid gap-x-4 gap-y-4 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_0.7fr_0.7fr_auto]">
        <label className="block sm:col-span-2 lg:col-span-1">
          <span className={labelText}>Search by name</span>
          <input type="search" value={q} onChange={(event) => setQ(event.target.value)} autoComplete="off" placeholder="For example: tee" className={field} />
        </label>
        {wide && (
          <>
            {typeField}
            {priceFields}
            {stockField}
          </>
        )}
      </div>

      {!wide && (
        <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group relative z-10 mt-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-base font-semibold text-ink [&::-webkit-details-marker]:hidden">
            More filters
            {activeOther > 0 && <span className="rounded-sm border border-sage-dark px-1.5 text-xs font-semibold text-sage-dark">{activeOther} on</span>}
            <svg aria-hidden="true" viewBox="0 0 12 12" width="14" height="14" className="ml-auto transition-transform group-open:rotate-180"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-4">
            <div className="col-span-2">{typeField}</div>
            {priceFields}
            <div className="col-span-2">{stockField}</div>
          </div>
        </details>
      )}

      <div className="relative z-10 mt-3">{help}</div>

      {anyFilter && (
        <p className="relative z-10 mt-3">
          <button type="button" onClick={onClear} className="btn btn-secondary btn-small">
            Clear filters
          </button>
        </p>
      )}
    </form>
  );
}
