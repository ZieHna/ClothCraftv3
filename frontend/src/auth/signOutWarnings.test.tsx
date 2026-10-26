import { render, screen, configure, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cartStore, type CartSync } from '../cart/cartStore';
import { handlers } from '../mocks/handlers';
import { loadDb, resetDb } from '../mocks/shopDb';
import { signInTestCustomer } from '../test/mockSession';
import { AuthProvider, useAuth } from './AuthContext';

/** Step 12: sign-out warns before anything is lost: unfinished designs on this device, and cart edits that could not be saved. */
const clearDrafts = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const drafts = vi.hoisted(() => ({ count: 0 }));
vi.mock('../drafts/registry', () => ({ clearDraftsOnSignOut: clearDrafts }));
vi.mock('../drafts/deviceDrafts', () => ({ knownDraftCount: () => null, countDrafts: () => Promise.resolve(drafts.count), draftsMayChange: () => undefined }));

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 30000 });
const server = setupServer(...handlers);
beforeAll(() => {
  server.listen({ onUnhandledFrame: ({ defaults }) => defaults.error() });
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
  clearDrafts.mockClear();
  drafts.count = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  server.resetHandlers();
});

function Probe() {
  const { user, signOut } = useAuth();
  return (
    <div>
      <p data-testid="who">{user ? user.displayName : 'nobody'}</p>
      <button onClick={signOut}>sign out</button>
    </div>
  );
}

/** The sign-out request is still on its way when the page says "nobody": let it land before the next test signs in (as shopFlow does). */
const sessionGone = () => vi.waitFor(() => expect(Object.keys(loadDb().sessions)).toHaveLength(0));

async function signedIn() {
  signInTestCustomer('Ana Cruz', 9);
  render(<AuthProvider><Probe /></AuthProvider>);
  await vi.waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('Ana Cruz'));
}

describe('unfinished designs', () => {
  it('says how many there are; "Stay signed in" keeps everything, "Sign out anyway" signs out and deletes them', async () => {
    const user = userEvent.setup({ delay: null });
    drafts.count = 3;
    await signedIn();
    await user.click(screen.getByRole('button', { name: 'sign out' }));
    const ask = await screen.findByTestId('signout-drafts');
    expect(ask).toHaveTextContent('You have 3 unfinished designs on this device. Add them to your cart to keep them, or sign out anyway.');
    expect(within(ask).getByRole('button', { name: 'Stay signed in' })).toHaveFocus(); // the safe choice
    await user.click(within(ask).getByRole('button', { name: 'Stay signed in' }));
    expect(screen.getByTestId('who')).toHaveTextContent('Ana Cruz');
    expect(clearDrafts).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'sign out' }));
    await user.click(within(await screen.findByTestId('signout-drafts')).getByRole('button', { name: 'Sign out anyway' }));
    await vi.waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('nobody'));
    expect(clearDrafts).toHaveBeenCalledWith('u9');
    await sessionGone();
  });

  it('one design is said as one; none asks nothing', async () => {
    const user = userEvent.setup({ delay: null });
    drafts.count = 1;
    await signedIn();
    await user.click(screen.getByRole('button', { name: 'sign out' }));
    expect(await screen.findByTestId('signout-drafts')).toHaveTextContent('You have 1 unfinished design on this device. Add it to your cart to keep it, or sign out anyway.');
    await user.click(screen.getByRole('button', { name: 'Stay signed in' }));
    drafts.count = 0;
    await user.click(screen.getByRole('button', { name: 'sign out' }));
    await vi.waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('nobody'));
    expect(screen.queryByTestId('signout-drafts')).not.toBeInTheDocument();
    await sessionGone();
  });
});

describe('cart edits not saved (real shop)', () => {
  const pending: CartSync = { phase: 'ready', pending: true, offline: true, conflict: false, added: 0, refused: 0 };

  it('flushes first; if that fails it asks "Some cart changes couldn\'t be saved. Sign out anyway?"', async () => {
    const user = userEvent.setup({ delay: null });
    await signedIn();
    vi.spyOn(cartStore, 'getSync').mockReturnValue(pending);
    const flush = vi.spyOn(cartStore, 'flush').mockResolvedValue(false);
    const leave = vi.spyOn(cartStore, 'signOut');
    await user.click(screen.getByRole('button', { name: 'sign out' }));
    const ask = await screen.findByTestId('signout-cart');
    expect(flush).toHaveBeenCalledWith(3000);
    expect(ask).toHaveTextContent("Some cart changes couldn't be saved. Sign out anyway?");
    await user.click(within(ask).getByRole('button', { name: 'Stay signed in' }));
    expect(screen.getByTestId('who')).toHaveTextContent('Ana Cruz');
    expect(leave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'sign out' }));
    await user.click(within(await screen.findByTestId('signout-cart')).getByRole('button', { name: 'Sign out anyway' }));
    await vi.waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('nobody'));
    expect(leave).toHaveBeenCalledTimes(1);
    await sessionGone();
  });

  it('a flush that works signs out without a question', async () => {
    const user = userEvent.setup({ delay: null });
    await signedIn();
    vi.spyOn(cartStore, 'getSync').mockReturnValue(pending);
    vi.spyOn(cartStore, 'flush').mockResolvedValue(true);
    await user.click(screen.getByRole('button', { name: 'sign out' }));
    await vi.waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('nobody'));
    expect(screen.queryByTestId('signout-cart')).not.toBeInTheDocument();
    await sessionGone();
  });
});
