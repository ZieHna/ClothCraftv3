import { configure, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../auth/AuthContext';
import { cartStore } from '../cart/cartStore';
import { handlers } from '../mocks/handlers';
import { loadDb, resetDb } from '../mocks/shopDb';
import { signInTestCustomer } from '../test/mockSession';
import { setViewportWidth } from '../test/viewport';
import { HeaderMenu } from './HeaderMenu';

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 30000 });
const server = setupServer(...handlers);
beforeAll(() => {
  server.listen({ onUnhandledFrame: ({ defaults }) => defaults.error() });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? `${window.location.origin}${input}` : input, init));
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  Element.prototype.scrollIntoView ??= function () {};
});
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  resetDb();
  sessionStorage.clear();
  localStorage.clear();
  cartStore.setOwner(null);
  setViewportWidth(1280);
});
afterEach(() => server.resetHandlers());

function Where() {
  const { pathname, search, hash } = useLocation();
  return <p data-testid="where">{pathname + search + hash}</p>;
}
/** what the page knows about who is signed in: the menu may only be opened once this has settled, or the answer closes it */
function Who() {
  const { user, status } = useAuth();
  return <p data-testid="who">{status === 'loading' ? 'checking' : user ? `in:${user.displayName}` : 'out'}</p>;
}
function renderMenu(at = '/') {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <AuthProvider>
            <HeaderMenu currentSection={null} />
            <Where />
            <Who />
            <p>outside</p>
          </AuthProvider>
        ),
      },
    ],
    { initialEntries: [at] },
  );
  render(<RouterProvider router={router} />);
}
const button = () => screen.getByTestId('account-menu-button');
const menu = () => screen.findByRole('menu');
const items = () => within(screen.getByRole('menu')).getAllByRole('menuitem');
const labels = () => items().map((i) => i.textContent?.replace(/\s+/g, ' ').trim());

/** a signed-in customer, and the menu once the session check has finished (opening it earlier would be closed by that answer) */
async function renderSignedIn(width = 1280) {
  setViewportWidth(width);
  signInTestCustomer('Ana Cruz', 4);
  renderMenu();
  await vi.waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('in:Ana Cruz'));
}

describe('the button: a hamburger that becomes an X', () => {
  it('says what it will do, whether it is open and which panel it controls; the bars show the X while open', async () => {
    const user = userEvent.setup({ delay: null });
    renderMenu();
    expect(button().tagName).toBe('BUTTON');
    expect(button()).toHaveAccessibleName('Open menu');
    expect(button()).toHaveAttribute('aria-haspopup', 'menu');
    expect(button()).toHaveAttribute('aria-expanded', 'false');
    expect(button().querySelector('[data-open]')).toBeNull();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(button());
    const panel = await menu();
    expect(button()).toHaveAccessibleName('Close menu');
    expect(button()).toHaveAttribute('aria-expanded', 'true');
    expect(button()).toHaveAttribute('aria-controls', panel.id);
    expect(button().querySelector('[data-open]')).not.toBeNull(); // the X
    expect(panel).toHaveAccessibleName('Site menu');
    await user.click(button()); // the same button closes it
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button()).toHaveAccessibleName('Open menu');
    expect(button()).toHaveAttribute('aria-expanded', 'false');
    expect(button().querySelector('[data-open]')).toBeNull();
  });

  it('is at least 44 px square and its three bars are not announced', () => {
    renderMenu();
    expect(button().className).toMatch(/\bsize-11\b/); // 2.75rem = 44 px
    expect(button().querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('Enter and Space toggle it', async () => {
    const user = userEvent.setup({ delay: null });
    renderMenu();
    button().focus();
    await user.keyboard('{Enter}');
    expect(await menu()).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.keyboard(' ');
    expect(await menu()).toBeInTheDocument();
  });
});

describe('signed out (a wide screen: the links are in the header)', () => {
  it('opens on Register, Login, CC user, then Need help? (Coming soon) and Documentation (a link); focus moves into the panel', async () => {
    const user = userEvent.setup({ delay: null });
    renderMenu();
    await user.click(button());
    await menu();
    expect(labels()).toEqual(['Register', 'Login', 'CC user', 'Need help? Coming soon', 'Documentation (opens in a new tab)']);
    expect(items()[0]).toHaveFocus();
  });

  it('has no links to the site\'s pages here (they are in the header row)', async () => {
    const user = userEvent.setup({ delay: null });
    renderMenu();
    await user.click(button());
    await menu();
    expect(screen.queryByRole('menuitem', { name: 'How it works' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Category' })).not.toBeInTheDocument();
  });

  it('Need help? is shown as "Coming soon" and cannot be used: disabled, no link, nothing happens', async () => {
    const user = userEvent.setup({ delay: null });
    renderMenu('/somewhere');
    await user.click(button());
    await menu();
    const soon = screen.getByRole('menuitem', { name: /^Need help?/ });
    expect(soon).toHaveAttribute('aria-disabled', 'true');
    expect(soon).toHaveTextContent('Coming soon');
    expect(soon.tagName).not.toBe('A');
    expect(soon).not.toHaveAttribute('href');
    await user.click(soon);
    expect(screen.getByRole('menu')).toBeInTheDocument(); // still open: it did nothing
    expect(screen.getByTestId('where')).toHaveTextContent('/somewhere');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // it can be reached with the arrow keys (so it is announced), and Enter on it does nothing either
    items()[2].focus();
    await user.keyboard('{ArrowDown}');
    expect(items()[3]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/somewhere');
  });

  it('Documentation is a real link to the static page /docs/, opened in a new tab without handing over the opener, and closing the menu', async () => {
    const user = userEvent.setup({ delay: null });
    renderMenu('/somewhere');
    await user.click(button());
    await menu();
    const docs = screen.getByRole('menuitem', { name: /^Documentation/ });
    expect(docs.tagName).toBe('A');
    expect(docs).toHaveAttribute('href', '/docs/');
    expect(docs).toHaveAttribute('target', '_blank');
    expect(docs.getAttribute('rel')).toContain('noopener');
    expect(docs).not.toHaveAttribute('aria-disabled');
    expect(docs).not.toHaveTextContent('Coming soon');
    expect(screen.getAllByRole('menuitem', { name: /Documentation/ })).toHaveLength(1); // one link, not two
    await user.click(docs);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/somewhere'); // this tab stays where it was
    expect(button()).toHaveFocus();
  });

  it('arrow keys move round the items, Home and End jump, Esc closes and gives focus back to the button', async () => {
    const user = userEvent.setup({ delay: null });
    renderMenu();
    button().focus();
    await user.keyboard('{ArrowDown}');
    await menu();
    expect(items()[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items()[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items()[4]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items()[0]).toHaveFocus(); // round again
    await user.keyboard('{ArrowUp}');
    expect(items()[4]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items()[0]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button()).toHaveFocus();
    expect(button()).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{ArrowUp}'); // ArrowUp on the button opens it on the last item
    await menu();
    expect(items()[4]).toHaveFocus();
  });

  it('a press outside closes it, and so does Tab; a press inside does not', async () => {
    const user = userEvent.setup({ delay: null });
    renderMenu();
    await user.click(button());
    await menu();
    fireEvent.pointerDown(screen.getByRole('menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(button());
    await menu();
    await user.tab();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Register opens the register dialog and Login the sign-in dialog; the menu closes first and focus returns to the button', async () => {
    const user = userEvent.setup({ delay: null });
    renderMenu();
    await user.click(button());
    await user.click(await screen.findByRole('menuitem', { name: 'Register' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('heading', { name: 'Register' })).toBeInTheDocument();
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }).click();
    await user.click(button());
    await user.click(await screen.findByRole('menuitem', { name: 'Login' }));
    expect(within(screen.getByRole('dialog')).getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('CC user opens a dialog (the frozen mock build offers Employee login only; the real build also has Admin login); Employee login goes to the staff sign-in (/staff), which the router shows as the staff login or, with a staff session, the dashboard', async () => {
    const user = userEvent.setup({ delay: null });
    renderMenu();
    await user.click(button());
    const cc = await screen.findByRole('menuitem', { name: 'CC user' });
    await user.click(cc);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    const employee = await screen.findByTestId('chooser-employee');
    expect(screen.queryByTestId('chooser-admin')).not.toBeInTheDocument(); // the mock build has no admin area
    await user.click(employee);
    expect(screen.getByTestId('where')).toHaveTextContent('/staff');
  });
});

describe('signed in', () => {
  it('shows the name and email, then Account, Orders, Sign out, then Need help? and Documentation; no Register, Login or CC user', async () => {
    const user = userEvent.setup({ delay: null });
    await renderSignedIn();
    await user.click(button());
    await menu();
    expect(labels()).toEqual(['Account', 'Orders', 'Sign out', 'Need help? Coming soon', 'Documentation (opens in a new tab)']);
    expect(screen.getByTestId('menu-who')).toHaveTextContent('Ana Cruz');
    expect(screen.getByTestId('menu-who')).toHaveTextContent('ana-cruz@example.test');
    for (const gone of ['Register', 'Login', 'CC user']) expect(screen.queryByRole('menuitem', { name: gone })).not.toBeInTheDocument();
  });

  it('Account and Orders go to the account page (Orders to its list), Sign out signs out', async () => {
    const user = userEvent.setup({ delay: null });
    await renderSignedIn();
    await user.click(button());
    await user.click(await screen.findByRole('menuitem', { name: 'Orders' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/account#orders');
    expect(button()).toHaveFocus();
    await user.click(button());
    await user.click(await screen.findByRole('menuitem', { name: 'Account' }));
    expect(screen.getByTestId('where').textContent).toBe('/account');
    await user.click(button());
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await user.click(button());
    expect(await screen.findByRole('menuitem', { name: 'Register' })).toBeInTheDocument(); // signed out again
    await vi.waitFor(() => expect(Object.keys(loadDb().sessions)).toHaveLength(0), { timeout: 8000 });
  });

  it('while a returning visitor\'s session is being checked, the menu offers neither Register nor Login', async () => {
    const user = userEvent.setup({ delay: null });
    signInTestCustomer('Ana Cruz', 4);
    renderMenu();
    await user.click(button());
    expect(await screen.findByText('Checking your account…')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Register' })).not.toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('in:Ana Cruz')); // the answer arrives (and closes the menu: its items changed)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('a narrow screen: the site links are at the top of the menu', () => {
  const NAV = ['How it works', 'Category', 'Featured designs', 'Design', 'Contact'];

  it('signed out: the five links, a divider, then Register, Login, CC user and the placeholders', async () => {
    const user = userEvent.setup({ delay: null });
    setViewportWidth(390);
    renderMenu();
    await user.click(button());
    await menu();
    expect(labels()).toEqual([...NAV, 'Register', 'Login', 'CC user', 'Need help? Coming soon', 'Documentation (opens in a new tab)']);
    const hrefs = items().slice(0, 5).map((i) => i.getAttribute('href'));
    expect(hrefs).toEqual(['/#how-it-works', '/category', '/#featured', '/design', '/#contact']);
    expect(labels()).not.toContain('Browse designs');
    const panel = screen.getByRole('menu');
    const separators = within(panel).getAllByRole('separator');
    expect(separators).toHaveLength(2); // links | account | help
    expect(separators[0].previousElementSibling).toBe(items()[4]); // the divider sits right under the last link
    expect(separators[0].nextElementSibling).toBe(items()[5]);
  });

  it('signed in: the links come above the name and the account items', async () => {
    const user = userEvent.setup({ delay: null });
    await renderSignedIn(390);
    await user.click(button());
    await menu();
    expect(labels()).toEqual([...NAV, 'Account', 'Orders', 'Sign out', 'Need help? Coming soon', 'Documentation (opens in a new tab)']);
  });

  it('choosing a link closes the menu, returns focus to the button first, and goes to the section (hash in the URL)', async () => {
    const user = userEvent.setup({ delay: null });
    setViewportWidth(390);
    renderMenu('/cart');
    await user.click(button());
    await user.click(await screen.findByRole('menuitem', { name: 'Contact' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/#contact');
    await user.click(button());
    await user.click(await screen.findByRole('menuitem', { name: 'Category' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/category');
  });
});
