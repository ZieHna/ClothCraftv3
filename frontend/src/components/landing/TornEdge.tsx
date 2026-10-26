// A ragged paper edge: the same jagged-cut idea as the hills in the video. The points are fixed (a tiny seeded generator),
// so every render and every build draws the same edge.
const POINTS = (() => {
  const out: number[] = [];
  let seed = 7;
  for (let i = 0; i <= 60; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    out.push(2 + (seed / 233280) * 14);
  }
  return out;
})();
const PATH = `M0 24 L${POINTS.map((y, i) => `${i * 20} ${y.toFixed(1)}`).join(' L')} L1200 24 Z`;

/**
 * Sits on the top edge of a section and overlaps the section above it. Give it the colour of its OWN section with a fill
 * class (for example "fill-paper"). The parent must be `relative` and must not clip its overflow.
 */
export function TornEdge({ className = '' }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 1200 24" preserveAspectRatio="none" className={`pointer-events-none absolute inset-x-0 bottom-[calc(100%-1px)] h-5 w-full sm:h-6 ${className}`}>
      <path d={PATH} />
    </svg>
  );
}
