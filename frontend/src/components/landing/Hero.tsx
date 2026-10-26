import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { useReducedMotion } from '../../hooks/useReducedMotion';

// Cross-fading photos, in this order. Files come from scripts/optimise-images.mjs (public/site/).
const SLIDES = [
  { name: 'hero-1', widths: [800, 1600] },
  { name: 'hero-2', widths: [800, 1600] },
  { name: 'hero-3', widths: [800, 1600] },
  { name: 'hero-4', widths: [720] },
] as const;
const INTERVAL_MS = 6000;

function srcSet(name: string, widths: readonly number[]) {
  return widths.map((w) => `/site/${name}-${w}.webp ${w}w`).join(', ');
}

export function Hero() {
  const reduced = useReducedMotion();
  const { requireAccount } = useAuth();
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [rest, setRest] = useState(false);

  // only the first photo is needed to paint; the others are requested once the page has finished loading
  useEffect(() => {
    if (document.readyState === 'complete') {
      setRest(true);
      return;
    }
    const onLoad = () => setRest(true);
    window.addEventListener('load', onLoad);
    return () => window.removeEventListener('load', onLoad);
  }, []);

  const running = rest && !paused && !reduced;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % SLIDES.length), INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  return (
    <section aria-label="Welcome" className="relative bg-paper-warm">
      <div
        role="group"
        aria-roledescription="carousel"
        aria-label="Photos of clothing on racks"
        className="relative h-72 overflow-hidden bg-brown-dark sm:h-80 md:absolute md:inset-0 md:h-auto"
      >
        <div aria-live="off">
          {SLIDES.map((slide, i) =>
            i === 0 || rest ? (
              <img
                key={slide.name}
                src={`/site/${slide.name}-${slide.widths[slide.widths.length - 1]}.webp`}
                srcSet={srcSet(slide.name, slide.widths)}
                sizes="100vw"
                alt=""
                aria-hidden="true"
                width={1600}
                height={1066}
                fetchPriority={i === 0 ? 'high' : 'low'}
                decoding={i === 0 ? 'sync' : 'async'}
                className={`absolute inset-0 size-full object-cover transition-opacity duration-[1400ms] ease-in-out ${i === index ? 'opacity-100' : 'opacity-0'}`}
              />
            ) : null,
          )}
        </div>
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-brown-dark/40 via-transparent to-transparent" />

        <div className="absolute right-3 top-3 flex items-center gap-1 border border-brown-dark bg-cream px-1.5 py-1 md:bottom-6 md:right-6 md:top-auto">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-label={paused || reduced ? 'Start the photo slideshow' : 'Pause the photo slideshow'}
            className="grid size-9 place-items-center text-ink hover:bg-paper-warm"
          >
            {paused || reduced ? (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 1.5v13l11-6.5z" fill="currentColor" /></svg>
            ) : (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 1.5h3.5v13H3zM9.5 1.5H13v13H9.5z" fill="currentColor" /></svg>
            )}
          </button>
          {SLIDES.map((slide, i) => (
            <button
              key={slide.name}
              type="button"
              onClick={() => {
                setIndex(i);
                setRest(true);
              }}
              aria-label={`Show photo ${i + 1} of ${SLIDES.length}`}
              aria-current={i === index ? 'true' : undefined}
              className="group grid size-9 place-items-center"
            >
              <span className={`block size-3 rounded-full border-2 border-brown-dark ${i === index ? 'bg-brown-dark' : 'bg-cream group-hover:bg-tan'}`} />
            </button>
          ))}
        </div>
      </div>

      {/* the wrapper lets clicks through to the slideshow controls under it; only the card takes them */}
      <div className="pointer-events-none relative z-10 mx-auto -mt-12 max-w-6xl px-4 pb-14 md:mt-0 md:py-24">
        <div className="stitched taped pointer-events-auto relative max-w-xl border border-tan bg-cream p-7 sm:p-10 md:max-w-2xl">
          <p className="eyebrow">Custom garments</p>
          {/* The hero tagline. ("Make it yours." is step 2 of How it works and is burned into the video: leave that one alone.) */}
          <h1 className="mt-3 text-4xl leading-[0.98] min-[400px]:text-5xl sm:text-6xl md:text-7xl md:leading-[0.95]">
            Designed by <em className="text-brown">You,</em> Crafted for <em className="text-brown">You</em>
          </h1>
          <p className="mt-5 max-w-md text-lg">Pick a garment, color and size, then add your own text, an image or a shape.</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link to="/designs" className="btn btn-primary">
              Browse designs
            </Link>
            <button type="button" onClick={() => requireAccount(() => navigate('/category'))} className="btn btn-secondary">
              Design your own
            </button>
          </div>
          <p className="mt-4 text-sm text-muted">Pay by cash on delivery or bank transfer.</p>
        </div>
      </div>
    </section>
  );
}
