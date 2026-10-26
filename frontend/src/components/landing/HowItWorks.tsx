import { STEPS } from '../../content/steps';
import { HowItWorksVideo } from './HowItWorksVideo';
import { TornEdge } from './TornEdge';

/**
 * The four steps as real text (the video's words, so nothing depends on the video) beside the video itself.
 *
 * Layout: this section is deliberately wider than the rest of the page (max-w-[92rem], 1472px) because the video is the
 * feature. From 1024px up it is two columns: the eyebrow, heading and steps on the left (41%), the video on the right
 * (59%), both starting at the same top edge. Below 1024px it is one column, text first and the video full width under it.
 * The video's own width is capped at its 1280px source (see HowItWorksVideo), so it is never upscaled.
 */
export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="relative bg-paper">
      <TornEdge className="fill-paper" />
      <div className="mx-auto max-w-[92rem] px-4 py-16 lg:py-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,41fr)_minmax(0,59fr)] lg:items-start lg:gap-14">
          <div>
            <p className="eyebrow">How it works</p>
            <h2 id="how-title" className="mt-2 max-w-2xl text-5xl leading-none sm:text-6xl lg:text-5xl xl:text-6xl">
              Four steps, <em className="text-brown">start to door.</em>
            </h2>
            <ol className="mt-8 space-y-6">
              {STEPS.map((step, i) => (
                <li key={step.tag} className="relative flex gap-5 border-t border-dashed border-brown/60 pt-5">
                  <span aria-hidden="true" className="w-14 shrink-0 font-display text-5xl font-bold leading-none text-brown/40">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <p className="eyebrow text-[0.75rem]!">{step.tag}</p>
                    <h3 className="mt-1 text-3xl leading-tight">
                      {step.headline[0]} <em className="text-brown">{step.headline[1]}</em>
                    </h3>
                    <p className="mt-1">{step.support}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <HowItWorksVideo />
        </div>
      </div>
    </section>
  );
}
