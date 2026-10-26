import { configure, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_SESSION_KEY } from '../api/client';
import type { DeliveryDetails, Product, Variant } from '../api/types';
import { cartKeyFor, cartStore } from '../cart/cartStore';
import { Layout } from '../components/Layout';
import { formatMoney } from '../lib/format';
import { handlers } from '../mocks/handlers';
import { signInTestCustomer } from '../test/mockSession';
import { placeOrder as serverPlaceOrder, priceCart } from '../mocks/shop';
import { catalogue, DB_KEY, liveProducts, loadDb, resetDb, saveDb } from '../mocks/shopDb';
import { Account } from './Account';
import { Cart } from './Cart';
import { Checkout } from './Checkout';
import { OrderPage } from './OrderPage';
import { Product as ProductPage } from './Product';

// role queries over a whole page are slow in jsdom, and the handlers wait 100-400 ms like a real server
configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 60000 });

// The real handlers run for real: the pages talk to them over fetch, exactly as in the browser.
const server = setupServer(...handlers);
beforeAll(() => {
  server.listen({ onUnhandledFrame: ({ defaults }) => defaults.error() }); // an /api call with no handler is a bug
  const realFetch = globalThis.fetch; // taken after listen(): this is the one MSW intercepts
  // node's fetch needs absolute URLs; the app always calls /api on its own origin
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? `${window.location.origin}${input}` : input, init));
  window.scrollTo = vi.fn();
  // jsdom has no modal <dialog>: open and close are enough for the sign-in dialog
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});
afterEach(() => server.resetHandlers());

const all: { product: Product; variant: Variant }[] = catalogue.products.flatMap((product) => product.variants.map((variant) => ({ product, variant })));
const plenty = all.find((x) => x.variant.stock >= 5 && x.variant.status === 'in_stock')!;
const soldOut = all.find((x) => x.variant.stock === 0)!;
const low = all.find((x) => x.variant.stock >= 1 && x.variant.status === 'low_stock')!;

const GOOD: DeliveryDetails = { fullName: 'Juana Dela Cruz', email: 'juana@example.com', phone: '0917 123 4567', street: '12 Rizal Street', city: 'Quezon City', province: 'PH-00', postalCode: '1100', note: '' };

/** a signed-in customer (id 1), and their cart, as AuthProvider sets it once it knows who is signed in */
const signIn = () => {
  const id = signInTestCustomer('Demo', 1);
  cartStore.setOwner(String(id));
  return id;
};
const storedCart = () => JSON.parse(localStorage.getItem(cartKeyFor('1')) ?? 'null') as unknown;
const money = (n: number) => formatMoney(n, 'PHP');

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <Layout />,
        children: [
          { path: 'category', element: <p>Category page</p> },
          { path: 'products/:id', element: <ProductPage /> },
          { path: 'cart', element: <Cart /> },
          { path: 'checkout', element: <Checkout /> },
          { path: 'orders/:id', element: <OrderPage /> },
          { path: 'account', element: <Account /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const productUrl = (x: { product: Product; variant: Variant }) => `/products/${x.product.id}?color=${x.variant.color}&size=${x.variant.size}`;

async function fillDelivery(user: UserEvent, d: DeliveryDetails = GOOD) {
  await user.type(screen.getByRole('textbox', { name: /full name/i }), d.fullName);
  await user.type(screen.getByRole('textbox', { name: /^email/i }), d.email);
  await user.type(screen.getByRole('textbox', { name: /mobile number/i }), d.phone);
  await user.type(screen.getByRole('textbox', { name: /house number and street/i }), d.street);
  await user.type(screen.getByRole('textbox', { name: /city or municipality/i }), d.city);
  await user.selectOptions(await screen.findByRole('combobox', { name: /province/i }), d.province);
  await user.type(screen.getByRole('textbox', { name: /postal code/i }), d.postalCode);
}

/** Open the checkout with a ready cart, waiting until the server has priced it and sent the options. */
async function openCheckout(user: UserEvent, lines: { sku: string; productId: string; quantity: number }[]) {
  lines.forEach((l) => cartStore.add(l.sku, l.productId, l.quantity));
  cartStore.setAllSelected(true); // step 10: only ticked lines are checked out
  const router = renderAt('/checkout');
  await screen.findByRole('heading', { name: 'Checkout' });
  await within(await screen.findByTestId('summary-lines')).findAllByRole('listitem');
  await screen.findByRole('option', { name: 'Metro Manila (NCR)' });
  void user;
  return router;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetDb();
  cartStore.setOwner(null);
});

describe('product page: add to cart', () => {
  it('adds the chosen variant, announces it, and the header badge follows', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    renderAt(productUrl(plenty));
    await screen.findByRole('heading', { name: plenty.product.name });
    expect(screen.getByTestId('cart-count')).toHaveTextContent('0');
    await user.click(screen.getByRole('button', { name: 'Add to cart' }));
    expect(screen.getByTestId('added-status')).toHaveTextContent('Added 1 to your cart.');
    expect(screen.getByTestId('cart-count')).toHaveTextContent('1');
    await user.click(screen.getByRole('button', { name: 'One more' }));
    await user.click(screen.getByRole('button', { name: 'One more' }));
    await user.click(screen.getByRole('button', { name: 'Add to cart' }));
    expect(screen.getByTestId('cart-count')).toHaveTextContent('4');
    expect(storedCart()).toEqual([{ sku: plenty.variant.sku, productId: plenty.product.id, quantity: 4 }]);
  });

  it('signed out: there is no cart link; Add to cart asks to sign in first, and adds the item once the customer has registered', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt(productUrl(plenty));
    await screen.findByRole('heading', { name: plenty.product.name });
    expect(screen.queryByTestId('cart-count')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'One more' }));
    await user.click(screen.getByRole('button', { name: 'Add to cart' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('auth-reason')).toHaveTextContent('Sign in or register to add this to your cart.');
    expect(screen.queryByTestId('added-status')?.textContent ?? '').toBe('');
    await user.click(within(dialog).getByRole('button', { name: 'Register' }));
    await user.type(within(dialog).getByLabelText('Your name'), 'Juana Dela Cruz');
    await user.type(within(dialog).getByLabelText('Email'), 'juana@example.com');
    await user.type(within(dialog).getByLabelText('Password'), 'a long and careful password');
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));
    expect(await screen.findByTestId('cart-count')).toHaveTextContent('2');
    // the cart store and the page state are two updates that may land in two renders: wait for the message
    await vi.waitFor(() => expect(screen.getByTestId('added-status')).toHaveTextContent('Added 2 to your cart.'), { timeout: 8000 });
    expect(storedCart()).toEqual([{ sku: plenty.variant.sku, productId: plenty.product.id, quantity: 2 }]);
  });

  it('limits the quantity to what the server says is in stock', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt(productUrl(low));
    await screen.findByRole('heading', { name: low.product.name });
    const field = screen.getByRole('spinbutton', { name: 'Quantity' });
    await user.clear(field);
    await user.type(field, '50');
    expect(field).toHaveValue(low.variant.stock);
    expect(screen.getByRole('button', { name: 'One more' })).toBeDisabled();
  });

  it('cannot add a sold-out variant', async () => {
    renderAt(productUrl(soldOut));
    await screen.findByRole('heading', { name: soldOut.product.name });
    expect(screen.getByRole('button', { name: 'Add to cart' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Quantity' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Design this' })).toBeDisabled();
  });
});

describe('cart page', () => {
  it('shows server prices, no VAT line (step 9: it is stated at checkout and on the order), and updates when the quantity changes', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    cartStore.add(plenty.variant.sku, plenty.product.id, 2);
    cartStore.setAllSelected(true); // step 10: the total is the ticked lines'
    renderAt('/cart');
    await vi.waitFor(() => expect(screen.getByTestId('line-total')).toHaveTextContent(money(plenty.variant.price * 2)));
    expect(screen.getByTestId('quote-total')).toHaveTextContent(money(priceCart([{ sku: plenty.variant.sku, quantity: 2 }]).total));
    expect(screen.queryByTestId('quote-vat')).toBeNull();
    expect(screen.getByTestId('delivery-fee')).toHaveTextContent('Free delivery');
    await user.click(within(screen.getByTestId('cart-line')).getByRole('button', { name: 'One more' }));
    await vi.waitFor(() => expect(screen.getByTestId('line-total')).toHaveTextContent(money(plenty.variant.price * 3)));
    expect(screen.getByTestId('cart-count')).toHaveTextContent('3');
  });

  it('removes a line, and Undo puts it back', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    cartStore.add(plenty.variant.sku, plenty.product.id, 1);
    renderAt('/cart');
    await screen.findByTestId('line-total');
    await user.click(screen.getByRole('button', { name: /^Remove .* from the cart$/ }));
    expect(screen.getByTestId('cart-empty')).toBeInTheDocument();
    expect((screen.getByTestId('cart-status')).textContent).toMatch(/^Removed /);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByTestId('cart-line')).toBeInTheDocument();
  });

  it('flags an item that is over stock, blocks Checkout, and "Set to N" fixes it', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    cartStore.add(low.variant.sku, low.product.id, low.variant.stock + 2);
    cartStore.setAllSelected(true); // step 10: only a ticked problem line blocks Checkout
    renderAt('/cart');
    const issue = await screen.findByTestId('line-issue');
    expect(issue).toHaveTextContent(`Sorry, only ${low.variant.stock} of ${low.product.name}`);
    expect(screen.getAllByRole('button', { name: 'Checkout' })[0]).toBeDisabled();
    expect((screen.getByTestId('checkout-gate')).textContent).toMatch(/Fix the item marked above/);
    await user.click(within(issue).getByRole('button', { name: `Set to ${low.variant.stock}` }));
    await vi.waitFor(() => expect(screen.queryByTestId('line-issue')).not.toBeInTheDocument());
    await vi.waitFor(() => expect(screen.getAllByRole('button', { name: 'Checkout' })[0]).toBeEnabled());
  });

  it('shows a sold-out item as such and only offers Remove', async () => {
    signIn();
    cartStore.add(soldOut.variant.sku, soldOut.product.id, 1);
    renderAt('/cart');
    const issue = await screen.findByTestId('line-issue');
    expect((issue).textContent).toMatch(/just sold out/);
    expect(within(issue).queryByRole('button', { name: /Set to/ })).not.toBeInTheDocument();
    expect(within(issue).getByRole('button', { name: 'Remove from cart' })).toBeInTheDocument();
  });

  it('keeps the cart across a reload (a new page load reads it back)', async () => {
    signIn();
    cartStore.add(plenty.variant.sku, plenty.product.id, 3);
    cartStore.reload(); // what a page load does
    renderAt('/cart');
    await vi.waitFor(() => expect(screen.getByTestId('line-total')).toHaveTextContent(money(plenty.variant.price * 3)));
  });

  it('is cleared by signing out', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    cartStore.add(plenty.variant.sku, plenty.product.id, 2);
    renderAt('/cart');
    await screen.findByTestId('line-total');
    await user.click(await screen.findByTestId('account-menu-button'));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: /sign in to see your cart/i })).toBeInTheDocument();
    expect(screen.queryByTestId('cart-count')).not.toBeInTheDocument();
    expect(storedCart()).toEqual([]);
    // signing out also asks the server to end the session, and that answer is still on its way: let it land before the next test starts
    // (a request sent while it is in flight can miss the mock server in jsdom); the session is gone from the server when its answer is made
    expect(sessionStorage.getItem(MOCK_SESSION_KEY)).toBeNull();
    await vi.waitFor(() => expect(Object.keys(loadDb().sessions)).toHaveLength(0));
  });

  it('signed out, the cart page asks for sign-in and shows no cart (there is no guest cart)', async () => {
    renderAt('/cart');
    expect(await screen.findByRole('heading', { name: /sign in to see your cart/i })).toBeInTheDocument();
    expect(screen.getByText(/Your cart belongs to your account/)).toBeInTheDocument();
    expect(screen.queryByTestId('cart-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cart-count')).not.toBeInTheDocument();
  });
});

describe('checkout', () => {
  it('needs a signed-in shopper', async () => {
    cartStore.add(plenty.variant.sku, plenty.product.id, 1);
    renderAt('/checkout');
    expect(await screen.findByRole('heading', { name: /sign in to check out/i })).toBeInTheDocument();
  });

  it('sends an empty cart back to the cart', async () => {
    signIn();
    const router = renderAt('/checkout');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/cart'));
  });

  it('offers exactly Cash on delivery and Bank transfer, with no card fields', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    await openCheckout(user, [{ sku: plenty.variant.sku, productId: plenty.product.id, quantity: 1 }]);
    await screen.findByRole('radio', { name: /cash on delivery/i });
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')?.querySelector('.text-lg')?.textContent)).toEqual(['Cash on delivery', 'Bank transfer']);
    expect(document.querySelector('[autocomplete^="cc-"]')).toBeNull();
    expect(screen.queryByText(/card number|credit|debit/i)).toBeNull();
    expect(screen.getByTestId('quote-vat')).toHaveTextContent('12% VAT');
    // the bank note appears only with Bank transfer, and never mentions a deadline
    expect(screen.queryByTestId('bank-note')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /bank transfer/i }));
    const note = screen.getByTestId('bank-note');
    expect((note).textContent).toMatch(/waits for your payment/);
    expect((note).textContent).toMatch(/staff may cancel it if payment is not received/);
    expect((note).textContent).toMatch(/go back into stock/);
    expect(note.textContent).not.toMatch(/deadline|within \d|\d+ (hours?|days?)/i);
  });

  it('checks the form: an error summary that takes focus, field messages, and nothing is ordered', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    await openCheckout(user, [{ sku: plenty.variant.sku, productId: plenty.product.id, quantity: 1 }]);
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    const summary = screen.getByTestId('error-summary');
    expect(summary).toHaveAttribute('role', 'alert');
    expect(summary).toHaveFocus();
    expect(summary).toHaveTextContent('Full name: Enter your full name.');
    expect(summary).toHaveTextContent('Postal code: Enter a 4-digit postal code');
    expect(summary).toHaveTextContent('Payment: Choose how you will pay.');
    const email = screen.getByRole('textbox', { name: /^email/i });
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAccessibleDescription(/Enter an email address/);
    expect(loadDb().orders).toHaveLength(0);
    // a link in the summary moves focus to its field, and typing clears that field's message
    await user.click(within(summary).getByRole('link', { name: /Full name/ }));
    expect(screen.getByRole('textbox', { name: /full name/i })).toHaveFocus();
    await user.type(screen.getByRole('textbox', { name: /full name/i }), 'Ana');
    expect(screen.getByRole('textbox', { name: /full name/i })).not.toHaveAttribute('aria-invalid');
  });

  it('places a Cash on delivery order: confirmation page, cart emptied, order in the list', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    await openCheckout(user, [{ sku: plenty.variant.sku, productId: plenty.product.id, quantity: 2 }]);
    await fillDelivery(user);
    await user.click(screen.getByRole('radio', { name: /cash on delivery/i }));
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    const heading = await screen.findByTestId('order-heading');
    expect(heading).toHaveTextContent('Thank you. Your order is S00001');
    expect(heading).toHaveFocus();
    expect(screen.getByTestId('order-status')).toHaveAttribute('data-state', 'confirmed');
    expect((screen.getByTestId('order-status')).textContent).toMatch(/pay in cash when your order arrives/);
    expect(screen.getByTestId('order-delivery')).toHaveTextContent('Metro Manila (NCR)');
    expect(screen.getByTestId('quote-total')).toHaveTextContent(money(plenty.variant.price * 2));
    expect(screen.queryByText(/reset when this browser tab|demo account|demo only|demo shop|for this demo/i)).not.toBeInTheDocument(); // step 8c: no mock-only wording (the test customer is called Demo)
    expect(screen.getByTestId('cart-count')).toHaveTextContent('0');
    expect(storedCart()).toEqual([]);
    expect(liveProducts().flatMap((p) => p.variants).find((v) => v.sku === plenty.variant.sku)!.stock).toBe(plenty.variant.stock - 2);
    // the orders list under Account
    await user.click(screen.getByRole('link', { name: 'Your orders' }));
    const row = await screen.findByTestId('order-row');
    expect(row).toHaveTextContent('Order S00001');
    expect(row).toHaveTextContent('Confirmed');
    expect(row).toHaveTextContent(money(plenty.variant.price * 2));
  });

  it('places a Bank transfer order: it waits for payment, shows placeholder details, and promises no deadline', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    await openCheckout(user, [{ sku: plenty.variant.sku, productId: plenty.product.id, quantity: 1 }]);
    await fillDelivery(user);
    await user.click(screen.getByRole('radio', { name: /bank transfer/i }));
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByTestId('order-heading');
    const status = screen.getByTestId('order-status');
    expect(status).toHaveAttribute('data-state', 'awaiting_payment');
    expect(screen.getByTestId('wait-note')).toHaveTextContent('the order waits for your payment. If payment is not received, our staff may cancel the order, and the items then go back into stock.');
    const bank = screen.getByTestId('bank-details');
    expect((bank).textContent).toMatch(/placeholders: the shop has no bank account yet\. Do not send money\./);
    expect(bank).toHaveTextContent('S00001');
    expect(document.body.textContent).not.toMatch(/deadline|within \d|\d+ (hours?|days?)|by (mon|tues|wednes|thurs|fri|satur|sun)day/i);
  });

  it('refuses when an item ran out meanwhile: back to the cart, exact sentence, cart kept, nothing ordered', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    await openCheckout(user, [{ sku: low.variant.sku, productId: low.product.id, quantity: low.variant.stock }]);
    await fillDelivery(user);
    await user.click(screen.getByRole('radio', { name: /cash on delivery/i }));
    // somebody else takes the last units after the page priced the cart
    const other = serverPlaceOrder({ lines: [{ sku: low.variant.sku, quantity: low.variant.stock }], delivery: GOOD, paymentMethod: 'cod', quotedTotal: priceCart([{ sku: low.variant.sku, quantity: low.variant.stock }]).total }, null);
    expect(other.status).toBe(201);
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    const refused = await screen.findByTestId('checkout-refused');
    expect((refused).textContent).toMatch(/^Your order was not placed\. Sorry, .* just sold out\. Your cart has been kept\.$/);
    expect(cartStore.get().lines).toEqual([{ sku: low.variant.sku, productId: low.product.id, quantity: low.variant.stock, selected: true }]); // kept with its tick
    expect(loadDb().orders).toHaveLength(1); // only the other buyer's
    expect((await screen.findByTestId('line-issue')).textContent).toMatch(/just sold out/);
  });

  it('refuses with price_changed when the price moved: nothing ordered, new total shown, second press succeeds', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    await openCheckout(user, [{ sku: plenty.variant.sku, productId: plenty.product.id, quantity: 2 }]);
    await fillDelivery(user);
    await user.click(screen.getByRole('radio', { name: /cash on delivery/i }));
    const shown = priceCart([{ sku: plenty.variant.sku, quantity: 2 }]).total;
    expect(screen.getByTestId('quote-total')).toHaveTextContent(money(shown));
    // the price rises after the shopper saw the total
    const db = loadDb();
    db.priceDelta[plenty.variant.sku] = 25;
    saveDb(db);
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    const notice = await screen.findByTestId('price-changed');
    expect(notice).toHaveTextContent('Nothing was ordered.');
    expect(notice).toHaveTextContent(`The new total is ${money(shown + 50)}.`);
    expect(screen.getByTestId('quote-total')).toHaveTextContent(money(shown + 50));
    expect(loadDb().orders).toHaveLength(0);
    expect(cartStore.get().lines).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByTestId('order-heading')).toHaveTextContent('S00001');
    expect(loadDb().orders[0].total).toBe(shown + 50);
    expect(sessionStorage.getItem(DB_KEY)).toContain('S00001');
  });

  it('a double click on Place order makes one order', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    await openCheckout(user, [{ sku: plenty.variant.sku, productId: plenty.product.id, quantity: 1 }]);
    await fillDelivery(user);
    await user.click(screen.getByRole('radio', { name: /cash on delivery/i }));
    const button = screen.getByRole('button', { name: 'Place order' });
    await user.dblClick(button);
    await screen.findByTestId('order-heading');
    expect(loadDb().orders).toHaveLength(1);
  });
});

describe('ticked lines (step 10)', () => {
  const other = all.find((x) => x.variant.stock >= 5 && x.variant.status === 'in_stock' && x.product.id !== plenty.product.id)!;
  const lineOf = (sku: string) => screen.getAllByTestId('cart-line').find((li) => li.dataset.sku === sku)!;
  const tickBox = (sku: string) => within(lineOf(sku)).getByRole('checkbox', { name: /^Select / });
  const selectAll = () => screen.getByRole('checkbox', { name: 'Select all' }) as HTMLInputElement;
  const checkoutButton = () => screen.getAllByRole('button', { name: 'Checkout' })[0]!;
  const lines = () => cartStore.get().lines.map((l) => ({ sku: l.sku, quantity: l.quantity, selected: !!l.selected }));
  const summaryItems = () => within(screen.getByTestId('summary-lines')).getAllByRole('listitem');
  /** the bodies of the quote requests, in order */
  function watchQuotes() {
    const bodies: { lines: { sku: string; quantity: number }[] }[] = [];
    const listener = ({ request }: { request: Request }) => {
      if (new URL(request.url).pathname === '/api/cart/quote') void request.clone().json().then((b: (typeof bodies)[number]) => bodies.push(b));
    };
    server.events.on('request:start', listener);
    return { bodies, stop: () => server.events.removeListener('request:start', listener) };
  }
  /** checkout with `ticked` ticked and `other` in the cart, unticked */
  async function partialCheckout(user: UserEvent, ticked: { sku: string; productId: string; quantity: number }) {
    cartStore.add(other.variant.sku, other.product.id, 1);
    await openCheckout(user, [ticked]);
    cartStore.setSelected(other.variant.sku, false); // openCheckout ticks every line: leave this one out
    await vi.waitFor(() => expect(summaryItems()).toHaveLength(1));
    await fillDelivery(user);
    await user.click(screen.getByRole('radio', { name: /cash on delivery/i }));
  }

  it('Select all goes unticked, mixed, ticked; the count is spoken; only ticked lines are totalled; an unticked problem does not block', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    const quotes = watchQuotes();
    cartStore.add(plenty.variant.sku, plenty.product.id, 1);
    cartStore.add(other.variant.sku, other.product.id, 1);
    cartStore.add(soldOut.variant.sku, soldOut.product.id, 1);
    renderAt('/cart');
    await screen.findByTestId('line-issue');
    expect(selectAll().checked).toBe(false);
    expect(selectAll().indeterminate).toBe(false);
    expect(screen.getByTestId('selection-count')).toHaveTextContent('0 of 3 selected');
    expect(screen.getByTestId('selection-count')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('checkout-gate')).toHaveTextContent('Tick the items you want to order.');
    expect(checkoutButton()).toBeDisabled();
    expect(screen.queryByTestId('quote-total')).toBeNull();
    expect(tickBox(plenty.variant.sku)).toHaveAccessibleName(new RegExp(`^Select ${plenty.product.name} \\(`));

    await user.click(tickBox(plenty.variant.sku));
    expect(screen.getByTestId('selection-count')).toHaveTextContent('1 of 3 selected');
    expect(screen.getByTestId('bar-count')).toHaveTextContent('Total, 1 of 3 selected');
    expect(selectAll().indeterminate).toBe(true);
    expect(selectAll().checked).toBe(false);
    const one = priceCart([{ sku: plenty.variant.sku, quantity: 1 }]).total;
    await vi.waitFor(() => expect(screen.getByTestId('quote-total')).toHaveTextContent(money(one)));
    expect(screen.getByTestId('bar-total')).toHaveTextContent(money(one));
    // the sold-out line is not ticked: it says what is wrong but does not stop the others
    expect(within(lineOf(soldOut.variant.sku)).getByTestId('line-issue')).toHaveTextContent('Not ticked, so it does not stop the others from being ordered.');
    await vi.waitFor(() => expect(checkoutButton()).toBeEnabled());
    // the totals came from a request holding only the ticked line; every line was still priced for its own display
    expect(quotes.bodies.some((b) => b.lines.length === 1 && b.lines[0]!.sku === plenty.variant.sku && b.lines[0]!.quantity === 1)).toBe(true);
    expect(quotes.bodies.some((b) => b.lines.length === 3)).toBe(true);
    quotes.stop();

    await user.click(tickBox(soldOut.variant.sku)); // a ticked problem blocks
    await vi.waitFor(() => expect(screen.getByTestId('checkout-gate').textContent).toMatch(/Fix the item marked above, or untick it/));
    expect(checkoutButton()).toBeDisabled();

    await user.click(selectAll()); // mixed -> all
    expect(lines().every((l) => l.selected)).toBe(true);
    expect(selectAll().checked).toBe(true);
    expect(selectAll().indeterminate).toBe(false);
    expect(screen.getByTestId('selection-count')).toHaveTextContent('3 of 3 selected');
    await user.click(selectAll()); // all -> none
    expect(lines().some((l) => l.selected)).toBe(false);
    expect(screen.getByTestId('selection-count')).toHaveTextContent('0 of 3 selected');
    // quantity and Remove work on an unticked line
    await user.click(within(lineOf(plenty.variant.sku)).getByRole('button', { name: 'One more' }));
    expect(lines().find((l) => l.sku === plenty.variant.sku)!.quantity).toBe(2);
    await user.click(within(lineOf(other.variant.sku)).getByRole('button', { name: /^Remove .* from the cart$/ }));
    expect(lines().map((l) => l.sku)).toEqual([plenty.variant.sku, soldOut.variant.sku]);
    // the header badge still counts every piece in the cart
    expect(screen.getByTestId('cart-count')).toHaveTextContent('3');
  });

  it('a direct visit to checkout with nothing ticked goes back to the cart', async () => {
    signIn();
    cartStore.add(plenty.variant.sku, plenty.product.id, 1);
    const router = renderAt('/checkout');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/cart'));
    expect(lines()).toEqual([{ sku: plenty.variant.sku, quantity: 1, selected: false }]);
  });

  it('checks out only the ticked lines; the others stay in the cart, unticked', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    await partialCheckout(user, { sku: plenty.variant.sku, productId: plenty.product.id, quantity: 2 });
    expect(screen.getByTestId('checkout-partial')).toHaveTextContent('Ordering the item you ticked. The other item stays in your cart.');
    await vi.waitFor(() => expect(screen.getByTestId('quote-total')).toHaveTextContent(money(priceCart([{ sku: plenty.variant.sku, quantity: 2 }]).total)));
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByTestId('order-heading');
    expect(loadDb().orders[0]!.lines.map((l) => [l.sku, l.quantity])).toEqual([[plenty.variant.sku, 2]]);
    expect(lines()).toEqual([{ sku: other.variant.sku, quantity: 1, selected: false }]);
    expect(storedCart()).toEqual([{ sku: other.variant.sku, productId: other.product.id, quantity: 1 }]);
  });

  it('stock_conflict keeps every line and every tick', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    await partialCheckout(user, { sku: low.variant.sku, productId: low.product.id, quantity: low.variant.stock });
    const before = lines();
    expect(before).toEqual([{ sku: other.variant.sku, quantity: 1, selected: false }, { sku: low.variant.sku, quantity: low.variant.stock, selected: true }]);
    serverPlaceOrder({ lines: [{ sku: low.variant.sku, quantity: low.variant.stock }], delivery: GOOD, paymentMethod: 'cod', quotedTotal: priceCart([{ sku: low.variant.sku, quantity: low.variant.stock }]).total }, null);
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByTestId('checkout-refused');
    expect(lines()).toEqual(before);
    expect(loadDb().orders).toHaveLength(1); // only the other buyer's
  });

  it('price_changed keeps every line and tick; the second press orders only the ticked line', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    await partialCheckout(user, { sku: plenty.variant.sku, productId: plenty.product.id, quantity: 2 });
    const shown = priceCart([{ sku: plenty.variant.sku, quantity: 2 }]).total;
    await vi.waitFor(() => expect(screen.getByTestId('quote-total')).toHaveTextContent(money(shown)));
    const before = lines();
    const db = loadDb();
    db.priceDelta[plenty.variant.sku] = 25;
    saveDb(db);
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByTestId('price-changed');
    expect(lines()).toEqual(before);
    expect(loadDb().orders).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByTestId('order-heading');
    expect(loadDb().orders[0]!.total).toBe(shown + 50);
    expect(lines()).toEqual([{ sku: other.variant.sku, quantity: 1, selected: false }]);
  });

  it('a quantity raised in another tab while the order is placed: only what was ordered leaves the cart', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    await partialCheckout(user, { sku: plenty.variant.sku, productId: plenty.product.id, quantity: 2 });
    // the moment the order is sent, another tab raises the ticked line to 5
    const raise = ({ request }: { request: Request }) => {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/orders') return;
      localStorage.setItem(cartKeyFor('1'), JSON.stringify([{ sku: other.variant.sku, productId: other.product.id, quantity: 1 }, { sku: plenty.variant.sku, productId: plenty.product.id, quantity: 5, selected: true }]));
      window.dispatchEvent(new StorageEvent('storage', { key: cartKeyFor('1') }));
    };
    server.events.on('request:start', raise);
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByTestId('order-heading');
    server.events.removeListener('request:start', raise);
    expect(loadDb().orders[0]!.lines.map((l) => [l.sku, l.quantity])).toEqual([[plenty.variant.sku, 2]]);
    expect(lines()).toEqual([{ sku: other.variant.sku, quantity: 1, selected: false }, { sku: plenty.variant.sku, quantity: 3, selected: false }]);
  });

  it('the note after Proceed to checkout shows in the cart until it is dismissed', async () => {
    const user = userEvent.setup({ delay: null });
    signIn();
    cartStore.add(plenty.variant.sku, plenty.product.id, 1);
    cartStore.add(other.variant.sku, other.product.id, 1);
    cartStore.selectOnly(other.variant.sku); // what the Design page's Proceed to checkout does
    renderAt('/cart');
    expect(await screen.findByTestId('just-made-note')).toHaveTextContent('Checking out the design you just made. Your other items are still in your cart.');
    await user.click(screen.getByRole('button', { name: 'Dismiss this note' }));
    expect(screen.queryByTestId('just-made-note')).toBeNull();
    expect(lines().map((l) => l.selected)).toEqual([false, true]); // dismissing changes no tick
  });
});
