import { useSearchParams } from 'react-router';
import { DesignCard } from '../components/designs/DesignCard';
import { DesignCarousel } from '../components/designs/DesignCarousel';
import { DESIGN_CATALOG, featuredDesigns, GARMENT_LABEL, garmentTypesInUse, stylesInUse, type DesignStyle } from '../designs/catalog';

const chip = (on: boolean) =>
  `inline-flex min-h-11 items-center border px-4 text-sm font-medium ${on ? 'border-ink bg-ink text-cream' : 'border-tan bg-paper text-ink hover:border-brown'}`;

/**
 * Browse all designs (/designs): every premade design of the catalog, a carousel of the highlighted ones, and two filters whose choices are
 * read from the catalog itself (a style or garment that no design has is never offered). The filters live in the address (?style=, ?apparel=),
 * so a filtered view can be shared and Back works. "Customize Design" opens the real editor with that design (see pages/Design.tsx).
 */
export function DesignsPage() {
  const [params, setParams] = useSearchParams();
  const styles = stylesInUse();
  const apparel = garmentTypesInUse();
  const styleParam = params.get('style');
  const apparelParam = params.get('apparel');
  const style = styles.includes(styleParam as DesignStyle) ? (styleParam as DesignStyle) : 'all';
  const garment = apparel.includes(apparelParam ?? '') ? (apparelParam as string) : 'all';
  const shown = DESIGN_CATALOG.filter((d) => (style === 'all' || d.style === style) && (garment === 'all' || d.garmentTypes.includes(garment)));

  const set = (name: 'style' | 'apparel', value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  };

  return (
    <section className="mx-auto max-w-6xl px-4 py-8 sm:py-12" data-testid="designs-page">
      <p className="eyebrow">Premade designs</p>
      <h1 className="mt-2 text-5xl leading-none sm:text-6xl">
        Find your next <em className="text-brown">design.</em>
      </h1>
      <p className="mt-4 max-w-prose text-lg">
        Pick a premade design you like, choose the garment, and make it yours: the design opens in the ClothCraft editor, where you can change the words, colours and shapes, move
        things around, or add your own.
      </p>

      <div className="mt-8">
        <DesignCarousel designs={featuredDesigns()} />
      </div>

      <h2 className="mt-12 text-4xl leading-none sm:text-5xl">All designs</h2>
      <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end" data-testid="design-filters">
        <fieldset className="min-w-0">
          <legend className="text-sm font-medium text-muted">Style</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {(['all', ...styles] as const).map((s) => (
              <button key={s} type="button" aria-pressed={style === s} onClick={() => set('style', s)} className={chip(style === s)} data-testid={`style-${s}`}>
                {s === 'all' ? 'All styles' : s}
              </button>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor="apparel" className="block text-sm font-medium text-muted">
            Apparel
          </label>
          <select id="apparel" value={garment} onChange={(e) => set('apparel', e.target.value)} className="mt-1 min-h-11 w-full min-w-48 border border-tan bg-paper px-3 text-base" data-testid="apparel-filter">
            <option value="all">All apparel</option>
            {apparel.map((code) => (
              <option key={code} value={code}>
                {(GARMENT_LABEL[code] ?? code).replace(/^./, (c) => c.toUpperCase())}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p role="status" aria-live="polite" className="mt-4 text-sm text-muted" data-testid="design-count">
        Showing {shown.length} of {DESIGN_CATALOG.length} designs.
      </p>
      {shown.length === 0 ? (
        <div className="mt-4 border-2 border-dashed border-tan bg-paper p-6" data-testid="designs-empty">
          <p className="font-medium text-ink">No design matches that style and apparel.</p>
          <p className="mt-1 text-sm text-muted">Try another style or choose all apparel.</p>
          <button type="button" className="btn btn-secondary btn-small mt-3" onClick={() => setParams({}, { replace: true })}>
            Show all designs
          </button>
        </div>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4">
          {shown.map((d) => (
            <DesignCard key={d.id} design={d} />
          ))}
        </ul>
      )}
    </section>
  );
}
