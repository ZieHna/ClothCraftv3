import { useId, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { customizeUrl, garmentLabels, previewUrl, type PremadeDesign } from '../../designs/catalog';

/**
 * The highlighted designs, one at a time. No automatic turning (nothing moves unless you press a button), Previous and Next buttons with
 * a position count, one dot per design, and the Left and Right arrow keys when the carousel has focus. Only the shown slide is drawn, so a
 * screen reader reads one design at a time; the count is announced when it changes.
 */
export function DesignCarousel({ designs, label = 'Highlighted designs' }: { designs: readonly PremadeDesign[]; label?: string }) {
  const id = useId();
  const [index, setIndex] = useState(0);
  if (designs.length === 0) return null;
  const count = designs.length;
  const at = Math.min(index, count - 1);
  const design = designs[at]!;
  const go = (to: number) => setIndex(((to % count) + count) % count);
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLElement && e.target.matches('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(at - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(at + 1);
    }
  };

  return (
    <section aria-roledescription="carousel" aria-label={label} onKeyDown={onKey} className="min-w-0 border border-tan bg-cream" data-testid="design-carousel">
      <div className="grid gap-4 p-4 sm:gap-6 sm:p-6 md:grid-cols-2 md:items-center">
        <div role="group" aria-roledescription="slide" aria-label={`${at + 1} of ${count}: ${design.name}`} className="contents">
          <img
            key={design.id}
            src={previewUrl(design.id)}
            alt={design.previewAlt}
            width={560}
            height={560}
            decoding="async"
            className="mx-auto aspect-square w-full max-w-md bg-white object-contain"
            data-testid="carousel-image"
          />
          <div className="min-w-0">
            <p className="eyebrow" data-testid="carousel-style">
              {design.style}
            </p>
            <h2 id={`${id}-name`} className="mt-1 text-4xl leading-none sm:text-5xl" data-testid="carousel-name">
              {design.name}
            </h2>
            <p className="mt-3 text-lg">{design.summary}</p>
            <p className="mt-2 text-sm text-muted">Made for {garmentLabels(design).join(', ')}.</p>
            <p className="mt-5">
              <Link to={customizeUrl(design.id)} className="btn btn-primary" aria-label={`Customize Design: ${design.name}`}>
                Customize Design
              </Link>
            </p>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-tan px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-secondary btn-small" onClick={() => go(at - 1)} aria-controls={`${id}-name`} data-testid="carousel-prev">
            Previous
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => go(at + 1)} aria-controls={`${id}-name`} data-testid="carousel-next">
            Next
          </button>
        </div>
        <p role="status" aria-live="polite" className="text-sm text-muted" data-testid="carousel-position">
          Design {at + 1} of {count}
        </p>
        <div className="flex flex-wrap items-center" role="group" aria-label="Choose a design">
          {designs.map((d, i) => (
            <button key={d.id} type="button" onClick={() => go(i)} aria-label={`Show ${d.name}`} aria-current={i === at ? 'true' : undefined} className="group grid size-11 place-items-center" data-testid="carousel-dot">
              <span className={`block size-3 rounded-full border-2 border-brown-dark ${i === at ? 'bg-brown-dark' : 'bg-cream group-hover:bg-tan'}`} />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
