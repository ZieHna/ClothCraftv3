// Step 6c-verify: the shop against the REAL API service and Odoo, in real Edge, through the Vite proxy.
// It REGISTERS REAL CUSTOMERS (through the real form) and PLACES REAL ORDERS in whatever database the API serves, so point it at a THROWAWAY COPY only (never clothcraft_sim,
// clothcraft_dev or the live clothcraft). Setup, from the repo root:
//   1. copy clothcraft_dev into clothcraft_e2e (pg_dump / pg_restore), start a second Odoo (-d clothcraft_e2e --db-filter) and a second
//      API (ODOO_DB=clothcraft_e2e, TRUSTED_PROXIES=* so each browser context can present its own client address,
//      ALLOWED_ORIGINS=http://localhost:4175, published on 127.0.0.1:8001) as separate containers;
//   2. VITE_API=odoo npx vite build --outDir <dir>, then
//      VITE_API=odoo VITE_PROXY_TARGET=http://127.0.0.1:8001 npx vite preview --outDir <dir> --port 4175
//   3. node scripts/check-shop-real.mjs http://localhost:4175 <outDir> --db-container <db container> --db clothcraft_e2e
// The script reads and (for the price-change case only) changes the throwaway database with psql inside the db container.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createReport, launch, savedCart, seedCart } from './lib/e2e-common.mjs';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const [base, out] = args;
const dbContainer = flag('--db-container');
const db = flag('--db');
if (!base || !out || !dbContainer || !db) throw new Error('usage: node scripts/check-shop-real.mjs <baseUrl> <outDir> --db-container <name> --db <throwaway database>');
if (!/^clothcraft_(e2e|ctest|throwaway)/.test(db)) throw new Error(`refusing to run against "${db}": only a throwaway copy (clothcraft_e2e...) may be used`);

const rep = createReport(out, 'shop-real');
const { check, report } = rep;
const browser = await launch();
const shot = (page, name) => page.screenshot({ path: path.join(out, 'shots', name) });
const PASSWORD = 'a long and careful e2e password';
const ipOf = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const sql = (q) => execFileSync('docker', ['exec', dbContainer, 'sh', '-c', `psql -U "$POSTGRES_USER" -d ${db} -At -c "${q}"`], { encoding: 'utf8' }).trim();
const apiOrders = () => Number(sql("select count(*) from sale_order where client_order_ref like 'api:%'"));
const allOrders = () => Number(sql('select count(*) from sale_order'));
const fmt = (n) => '₱' + n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

// Chrome logs every 4xx answer as a console error. The cases below PROVOKE a 409 on purpose, so that one message is expected.
const expected409 = /Failed to load resource: the server responded with a status of 409/;
/**
 * A fresh browser context. Unless `anonymous`, a NEW customer registers through the real form and is signed in, so every case runs as
 * a real account with its own session cookie. Each context presents its own client address (X-Forwarded-For; the API is started
 * trusting it), so the registration limit per address does not stop a run of many contexts. `tolerate` is an extra console message
 * that a case provokes on purpose.
 */
async function open(label, cart = null, { anonymous = false, tolerate = null, name = 'Juana Dela Cruz' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': ipOf() } });
  const page = await ctx.newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !expected409.test(m.text()) && !(tolerate && tolerate.test(m.text())) && report.console.push(`${label} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => report.console.push(`${label} pageerror: ${e.message}`));
  await page.goto(base + '/category', { waitUntil: 'networkidle' });
  const email = `e2e-${randomUUID().slice(0, 12)}@example.test`;
  if (!anonymous) {
    // step 8a: one account menu in the header (Sign in, Register) instead of two buttons
    await page.getByTestId('account-menu-button').click();
    await page.getByRole('menuitem', { name: 'Register' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Your name').fill(name);
    await dialog.getByLabel('Email').fill(email);
    await dialog.getByLabel('Password').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Create account' }).click();
    await page.getByTestId('signed-in-name').waitFor({ state: 'attached' });
  }
  if (cart) await setCart(page, cart);
  return { ctx, page, email, password: PASSWORD, name };
}
/** step 8a: a cart is a signed-in customer's own (there is no guest cart). Step 12: it is kept on the account, so it is seeded through
 *  PUT /api/cart. Step 10: a seeded line is stored ticked (ready to check out) unless it says selected: false, which stores it unticked */
const setCart = (page, lines) => seedCart(page, lines);
/** step 12: the page's copy, once it is saved and the account's cart agrees with it */
const storedCart = (page) => savedCart(page);
const go = async (page, url) => { await page.goto(base + url, { waitUntil: 'networkidle' }); await page.waitForTimeout(250); };
const badge = (page) => page.getByTestId('cart-count').textContent();
const stockText = async (page) => (await page.getByTestId('variant-stock').textContent()).trim();
const apiGet = (page, p) => page.evaluate(async (u) => (await fetch(u)).json(), p);

async function fillForm(page) {
  await page.getByRole('option', { name: 'Metro Manila (NCR)' }).waitFor({ state: 'attached' });
  await page.getByLabel('Full name').fill('Juana Dela Cruz');
  await page.getByLabel('Email').fill('juana@example.com');
  await page.getByLabel('Mobile number').fill('0917 123 4567');
  await page.getByLabel('House number and street').fill('12 Rizal Street');
  await page.getByLabel('City or municipality').fill('Quezon City');
  await page.getByLabel('Province').selectOption({ label: 'Metro Manila (NCR)' });
  await page.getByLabel('Postal code').fill('1100');
}
const waitQuote = (page) => page.waitForFunction(() => /₱/.test(document.querySelector('[data-testid="quote-total"]')?.textContent ?? ''));

// ---- pick variants to use, from the API, so nothing is hard-coded: each case gets one of its own
const probe = await open('probe', null, { anonymous: true });
const catalogue = (await apiGet(probe.page, '/api/catalogue/products')).data.products;
const variants = [];
for (const p of catalogue) {
  const detail = (await apiGet(probe.page, `/api/catalogue/products/${p.id}`)).data;
  for (const v of detail.variants) variants.push({ ...v, productId: p.id, name: p.name });
}
await probe.ctx.close();
const plenty = variants.filter((v) => v.stock >= 5 && v.stock <= 40);
const few = variants.filter((v) => v.stock >= 2 && v.stock <= 3);
check('the throwaway database has variants to test with', plenty.length >= 6 && few.length >= 1, `${plenty.length} plenty, ${few.length} few`);
const [cod, bank, over, price, dbl, other] = plenty;
const low = few[0];
const urlOf = (v) => `/products/${v.productId}?color=${v.color}&size=${v.size}`;
const ordersBefore = apiOrders();
report.data.ordersBefore = { all: allOrders(), api: ordersBefore };
check('the throwaway database starts with 0 API orders', ordersBefore === 0, String(ordersBefore));

async function section(name, fn) {
  const label = name.split(':')[0];
  try { await fn(label); } catch (error) { check(`${name}: ran to the end`, false, error.message.split('\n')[0]); }
}

// =================================================================== 1. cash on delivery, the whole way
let codOrder = null;
await section('cod: product page to order page', async (label) => {
  const { ctx, page } = await open(label);
  await go(page, urlOf(cod));
  const expectText = cod.status === 'low_stock' ? `Only ${cod.stock} left` : `${cod.stock} available`;
  check('cod: the product page shows the stock Odoo has', (await stockText(page)).includes(expectText), `${await stockText(page)} vs ${expectText}`);
  check('cod: no demo or mock wording on the page (odoo mode)', (await page.getByTestId('mock-reset-note').count()) === 0 && !/Demo only|pretend staff/.test(await page.locator('body').innerText()));
  await page.getByRole('button', { name: 'One more' }).click();
  await page.getByRole('button', { name: 'Add to cart' }).click();
  check('cod: add to cart (2) updates the header', (await badge(page)) === '2');
  await page.reload({ waitUntil: 'networkidle' });
  check('cod: the cart survives a reload', (await badge(page)) === '2');
  await page.getByRole('link', { name: /^Cart/ }).click();
  await page.waitForFunction(() => /₱/.test(document.querySelector('[data-testid="line-total"]')?.textContent ?? ''));
  await page.getByRole('checkbox', { name: /^Select / }).first().check(); // step 10: a line added from the product page starts unticked
  await waitQuote(page);
  const quote = (await page.evaluate(async (l) => (await (await fetch('/api/cart/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: l }) })).json()).data, [{ sku: cod.sku, quantity: 2 }]));
  check('cart: the total shown is the one Odoo quotes', (await page.getByTestId('quote-total').textContent()).trim() === fmt(quote.total), `${await page.getByTestId('quote-total').textContent()} vs ${fmt(quote.total)}`);
  const cartVatLines = await page.getByTestId('quote-vat').count(); // step 9: the cart shows no VAT line; checkout and the order do
  check('cart: delivery says free (DELIVERY_LABEL, default "Free delivery")', (await page.getByTestId('delivery-fee').textContent()).trim() === 'Free delivery');
  await shot(page, 'real-cart.png');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Checkout' && !b.disabled && b.offsetParent));
  await page.getByRole('button', { name: 'Checkout' }).first().click();
  await page.waitForURL('**/checkout');
  await page.getByRole('heading', { name: 'Checkout' }).waitFor();
  await waitQuote(page);
  check('checkout: no "orders reset when this tab closes" note (that is the mock)', (await page.getByTestId('mock-reset-note').count()) === 0);
  check('checkout: the VAT shown is Odoo\'s, rounded once (and the cart showed none)', cartVatLines === 0 && (await page.getByTestId('quote-vat').textContent()).includes(fmt(quote.vatAmount).slice(1)), `cart VAT lines ${cartVatLines}; ${await page.getByTestId('quote-vat').textContent()} vs ${quote.vatAmount}`);
  await fillForm(page);
  await page.getByRole('radio', { name: /Cash on delivery/ }).check();
  check('checkout: cash on delivery shows no bank note', (await page.getByTestId('bank-note').count()) === 0);
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByTestId('order-heading').waitFor();
  const heading = (await page.getByTestId('order-heading').textContent()).trim();
  check('order: the heading carries Odoo\'s order number', /Your order is S\d{5,}/.test(heading), heading);
  const id = page.url().split('/orders/')[1].split(/[?#]/)[0];
  const ref = /S\d{5,}/.exec(heading)?.[0];
  codOrder = { id, ref };
  const status = page.getByTestId('order-status');
  check('order: confirmed, pay in cash on arrival, no bank details', (await status.getAttribute('data-state')) === 'confirmed' && /pay in cash when your order arrives/.test(await status.textContent()) && (await page.getByTestId('bank-details').count()) === 0);
  check('order: the delivery details are the ones typed', /Juana Dela Cruz/.test(await page.getByTestId('order-delivery').textContent()) && /Metro Manila/.test(await page.getByTestId('order-delivery').textContent()));
  check('order: the line and the total are Odoo\'s', (await page.getByTestId('order-lines').textContent()).includes(cod.name) && (await page.locator('body').innerText()).includes(fmt(quote.total)));
  check('order: no staff-cancel control (the mock\'s)', (await page.getByTestId('mock-staff-cancel').count()) === 0);
  check('order: the cart was emptied', (await badge(page)) === '0');
  await shot(page, 'real-order-cod.png');
  const row = sql(`select so.state, pt.state, pp.name->>'en_US' from sale_order so join sale_order_transaction_rel r on r.sale_order_id=so.id join payment_transaction pt on pt.id=r.transaction_id join payment_provider pp on pp.id=pt.provider_id where so.name='${ref}'`);
  check('odoo: the order is confirmed (sale) with one pending Cash on Delivery transaction', row === 'sale|pending|Cash on Delivery', row);
  const picking = sql(`select count(*) from stock_picking sp join sale_order so on so.id=sp.sale_id where so.name='${ref}' and sp.state not in ('cancel','done')`);
  check('odoo: its stock is reserved in a delivery picking', picking === '1', picking);
  await go(page, urlOf(cod));
  const left = cod.stock - 2;
  check('product page: the stock dropped by the 2 ordered', (await stockText(page)).includes(String(left)), `${await stockText(page)} (expected ${left})`);
  await page.reload({ waitUntil: 'networkidle' });
  await go(page, `/orders/${id}`);
  check('reload: the order page still shows the order', (await page.getByTestId('order-heading').textContent()).includes(ref));
  await page.reload({ waitUntil: 'networkidle' });
  check('reload again: still there (it is read from Odoo, not kept in the browser)', (await page.getByTestId('order-heading').textContent()).includes(ref));
  await go(page, '/account');
  await page.getByTestId('orders-list').waitFor();
  check('account: the orders list has the order, linking to it', (await page.getByTestId('order-row').filter({ hasText: ref }).count()) === 1);
  await page.getByTestId('order-row').filter({ hasText: ref }).getByRole('link').click();
  await page.getByTestId('order-heading').waitFor();
  check('account: the link opens that order', page.url().endsWith(`/orders/${id}`));
  await ctx.close();
});

// =================================================================== 2. bank transfer
await section('bank: bank transfer waits for payment', async (label) => {
  const { ctx, page } = await open(label, [{ sku: bank.sku, productId: bank.productId, quantity: 1 }]);
  await go(page, '/checkout');
  await waitQuote(page);
  await fillForm(page);
  await page.getByRole('radio', { name: /Bank transfer/ }).check();
  const note = await page.getByTestId('bank-note').textContent();
  check('bank: the checkout says it waits for payment and staff may cancel it, items go back to stock', /waits for your payment/.test(note) && /staff may cancel it if payment is not received/.test(note) && /go back/.test(note), note);
  check('bank: no payment deadline in the text', !/deadline|within \d|\d+ (hours?|days?)/i.test(note));
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByTestId('order-heading').waitFor();
  const heading = (await page.getByTestId('order-heading').textContent()).trim();
  const ref = /S\d{5,}/.exec(heading)?.[0];
  const wait = await page.getByTestId('wait-note').textContent();
  check('bank order: awaiting payment', (await page.getByTestId('order-status').getAttribute('data-state')) === 'awaiting_payment');
  check('bank order: waits for payment; staff may cancel; items go back into stock', /waits for your payment\. If payment is not received, our staff may cancel the order, and the items then go back into stock\./.test(wait), wait);
  const details = await page.getByTestId('bank-details').textContent();
  check('bank order: the payment reference is the order number, and the details are labelled placeholders', details.includes(ref) && /placeholders[^.]*\. Do not send money/.test(await page.locator('body').innerText()) && !/demo/i.test(await page.locator('body').innerText()), details);
  check('bank order: no staff-cancel control in the page', (await page.getByTestId('mock-staff-cancel').count()) === 0);
  await shot(page, 'real-order-bank.png');
  const row = sql(`select so.state, pt.state, pp.name->>'en_US' from sale_order so join sale_order_transaction_rel r on r.sale_order_id=so.id join payment_transaction pt on pt.id=r.transaction_id join payment_provider pp on pp.id=pt.provider_id where so.name='${ref}'`);
  check('odoo: confirmed (sale) with one pending Wire Transfer transaction', row === 'sale|pending|Wire Transfer', row);
  await go(page, urlOf(bank));
  check('product page: the unit is held (stock dropped by 1)', (await stockText(page)).includes(String(bank.stock - 1)), `${await stockText(page)} (expected ${bank.stock - 1})`);
  await ctx.close();
});

// =================================================================== 3. not enough stock
await section('stock: more than is available', async (label) => {
  // 3a. the cart already asks for more than there is: the cart says so and checkout is off
  const a = await open(label, [{ sku: over.sku, productId: over.productId, quantity: over.stock + 1 }]);
  await go(a.page, '/cart');
  await a.page.getByTestId('line-issue').waitFor();
  const issue = await a.page.getByTestId('line-issue').textContent();
  check('over stock (cart): the line says "Sorry, only N of ... left." with a Set to N button', new RegExp(`Sorry, only ${over.stock} of .* left\\.`).test(issue) && (await a.page.getByRole('button', { name: `Set to ${over.stock}` }).isVisible()), issue);
  check('over stock (cart): Checkout is off', await a.page.getByRole('button', { name: 'Checkout' }).first().isDisabled());
  // 3b. the API itself answers 409 for it, with the guard's sentence, and creates nothing
  const before = apiOrders();
  const r = await a.page.evaluate(async ({ sku, qty }) => {
    const res = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `over-${Math.random()}` },
      body: JSON.stringify({ lines: [{ sku, quantity: qty }], paymentMethod: 'cod', quotedTotal: 1, delivery: { fullName: 'Juana Dela Cruz', email: 'juana@example.com', phone: '09171234567', street: '12 Rizal Street', city: 'Quezon City', province: 'PH-00', postalCode: '1100', note: '' } }) });
    return { status: res.status, body: await res.json() };
  }, { sku: over.sku, qty: over.stock + 1 });
  check('over stock (API): 409 stock_conflict with "Sorry, only N of ... left." and the cart kept', r.status === 409 && r.body.error.code === 'stock_conflict' && new RegExp(`^Sorry, only ${over.stock} of .* left\\. Your cart has been kept\\.$`).test(r.body.error.message), JSON.stringify(r.body).slice(0, 300));
  check('over stock (API): no order was created', apiOrders() === before);
  await a.ctx.close();

  // 3c. the stock runs out between the cart and the submit: another buyer takes it
  const { ctx, page } = await open(label, [{ sku: low.sku, productId: low.productId, quantity: low.stock }]);
  await go(page, '/checkout');
  await waitQuote(page);
  await fillForm(page);
  await page.getByRole('radio', { name: /Cash on delivery/ }).check();
  // step 12: the other buyer is another account (an order takes its lines off its OWN saved cart, so it cannot be this shopper's session)
  const other = await open(`${label}-other`, null, { name: 'Another Buyer' });
  const taken = await other.page.evaluate(async ({ sku, qty, total }) => {
    const res = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `other-${Math.random()}` },
      body: JSON.stringify({ lines: [{ sku, quantity: qty }], paymentMethod: 'cod', quotedTotal: total, delivery: { fullName: 'Another Buyer', email: 'other@example.com', phone: '09171234567', street: '99 Other Street', city: 'Pasig', province: 'PH-00', postalCode: '1600', note: '' } }) });
    return res.status;
  }, { sku: low.sku, qty: low.stock, total: low.price * low.stock });
  check('stock gone: another buyer\'s order for the same units succeeded first', taken === 201, String(taken));
  const mid = apiOrders();
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByTestId('checkout-refused').waitFor();
  const refused = (await page.getByTestId('checkout-refused').textContent()).trim();
  check('stock gone: back on the cart with "Your order was not placed. Sorry, ... just sold out. Your cart has been kept."', /^Your order was not placed\. Sorry, .* just sold out\. Your cart has been kept\.$/.test(refused), refused);
  check('stock gone: the cart still has the item', (await storedCart(page)).length === 1);
  await page.getByTestId('line-issue').waitFor();
  check('stock gone: the line says it is sold out and Checkout is off', (await page.getByTestId('line-issue').isVisible()) && (await page.getByRole('button', { name: 'Checkout' }).first().isDisabled()));
  check('stock gone: no order was created for this shopper', apiOrders() === mid);
  await shot(page, 'real-stock-gone.png');
  await other.ctx.close();
  await ctx.close();
});

// =================================================================== 4. the price changes between add and submit
await section('price: the price changes before submit', async (label) => {
  const { ctx, page } = await open(label);
  await go(page, urlOf(price));
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await go(page, '/cart'); // step 10: a line added from the product page starts unticked; tick it in the cart
  await page.getByRole('checkbox', { name: /^Select / }).first().check();
  await go(page, '/checkout');
  await waitQuote(page);
  const was = price.price;
  check('price: the checkout total is the price Odoo had', (await page.getByTestId('quote-total').textContent()).trim() === fmt(was), `${await page.getByTestId('quote-total').textContent()} vs ${fmt(was)}`);
  await fillForm(page);
  await page.getByRole('radio', { name: /Cash on delivery/ }).check();
  sql(`update product_template set list_price = list_price + 25 where id = (select product_tmpl_id from product_product where default_code='${price.sku}')`);
  const before = apiOrders();
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByTestId('price-changed').waitFor();
  const notice = await page.getByTestId('price-changed').textContent();
  check('price: 409 shown as "Nothing was ordered" with the new total', /Nothing was ordered\./.test(notice) && notice.includes(`The new total is ${fmt(was + 25)}.`), notice);
  check('price: the summary now shows the new total', (await page.getByTestId('quote-total').textContent()).trim() === fmt(was + 25));
  check('price: no order was created and the cart is untouched', apiOrders() === before && (await badge(page)) === '1');
  await shot(page, 'real-price-changed.png');
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByTestId('order-heading').waitFor();
  const paid = sql(`select so.amount_total from sale_order so where so.name='${/S\d{5,}/.exec(await page.getByTestId('order-heading').textContent())[0]}'`);
  check('price: pressing Place order again with the new total creates the order at the new price', Number(paid) === was + 25, paid);
  await ctx.close();
});

// =================================================================== 5. a double click
await section('double: double-clicking Place order', async (label) => {
  const { ctx, page } = await open(label, [{ sku: dbl.sku, productId: dbl.productId, quantity: 1 }]);
  await go(page, '/checkout');
  await waitQuote(page);
  await fillForm(page);
  await page.getByRole('radio', { name: /Cash on delivery/ }).check();
  const before = apiOrders();
  await page.getByRole('button', { name: 'Place order' }).dblclick();
  await page.getByTestId('order-heading').waitFor();
  await page.waitForTimeout(1500);
  check('double click: exactly one order was created', apiOrders() === before + 1, `${apiOrders() - before} new`);
  const units = sql(`select coalesce(sum(sol.product_uom_qty),0) from sale_order_line sol join product_product pp on pp.id=sol.product_id join sale_order so on so.id=sol.order_id where pp.default_code='${dbl.sku}' and so.client_order_ref like 'api:%'`);
  check('double click: one unit reserved, not two', Number(units) === 1, units);
  await ctx.close();
});

// =================================================================== 6. the list shows every order, from Odoo
await section('list: the orders list', async (label) => {
  const { ctx, page, email } = await open(label);
  // two orders of this customer, placed through the API from the page (the cookie is the session)
  const sent = await page.evaluate(async ({ skus, delivery }) => {
    const out = [];
    for (const sku of skus) {
      // the price is asked for now: an earlier case in this run raised the price of a whole product
      const quote = await (await fetch('/api/cart/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: [{ sku, quantity: 1 }] }) })).json();
      const r = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `list-${Math.random()}` }, body: JSON.stringify({ lines: [{ sku, quantity: 1 }], paymentMethod: 'cod', quotedTotal: quote.data.total, delivery }) });
      out.push(r.status);
    }
    return out;
  }, { skus: [cod.sku, bank.sku], delivery: { fullName: 'Juana Dela Cruz', email: 'juana@example.com', phone: '09171234567', street: '12 Rizal Street', city: 'Quezon City', province: 'PH-00', postalCode: '1100', note: '' } });
  check('list: this customer placed two orders', sent.join() === '201,201', sent.join());
  await go(page, '/account');
  await page.getByTestId('orders-list').waitFor();
  const rows = await page.getByTestId('order-row').count();
  const inOdoo = Number(sql(`select count(*) from sale_order so join res_users u on u.partner_id = so.partner_id where u.login='${email}'`));
  check('account: the list has one row per order of THIS customer in Odoo (two), and none of anyone else\'s', rows === 2 && inOdoo === 2, `${rows} rows, ${inOdoo} in Odoo`);
  await shot(page, 'real-account.png');
  await page.reload({ waitUntil: 'networkidle' });
  check('account: after a reload the list is the same', (await page.getByTestId('order-row').count()) === rows);
  await ctx.close();
});

// =================================================================== 7. real accounts: two customers, sign out, sign in, the cookie
await section('accounts: two customers', async (label) => {
  const tolerate = /Failed to load resource: the server responded with a status of (401|404|422|429)/;
  const alice = await open('alice', [{ sku: cod.sku, productId: cod.productId, quantity: 1 }], { tolerate, name: 'Alice Account' });
  const bob = await open('bob', null, { tolerate, name: 'Bob Account' });
  const cookies = await alice.ctx.cookies();
  const session = cookies.find((c) => c.name === 'cc_session');
  check('cookie: the session cookie is set, httpOnly, SameSite Lax, on the shop\'s own origin', !!session && session.httpOnly === true && session.sameSite === 'Lax' && session.path === '/', JSON.stringify(session && { ...session, value: '<hidden>' }));
  check('cookie: the page cannot read it (document.cookie has no session)', !(await alice.page.evaluate(() => document.cookie)).includes('cc_session'));
  check('cookie: nothing about the session is kept in web storage', (await alice.page.evaluate(() => JSON.stringify([...Object.entries(localStorage), ...Object.entries(sessionStorage)]))).toLowerCase().includes('cc_session') === false);

  // alice places an order through the real checkout
  await go(alice.page, '/checkout');
  await waitQuote(alice.page);
  await fillForm(alice.page);
  await alice.page.getByRole('radio', { name: /Cash on delivery/ }).check();
  await alice.page.getByRole('button', { name: 'Place order' }).click();
  await alice.page.getByTestId('order-heading').waitFor();
  const aliceUrl = alice.page.url();
  const aliceId = aliceUrl.split('/orders/')[1].split(/[?#]/)[0];
  const aliceRef = /S\d{5,}/.exec(await alice.page.getByTestId('order-heading').textContent())[0];
  const owner = sql(`select u.login from sale_order so join res_users u on u.partner_id = so.partner_id where so.name='${aliceRef}'`);
  check('alice: the order belongs to alice\'s own account in Odoo, not to a shared customer', owner === alice.email, owner);

  // bob sees none of it
  await go(bob.page, '/account');
  await bob.page.getByTestId('orders-empty').waitFor();
  check('bob: his account page shows no orders, not alice\'s', (await bob.page.getByTestId('order-row').count()) === 0 && (await bob.page.getByTestId('orders-empty').count()) === 1);
  check('bob: the page says who is signed in (his name and email)', /Signed in as Bob Account/.test(await bob.page.getByTestId('account-signed-in').textContent()) && (await bob.page.getByTestId('account-signed-in').textContent()).includes(bob.email));
  const direct = await bob.page.evaluate(async (id) => { const r = await fetch('/api/orders/' + id); return { status: r.status, body: await r.json() }; }, aliceId);
  check('bob: asking for alice\'s order by its number is 404 "not found"', direct.status === 404 && direct.body.error.code === 'not_found', JSON.stringify(direct));
  await go(bob.page, '/orders/' + aliceId);
  const bobSees = await bob.page.locator('body').innerText();
  check('bob: alice\'s order page shows nothing of hers (no reference, no address)', !bobSees.includes(aliceRef) && !bobSees.includes('Rizal Street'));
  const bobList = await bob.page.evaluate(async () => (await (await fetch('/api/orders')).json()).data.length);
  check('bob: his order list is empty from the API too', bobList === 0);

  // bob places his own; alice still sees only hers
  const bobVariant = other;
  await setCart(bob.page, [{ sku: bobVariant.sku, productId: bobVariant.productId, quantity: 1 }]);
  await go(bob.page, '/checkout');
  await waitQuote(bob.page);
  await fillForm(bob.page);
  await bob.page.getByRole('radio', { name: /Cash on delivery/ }).check();
  await bob.page.getByRole('button', { name: 'Place order' }).click();
  await bob.page.getByTestId('order-heading').waitFor();
  const bobId = bob.page.url().split('/orders/')[1].split(/[?#]/)[0];
  await go(alice.page, '/account');
  await alice.page.getByTestId('orders-list').waitFor();
  check('alice: her list has her order and not bob\'s', (await alice.page.getByTestId('order-row').count()) === 1 && (await alice.page.getByTestId('orders-list').textContent()).includes(aliceRef));
  const aliceSeesBob = await alice.page.evaluate(async (id) => (await fetch('/api/orders/' + id)).status, bobId);
  check('alice: bob\'s order number is 404 for her', aliceSeesBob === 404);

  // a reload keeps alice signed in (the cookie), without any password in the page
  await alice.page.reload({ waitUntil: 'networkidle' });
  check('reload: alice is still signed in (the session is the cookie)', await alice.page.getByTestId('signed-in-name').count().then((n) => n === 1));

  // sign out: the page, and a copy of the cookie, are dead
  const copy = (await alice.ctx.cookies()).find((c) => c.name === 'cc_session');
  await alice.page.getByTestId('account-menu-button').click();
  const [loggedOut] = await Promise.all([alice.page.waitForResponse((r) => r.url().endsWith('/api/auth/logout')), alice.page.getByRole('menuitem', { name: 'Sign out' }).click()]);
  check('sign out: the server answers 200 and clears the cookie', loggedOut.status() === 200 && /Max-Age=0/i.test((await loggedOut.allHeaders())['set-cookie'] ?? ''));
  await alice.page.getByTestId('signed-in-name').waitFor({ state: 'detached' });
  check('sign out: the header is back to the Sign in / Register menu and has no cart link (a cart belongs to a signed-in customer)', (await alice.page.getByTestId('cart-count').count()) === 0);
  const afterOut = await alice.page.evaluate(async () => (await fetch('/api/orders')).status);
  check('sign out: the orders are out of reach (401)', afterOut === 401);
  const thief = await browser.newContext({ viewport: { width: 1366, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': ipOf() } });
  await thief.addCookies([{ name: copy.name, value: copy.value, domain: copy.domain, path: '/' }]);
  const tp = await thief.newPage();
  await tp.goto(base + '/category', { waitUntil: 'networkidle' });
  const replay = await tp.evaluate(async () => { const r = await fetch('/api/orders'); return r.status; });
  check('sign out: a copy of the old cookie, replayed in another browser, is refused (401)', replay === 401);
  await thief.close();

  // sign back in: wrong password first, then the right one
  await go(alice.page, '/account');
  await alice.page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  const dlg = alice.page.getByRole('dialog');
  await dlg.getByLabel('Email').fill(alice.email);
  await dlg.getByLabel('Password').fill('not the right password');
  await dlg.getByRole('button', { name: 'Sign in' }).click();
  await dlg.getByText('The email or password is not right.').waitFor();
  check('sign in: a wrong password says so, in words, and signs nobody in', (await alice.page.getByTestId('signed-in-name').count()) === 0);
  await dlg.getByLabel('Password').fill(alice.password);
  await dlg.getByRole('button', { name: 'Sign in' }).click();
  await alice.page.getByTestId('orders-list').waitFor();
  check('sign in: the right password brings alice back to her own order', (await alice.page.getByTestId('orders-list').textContent()).includes(aliceRef) && (await alice.page.getByTestId('order-row').count()) === 1);

  // Odoo's side: the password is hashed, and only a hash of the session id is kept
  const stored = sql(`select left(password, 15) from res_users where login='${alice.email}'`);
  check('odoo: the password is stored hashed, never as typed', stored.startsWith('$pbkdf2-sha512$'), stored);
  const sess = sql(`select count(*) from clothcraft_api_session s join res_users u on u.id=s.user_id where u.login='${alice.email}'`);
  const raw = sql(`select count(*) from clothcraft_api_session where sid_hash = '${copy.value.split('.')[0]}'`);
  check('odoo: alice has sessions on record, and none of them holds the cookie value itself', Number(sess) >= 2 && Number(raw) === 0, `${sess} / ${raw}`);
  const revoked = sql(`select count(*) from clothcraft_api_session s join res_users u on u.id=s.user_id where u.login='${alice.email}' and s.revoked`);
  check('odoo: the session she signed out of is revoked', Number(revoked) >= 1, revoked);
  await alice.ctx.close();
  await bob.ctx.close();
});

// =================================================================== 8. step 10: only the ticked lines are ordered
await section('selection: one of two lines ticked', async (label) => {
  const [ticked, left] = plenty.slice(6);
  const { ctx, page } = await open(label, [
    { sku: ticked.sku, productId: ticked.productId, quantity: 2 },
    { sku: left.sku, productId: left.productId, quantity: 1, selected: false },
  ]);
  await go(page, '/cart');
  await waitQuote(page);
  const quote = (await page.evaluate(async (l) => (await (await fetch('/api/cart/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: l }) })).json()).data, [{ sku: ticked.sku, quantity: 2 }]));
  check('selection: the cart totals the ticked line only, as Odoo quotes it, and says "1 of 2 selected"', (await page.getByTestId('quote-total').textContent()).trim() === fmt(quote.total) && (await page.getByTestId('selection-count').textContent()).trim() === '1 of 2 selected', `${await page.getByTestId('quote-total').textContent()} vs ${fmt(quote.total)}`);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Checkout' && !b.disabled && b.offsetParent));
  await page.getByRole('button', { name: 'Checkout' }).first().click();
  await page.waitForURL('**/checkout');
  await waitQuote(page);
  check('selection: checkout lists only the ticked line and says the other stays in the cart', (await page.getByTestId('summary-lines').locator('li').count()) === 1 && (await page.getByTestId('checkout-partial').isVisible()));
  await fillForm(page);
  await page.getByRole('radio', { name: /Cash on delivery/ }).check();
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByTestId('order-heading').waitFor();
  const ref = /S\d{5,}/.exec(await page.getByTestId('order-heading').textContent())?.[0];
  const inOdoo = sql(`select string_agg(pp.default_code || ' x' || sol.product_uom_qty::int, ',') from sale_order_line sol join sale_order so on so.id=sol.order_id join product_product pp on pp.id=sol.product_id where so.name='${ref}' and pp.default_code in ('${ticked.sku}','${left.sku}')`);
  check('odoo: the order holds the ticked line only, with its quantity', inOdoo === `${ticked.sku} x2`, inOdoo);
  const stored = await storedCart(page);
  check('selection: the unticked line stays in the cart, unticked, and the badge counts it', JSON.stringify(stored) === JSON.stringify([{ sku: left.sku, productId: left.productId, quantity: 1 }]) && (await badge(page)) === '1', JSON.stringify(stored));
  await ctx.close();
});

report.data.ordersAfter = { all: allOrders(), api: apiOrders(), deliveryAddresses: Number(sql("select count(*) from res_partner where type='delivery' and parent_id is not null and create_date > now() - interval '1 day'")), picks: Number(sql("select count(*) from stock_picking sp join sale_order so on so.id=sp.sale_id where so.client_order_ref like 'api:%'")), transactions: Number(sql("select count(*) from payment_transaction pt join sale_order_transaction_rel r on r.transaction_id=pt.id join sale_order so on so.id=r.sale_order_id where so.client_order_ref like 'api:%'")) };
await browser.close();
rep.finish();
