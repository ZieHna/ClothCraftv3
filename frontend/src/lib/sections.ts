/**
 * In-page links (How it works, Browse designs, Featured designs, Contact on the landing page). Used by the router's hash handling in
 * Layout and by SectionLink, so a link to the section you are already at still moves you there.
 */

/** True when the visitor's system asks for less motion. */
export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Scroll to the section with this id (smoothly, or at once under reduced motion; html's scroll-padding-top keeps it clear of the sticky
 * header) and move focus to its heading, so a keyboard or screen reader user starts reading there. Returns false when there is no such
 * element on the page.
 */
export function goToSection(id: string): boolean {
  const section = document.getElementById(id);
  if (!section) return false;
  section.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  const heading = section.matches('h1, h2, h3') ? section : section.querySelector<HTMLElement>('h1, h2, h3');
  if (heading) {
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1'); // focusable by script only, never a Tab stop
    heading.focus({ preventScroll: true }); // the scroll above is the one that counts: it is smooth, and focus must not cut it short
  }
  return true;
}
