import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { AuthProvider, useAuth } from '../auth/AuthContext';
import { useCart } from '../cart/cartStore';
import { goToSection } from '../lib/sections';
import { CartOfflineBar } from './CartSyncNotes';
import { Footer, FooterSlim } from './Footer';
import { HeaderMenu } from './HeaderMenu';
import { linkBase, linkState, NAV_ITEMS, SectionLink, useCurrentSection, useWideNav } from './siteNav';

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // a hash with a stray % is looked up as it is
  }
};

/** A route change starts at the top; a link with a #hash goes to that section (smoothly, clear of the sticky header, and focus moves to its heading). */
function ScrollToHash() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash && goToSection(safeDecode(hash.slice(1)))) return;
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

/** True once the page has been scrolled at all: the header then gets its shadow. State changes only when that answer changes. */
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(() => window.scrollY > 0);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 0);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);
  return scrolled;
}

/** The cart link. The badge is the sum of the quantities the shopper chose (their own numbers); it is text, not only colour. */
function CartLink() {
  const { count, loading } = useCart();
  // real shop, while the saved cart is fetched: no number at all rather than a wrong one
  return (
    <NavLink
      to="/cart"
      aria-label={loading ? 'Cart, loading' : count === 0 ? 'Cart, empty' : `Cart, ${count} ${count === 1 ? 'item' : 'items'}`}
      className={({ isActive }) => `inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap border-b-2 pb-0.5 text-base font-medium no-underline ${isActive ? 'border-sage-dark text-ink' : 'border-transparent text-muted hover:text-ink'}`}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 4h2.5l2 11h10l2-8H7" />
        <circle cx="9.5" cy="19" r="1.3" />
        <circle cx="17" cy="19" r="1.3" />
      </svg>
      <span className="hidden sm:inline">Cart</span>
      <span data-testid="cart-count" data-loading={loading || undefined} className={`min-w-6 rounded-full border px-1.5 text-center text-xs font-semibold ${loading || count === 0 ? 'border-muted text-muted' : 'border-ink bg-ink text-cream'}`}>
        {loading ? '…' : count}
      </span>
    </NavLink>
  );
}

/**
 * The header stays at the top of the window while the page scrolls (sticky: it takes no extra room and nothing moves), on every page but the
 * editor (/design): there a phone needs every pixel of height for the canvas above its fixed bottom bars (in landscape the canvas no longer
 * fits with 68 px of header on screen), so the header scrolls away as it did before step A. It has a solid
 * token background, and a soft shadow once the page has scrolled. Its height is fixed (--header-height) at every width: below 1024 px
 * the links live in the menu, so there is never a second row. z-40 keeps it over the page and under the dialogs (native, in the top
 * layer); the menu panel opens inside it.
 */
function Header() {
  const { user } = useAuth();
  const wide = useWideNav();
  const scrolled = useScrolled();
  const { pathname } = useLocation();
  const current = useCurrentSection(pathname === '/');
  const sticky = pathname !== '/design';
  return (
    <header
      data-scrolled={scrolled || undefined}
      className={`${sticky ? 'sticky top-0' : 'relative'} z-40 box-border h-[var(--header-height)] shrink-0 border-b border-tan bg-paper transition-shadow motion-reduce:transition-none ${scrolled ? 'shadow-header' : ''}`}
    >
      <div className="mx-auto flex h-full max-w-6xl items-center justify-between gap-x-3 px-4 sm:gap-x-6">
        <Link to="/" className="flex min-w-0 items-center gap-2 no-underline sm:gap-2.5" aria-label="ClothCraft, home">
          <img src="/site/logo-96.webp" alt="" width={40} height={40} className="size-9 shrink-0 rounded-sm sm:size-10" />
          <span className="font-display text-2xl font-bold italic leading-none text-ink sm:text-3xl">ClothCraft</span>
        </Link>

        {wide && (
          <nav aria-label="Main" className="flex items-center gap-x-5" data-testid="main-nav">
            {NAV_ITEMS.map((item) =>
              item.kind === 'section' ? (
                <SectionLink key={item.label} id={item.id} aria-current={current === item.id ? 'location' : undefined} className={`${linkBase} ${linkState(current === item.id)}`}>
                  {item.label}
                </SectionLink>
              ) : (
                <NavLink key={item.label} to={item.to} className={({ isActive }) => `${linkBase} ${linkState(isActive)}`}>
                  {item.label}
                </NavLink>
              ),
            )}
          </nav>
        )}

        {/* a cart belongs to a signed-in customer: there is no cart link before sign-in (and never for a staff session) */}
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
          {user && <CartLink />}
          {user && (
            <span data-testid="signed-in-name" className="hidden max-w-40 truncate text-sm font-medium text-ink xl:inline">
              {user.displayName}
            </span>
          )}
          <HeaderMenu currentSection={current} />
        </div>
      </div>
    </header>
  );
}

/** html[data-header] tells index.css whether the header covers the top of the window (scroll-padding-top is its height only then). */
function useHeaderMode(sticky: boolean) {
  useEffect(() => {
    document.documentElement.dataset.header = sticky ? 'sticky' : 'static';
    return () => {
      delete document.documentElement.dataset.header;
    };
  }, [sticky]);
}

export function Layout() {
  // The Design route (and only it) becomes a window-sized workspace from 1024 px up: header, the editor filling the rest, and a
  // one-line footer. Below 1024 px, and on every other route, the page is as it always was. The 42rem floor keeps the canvas
  // from shrinking under 320 px in a very short window: the page scrolls instead.
  const path = useLocation().pathname;
  const designRoute = path === '/design';
  useHeaderMode(!designRoute);
  return (
    <AuthProvider>
      <div className={designRoute ? 'flex min-h-screen flex-col lg:h-dvh lg:min-h-[42rem]' : 'flex min-h-screen flex-col'}>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-cream focus:px-4 focus:py-2 focus:font-semibold focus:text-ink">
          Skip to main content
        </a>
        <ScrollToHash />
        <Header />
        {path !== '/cart' && <CartOfflineBar />}
        {/* keyed by the path: a new page fades in (index.css .page-fade, off under reduced motion). The classes are the same as before, so the
            editor's window-sized layout is untouched. A query string or #hash change keeps the page (and what is typed in it). */}
        <main key={path} id="main" className={`page-fade ${designRoute ? 'flex-1 lg:min-h-0' : 'flex-1'}`}>
          <Outlet />
        </main>
        {designRoute ? (
          <>
            <div className="lg:hidden">
              <Footer />
            </div>
            <div className="hidden lg:block">
              <FooterSlim />
            </div>
          </>
        ) : (
          <Footer />
        )}
      </div>
    </AuthProvider>
  );
}
