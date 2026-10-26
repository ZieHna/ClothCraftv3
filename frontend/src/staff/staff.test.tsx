import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryDetails, PaymentMethodId } from '../api/types';
import { MOCK_SESSION_KEY, MOCK_STAFF_SESSION_KEY } from '../api/client';
import { handlers } from '../mocks/handlers';
import { placeOrder, priceCart } from '../mocks/shop';
import { catalogue, loadDb, resetDb, saveDb } from '../mocks/shopDb';
import { DEMO_STAFF, transition } from '../mocks/staff';
import { OrderDetailPage } from './OrderDetailPage';
import { OrdersPage } from './OrdersPage';
import { StaffApp } from './StaffApp';

// the handlers wait 100-400 ms like a real server, and role queries over a whole page are slow in jsdom
configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 60000 });

const server = setupServer(...handlers);
beforeAll(() => {
  server.listen({ onUnhandledFrame: ({ defaults }) => defaults.error() });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? `${window.location.origin}${input}` : input, init));
  window.scrollTo = vi.fn();
});
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});
afterEach(() => server.resetHandlers());
beforeEach(() => {
  resetDb();
  sessionStorage.clear();
  next = 0;
});

const GOOD: DeliveryDetails = {
  fullName: 'Juana Dela Cruz', email: 'juana@example.com', phone: '0917 123 4567', street: '12 Rizal Street', city: 'Quezon City', province: 'PH-00', postalCode: '1100', note: 'Leave with the guard',
};
const variants = catalogue.products.flatMap((p) => p.variants).filter((v) => v.stock >= 5 && v.status === 'in_stock');
let next = 0;
function place(method: PaymentMethodId = 'cod', name = 'Juana Dela Cruz') {
  const lines = [{ sku: variants[next++].sku, quantity: 1 }];
  const result = placeOrder({ lines, delivery: { ...GOOD, fullName: name }, paymentMethod: method, quotedTotal: priceCart(lines).total }, null, loadDb(), 0);
  if (result.status !== 201) throw new Error('could not place the test order');
  return result.order;
}
const inventory = DEMO_STAFF.find((s) => s.role === 'inventory')!;
const admin = DEMO_STAFF.find((s) => s.role === 'admin')!;
/** the staff member is already signed in: what signing in leaves behind */
function seedStaff(who: typeof inventory) {
  const db = loadDb();
  db.staffSessions['test-staff'] = who.id;
  saveDb(db);
  sessionStorage.setItem(MOCK_STAFF_SESSION_KEY, 'test-staff');
}
const orderIn = (id: string) => loadDb().orders.find((o) => o.id === id)!;

function renderAt(path: string) {
  const router = createMemoryRouter(
    [{ path: '/staff', element: <StaffApp />, children: [{ index: true, element: <OrdersPage /> }, { path: 'orders/:id', element: <OrderDetailPage /> }] }],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('signing in', () => {
  it('shows the sign-in form to a visitor, with the two demo accounts in the mock, and nothing else', async () => {
    renderAt('/staff');
    expect(await screen.findByRole('heading', { name: 'Staff sign in' })).toBeInTheDocument();
    expect(await screen.findByTestId('staff-demo-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('staff-orders')).not.toBeInTheDocument();
    expect(screen.queryByTestId('staff-who')).not.toBeInTheDocument();
  });

  it('a wrong password is told in one sentence and the password field is emptied', async () => {
    const user = userEvent.setup();
    renderAt('/staff');
    await user.type(await screen.findByLabelText('Email'), inventory.email);
    await user.type(screen.getByLabelText('Password'), 'not the password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The email or password is not right.');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('a demo account fills the form, signs in, shows who and what role, and signing out returns to the form', async () => {
    const user = userEvent.setup();
    renderAt('/staff');
    await user.click(await screen.findByRole('button', { name: /Use Administrator account/ }));
    expect(screen.getByLabelText('Email')).toHaveValue(admin.email);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const who = await screen.findByTestId('staff-who');
    expect(who).toHaveTextContent('Demo Administrator');
    expect(who).toHaveTextContent('Administrator');
    expect(await screen.findByRole('heading', { name: 'Orders' })).toBeInTheDocument();
    await user.click(within(who).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Staff sign in' })).toBeInTheDocument();
    // the token is forgotten at once; the server ends the session when its answer to the sign-out request is made
    expect(sessionStorage.getItem(MOCK_STAFF_SESSION_KEY)).toBeNull();
    await waitFor(() => expect(Object.keys(loadDb().staffSessions)).toHaveLength(0));
  });

  it('a customer session alone opens nothing: the dashboard still asks for a staff sign-in', async () => {
    const db = loadDb();
    db.users.push({ id: 1, name: 'Shopper', email: 'shopper@example.test', password: 'a long shopper password' });
    db.sessions['customer-token'] = 1;
    saveDb(db);
    sessionStorage.setItem(MOCK_SESSION_KEY, 'customer-token');
    renderAt('/staff');
    expect(await screen.findByRole('heading', { name: 'Staff sign in' })).toBeInTheDocument();
    expect(screen.queryByTestId('staff-orders')).not.toBeInTheDocument();
  });

  it('a stale staff session (the server forgot it) lands on the form with a notice, and the customer session is untouched', async () => {
    place('cod');
    seedStaff(inventory);
    sessionStorage.setItem(MOCK_SESSION_KEY, 'customer-token');
    const user = userEvent.setup();
    renderAt('/staff');
    expect(await screen.findByTestId('staff-orders')).toBeInTheDocument();
    const db = loadDb();
    db.staffSessions = {};
    saveDb(db);
    await user.click(screen.getByRole('button', { name: 'Packed' }));
    expect(await screen.findByTestId('staff-session-ended')).toHaveTextContent('Your session ended');
    expect(await screen.findByRole('heading', { name: 'Staff sign in' })).toBeInTheDocument();
    expect(sessionStorage.getItem(MOCK_SESSION_KEY)).toBe('customer-token');
  });
});

describe('the orders table', () => {
  it('lists the orders newest first with who, how they pay, the total and the status in words', async () => {
    const a = place('cod', 'Ana Reyes');
    const b = place('bank_transfer', 'Ben Santos');
    seedStaff(inventory);
    renderAt('/staff');
    const rows = await screen.findAllByTestId('staff-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(b.reference);
    expect(rows[0]).toHaveTextContent('Ben Santos');
    expect(rows[0]).toHaveTextContent('Bank transfer');
    expect(rows[0]).toHaveTextContent('Not paid yet');
    expect(rows[0]).toHaveTextContent('Awaiting payment');
    expect(rows[1]).toHaveTextContent(a.reference);
    expect(rows[1]).toHaveTextContent('Confirmed');
    expect(screen.getByTestId('staff-count')).toHaveTextContent('Showing 1 to 2 of 2 orders');
  });

  it('a status tab filters at once, and the search finds an order by its number or the customer', async () => {
    const a = place('cod', 'Ana Reyes');
    place('bank_transfer', 'Ben Santos');
    seedStaff(inventory);
    const user = userEvent.setup();
    renderAt('/staff');
    await screen.findAllByTestId('staff-row');
    await user.click(screen.getByRole('button', { name: 'Awaiting payment' }));
    await waitFor(() => expect(screen.getAllByTestId('staff-row')).toHaveLength(1));
    expect(screen.getByTestId('staff-row')).toHaveAttribute('data-state', 'awaiting_payment');
    await user.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(screen.getAllByTestId('staff-row')).toHaveLength(2));
    await user.type(screen.getByLabelText('Search'), a.reference);
    await user.click(screen.getByRole('button', { name: 'Show orders' }));
    await waitFor(() => expect(screen.getAllByTestId('staff-row')).toHaveLength(1));
    expect(screen.getByTestId('staff-row')).toHaveTextContent('Ana Reyes');
  });

  it('says so when nothing matches, and Clear brings everything back', async () => {
    place('cod');
    seedStaff(inventory);
    const user = userEvent.setup();
    renderAt('/staff');
    await screen.findAllByTestId('staff-row');
    await user.click(screen.getByRole('button', { name: 'Delivered' }));
    expect(await screen.findByTestId('staff-empty')).toHaveTextContent('No orders match these filters.');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(await screen.findAllByTestId('staff-row')).toHaveLength(1);
  });

  it('pages: 26 orders are two pages, and Next shows the older one', async () => {
    seedStaff(inventory);
    for (let i = 0; i < 26; i++) {
      next = i % variants.length;
      place('cod');
    }
    const user = userEvent.setup();
    renderAt('/staff');
    await screen.findAllByTestId('staff-row');
    expect(screen.getAllByTestId('staff-row')).toHaveLength(25);
    expect(screen.getByTestId('staff-page')).toHaveTextContent('Page 1 of 2');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getAllByTestId('staff-row')).toHaveLength(1));
    expect(screen.getByTestId('staff-page')).toHaveTextContent('Page 2 of 2');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});

describe('one order', () => {
  it('a cash-on-delivery order goes through every step with one click each, and the history and the status follow', async () => {
    const o = place('cod');
    seedStaff(inventory);
    const user = userEvent.setup();
    renderAt(`/staff/orders/${o.id}`);
    expect(await screen.findByTestId('staff-order-status')).toHaveTextContent('Confirmed');
    expect(screen.getByTestId('staff-customer')).toHaveTextContent('juana@example.com');
    expect(screen.getByTestId('staff-delivery')).toHaveTextContent('Leave with the guard');
    await user.click(await screen.findByTestId('staff-move-packed'));
    await waitFor(() => expect(screen.getByTestId('staff-order-status')).toHaveTextContent('Packed'));
    expect(screen.getByTestId('staff-done')).toHaveTextContent('Marked as packed.');
    await user.click(screen.getByTestId('staff-move-shipped'));
    await waitFor(() => expect(screen.getByTestId('staff-order-status')).toHaveTextContent('Shipped'));
    expect(screen.queryByTestId('staff-move-cancelled')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('staff-move-delivered'));
    await waitFor(() => expect(screen.getByTestId('staff-order-status')).toHaveTextContent('Delivered'));
    expect(screen.getByTestId('staff-final')).toHaveTextContent('There is nothing more to do');
    expect(screen.getByTestId('staff-payment')).toHaveTextContent('Cash collected on delivery.');
    const history = screen.getAllByTestId('staff-history-row');
    expect(history).toHaveLength(3);
    expect(history[2].textContent).toMatch(/Shipped.*Delivered/);
    expect(history[2]).toHaveTextContent('Demo Inventory Staff');
    expect(orderIn(o.id).state).toBe('delivered');
  });

  it('cancelling asks first, then gives the stock back, and "Go back" changes nothing', async () => {
    const o = place('cod');
    seedStaff(inventory);
    const user = userEvent.setup();
    renderAt(`/staff/orders/${o.id}`);
    await user.click(await screen.findByTestId('staff-move-cancelled'));
    expect(screen.getByTestId('staff-confirm')).toHaveTextContent('Cancelling gives the items back to stock');
    await user.click(screen.getByRole('button', { name: 'Go back' }));
    expect(screen.queryByTestId('staff-confirm')).not.toBeInTheDocument();
    expect(orderIn(o.id).state).toBe('confirmed');
    await user.click(screen.getByTestId('staff-move-cancelled'));
    await user.click(screen.getByTestId('staff-confirm-yes'));
    await waitFor(() => expect(screen.getByTestId('staff-order-status')).toHaveTextContent('Cancelled'));
    expect(orderIn(o.id).state).toBe('cancelled');
  });

  it('a paid bank-transfer order: Inventory Staff see why they cannot cancel it and have no button for it', async () => {
    const o = place('bank_transfer');
    transition(o.id, 'inventory', 'Someone', { to: 'confirmed', expectedState: 'awaiting_payment', note: '' });
    seedStaff(inventory);
    renderAt(`/staff/orders/${o.id}`);
    expect(await screen.findByTestId('staff-order-status')).toHaveTextContent('Paid');
    expect(screen.queryByTestId('staff-move-cancelled')).not.toBeInTheDocument();
    expect(screen.getByTestId('staff-blocked')).toHaveTextContent('Only an Administrator can cancel an order that has been paid.');
    expect(screen.getByTestId('staff-move-packed')).toBeInTheDocument();
  });

  it('an Administrator can cancel it, but only with a note: no note is refused on the field, with a note it is done and says REFUND DUE', async () => {
    const o = place('bank_transfer');
    transition(o.id, 'inventory', 'Someone', { to: 'confirmed', expectedState: 'awaiting_payment', note: '' });
    seedStaff(admin);
    const user = userEvent.setup();
    renderAt(`/staff/orders/${o.id}`);
    await user.click(await screen.findByTestId('staff-move-cancelled'));
    expect(screen.getByTestId('staff-confirm')).toHaveTextContent('refund to arrange outside this system');
    await user.click(screen.getByTestId('staff-confirm-yes'));
    expect(await screen.findByTestId('staff-note-error')).toHaveTextContent('a refund has to be arranged');
    expect(orderIn(o.id).state).toBe('confirmed');
    await user.type(screen.getByLabelText(/Note/), 'Finance refunds by transfer');
    await user.click(screen.getByTestId('staff-confirm-yes'));
    await waitFor(() => expect(screen.getByTestId('staff-order-status')).toHaveTextContent('Cancelled'));
    expect(screen.getAllByTestId('staff-history-row').at(-1)).toHaveTextContent('Note: REFUND DUE. Finance refunds by transfer');
  });

  it('when somebody else moved the order first, nothing is done, the screen catches up and says who', async () => {
    const o = place('cod');
    seedStaff(inventory);
    const user = userEvent.setup();
    renderAt(`/staff/orders/${o.id}`);
    await user.click(await screen.findByTestId('staff-move-packed'));
    await waitFor(() => expect(screen.getByTestId('staff-order-status')).toHaveTextContent('Packed'));
    // another person ships it while this screen still shows "packed"
    transition(o.id, 'admin', 'Demo Administrator', { to: 'shipped', expectedState: 'packed', note: '' });
    await user.click(screen.getByTestId('staff-move-cancelled'));
    await user.click(screen.getByTestId('staff-confirm-yes'));
    expect(await screen.findByTestId('staff-problem')).toHaveTextContent('This order is now shipped; it was changed by Demo Administrator. Nothing was done.');
    expect(screen.getByTestId('staff-order-status')).toHaveTextContent('Shipped');
    expect(orderIn(o.id).state).toBe('shipped');
    expect(screen.queryByTestId('staff-confirm')).not.toBeInTheDocument();
  });

  it('an order that is not there says so', async () => {
    seedStaff(inventory);
    renderAt('/staff/orders/999');
    expect(await screen.findByRole('heading', { name: 'Order not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All orders' })).toBeInTheDocument();
  });
});
