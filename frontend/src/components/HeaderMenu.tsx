import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { API_MODE } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { NAV_ITEMS, SectionLink, useWideNav } from './siteNav';

/** The CC user dialog (Admin login / Employee login) is loaded only when it is opened. */
const StaffChooser = lazy(async () => ({ default: (await import('./StaffChooser')).StaffChooser }));

/** Where the static documentation page is served (frontend/public/docs/index.html, copied unchanged into the build). */
const DOCS_PATH = '/docs/';

const itemClass =
  'flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2 text-left text-base font-medium text-ink no-underline hover:bg-paper-warm focus:bg-ink focus:text-cream focus:outline-none focus-visible:outline-none';
const currentItemClass = 'border-l-4 border-sage-dark pl-3';

/**
 * The header's menu: a hamburger button that turns into an X while the menu is open (step A). Its panel holds
 *  - below the width where the links fit in the header (siteNav NAV_QUERY): the main links, then a divider;
 *  - signed out: Register, Login, CC user (opens a small dialog: Admin login, /admin/login, or Employee login, /staff, where a staff session goes on to the dashboard);
 *  - signed in: the customer's name and email, Account, Orders, Sign out;
 *  - then Need help?, shown but not clickable ("Coming soon", aria-disabled), and Documentation, a link to the static page /docs/ that opens in a new tab.
 * It is a WAI-ARIA menu button:
 *  - the button says what it will do ("Open menu" / "Close menu") and whether it is open (aria-expanded), and which panel it controls;
 *  - click, Enter and Space toggle it; opening moves focus to the first item (ArrowUp on the button: the last); ArrowUp/ArrowDown move
 *    round the items, Home/End jump; a disabled item can be reached (so it is announced) but does nothing;
 *  - Esc closes and puts focus back on the button; Tab closes and lets focus move on; a press anywhere outside closes;
 *  - choosing an item closes the menu and puts focus on the button first, so a dialog opened from it gives focus back there.
 * The X is drawn with three bars that move; under prefers-reduced-motion they swap at once (index.css switches transitions off).
 */
export function HeaderMenu({ currentSection }: { currentSection: string | null }) {
  const { user, status, openSignIn, openRegister, signOut } = useAuth();
  const { pathname } = useLocation();
  const wide = useWideNav();
  const ids = useId();
  const panelId = `${ids}-menu`;
  const [open, setOpen] = useState(false);
  const [focusOn, setFocusOn] = useState<'first' | 'last'>('first');
  const [chooser, setChooser] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const entries = () => [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  // focus goes into the panel when it opens
  useEffect(() => {
    if (!open) return;
    const list = entries();
    (focusOn === 'last' ? list[list.length - 1] : list[0])?.focus();
  }, [open, focusOn]);

  // a press outside closes it (focus stays where the press put it)
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  // Signing in or out, widening the window until the links fit in the header, or going to another page: the menu closes. Done while
  // rendering (React's "adjust state when a value changes" pattern), NOT in an effect: an effect runs a moment AFTER the render that
  // changed the account, so a press in that moment (the session check answering as the visitor opens the menu) was opened and then undone.
  const situation = `${user?.id ?? ''}|${wide}|${pathname}`;
  const [lastSituation, setLastSituation] = useState(situation);
  if (lastSituation !== situation) {
    setLastSituation(situation);
    setOpen(false);
  }

  const openAt = (where: 'first' | 'last') => {
    setFocusOn(where);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const choose = (run?: () => void) => () => {
    close(true);
    run?.();
  };

  const onButtonKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openAt(event.key === 'ArrowUp' ? 'last' : 'first');
    }
  };
  const onPanelKey = (event: KeyboardEvent) => {
    const list = entries();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(list.length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') close(false);
  };

  const button_ = (label: string, run: () => void) => (
    <button key={label} type="button" role="menuitem" tabIndex={-1} onClick={choose(run)} className={itemClass}>
      {label}
    </button>
  );
  const link = (label: string, to: string, run?: () => void) => (
    <Link key={label} to={to} role="menuitem" tabIndex={-1} onClick={choose(run)} className={itemClass}>
      {label}
    </Link>
  );
  /** shown, announced, reachable with the arrow keys, and does nothing */
  const soon = (label: string) => (
    <span key={label} role="menuitem" aria-disabled="true" tabIndex={-1} className={`${itemClass} cursor-default text-muted hover:bg-transparent`}>
      {label}{' '}
      <span className="shrink-0 whitespace-nowrap border border-tan px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-muted">Coming soon</span>
    </span>
  );
  /** The documentation is a static page (public/docs/index.html), not a route of this app: a plain link, opened in a new tab. */
  const documentation = () => (
    <a key="Documentation" href={DOCS_PATH} target="_blank" rel="noopener" role="menuitem" tabIndex={-1} onClick={choose()} className={itemClass}>
      Documentation
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
  const divider = (key: string): ReactNode => <div key={key} role="separator" className="my-1 border-t border-tan" />;

  return (
    <div ref={wrapper} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? 'Close menu' : 'Open menu'}
        data-testid="account-menu-button"
        onClick={() => (open ? close(false) : openAt('first'))}
        onKeyDown={onButtonKey}
        className="inline-flex size-11 items-center justify-center border border-brown-dark bg-cream text-ink hover:bg-paper-warm"
      >
        <span aria-hidden="true" data-open={open || undefined} className="group relative block h-4 w-6">
          <span className="absolute inset-x-0 top-1/2 -mt-px h-0.5 -translate-y-1.75 bg-current transition-[translate,rotate,opacity] duration-200 motion-reduce:transition-none group-data-open:translate-y-0 group-data-open:rotate-45" />
          <span className="absolute inset-x-0 top-1/2 -mt-px h-0.5 bg-current transition-opacity duration-200 motion-reduce:transition-none group-data-open:opacity-0" />
          <span className="absolute inset-x-0 top-1/2 -mt-px h-0.5 translate-y-1.75 bg-current transition-[translate,rotate,opacity] duration-200 motion-reduce:transition-none group-data-open:translate-y-0 group-data-open:-rotate-45" />
        </span>
      </button>
      {open && (
        <div
          ref={panel}
          id={panelId}
          role="menu"
          aria-label="Site menu"
          onKeyDown={onPanelKey}
          data-testid="account-menu"
          className="absolute right-0 top-full z-40 mt-1 max-h-[calc(100dvh-var(--header-height)-1rem)] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto border border-brown-dark bg-cream py-1 shadow-menu"
        >
          {!wide && (
            <>
              {NAV_ITEMS.map((item) =>
                item.kind === 'section' ? (
                  <SectionLink
                    key={item.label}
                    id={item.id}
                    role="menuitem"
                    tabIndex={-1}
                    onNavigate={() => close(true)}
                    aria-current={currentSection === item.id ? 'location' : undefined}
                    className={`${itemClass} ${currentSection === item.id ? currentItemClass : ''}`}
                  >
                    {item.label}
                  </SectionLink>
                ) : (
                  <NavRoute key={item.label} to={item.to} label={item.label} onChoose={choose()} />
                ),
              )}
              {divider('nav-divider')}
            </>
          )}

          {user ? (
            <>
              <div role="presentation" className="border-b border-tan px-4 py-2" data-testid="menu-who">
                <p className="truncate text-base font-semibold text-ink">{user.displayName}</p>
                <p className="truncate text-sm text-muted">{user.email}</p>
              </div>
              {link('Account', '/account')}
              {link('Orders', '/account#orders')}
              {button_('Sign out', signOut)}
            </>
          ) : status === 'loading' ? (
            <p role="status" className="px-4 py-2 text-sm text-muted">
              Checking your account…
            </p>
          ) : (
            <>
              {button_('Register', () => openRegister())}
              {button_('Login', () => openSignIn())}
              {button_('CC user', () => setChooser(true))}
            </>
          )}
          {divider('help-divider')}
          {soon('Need help?')}
          {documentation()}
        </div>
      )}
      {chooser && (
        <Suspense fallback={null}>
          <StaffChooser admin={API_MODE !== 'mock'} onClose={() => setChooser(false)} />
        </Suspense>
      )}
    </div>
  );
}

/** A page link in the menu's top group: current (aria-current="page") on its own page. */
function NavRoute({ to, label, onChoose }: { to: string; label: string; onChoose: () => void }) {
  const { pathname } = useLocation();
  const here = pathname === to;
  return (
    <Link to={to} role="menuitem" tabIndex={-1} onClick={onChoose} aria-current={here ? 'page' : undefined} className={`${itemClass} ${here ? currentItemClass : ''}`}>
      {label}
    </Link>
  );
}
