import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowseRedirect } from '../pages/BrowseRedirect';
import { cartStore } from '../cart/cartStore';
import { setViewportWidth } from '../test/viewport';
import { Layout } from './Layout';

// vitest runs from frontend/; the stylesheet is read as text (css?raw comes back empty under vitest)
const css = readFileSync('src/index.css', 'utf8');

/** The header's links and the section links (step A). jsdom has no layout and no scrolling, so what is proved here is what the code ASKS for:
 *  which element it scrolls to and how (smooth, or at once under reduced motion), where focus goes, and what the URL says. */
const scrollIntoView = vi.fn();
let motionReduced = true;
const realMatchMedia = window.matchMedia;

beforeAll(() => {
  Element.prototype.scrollIntoView = function (this: Element, options?: ScrollIntoViewOptions) {
    scrollIntoView(this.id, options);
  };
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
beforeEach(() => {
  scrollIntoView.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  cartStore.setOwner(null);
  setViewportWidth(1280);
  motionReduced = true;
  const delegate = realMatchMedia;
  window.matchMedia = (query: string) => {
    const real = delegate(query);
    return query.includes('prefers-reduced-motion') ? ({ ...real, media: query, matches: motionReduced } as MediaQueryList) : real;
  };
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
});

function Where() {
  const { pathname, search, hash } = useLocation();
  return <p data-testid="where">{pathname + search + hash}</p>;
}
const section = (id: string, title: string) => (
  <section id={id} aria-labelledby={`${id}-t`}>
    <h2 id={`${id}-t`}>{title}</h2>
  </section>
);
function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <>
            <Layout />
            <Where />
          </>
        ),
        children: [
          {
            index: true,
            element: (
              <>
                {section('how-it-works', 'Four steps')}
                {section('shop', 'Start with a garment.')}
                {section('featured', 'Featured designs.')}
                {section('contact', 'Get in touch')}
              </>
            ),
          },
          { path: 'category', element: <h1>Category</h1> },
          { path: 'browse', element: <BrowseRedirect /> },
          { path: 'design', element: <h1>Design</h1> },
          { path: 'cart', element: <h1>Cart</h1> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <>
      <RouterProvider router={router} />
    </>,
  );
  return router;
}
const mainNav = () => screen.getByRole('navigation', { name: 'Main' });
const where = () => screen.getByTestId('where');

describe('the header', () => {
  it('is sticky, with a solid token background and no shadow until the page is scrolled', async () => {
    renderAt('/');
    const header = screen.getByRole('banner');
    expect(header.className).toMatch(/\bsticky\b/);
    expect(header.className).toMatch(/\btop-0\b/);
    expect(header.className).toMatch(/\bbg-paper\b/);
    expect(header.className).toMatch(/h-\[var\(--header-height\)\]/); // one fixed height: scrolling and opening the menu shift nothing
    expect(header).not.toHaveAttribute('data-scrolled');
    expect(header.className).not.toMatch(/shadow-header/);
    Object.defineProperty(window, 'scrollY', { value: 120, configurable: true });
    act(() => void window.dispatchEvent(new Event('scroll')));
    expect(header).toHaveAttribute('data-scrolled', 'true');
    expect(header.className).toMatch(/shadow-header/);
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    act(() => void window.dispatchEvent(new Event('scroll')));
    expect(header).not.toHaveAttribute('data-scrolled');
  });

  it('is sticky on every page but the editor (/design), where it scrolls away and the page needs no clearance under it', () => {
    renderAt('/design');
    const header = screen.getByRole('banner');
    expect(header.className).not.toMatch(/sticky/);
    expect(document.documentElement.dataset.header).toBe('static');
    expect(css).toMatch(/html\[data-header='static'\]\s*\{\s*scroll-padding-top:\s*0;/);
  });

  it('says so on the page element, so scroll-padding-top applies only while the header is sticky', () => {
    renderAt('/cart');
    expect(document.documentElement.dataset.header).toBe('sticky');
  });

  it('wide: How it works, Category, Featured designs, Design, Contact, in that order, and no "Browse designs" or "Browse" link (the designs have their own page, /designs)', () => {
    renderAt('/');
    expect(within(mainNav()).getAllByRole('link').map((a) => a.textContent)).toEqual(['How it works', 'Category', 'Featured designs', 'Design', 'Contact']);
    expect(within(mainNav()).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/#how-it-works', '/category', '/#featured', '/design', '/#contact']);
    expect(within(mainNav()).queryByRole('link', { name: 'Browse' })).not.toBeInTheDocument();
  });

  it('narrow: the row is gone from the header (the links are in the menu)', () => {
    setViewportWidth(390);
    renderAt('/');
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.getByTestId('account-menu-button')).toBeInTheDocument();
  });

  it('Category is the current page on /category (aria-current="page"), and Design on /design', () => {
    renderAt('/category');
    expect(within(mainNav()).getByRole('link', { name: 'Category' })).toHaveAttribute('aria-current', 'page');
    expect(within(mainNav()).getByRole('link', { name: 'Design' })).not.toHaveAttribute('aria-current');
  });
});

describe('section links: smooth scroll, hash in the URL, focus on the heading', () => {
  it('from another page: goes to / with the hash, scrolls to the section and focuses its heading', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt('/cart');
    await user.click(within(mainNav()).getByRole('link', { name: 'Contact' }));
    expect(where()).toHaveTextContent('/#contact');
    expect(scrollIntoView).toHaveBeenCalledWith('contact', expect.objectContaining({ block: 'start' }));
    const heading = screen.getByRole('heading', { name: 'Get in touch' });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1'); // reachable by script, not a Tab stop
  });

  it('each of the three goes to its own section', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt('/');
    for (const [name, id, heading] of [
      ['How it works', 'how-it-works', 'Four steps'],
      ['Featured designs', 'featured', 'Featured designs.'],
      ['Contact', 'contact', 'Get in touch'],
    ] as const) {
      scrollIntoView.mockClear();
      await user.click(within(mainNav()).getByRole('link', { name }));
      expect(where()).toHaveTextContent(`/#${id}`);
      expect(scrollIntoView).toHaveBeenCalledWith(id, expect.anything());
      expect(screen.getByRole('heading', { name: heading })).toHaveFocus();
    }
  });

  it('scrolls smoothly, and at once when the visitor asked for reduced motion', async () => {
    const user = userEvent.setup({ delay: null });
    motionReduced = false;
    renderAt('/');
    await user.click(within(mainNav()).getByRole('link', { name: 'Contact' }));
    expect(scrollIntoView).toHaveBeenLastCalledWith('contact', expect.objectContaining({ behavior: 'smooth' }));
    motionReduced = true;
    await user.click(within(mainNav()).getByRole('link', { name: 'Featured designs' }));
    expect(scrollIntoView).toHaveBeenLastCalledWith('featured', expect.objectContaining({ behavior: 'auto' }));
  });

  it('the same link again, at the same place, still scrolls and focuses (the URL does not change)', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt('/');
    const link = within(mainNav()).getByRole('link', { name: 'Contact' });
    await user.click(link);
    (document.activeElement as HTMLElement).blur();
    scrollIntoView.mockClear();
    await user.click(link);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Get in touch' })).toHaveFocus();
    expect(where()).toHaveTextContent('/#contact');
  });

  it('a page opened on /#contact goes straight there', () => {
    renderAt('/#contact');
    expect(scrollIntoView).toHaveBeenCalledWith('contact', expect.anything());
    expect(screen.getByRole('heading', { name: 'Get in touch' })).toHaveFocus();
  });

  it('a new page starts at the top (no hash)', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt('/');
    await user.click(within(mainNav()).getByRole('link', { name: 'Category' }));
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 0);
  });

  it('the clearance below the sticky header is set once for every in-page jump (scroll-padding-top in index.css)', () => {
    expect(css).toMatch(/scroll-padding-top:\s*var\(--header-height\);/);
    expect(css).toMatch(/--header-height:\s*4\.25rem/);
  });
});

describe('the current section is marked (aria-current="location")', () => {
  type Entry = { target: Element; isIntersecting: boolean };
  function mockObserver() {
    const state: { callback: (entries: Entry[]) => void; watched: string[] } = { callback: () => undefined, watched: [] };
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: Entry[]) => void) {
          state.callback = callback;
        }
        observe(element: Element) {
          state.watched.push(element.id);
        }
        disconnect() {}
        unobserve() {}
      },
    );
    return state;
  }

  it('follows the section in view, the last one in page order wins, and nothing is marked while a section without a link is in view', () => {
    const observer = mockObserver();
    renderAt('/');
    expect(observer.watched).toEqual(['how-it-works', 'shop', 'featured', 'contact']); // every section, linked or not
    const el = (id: string) => document.getElementById(id)!;
    const current = () => within(mainNav()).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'location').map((a) => a.textContent);
    expect(current()).toEqual([]);
    act(() => observer.callback([{ target: el('how-it-works'), isIntersecting: true }]));
    expect(current()).toEqual(['How it works']);
    // the categories section (no link) comes into view while How it works is still partly in the band: nothing is current
    act(() => observer.callback([{ target: el('shop'), isIntersecting: true }]));
    expect(current()).toEqual([]);
    act(() => observer.callback([{ target: el('how-it-works'), isIntersecting: false }, { target: el('shop'), isIntersecting: false }, { target: el('featured'), isIntersecting: true }]));
    expect(current()).toEqual(['Featured designs']);
    act(() => observer.callback([{ target: el('featured'), isIntersecting: false }]));
    expect(current()).toEqual([]);
  });

  it('is not used off the landing page', () => {
    const observer = mockObserver();
    renderAt('/category');
    expect(observer.watched).toEqual([]);
  });
});

describe('/browse is now /category', () => {
  it('redirects with and without a query string and a hash (replacing the old address)', async () => {
    const router = renderAt('/browse');
    await vi.waitFor(() => expect(where().textContent).toBe('/category'));
    expect(router.state.historyAction).toBe('REPLACE');
    router.navigate('/browse?group=Men&stock=1');
    await vi.waitFor(() => expect(where()).toHaveTextContent('/category?group=Men&stock=1'));
    router.navigate('/browse?q=tee#results');
    await vi.waitFor(() => expect(where()).toHaveTextContent('/category?q=tee#results'));
  });
});

describe('the menu button sits at the right end of the header', () => {
  it('it is the last control in the header, after the cart link', () => {
    renderAt('/');
    const header = screen.getByRole('banner');
    const controls = [...header.querySelectorAll('a, button')];
    expect(controls[controls.length - 1]).toBe(screen.getByTestId('account-menu-button'));
    fireEvent.click(screen.getByTestId('account-menu-button'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
