import { TornEdge } from './TornEdge';

/**
 * Step A: a placeholder section for ready-made designs (predesigned shirts), after "How it works". The carousel comes in the next
 * step; until then it says so, and nothing is invented. The id is what the header's "Browse designs" link and the hero button go to.
 */
export function BrowseDesigns() {
  return (
    <section id="browse-designs" aria-labelledby="browse-designs-title" className="relative bg-paper-warm">
      <TornEdge className="fill-paper-warm" />
      <div className="mx-auto max-w-6xl px-4 py-14 lg:py-16">
        <h2 id="browse-designs-title" className="text-5xl leading-none sm:text-6xl">
          Browse <em className="text-brown">designs.</em>
        </h2>
        <p className="mt-4 max-w-prose text-lg" data-testid="browse-designs-note">
          Predesigned shirts are coming soon.
        </p>
      </div>
    </section>
  );
}
