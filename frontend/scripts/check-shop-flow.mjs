// FROZEN in step 8 (not run): it drives the MOCK build through the old header (separate Sign in and Register buttons), the guest
// cart and mock-only wording, all of which step 8 removes. Its journeys are covered against the real service by check-shop-real.mjs and
// check-staff-real.mjs. Kept for reference; see frontend/README.md "Frozen checks".
// Step 5a: cart, checkout, orders. Drives the BUILT app in real Edge, with the mock API (VITE_API=mock) answering:
//   npm run build && npx vite preview --port 4173
//   node scripts/check-shop-flow.mjs http://localhost:4173 <outDir> [--odoo http://localhost:4174]
// The optional --odoo base is a second preview of a build made with VITE_API=odoo (see the README); it only proves that the
// mock-only controls are not in the page there.
import path from 'node:path';
import { createReport, launch, seedAccount } from './lib/e2e-common.mjs';

const args = process.argv.slice(2);
const [base, out] = args;
const odooBase = args.includes('--odoo') ? args[args.indexOf('--odoo') + 1] : null;
if (!base || !out) throw new Error('usage: node scripts/check-shop-flow.mjs <baseUrl> <outDir> [--odoo <baseUrl>]');
const rep = createReport(out, 'shop-flow');
const { check, report } = rep;
const browser = await launch();
const shot = (page, name) => page.screenshot({ path: path.join(out, 'shots', name) });

const TEE = { sku: 'SIM-M-TEE-BLK-M', productId: 'm-tee', url: '/products/m-tee?color=black&size=M' };
const DEADLINE = /deadline|within \d|\d+ (hours?|days?)|by (mon|tues|wednes|thurs|fri|satur|sun)day/i;

async function open(o = {}) {
  const { width = 1366, height = 768, touch = false, dpr = 1, signedIn = true, cart = null } = o;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, hasTouch: touch, isMobile: touch });
  if (signedIn) await seedAccount(ctx); // a registered, signed-in customer (mock account 1)
  const tag = `${width}x${height}`;
  const page = await ctx.newPage();
  // Chrome logs every 4xx answer as a console error. Sections 3 and 4 PROVOKE a 409 (stock gone, price changed) on purpose,
  // so exactly that message is expected; anything else still counts.
  const expected = /Failed to load resource: the server responded with a status of 409/;
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !expected.test(m.text()) && report.console.push(`${tag} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => report.console.push(`${tag} pageerror: ${e.message}`));
  await page.goto(base + '/browse', { waitUntil: 'networkidle' });
  if (cart) await setCart(page, cart);
  return { ctx, page };
}
const setCart = (page, lines) => page.evaluate((l) => localStorage.setItem('cc.cart.v1', JSON.stringify(l)), lines);
const go = async (page, url) => { await page.goto(base + url, { waitUntil: 'networkidle' }); await page.waitForTimeout(250); };
const badge = (page) => page.getByTestId('cart-count').textContent();
const mockDb = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('cc.mock.db.v1') || '{"orders":[],"priceDelta":{}}'));
const stockText = async (page) => (await page.getByTestId('variant-stock').textContent()).trim();

async function fillForm(page) {
  await page.getByLabel('Full name').fill('Juana Dela Cruz');
  await page.getByLabel('Email').fill('juana@example.com');
  await page.getByLabel('Mobile number').fill('0917 123 4567');
  await page.getByLabel('House number and street').fill('12 Rizal Street');
  await page.getByLabel('City or municipality').fill('Quezon City');
  await page.getByLabel('Province').selectOption({ label: 'Metro Manila (NCR)' });
  await page.getByLabel('Postal code').fill('1100');
}

/** a real order made through the mock API from the page, so the order pages have something to show */
const seedOrder = (page, method) =>
  page.evaluate(async ({ sku, method }) => {
    const headers = { 'Content-Type': 'application/json', 'X-Mock-Session': sessionStorage.getItem('cc.mock.session') };
    const quote = await (await fetch('/api/cart/quote', { method: 'POST', headers, body: JSON.stringify({ lines: [{ sku, quantity: 1 }] }) })).json();
    const r = await fetch('/api/orders', {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': `seed-${Math.random()}` },
      body: JSON.stringify({ lines: [{ sku, quantity: 1 }], paymentMethod: method, quotedTotal: quote.data.total, delivery: { fullName: 'Juana Dela Cruz', email: 'juana@example.com', phone: '09171234567', street: '12 Rizal Street', city: 'Quezon City', province: 'PH-00', postalCode: '1100', note: '' } }),
    });
    return (await r.json()).data.id;
  }, { sku: TEE.sku, method });

// =================================================================== 1. the whole flow, desktop, from a signed-out visitor
{
  const { ctx, page } = await open({ signedIn: false });
  await go(page, TEE.url);
  const stockBefore = await stockText(page);
  check('product page: stock before any order reads "5 available"', /5 available/.test(stockBefore), stockBefore);
  check('product page: the old "No cart yet" note is gone and Add to cart exists', (await page.getByText('No cart yet').count()) === 0 && (await page.getByRole('button', { name: 'Add to cart' }).isEnabled()));
  check('product page: "Design this" is still there', await page.getByRole('button', { name: 'Design this' }).isEnabled());
  check('header: a Cart link with a count of 0', (await badge(page)) === '0');
  await page.getByRole('button', { name: 'One more' }).click();
  await page.getByRole('button', { name: 'Add to cart' }).click();
  check('add to cart: announced in a status region', /Added 2 to your cart/.test(await page.getByTestId('added-status').textContent()));
  check('add to cart: the header count is 2', (await badge(page)) === '2');
  await shot(page, 'shop-product-1366.png');

  await page.reload({ waitUntil: 'networkidle' });
  check('reload: the cart is still there (count 2, stored in localStorage)', (await badge(page)) === '2' && (await page.evaluate(() => localStorage.getItem('cc.cart.v1'))) === JSON.stringify([{ sku: TEE.sku, productId: TEE.productId, quantity: 2 }]));
  check('the stored cart has no price, name or stock in it', !/price|stock|total|name/i.test(await page.evaluate(() => localStorage.getItem('cc.cart.v1'))));

  await page.getByRole('link', { name: /^Cart/ }).click();
  await page.waitForSelector('[data-testid="line-total"]:not(:empty)');
  await page.waitForFunction(() => document.querySelector('[data-testid="line-total"]')?.textContent.includes('₱'));
  const total = (await page.getByTestId('quote-total').textContent()).trim();
  check('cart: total is the server\'s (2 x 349 = ₱698)', total === '₱698', total);
  check('cart: states 12% VAT included, and the server\'s VAT amount', /include 12% VAT: ₱74\.79 of the total/.test(await page.getByTestId('quote-vat').textContent()), await page.getByTestId('quote-vat').textContent());
  check('cart: delivery says "Free delivery (simulated)"', (await page.getByTestId('delivery-fee').textContent()).trim() === 'Free delivery (simulated)');
  check('cart: signed out, it says checkout needs an account', /needs an account/.test(await page.getByTestId('checkout-gate').textContent()));
  await shot(page, 'shop-cart-1366.png');

  // quantity, remove, undo
  await page.getByTestId('cart-line').getByRole('button', { name: 'One more' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="line-total"]')?.textContent.includes('1,047'));
  check('cart: one more -> line total and header update (₱1,047, count 3)', (await badge(page)) === '3');
  await page.getByRole('button', { name: /^Remove .* from the cart$/ }).click();
  check('cart: removing shows the empty state and an Undo in the status line', (await page.getByTestId('cart-empty').isVisible()) && /Removed/.test(await page.getByTestId('cart-status').textContent()));
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForSelector('[data-testid="cart-line"]');
  check('cart: Undo brings the line back with its quantity', (await badge(page)) === '3');

  // checkout asks for sign-in, then continues
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Checkout' && !b.disabled && b.offsetParent));
  await page.getByRole('button', { name: 'Checkout' }).first().click();
  check('checkout: a signed-out visitor is asked to sign in (the demo dialog)', await page.getByRole('dialog').isVisible());
  // no account yet: register in the dialog (name, email, password), and the shopper carries on to the checkout
  const sign = page.getByRole('dialog');
  await sign.getByRole('button', { name: 'Register' }).click();
  await sign.getByLabel('Your name').fill('Juana Dela Cruz');
  await sign.getByLabel('Email').fill('juana@example.com');
  await sign.getByLabel('Password').fill('a long and careful password');
  await sign.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/checkout');
  await page.getByRole('heading', { name: 'Checkout' }).waitFor();
  await page.getByRole('option', { name: 'Metro Manila (NCR)' }).waitFor({ state: 'attached' });
  check('checkout: after signing in, the shopper lands on the checkout', true);
  check('checkout: a demo note says orders and stock reset when the tab closes', /orders and stock reset when this browser tab is closed/.test(await page.getByTestId('mock-reset-note').textContent()));

  // the form
  await page.getByRole('button', { name: 'Place order' }).click();
  const summary = page.getByTestId('error-summary');
  check('form: an empty submit shows an error summary and focuses it', (await summary.isVisible()) && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'error-summary');
  const sumText = await summary.textContent();
  check('form: the summary lists the fields and the missing payment choice, in words', /Full name: Enter your full name/.test(sumText) && /Mobile number: Enter a Philippine mobile number/.test(sumText) && /Payment: Choose how you will pay/.test(sumText), sumText);
  check('form: invalid fields are marked aria-invalid and described by their message', (await page.getByLabel('Email').getAttribute('aria-invalid')) === 'true' && (await page.getByLabel('Email').getAttribute('aria-describedby')) !== null);
  check('form: nothing was ordered', (await mockDb(page)).orders.length === 0);
  await shot(page, 'shop-checkout-errors-1366.png');
  await fillForm(page);
  const radios = await page.getByRole('radio').evaluateAll((els) => els.map((e) => e.closest('label').textContent.trim().split('\n')[0]));
  check('payment: exactly two choices, Cash on delivery and Bank transfer', radios.length === 2 && /^Cash on delivery/.test(radios[0]) && /^Bank transfer/.test(radios[1]), JSON.stringify(radios));
  check('payment: no card number or card fields anywhere', (await page.locator('input[autocomplete^="cc-"]').count()) === 0);
  check('payment: the province list has Metro Manila (NCR) and 82 more', (await page.getByLabel('Province').locator('option').count()) === 84); // 83 + the "Choose" row
  await page.getByRole('radio', { name: /Bank transfer/ }).check();
  const bankNote = await page.getByTestId('bank-note').textContent();
  check('bank transfer: says the order waits for payment and staff may cancel it, items go back to stock', /waits for your payment/.test(bankNote) && /staff may cancel it if payment is not received/.test(bankNote) && /go back into stock/.test(bankNote), bankNote);
  check('bank transfer: no payment deadline in the text', !DEADLINE.test(bankNote));
  check('checkout: prices are PHP with 12% VAT included, shown', /All prices are in PHP and include 12% VAT/.test(await page.getByTestId('quote-vat').textContent()));
  await shot(page, 'shop-checkout-1366.png');
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByTestId('order-heading').waitFor();

  // the order page
  check('order: the heading names the order S00001 and has focus', /Thank you\. Your order is S00001/.test(await page.getByTestId('order-heading').textContent()) && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'order-heading');
  const wait = await page.getByTestId('wait-note').textContent();
  check('order: bank transfer waits for payment; staff may cancel it; items go back into stock', /waits for your payment\. If payment is not received, our staff may cancel the order, and the items then go back into stock\./.test(wait), wait);
  const bodyText = await page.locator('main').innerText();
  check('order: placeholder bank details are labelled as placeholders', /placeholders for this demo\. Do not send money/.test(bodyText) && /S00001/.test(await page.getByTestId('bank-details').textContent()));
  check('order: NO payment deadline anywhere on the page', !DEADLINE.test(bodyText), (bodyText.match(DEADLINE) || [''])[0]);
  check('order: 3 x ₱349 = ₱1,047, VAT shown', /1,047/.test(await page.getByTestId('quote-total').textContent()) && /12% VAT/.test(await page.getByTestId('quote-vat').textContent()));
  check('order: the delivery address shows Metro Manila (NCR)', /Metro Manila \(NCR\)/.test(await page.getByTestId('order-delivery').textContent()));
  check('order: the header count went back to 0 and the stored cart is empty', (await badge(page)) === '0' && (await page.evaluate(() => localStorage.getItem('cc.cart.v1'))) === '[]');
  check('order: the demo reset note is there', (await page.getByTestId('mock-reset-note').count()) === 1);
  await shot(page, 'shop-order-1366.png');

  // stock follows the order: held by a bank-transfer order, back after staff cancel
  await go(page, TEE.url);
  const stockHeld = await stockText(page);
  check('stock: the product page now shows 2 left (3 are held by the unpaid bank-transfer order)', /2 available|Only 2 left/.test(stockHeld), stockHeld);
  await go(page, '/orders/1');
  check('mock only: the "pretend staff cancelled" control is shown, labelled as demo only', (await page.getByTestId('mock-staff-cancel').count()) === 1 && /Demo only/.test(await page.getByTestId('mock-staff-cancel').textContent()));
  await page.getByRole('button', { name: /pretend staff cancelled/i }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="order-status"]')?.getAttribute('data-state') === 'cancelled');
  check('staff cancel: the order shows Cancelled and says the items went back into stock', /Its items went back into stock/.test(await page.getByTestId('order-status').textContent()));
  await go(page, TEE.url);
  const stockBack = await stockText(page);
  check('staff cancel: the stock is released (5 available again)', /5 available/.test(stockBack), stockBack);

  // orders list under Account
  await go(page, '/account');
  const rows = await page.getByTestId('order-row').allTextContents();
  check('account: the orders list shows S00001 as Cancelled with its total', rows.length === 1 && /S00001/.test(rows[0]) && /Cancelled/.test(rows[0]) && /1,047/.test(rows[0]), JSON.stringify(rows));
  check('account: the demo reset note is shown here too', (await page.getByTestId('mock-reset-note').count()) === 1);

  // sign-out clears the cart
  await go(page, TEE.url);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  check('sign-out: the cart has an item before', (await badge(page)) === '1');
  await page.getByRole('button', { name: 'Sign out' }).click();
  check('sign-out: the cart is cleared (count 0, stored cart empty)', (await badge(page)) === '0' && (await page.evaluate(() => localStorage.getItem('cc.cart.v1'))) === '[]');
  await ctx.close();
}

// =================================================================== 2. Cash on delivery, and the tab-reset behaviour
{
  const { ctx, page } = await open({ cart: [{ sku: TEE.sku, productId: TEE.productId, quantity: 1 }] });
  await go(page, '/checkout');
  await page.getByRole('option', { name: 'Metro Manila (NCR)' }).waitFor({ state: 'attached' });
  await fillForm(page);
  await page.getByRole('radio', { name: /Cash on delivery/ }).check();
  check('cash on delivery: no bank note is shown', (await page.getByTestId('bank-note').count()) === 0);
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByTestId('order-heading').waitFor();
  check('cash on delivery: confirmed, pay in cash on arrival, no bank details', (await page.getByTestId('order-status').getAttribute('data-state')) === 'confirmed' && /pay in cash when your order arrives/.test(await page.getByTestId('order-status').textContent()) && (await page.getByTestId('bank-details').count()) === 0);
  check('cash on delivery: no staff-cancel control for a confirmed order', (await page.getByTestId('mock-staff-cancel').count()) === 0);
  await go(page, TEE.url);
  check('cash on delivery: it holds stock too (4 left of 5)', /4 available|Only 4 left/.test(await stockText(page)), await stockText(page));
  // a new tab = a new session storage = orders and stock start over (the note says so)
  const second = await ctx.newPage();
  await second.goto(base + TEE.url, { waitUntil: 'networkidle' });
  check('a new tab starts with the original stock (5 available) as the note promises', /5 available/.test(await stockText(second)), await stockText(second));
  await second.goto(base + '/account', { waitUntil: 'networkidle' });
  check('a new tab has no orders in the list', (await second.getByTestId('orders-empty').count()) === 1);
  await ctx.close();
}

// =================================================================== 3. stock runs out between cart and order
async function findLowVariant(page) {
  return page.evaluate(async () => {
    const list = (await (await fetch('/api/catalogue/products')).json()).data.products;
    for (const p of list) {
      const detail = (await (await fetch(`/api/catalogue/products/${p.id}`)).json()).data;
      const v = detail.variants.find((x) => x.status === 'low_stock' && x.stock >= 1);
      if (v) return { sku: v.sku, productId: p.id, stock: v.stock };
    }
    return null;
  });
}
{
  const { ctx, page } = await open();
  const low = await findLowVariant(page);
  check('found a low-stock variant to test with', !!low, JSON.stringify(low));
  await setCart(page, [{ sku: low.sku, productId: low.productId, quantity: low.stock }]);
  await go(page, '/checkout');
  await page.getByRole('option', { name: 'Metro Manila (NCR)' }).waitFor({ state: 'attached' });
  await fillForm(page);
  await page.getByRole('radio', { name: /Cash on delivery/ }).check();
  // another buyer takes the last units after this page priced the cart
  await page.evaluate(({ sku, qty }) => {
    const db = JSON.parse(sessionStorage.getItem('cc.mock.db.v1') || '{"nextNumber":1,"orders":[],"idempotency":{},"priceDelta":{}}');
    db.orders.push({ id: '900', reference: 'S00900', state: 'confirmed', lines: [{ sku, quantity: qty }] });
    sessionStorage.setItem('cc.mock.db.v1', JSON.stringify(db));
  }, { sku: low.sku, qty: low.stock });
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByTestId('checkout-refused').waitFor();
  const refused = (await page.getByTestId('checkout-refused').textContent()).trim();
  check('stock gone: back on the cart with "Your order was not placed. Sorry, ... just sold out. Your cart has been kept."', /^Your order was not placed\. Sorry, .* just sold out\. Your cart has been kept\.$/.test(refused), refused);
  check('stock gone: the cart still has the item', (await page.evaluate(() => JSON.parse(localStorage.getItem('cc.cart.v1')).length)) === 1);
  check('stock gone: the line says it is sold out and Checkout is off', (await page.getByTestId('line-issue').isVisible()) && (await page.getByRole('button', { name: 'Checkout' }).first().isDisabled()));
  check('stock gone: no order was created for this shopper', (await mockDb(page)).orders.filter((o) => o.id !== '900').length === 0);
  await ctx.close();
}

// =================================================================== 4. the price changes between quote and order
{
  const { ctx, page } = await open({ cart: [{ sku: TEE.sku, productId: TEE.productId, quantity: 2 }] });
  await go(page, '/checkout');
  await page.getByRole('option', { name: 'Metro Manila (NCR)' }).waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('[data-testid="quote-total"]')?.textContent.includes('698'));
  await fillForm(page);
  await page.getByRole('radio', { name: /Cash on delivery/ }).check();
  await page.evaluate((sku) => {
    const db = JSON.parse(sessionStorage.getItem('cc.mock.db.v1') || '{"nextNumber":1,"orders":[],"idempotency":{},"priceDelta":{}}');
    db.priceDelta[sku] = 25; // the price rises by 25 per piece after the shopper saw the total
    sessionStorage.setItem('cc.mock.db.v1', JSON.stringify(db));
  }, TEE.sku);
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByTestId('price-changed').waitFor();
  const notice = await page.getByTestId('price-changed').textContent();
  check('price changed: 409 shown as "Nothing was ordered" with the new total (₱748)', /Nothing was ordered\./.test(notice) && /The new total is ₱748\./.test(notice), notice);
  check('price changed: the summary now shows the new total', (await page.getByTestId('quote-total').textContent()).trim() === '₱748');
  check('price changed: no order created, the cart is untouched', (await mockDb(page)).orders.length === 0 && (await badge(page)) === '2');
  await shot(page, 'shop-price-changed-1366.png');
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByTestId('order-heading').waitFor();
  check('price changed: pressing Place order again with the new total works', /748/.test(await page.getByTestId('quote-total').textContent()));
  await ctx.close();
}

// =================================================================== 5. sold-out and over-stock in the cart, at 390 px
{
  const { ctx, page } = await open({ width: 390, height: 844, touch: true, dpr: 3 });
  const low = await findLowVariant(page);
  await setCart(page, [{ sku: low.sku, productId: low.productId, quantity: low.stock + 3 }, { sku: TEE.sku, productId: TEE.productId, quantity: 1 }]);
  await go(page, '/cart');
  await page.waitForSelector('[data-testid="line-issue"]');
  const issue = (await page.getByTestId('line-issue').textContent()).trim();
  check('over stock: the line says "Sorry, only N of ... left." with a "Set to N" button', new RegExp(`Sorry, only ${low.stock} of .* left\\.`).test(issue) && (await page.getByRole('button', { name: `Set to ${low.stock}` }).isVisible()), issue);
  check('over stock: Checkout is off and the reason is in words', (await page.getByRole('button', { name: 'Checkout' }).first().isDisabled()) && /Fix the item marked above/.test(await page.getByTestId('checkout-gate').textContent()));
  await page.getByRole('button', { name: `Set to ${low.stock}` }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="line-issue"]'));
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Checkout' && !b.disabled && b.offsetParent));
  check('over stock: "Set to N" fixes it and Checkout is on again', true);
  await ctx.close();
}

// =================================================================== 6. layout, tap targets and no sideways scroll
const VIEWS = [
  { w: 320, h: 640, touch: true, dpr: 2 },
  { w: 390, h: 844, touch: true, dpr: 3 },
  { w: 768, h: 1024, touch: false, dpr: 1 },
  { w: 1024, h: 768, touch: false, dpr: 1 },
  { w: 1366, h: 768, touch: false, dpr: 1 },
];
report.data.layout = {};
for (const v of VIEWS) {
  const L = `${v.w}px:`;
  const { ctx, page } = await open({ width: v.w, height: v.h, touch: v.touch, dpr: v.dpr });
  const orderId = await seedOrder(page, 'bank_transfer');
  const lines = [{ sku: TEE.sku, productId: TEE.productId, quantity: 2 }];
  const widths = {};
  const flat = async (name, url, prep) => {
    await go(page, url);
    if (prep) await prep();
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    widths[name] = m.sw;
    check(`${L} ${name}: no horizontal scroll`, m.sw <= m.iw, `${m.sw} > ${m.iw}`);
    if ([390, 768, 1366].includes(v.w)) await shot(page, `shop-${name}-${v.w}.png`);
  };
  await flat('product', TEE.url);
  if (v.w === 390 || v.w === 320) {
    const t = await page.evaluate(() => {
      const size = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; };
      return { add: size([...document.querySelectorAll('button')].find((b) => b.textContent === 'Add to cart')), less: size(document.querySelector('button[aria-label="One less"]')), more: size(document.querySelector('button[aria-label="One more"]')), qty: size(document.querySelector('input[type=number]')) };
    });
    check(`${L} product: Add to cart and the quantity buttons are at least 44 px`, t.add[1] >= 44 && t.less[0] >= 44 && t.less[1] >= 44 && t.more[0] >= 44 && t.more[1] >= 44 && t.qty[1] >= 44, JSON.stringify(t));
  }
  await setCart(page, lines);
  await flat('cart', '/cart', async () => { await page.waitForFunction(() => document.querySelector('[data-testid="line-total"]')?.textContent.includes('₱')); });
  if (v.w <= 390) {
    // the fixed total bar at the bottom must not cover the last thing on the page
    const cover = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const bar = [...document.querySelectorAll('div.fixed')].find((d) => d.textContent.includes('Total'));
      const aside = document.querySelector('aside');
      return { barTop: bar.getBoundingClientRect().top, asideBottom: aside.getBoundingClientRect().bottom, barH: bar.getBoundingClientRect().height, visibleButtons: [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Checkout' && b.offsetParent).length };
    });
    check(`${L} cart: the bottom total bar does not cover the summary, and exactly one Checkout button shows`, cover.asideBottom <= cover.barTop + 1 && cover.visibleButtons === 1, JSON.stringify(cover));
    const checkoutBtn = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Checkout' && x.offsetParent).getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; });
    check(`${L} cart: the Checkout button is at least 44 px high`, checkoutBtn[1] >= 44, JSON.stringify(checkoutBtn));
  }
  await flat('checkout', '/checkout', async () => {
    await page.getByRole('option', { name: 'Metro Manila (NCR)' }).waitFor({ state: 'attached' });
    await page.getByRole('button', { name: 'Place order' }).click(); // with the error summary showing: the widest state
    await page.getByTestId('error-summary').waitFor();
    if (v.w <= 390) {
      const sizes = await page.evaluate(() => [...document.querySelectorAll('input:not([type=radio]), select, textarea, button[type=submit]')].map((e) => ({ id: e.id || e.type, h: Math.round(e.getBoundingClientRect().height), fs: parseFloat(getComputedStyle(e).fontSize) })));
      const small = sizes.filter((s) => s.h < 44 || (s.id.startsWith('field-') && s.fs < 16));
      check(`${L} checkout: every field and the submit button is at least 44 px high, fields use 16 px text (no zoom on focus)`, small.length === 0, JSON.stringify(small));
    }
  });
  await flat('order', `/orders/${orderId}`);
  await flat('account', '/account');
  report.data.layout[`${v.w}px scrollWidth`] = JSON.stringify(widths);
  if (v.w === 390 || v.w === 320) {
    await go(page, '/browse');
    const h = await page.evaluate(() => { const hd = document.querySelector('header'); return { sw: hd.scrollWidth, cw: hd.clientWidth, cart: Math.round(document.querySelector('[data-testid="cart-count"]').getBoundingClientRect().right) <= innerWidth }; });
    check(`${L} header: the Cart link fits (no overflow)`, h.sw <= h.cw && h.cart, JSON.stringify(h));
    await shot(page, `shop-header-${v.w}.png`);
  }
  await ctx.close();
}

// =================================================================== 7. a build for VITE_API=odoo
if (odooBase) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  await page.route('**/api/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found', message: 'No API in this check' } }) }));
  await page.goto(odooBase + '/orders/1', { waitUntil: 'networkidle' });
  const html = await page.locator('body').innerText();
  check('odoo build: an order page asks for sign-in (no demo session exists there) and shows no mock control', /Sign in to see your order/.test(html) && !/pretend staff|Demo only: orders and stock reset/.test(html), html.slice(0, 200));
  await page.goto(odooBase + '/cart', { waitUntil: 'networkidle' });
  check('odoo build: the cart page works and shows no demo reset note', (await page.getByTestId('cart-empty').count()) === 1 && (await page.getByTestId('mock-reset-note').count()) === 0);
  check('odoo build: no service worker is registered (the mock is not running)', (await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)) === 0);
  await ctx.close();
} else {
  report.data.odoo = 'skipped (no --odoo base given)';
}

await browser.close();
rep.finish();
