import { useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { TornEdge } from './TornEdge';

/** The call to design. Designing needs an account (a design has an owner), so with no session this asks for sign-in first. */
export function DesignCta() {
  const { requireAccount } = useAuth();
  const navigate = useNavigate();
  return (
    <section id="design" aria-labelledby="design-title" className="relative bg-sage-dark text-cream">
      <TornEdge className="fill-sage-dark" />
      <div className="relative mx-auto max-w-6xl px-4 py-16 lg:py-20">
        {/* paper-cut decoration (large screens only, kept clear of the text): a sage disc, a garment and the thread from the video */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-4 hidden w-[38%] lg:block">
          <div className="absolute right-6 top-1/2 size-72 -translate-y-1/2 rounded-full bg-sage-light" />
          <img src="/products/m-tee.webp" alt="" width={640} height={640} loading="lazy" decoding="async" className="absolute right-12 top-1/2 w-56 -translate-y-[52%] rotate-6 drop-shadow-[0_8px_8px_rgb(26_23_20/0.35)]" />
          <svg viewBox="0 0 400 300" className="absolute inset-0 size-full">
            <path d="M-10 250 C 70 200, 130 280, 230 230 S 360 170, 420 215" fill="none" stroke="var(--color-cream)" strokeOpacity="0.7" strokeWidth="3" strokeLinecap="round" strokeDasharray="1 11" />
          </svg>
        </div>

        <div className="relative max-w-xl">
          <p className="eyebrow text-cream!">Design your own</p>
          <h2 id="design-title" className="mt-2 text-5xl leading-none text-cream sm:text-6xl">
            Put your own mark <em className="text-tan">on it.</em>
          </h2>
          <p className="mt-5 text-lg">Choose a garment, then add text, an image or a shape. Designing and saving a design need an account, because every design has an owner.</p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <button type="button" onClick={() => requireAccount(() => navigate('/design'))} className="btn border-cream bg-cream text-ink hover:bg-paper-warm">
              Design your own
            </button>
            <span className="text-sm">Browsing needs no account.</span>
          </div>
        </div>
      </div>
    </section>
  );
}
