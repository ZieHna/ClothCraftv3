import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { goToSection } from '../lib/sections';

/**
 * The site's main links, in order. One list feeds both places they can appear: the row in the header (wide screens) and the top of the
 * header menu (below NAV_QUERY, where the row would no longer fit). A "section" link goes to a section of the landing page; a "route"
 * link to a page.
 */
export type NavItem = { label: string; kind: 'section'; id: string } | { label: string; kind: 'route'; to: string };

export const NAV_ITEMS: readonly NavItem[] = [
  { label: 'How it works', kind: 'section', id: 'how-it-works' },
  { label: 'Category', kind: 'route', to: '/category' },
  { label: 'Featured designs', kind: 'section', id: 'featured' },
  // the editor itself: with no garment chosen it sends the visitor to Category (see Design.tsx)
  { label: 'Design', kind: 'route', to: '/design' },
  { label: 'Contact', kind: 'section', id: 'contact' },
];
export const SECTION_IDS = NAV_ITEMS.flatMap((item) => (item.kind === 'section' ? [item.id] : []));

/** The width from which the five links fit in the header's row next to the logo, the cart and the menu button (measured in Edge). */
export const NAV_QUERY = '(min-width: 1024px)';
export const useWideNav = () => useMediaQuery(NAV_QUERY);

/**
 * A link to a section of the landing page. From another page it navigates to `/#id` (the router then scrolls and focuses, see Layout);
 * on the landing page, where "the same link again" would otherwise do nothing, it scrolls and focuses at once.
 */
export function SectionLink({ id, className, onNavigate, children, ...aria }: {
  id: string;
  className?: string | undefined;
  /** runs first (the header menu closes itself here) */
  onNavigate?: (() => void) | undefined;
  children: ReactNode;
  role?: 'menuitem' | undefined;
  tabIndex?: number | undefined;
  'aria-current'?: 'location' | undefined;
}) {
  const { pathname, hash } = useLocation();
  const click = (event: MouseEvent) => {
    onNavigate?.();
    if (pathname === '/' && hash === `#${id}` && goToSection(id)) event.preventDefault();
  };
  return (
    <Link to={{ pathname: '/', hash: `#${id}` }} onClick={click} className={className} {...aria}>
      {children}
    </Link>
  );
}

/**
 * Which landing-page section is in view, for aria-current on its link. Only on the landing page, only where IntersectionObserver exists, and
 * it changes state only when the answer changes (no work per scroll event). EVERY section of the page is watched, so that a section with a
 * link (How it works, Featured designs, Contact) stops being current as soon as another section, with a link or not (the
 * categories, the "design your own" band), reaches the band between the sticky header and 40% of the way down the screen. The last section
 * in page order that is in the band wins, as in a scroll-spy; it is marked only if it has a link.
 */
export function useCurrentSection(active: boolean): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (!active || typeof IntersectionObserver === 'undefined') {
      setCurrent(null);
      return;
    }
    const inBand = new Set<string>();
    const all = [...document.querySelectorAll<HTMLElement>('main section[id]')].map((element) => element.id);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inBand.add(entry.target.id);
          else inBand.delete(entry.target.id);
        }
        const lastInBand = [...all].reverse().find((id) => inBand.has(id)) ?? null;
        const last = lastInBand !== null && SECTION_IDS.includes(lastInBand) ? lastInBand : null;
        setCurrent((now) => (now === last ? now : last));
      },
      { rootMargin: '-72px 0px -60% 0px' },
    );
    for (const id of all) observer.observe(document.getElementById(id)!);
    return () => observer.disconnect();
  }, [active]);
  return active ? current : null;
}

export const linkBase = 'whitespace-nowrap border-b-2 pb-0.5 text-base font-medium no-underline';
export const linkState = (current: boolean) => (current ? 'border-sage-dark text-ink' : 'border-transparent text-muted hover:text-ink');
