import { render, screen, within, configure } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_SESSION_KEY } from '../api/client';
import { cartKeyFor, cartStore } from '../cart/cartStore';
import { RequireAccount } from '../components/RequireAccount';
import { handlers } from '../mocks/handlers';
import { resetDb } from '../mocks/shopDb';
import { signInTestCustomer } from '../test/mockSession';
import { AuthProvider, useAuth } from './AuthContext';
import { userKey } from './userKey';

const clearDrafts = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../drafts/registry', () => ({ clearDraftsOnSignOut: clearDrafts }));

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 30000 });
const server = setupServer(...handlers);
const calls: string[] = [];
beforeAll(() => {
  server.listen({ onUnhandledFrame: ({ defaults }) => defaults.error() });
  server.events.on('request:start', ({ request }) => calls.push(`${request.method} ${new URL(request.url).pathname}`));
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? `${window.location.origin}${input}` : input, init));
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
});
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  resetDb();
  sessionStorage.clear();
  localStorage.clear();
  calls.length = 0;
  clearDrafts.mockClear();
});
afterEach(() => server.resetHandlers());

function Probe() {
  const { user, status, openSignIn, openRegister, signOut } = useAuth();
  return (
    <div>
      <p data-testid="who">{status === 'loading' ? 'loading' : user ? `${user.displayName} <${user.email}> #${user.id}` : 'nobody'}</p>
      <button onClick={() => openSignIn()}>open sign in</button>
      <button onClick={() => openRegister()}>open register</button>
      <button onClick={signOut}>sign out</button>
      <RequireAccount what="see this">
        <p>the secret page</p>
      </RequireAccount>
    </div>
  );
}
const renderProbe = () => render(<AuthProvider><Probe /></AuthProvider>);
const dialog = () => screen.getByRole('dialog');

describe('userKey', () => {
  it('is the account id, never the name', () => {
    expect(userKey({ id: '12' })).toBe('u12');
    expect(userKey({ id: '12' })).not.toBe(userKey({ id: '13' }));
  });
});

describe('who is signed in', () => {
  it('a first-time visitor is signed out at once and the server is not asked', async () => {
    renderProbe();
    expect(screen.getByTestId('who')).toHaveTextContent('nobody');
    expect(await screen.findByRole('heading', { name: /sign in to see this/i })).toBeInTheDocument();
    expect(calls.filter((c) => c.includes('/api/auth/me'))).toEqual([]);
  });

  it('a returning visitor shows a status line while the session is checked, then the page, never the prompt', async () => {
    signInTestCustomer('Ana Cruz', 4);
    renderProbe();
    expect(screen.getByTestId('who')).toHaveTextContent('loading');
    expect(screen.getByRole('status')).toHaveTextContent('Checking your sign-in');
    expect(screen.queryByRole('heading', { name: /sign in to see this/i })).not.toBeInTheDocument();
    expect(await screen.findByText('the secret page')).toBeInTheDocument();
    expect(screen.getByTestId('who')).toHaveTextContent('Ana Cruz <ana-cruz@example.test> #4');
    expect(calls.filter((c) => c.includes('/api/auth/me'))).toHaveLength(1);
  });

  it('a session the server no longer knows is a signed-out visitor, quietly', async () => {
    sessionStorage.setItem(MOCK_SESSION_KEY, 'a-token-nobody-issued');
    renderProbe();
    expect(await screen.findByRole('heading', { name: /sign in to see this/i })).toBeInTheDocument();
    expect(screen.getByTestId('who')).toHaveTextContent('nobody');
    expect(screen.queryByTestId('session-ended')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(MOCK_SESSION_KEY)).toBeNull();
  });
});

describe('register', () => {
  it('creates the account, signs in, closes the dialog and remembers the session', async () => {
    const user = userEvent.setup({ delay: null });
    renderProbe();
    await user.click(screen.getByRole('button', { name: 'open register' }));
    await user.type(within(dialog()).getByLabelText('Your name'), 'Ana Cruz');
    await user.type(within(dialog()).getByLabelText('Email'), 'Ana@Example.com');
    await user.type(within(dialog()).getByLabelText('Password'), 'a long and careful password');
    await user.click(within(dialog()).getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('the secret page')).toBeInTheDocument();
    expect(screen.getByTestId('who')).toHaveTextContent('Ana Cruz <ana@example.com> #1');
    expect(sessionStorage.getItem(MOCK_SESSION_KEY)).toBeTruthy();
    expect(screen.getByRole('dialog', { hidden: true })).not.toHaveAttribute('open');
  });

  it('tells what is empty at once, without asking the server, and moves focus to the summary', async () => {
    const user = userEvent.setup({ delay: null });
    renderProbe();
    await user.click(screen.getByRole('button', { name: 'open register' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Create account' }));
    const summary = within(dialog()).getByTestId('auth-error-summary');
    expect(summary).toHaveTextContent('Your name: Enter your name.');
    expect(summary).toHaveTextContent('Email: Enter an email address like name@example.com.');
    expect(summary).toHaveTextContent('Password: Choose a password.');
    await vi.waitFor(() => expect(summary).toHaveFocus());
    expect(within(dialog()).getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog()).getByLabelText('Email')).toHaveAccessibleDescription('Enter an email address like name@example.com.');
    expect(calls.filter((c) => c.includes('/api/auth/register'))).toEqual([]);
  });

  it("shows the server's sentences against their fields, and does not keep the refused password", async () => {
    const user = userEvent.setup({ delay: null });
    renderProbe();
    await user.click(screen.getByRole('button', { name: 'open register' }));
    await user.type(within(dialog()).getByLabelText('Your name'), 'Ana');
    await user.type(within(dialog()).getByLabelText('Email'), 'ana@example.com');
    await user.type(within(dialog()).getByLabelText('Password'), 'password123');
    await user.click(within(dialog()).getByRole('button', { name: 'Create account' }));
    expect(await within(dialog()).findByText('Password: That password is too common. Choose another one.')).toBeInTheDocument();
    expect(within(dialog()).getByLabelText('Password')).toHaveValue('');
    expect(within(dialog()).getByLabelText('Password')).toHaveAccessibleDescription(expect.stringContaining('too common'));
    expect(screen.getByTestId('who')).toHaveTextContent('nobody');
  });

  it('says so when the email is taken, without saying more', async () => {
    const user = userEvent.setup({ delay: null });
    renderProbe();
    for (let n = 0; n < 2; n++) {
      await user.click(screen.getByRole('button', { name: 'open register' }));
      await user.type(within(dialog()).getByLabelText('Your name'), 'Ana');
      await user.type(within(dialog()).getByLabelText('Email'), 'ana@example.com');
      await user.type(within(dialog()).getByLabelText('Password'), 'a long and careful password');
      await user.click(within(dialog()).getByRole('button', { name: 'Create account' }));
      if (n === 0) {
        await screen.findByText('the secret page');
        await user.click(screen.getByRole('button', { name: 'sign out' }));
        await screen.findByRole('heading', { name: /sign in to see this/i });
      }
    }
    expect(await within(dialog()).findByText("We couldn't create an account with that email. If it is yours, sign in instead.")).toBeInTheDocument();
  });

  it('the password can be shown and hidden, and is hidden by default', async () => {
    const user = userEvent.setup({ delay: null });
    renderProbe();
    await user.click(screen.getByRole('button', { name: 'open register' }));
    const password = within(dialog()).getByLabelText('Password');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'new-password');
    await user.click(within(dialog()).getByRole('button', { name: /show password/i }));
    expect(password).toHaveAttribute('type', 'text');
    expect(within(dialog()).getByRole('button', { name: /hide password/i })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('sign in', () => {
  async function registerAndLeave(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'open register' }));
    await user.type(within(dialog()).getByLabelText('Your name'), 'Ana Cruz');
    await user.type(within(dialog()).getByLabelText('Email'), 'ana@example.com');
    await user.type(within(dialog()).getByLabelText('Password'), 'a long and careful password');
    await user.click(within(dialog()).getByRole('button', { name: 'Create account' }));
    await screen.findByText('the secret page');
    await user.click(screen.getByRole('button', { name: 'sign out' }));
    await screen.findByRole('heading', { name: /sign in to see this/i });
  }

  it('signs a registered customer in again, whatever the case of the email', async () => {
    const user = userEvent.setup({ delay: null });
    renderProbe();
    await registerAndLeave(user);
    await user.click(screen.getByRole('button', { name: 'open sign in' }));
    expect(within(dialog()).getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    await user.type(within(dialog()).getByLabelText('Email'), ' ANA@example.com ');
    await user.type(within(dialog()).getByLabelText('Password'), 'a long and careful password');
    await user.click(within(dialog()).getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('the secret page')).toBeInTheDocument();
    expect(screen.getByTestId('who')).toHaveTextContent('Ana Cruz <ana@example.com> #1');
  });

  it('a wrong password and an unknown email read the same, and the password field is emptied', async () => {
    const user = userEvent.setup({ delay: null });
    renderProbe();
    await registerAndLeave(user);
    const texts: string[] = [];
    for (const email of ['ana@example.com', 'nobody@example.com']) {
      await user.click(screen.getByRole('button', { name: 'open sign in' }));
      await user.clear(within(dialog()).getByLabelText('Email'));
      await user.type(within(dialog()).getByLabelText('Email'), email);
      await user.type(within(dialog()).getByLabelText('Password'), 'not the right password');
      await user.click(within(dialog()).getByRole('button', { name: 'Sign in' }));
      const summary = within(dialog()).getByTestId('auth-error-summary');
      await vi.waitFor(() => expect(summary).toHaveTextContent('The email or password is not right.'));
      texts.push(summary.textContent ?? '');
      expect(within(dialog()).getByLabelText('Password')).toHaveValue('');
      await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    }
    expect(texts[0]).toBe(texts[1]);
  });

  it('after too many attempts the server\'s sentence shows and the button waits', async () => {
    const user = userEvent.setup({ delay: null });
    server.use(http.post('/api/auth/login', () => HttpResponse.json({ error: { code: 'too_many_attempts', message: 'Too many sign-in attempts. Please wait a minute and try again.', retryAfter: 42 } }, { status: 429, headers: { 'Retry-After': '42' } })));
    renderProbe();
    await user.click(screen.getByRole('button', { name: 'open sign in' }));
    await user.type(within(dialog()).getByLabelText('Email'), 'ana@example.com');
    await user.type(within(dialog()).getByLabelText('Password'), 'whatever it is');
    await user.click(within(dialog()).getByRole('button', { name: 'Sign in' }));
    const summary = within(dialog()).getByTestId('auth-error-summary');
    await vi.waitFor(() => expect(summary).toHaveTextContent('Too many sign-in attempts. Please wait a minute and try again.'));
    expect(summary.textContent).toMatch(/You can try again in (41|42) seconds/);
    expect(within(dialog()).getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('says nothing was changed when the shop cannot be reached', async () => {
    const user = userEvent.setup({ delay: null });
    server.use(http.post('/api/auth/login', () => HttpResponse.error()));
    renderProbe();
    await user.click(screen.getByRole('button', { name: 'open sign in' }));
    await user.type(within(dialog()).getByLabelText('Email'), 'ana@example.com');
    await user.type(within(dialog()).getByLabelText('Password'), 'whatever it is');
    await user.click(within(dialog()).getByRole('button', { name: 'Sign in' }));
    expect(await within(dialog()).findByText(/Could not reach the shop. Nothing was changed/)).toBeInTheDocument();
  });
});

describe('signing in for something', () => {
  function Waiting() {
    const { requireAccount } = useAuth();
    return (
      <>
        <button onClick={() => requireAccount(() => cartStore.add('SIM-M-TEE-BLK-M', 'm-tee', 1), 'Sign in or register to add this to your cart.')}>add</button>
        <p data-testid="lines">{cartStore.get().lines.length}</p>
      </>
    );
  }

  it("says why it asks, runs what was waiting once signed in (into THIS customer's cart), and closing the dialog drops it", async () => {
    const user = userEvent.setup({ delay: null });
    render(<AuthProvider><Waiting /></AuthProvider>);
    await user.click(screen.getByRole('button', { name: 'add' }));
    expect(within(dialog()).getByTestId('auth-reason')).toHaveTextContent('Sign in or register to add this to your cart.');
    expect(dialog()).toHaveAccessibleDescription('Sign in or register to add this to your cart.');
    // closed without signing in: nothing is added, and the next sign-in does not add it either
    await user.keyboard('{Escape}');
    within(dialog()).getByRole('button', { name: 'Cancel' }).click();
    expect(cartStore.owner()).toBeNull();
    await user.click(screen.getByRole('button', { name: 'add' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Register' }));
    await user.type(within(dialog()).getByLabelText('Your name'), 'Ana Cruz');
    await user.type(within(dialog()).getByLabelText('Email'), 'ana@example.com');
    await user.type(within(dialog()).getByLabelText('Password'), 'a long and careful password');
    await user.click(within(dialog()).getByRole('button', { name: 'Create account' }));
    await vi.waitFor(() => expect(cartStore.owner()).toBe('1'));
    expect(JSON.parse(localStorage.getItem(cartKeyFor('1'))!)).toEqual([{ sku: 'SIM-M-TEE-BLK-M', productId: 'm-tee', quantity: 1 }]);
  });
});

describe('sign out and expiry', () => {
  it('sign-out ends the session at the server, clears the cart, deletes THIS account\'s drafts, and forgets the token', async () => {
    const user = userEvent.setup({ delay: null });
    signInTestCustomer('Ana Cruz', 9);
    cartStore.setOwner('9'); // what AuthProvider does once it knows who is signed in
    cartStore.add('SIM-M-TEE-BLK-M', 'm-tee', 2);
    renderProbe();
    await screen.findByText('the secret page');
    await user.click(screen.getByRole('button', { name: 'sign out' }));
    expect(screen.getByTestId('who')).toHaveTextContent('nobody');
    expect(clearDrafts).toHaveBeenCalledWith('u9');
    expect(JSON.parse(localStorage.getItem(cartKeyFor('9'))!)).toEqual([]);
    expect(cartStore.owner()).toBeNull(); // signed out: no cart at all
    await vi.waitFor(() => expect(sessionStorage.getItem(MOCK_SESSION_KEY)).toBeNull());
    expect(calls).toContain('POST /api/auth/logout');
  });

  it('when the server says the session is over, the customer is signed out, the cart is kept, and a notice says why', async () => {
    const user = userEvent.setup({ delay: null });
    signInTestCustomer('Ana Cruz', 3);
    cartStore.setOwner('3');
    cartStore.add('SIM-M-TEE-BLK-M', 'm-tee', 2);
    renderProbe();
    await screen.findByText('the secret page');
    // the session ends behind the page's back: the next request is refused
    server.use(http.get('/api/orders', () => HttpResponse.json({ error: { code: 'unauthorised', message: 'Sign in to place or see orders.' } }, { status: 401 })));
    const { listOrders } = await import('../api/orders');
    await listOrders().catch(() => undefined);
    expect(await screen.findByTestId('session-ended')).toHaveTextContent('Your session ended. Please sign in again.');
    expect(screen.getByTestId('who')).toHaveTextContent('nobody');
    expect(JSON.parse(localStorage.getItem(cartKeyFor('3'))!)).toHaveLength(1); // kept for when this customer signs in again
    expect(cartStore.get().lines).toEqual([]); // but nobody is signed in, so no cart is shown
    expect(clearDrafts).not.toHaveBeenCalled();   // a session that ended is not a sign-out: the drafts stay for when this customer comes back
    await user.click(within(screen.getByTestId('session-ended')).getByRole('button', { name: 'Sign in' }));
    expect(within(dialog()).getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
