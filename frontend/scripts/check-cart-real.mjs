// Step 12d: the cart kept on the account (GET/PUT /api/cart) against the REAL API service and Odoo, in real Edge, through the Vite proxy.
// Two customers, each signed in in two browser contexts (two "devices"). It REGISTERS REAL CUSTOMERS and PLACES A REAL ORDER, so point it at
// a THROWAWAY COPY only (the same setup as check-tracking-real.mjs):
//   node scripts/check-cart-real.mjs http://localhost:4175 <outDir> --db-container <db container> --db clothcraft_e2e
// Proves: the cart follows the account across contexts; isolation both ways; an edit in both contexts at once is merged and nothing is lost;
// sign-out then sign-in keeps the cart; designed lines survive across contexts; an order removes only its lines, in both contexts; an
// offline edit is kept and sent when the connection returns; a page hidden right after an edit still sends it (keepalive); the cart page and
// the badge say "loading" instead of a wrong cart; sign-out asks before unsaved cart edits or unfinished designs are lost.
// Screenshots (390 and 1366 px): the cart while loading, the note after a merge, the offline note, the two sign-out questions.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { cartCopyKey, createReport, launch, savedCart } from './lib/e2e-common.mjs';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const [base, out] = args;
const dbContainer = flag('--db-container');
const db = flag('--db');
if (!base || !out || !dbContainer || !db) throw new Error('usage: node scripts/check-cart-real.mjs <baseUrl> <outDir> --db-container <name> --db <throwaway database>');
if (!/^clothcraft_(e2e|ctest|throwaway)/.test(db)) throw new Error(`refusing to run against "${db}": only a throwaway copy (clothcraft_e2e...) may be used`);

const rep = createReport(out, 'cart-real');
const { check, report } = rep;
const browser = await launch();
const shot = (page, name) => page.screenshot({ path: path.join(out, 'shots', name), fullPage: true });
const PASSWORD = 'a long and careful e2e password';
const ipOf = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const sql = (q) => execFileSync('docker', ['exec', dbContainer, 'sh', '-c', `psql -U "$POSTGRES_USER" -d ${db} -At -c "${q}"`], { encoding: 'utf8' }).trim();
// 401 before sign-in, 409 is the cart conflict this script provokes on purpose; an offline page cannot load anything (ERR_INTERNET_DISCONNECTED)
const expected = /Failed to load resource: (the server responded with a status of (401|409)|net::ERR_INTERNET_DISCONNECTED)/;
const watch = (page, label) => {
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !expected.test(m.text()) && report.console.push(`${label} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => report.console.push(`${label} pageerror: ${e.message}`));
};
const go = async (page, url) => {
  await page.goto(base + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
};
const apiGet = (page, p) => page.evaluate(async (u) => (await fetch(u)).json(), p);
const accountCart = async (page) => (await apiGet(page, '/api/cart')).data.lines.map((l) => `${l.sku}${l.designId ? '#' + l.designId : ''}x${l.quantity}${l.selected ? '+' : ''}`);
const pageLines = (page) => page.getByTestId('cart-line').evaluateAll((els) => els.map((e) => `${e.dataset.sku}${e.dataset.design ? '#' + e.dataset.design : ''}`));
const badge = async (page) => (await page.getByTestId('cart-count').textContent()).trim();
let failShots = 0;
async function section(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(`${name}: ran to the end`, false, error.message.split('\n')[0]);
    for (const c of [globalThis.A1, globalThis.A2]) await c?.page.screenshot({ path: path.join(out, 'shots', `fail-${++failShots}-${c.label}.png`) }).catch(() => undefined);
  }
}
async function bothWidths(page, name) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await shot(page, `${name}-390.png`);
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.waitForTimeout(300);
  await shot(page, `${name}-1366.png`);
  return fits;
}

async function context(label) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': ipOf() } });
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(base + '/category', { waitUntil: 'networkidle' });
  return { ctx, page, label };
}
async function register(label, name) {
  const c = await context(label);
  c.email = `e2e-${randomUUID().slice(0, 12)}@example.test`;
  await c.page.getByTestId('account-menu-button').click();
  await c.page.getByRole('menuitem', { name: 'Register' }).click();
  const dialog = c.page.getByRole('dialog');
  await dialog.getByLabel('Your name').fill(name);
  await dialog.getByLabel('Email').fill(c.email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await c.page.getByTestId('signed-in-name').waitFor({ state: 'attached' });
  return c;
}
async function signIn(c, email) {
  await go(c.page, '/account');
  await c.page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  const dialog = c.page.getByRole('dialog');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await c.page.getByTestId('signed-in-name').waitFor({ state: 'attached' });
}
async function signInAgain(label, email) {
  const c = await context(label);
  c.email = email;
  await signIn(c, email);
  return c;
}
const urlOf = (v) => `/products/${v.productId}?color=${v.color}&size=${v.size}`;
async function addFromProduct(page, v) {
  await go(page, urlOf(v));
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.getByTestId('added-status').filter({ hasText: /Added/ }).waitFor();
}
async function openCart(page) {
  await go(page, '/cart');
  await page.getByTestId('cart-loading').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('[data-testid="cart-empty"]') || /₱/.test(document.querySelector('[data-testid="line-total"]')?.textContent ?? ''));
}
const row = (page, sku) => page.locator(`[data-testid="cart-line"][data-sku="${sku}"]:not([data-design])`);

// ---- four plain variants with stock (one per product), and a customizable garment
const probe = await context('probe');
const plain = [];
let designable = null;
for (const p of (await apiGet(probe.page, '/api/catalogue/products?stock=1')).data.products) {
  const detail = (await apiGet(probe.page, `/api/catalogue/products/${p.id}`)).data;
  const v = detail.variants.find((x) => x.stock >= 10);
  if (!v) continue;
  if (!designable && (await apiGet(probe.page, `/api/designs/pricing?product=${p.id}`)).data.designable) designable = { productId: p.id, ...v };
  else if (plain.length < 4) plain.push({ productId: p.id, ...v });
  if (plain.length === 4 && designable) break;
}
await probe.ctx.close();
check('the throwaway database has four plain variants in stock and a customizable garment', plain.length === 4 && !!designable);
if (plain.length < 4 || !designable) rep.finish();
const [V1, V2, V3, V4] = plain;
report.data.skus = { plain: plain.map((v) => v.sku), designed: designable.sku };

// ---- two customers, two contexts each
const A1 = (globalThis.A1 = await register('A1', 'Cart Check Ana'));
const B1 = await register('B1', 'Cart Check Ben');
const A2 = (globalThis.A2 = await signInAgain('A2', A1.email));
const B2 = await signInAgain('B2', B1.email);
const cartsBefore = Number(sql('select count(*) from clothcraft_cart'));

await section('follows: the cart follows the account across contexts', async () => {
  await addFromProduct(A1.page, V1);
  await savedCart(A1.page);
  await openCart(A2.page);
  check('follows: an item added in one context is in the other context\'s cart', JSON.stringify(await pageLines(A2.page)) === JSON.stringify([V1.sku]), JSON.stringify(await pageLines(A2.page)));
  check('follows: the other context\'s badge counts it', (await badge(A2.page)) === '1', await badge(A2.page));
  check('follows: it is stored in Odoo on the account (one cart, one line)', sql(`select count(*) from clothcraft_cart_line l join clothcraft_cart c on c.id=l.cart_id join res_users u on u.partner_id=c.partner_id where u.login='${A1.email}'`) === '1');
});

await section('isolation: each account sees only its own cart', async () => {
  await addFromProduct(B1.page, V2);
  await savedCart(B1.page);
  await openCart(B2.page);
  check('isolation: B\'s second context shows B\'s item only', JSON.stringify(await pageLines(B2.page)) === JSON.stringify([V2.sku]), JSON.stringify(await pageLines(B2.page)));
  await openCart(A2.page);
  check('isolation: A\'s contexts never show B\'s item', JSON.stringify(await pageLines(A2.page)) === JSON.stringify([V1.sku]), JSON.stringify(await pageLines(A2.page)));
  check('isolation: the API gives each account its own lines', JSON.stringify(await accountCart(A1.page)) === JSON.stringify([`${V1.sku}x1`]) && JSON.stringify(await accountCart(B1.page)) === JSON.stringify([`${V2.sku}x1`]));
  // a PUT from B can only ever write B's cart: the session decides whose cart it is
  const status = await B1.page.evaluate(async () => {
    const now = await (await fetch('/api/cart')).json();
    return (await fetch('/api/cart', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseVersion: now.data.version, lines: [] }) })).status;
  });
  check('isolation: B emptying "the cart" empties B\'s only; A\'s is untouched', status === 200 && JSON.stringify(await accountCart(A1.page)) === JSON.stringify([`${V1.sku}x1`]) && (await accountCart(B1.page)).length === 0);
});

await section('merge: an edit in both contexts at once', async () => {
  await openCart(A1.page);
  await openCart(A2.page); // both show V1 x1, at the same version
  // A1 raises V1; A2, not knowing, adds V3 from its own cart page state (a stale version): the second save is a 409, merged, saved again
  await row(A1.page, V1.sku).getByRole('button', { name: 'One more' }).click();
  await savedCart(A1.page);
  await row(A2.page, V1.sku).getByRole('checkbox').check();
  await savedCart(A2.page);
  check('merge: nothing lost: A1\'s quantity and A2\'s tick are both in the account\'s cart', JSON.stringify(await accountCart(A1.page)) === JSON.stringify([`${V1.sku}x2+`]), JSON.stringify(await accountCart(A1.page)));
  await A2.page.getByTestId('cart-merged').waitFor();
  check('merge: the context that met the newer cart says so, in words', (await A2.page.getByTestId('cart-merged').textContent()).includes('Your cart was also changed in another tab or on another device. We combined the changes'));
  check('merge: and shows the combined cart (the badge counts 2)', (await badge(A2.page)) === '2', await badge(A2.page));
  check('merge note: no sideways scroll at 390 px', await bothWidths(A2.page, 'cart-merged'));
  await A2.page.getByTestId('cart-merged').getByRole('button', { name: 'OK' }).click();

  // truly at the same moment: A1 adds V3, A2 adds V4, from product pages, in parallel
  await Promise.all([addFromProduct(A1.page, V3), addFromProduct(A2.page, V4)]);
  // wait until the ACCOUNT holds both adds. (Not "each context's copy equals the account": the context whose save landed first only learns of the
  // other's item when it next loads the cart, so that comparison passed or failed on timing. The assertions below, after both contexts open the
  // cart, are the real test.)
  for (let i = 0; i < 80; i++) {
    const names = (await accountCart(A1.page)).map((l) => l.split('x')[0]);
    if (names.includes(V3.sku) && names.includes(V4.sku)) break;
    await A1.page.waitForTimeout(150);
  }
  // and neither context has an unsaved edit left (which one saved first is timing; the copy of the one that saved first is stale until it reloads)
  await Promise.all([A1.page, A2.page].map(async (p) => {
    const key = await cartCopyKey(p);
    await p.waitForFunction((k) => JSON.parse(localStorage.getItem(k) ?? 'null')?.pending === false, key, { timeout: 8000 });
  }));
  await openCart(A1.page);
  await openCart(A2.page);
  const want = [V1.sku, V3.sku, V4.sku].sort();
  check('merge: two adds at the same moment: both items are in the account\'s cart', JSON.stringify((await accountCart(A1.page)).map((l) => l.split('x')[0]).sort()) === JSON.stringify(want), JSON.stringify(await accountCart(A1.page)));
  check('merge: and both contexts show the same three lines', JSON.stringify((await pageLines(A1.page)).sort()) === JSON.stringify(want) && JSON.stringify((await pageLines(A2.page)).sort()) === JSON.stringify(want));
});

await section('designed: a customized line survives across contexts', async () => {
  await go(A1.page, `/design?product=${designable.productId}&variant=${designable.sku}`);
  await A1.page.getByRole('button', { name: 'Add rectangle' }).click();
  await A1.page.waitForTimeout(300);
  await A1.page.getByRole('button', { name: 'Add this customization to cart' }).click();
  await A1.page.waitForFunction(() => /Added to your cart/.test(document.querySelector('[data-testid="design-cart-said"]')?.textContent ?? ''));
  const mine = (await savedCart(A1.page)).find((l) => l.designId);
  check('designed: the line names its design and keeps the editor\'s estimate on this device', !!mine && /^\d+$/.test(mine.designId) && typeof mine.estimate === 'number', JSON.stringify(mine));
  await openCart(A2.page);
  const there = A2.page.locator(`[data-testid="cart-line"][data-design="${mine.designId}"]`);
  check('designed: the other context shows the same designed line, with the design\'s preview', (await there.count()) === 1 && (await there.getByTestId('line-design-preview').count()) === 1);
  check('designed: Odoo keeps the design as a draft while it is in a cart', sql(`select state from clothcraft_design where id=${Number(mine.designId)}`) === 'draft');
  report.data.designId = mine.designId;
});

await section('order: an order removes only its lines, in both contexts', async () => {
  await openCart(A1.page);
  await A1.page.getByTestId('select-all').check(); // from mixed (V1 ticked): all ticked, then none
  await A1.page.getByTestId('select-all').uncheck();
  await row(A1.page, V3.sku).getByRole('checkbox').check();
  await savedCart(A1.page);
  await A1.page.getByRole('button', { name: 'Checkout' }).first().click();
  await A1.page.waitForURL('**/checkout');
  await A1.page.waitForFunction(() => /₱/.test(document.querySelector('[data-testid="quote-total"]')?.textContent ?? ''));
  await A1.page.getByRole('option', { name: 'Metro Manila (NCR)' }).waitFor({ state: 'attached' });
  await A1.page.getByLabel('Full name').fill('Cart Check Ana');
  await A1.page.getByLabel('Email').fill('ana@example.com');
  await A1.page.getByLabel('Mobile number').fill('0917 123 4567');
  await A1.page.getByLabel('House number and street').fill('12 Rizal Street');
  await A1.page.getByLabel('City or municipality').fill('Quezon City');
  await A1.page.getByLabel('Province').selectOption({ label: 'Metro Manila (NCR)' });
  await A1.page.getByLabel('Postal code').fill('1100');
  await A1.page.getByRole('radio', { name: /Cash on delivery/ }).check();
  await A1.page.getByRole('button', { name: 'Place order' }).click();
  await A1.page.getByTestId('order-heading').waitFor();
  const left = await savedCart(A1.page);
  const want = [V1.sku, V4.sku, `${designable.sku}#${report.data.designId}`].sort();
  const keys = (lines) => lines.map((l) => (l.designId ? `${l.sku}#${l.designId}` : l.sku)).sort();
  check('order: the ordered line left the cart; the three others stayed', JSON.stringify(keys(left)) === JSON.stringify(want), JSON.stringify(keys(left)));
  check('order: the account\'s cart in Odoo says the same', JSON.stringify((await accountCart(A1.page)).map((l) => l.split('x')[0]).sort()) === JSON.stringify(want), JSON.stringify(await accountCart(A1.page)));
  await openCart(A2.page);
  check('order: the other context shows the same three lines (no ordered line comes back)', JSON.stringify((await pageLines(A2.page)).sort()) === JSON.stringify(want), JSON.stringify(await pageLines(A2.page)));
  check('order: B\'s cart was not touched', (await accountCart(B1.page)).length === 0);
});

await section('offline: an offline edit is kept and sent when the connection returns', async () => {
  await openCart(A2.page);
  await A2.ctx.setOffline(true);
  await row(A2.page, V4.sku).getByRole('button', { name: 'One more' }).click();
  await A2.page.getByTestId('cart-offline').waitFor({ timeout: 10000 });
  check('offline: the page says the edit is kept on this device and will be saved', (await A2.page.getByTestId('cart-offline').textContent()).includes("You're offline. Your cart changes are kept on this device and will be saved when the connection is back."));
  const copy = await A2.page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('cc.cart.v2:')).map(([, v]) => JSON.parse(v))[0]);
  check('offline: the edit is in this device\'s copy, marked unsaved', copy?.pending === true && copy.lines.some((l) => l.sku === V4.sku && !l.designId && l.quantity === 2), JSON.stringify(copy?.lines?.map((l) => [l.sku, l.quantity])));
  check('offline: the account does not have it yet', (await accountCart(A1.page)).some((l) => l.startsWith(`${V4.sku}x1`)));
  check('offline note: no sideways scroll at 390 px', await bothWidths(A2.page, 'cart-offline'));
  // the sign-out question while edits cannot be saved
  await A2.page.getByTestId('account-menu-button').click();
  await A2.page.getByRole('menuitem', { name: 'Sign out' }).click();
  const ask = A2.page.getByTestId('signout-cart');
  await ask.waitFor({ timeout: 10000 });
  check('sign-out: with unsaved edits it asks "Some cart changes couldn\'t be saved. Sign out anyway?"', (await ask.textContent()).includes("Some cart changes couldn't be saved. Sign out anyway?"));
  check('sign-out question (cart): no sideways scroll at 390 px', await bothWidths(A2.page, 'signout-cart'));
  await ask.getByRole('button', { name: 'Stay signed in' }).click();
  check('sign-out: "Stay signed in" keeps the customer signed in', (await A2.page.getByTestId('signed-in-name').count()) === 1);
  await A2.ctx.setOffline(false);
  await savedCart(A2.page, 15000);
  check('offline: back online, the edit reached the account', (await accountCart(A1.page)).some((l) => l.startsWith(`${V4.sku}x2`)), JSON.stringify(await accountCart(A1.page)));
  await A2.page.getByTestId('cart-offline').waitFor({ state: 'detached' });
  check('offline: and the note is gone', (await A2.page.getByTestId('cart-offline').count()) === 0);
});

await section('pagehide: an edit made just before the page goes away is still sent (keepalive)', async () => {
  await openCart(A1.page);
  await row(A1.page, V1.sku).getByRole('button', { name: 'One more' }).click();
  await A1.page.goto('about:blank'); // inside the save delay: only the pagehide keepalive PUT can carry it
  await A2.page.waitForTimeout(1500);
  check('pagehide: the account has the edit made right before leaving', (await accountCart(A2.page)).some((l) => l.startsWith(`${V1.sku}x3`)), JSON.stringify(await accountCart(A2.page)));
});

await section('loading: the cart page and the badge never show a wrong cart while it loads', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  await A1.page.route('**/api/cart', async (route) => {
    if (route.request().method() === 'GET') await held;
    await route.continue();
  });
  await A1.page.goto(base + '/cart');
  await A1.page.getByTestId('cart-loading').waitFor();
  check('loading: the cart page says "Loading your cart…" (step B: its status message, inside the skeleton) and shows no line and no total', (await A1.page.getByTestId('cart-loading').getByRole('status').textContent()).trim() === 'Loading your cart…' && (await A1.page.getByTestId('cart-line').count()) === 0 && (await A1.page.getByTestId('quote-total').count()) === 0);
  check('loading: the badge shows no number ("…", "Cart, loading")', (await badge(A1.page)) === '…' && (await A1.page.getByRole('link', { name: 'Cart, loading' }).count()) === 1, await badge(A1.page));
  check('loading: no sideways scroll at 390 px', await bothWidths(A1.page, 'cart-loading'));
  release();
  await A1.page.getByTestId('cart-loading').waitFor({ state: 'detached' });
  await A1.page.waitForFunction(() => /₱/.test(document.querySelector('[data-testid="line-total"]')?.textContent ?? ''));
  check('loading: then the account\'s cart and its count', (await A1.page.getByTestId('cart-line').count()) === 3 && (await badge(A1.page)) === String(3 + 2 + 1), await badge(A1.page));
  await A1.page.unroute('**/api/cart');
});

await section('sign-out: then sign-in keeps the cart; unfinished designs are warned about first', async () => {
  // an unfinished design on this device (not added to the cart)
  await go(A1.page, `/design?product=${designable.productId}&variant=${designable.sku}`);
  // the design added to the cart earlier is still this product's draft on this device: continue it (one more unfinished change)
  const resume = A1.page.getByRole('button', { name: 'Continue your draft' });
  if (await resume.isVisible().catch(() => false)) await resume.click();
  await A1.page.getByRole('button', { name: 'Add circle' }).click();
  await A1.page.waitForTimeout(3000); // the draft is saved on this device a moment after the change
  await go(A1.page, '/cart');
  const before = await accountCart(A1.page);
  await A1.page.getByTestId('account-menu-button').click();
  await A1.page.getByRole('menuitem', { name: 'Sign out' }).click();
  const ask = A1.page.getByTestId('signout-drafts');
  await ask.waitFor({ timeout: 10000 });
  check('sign-out: it says how many unfinished designs are on this device', /^Unfinished designsYou have \d+ unfinished designs? on this device\. Add (them|it) to your cart to keep (them|it), or sign out anyway\./.test((await ask.textContent()).trim()), (await ask.textContent()).trim());
  check('sign-out question (designs): no sideways scroll at 390 px', await bothWidths(A1.page, 'signout-drafts'));
  await ask.getByRole('button', { name: 'Sign out anyway' }).click();
  await A1.page.getByTestId('signed-in-name').waitFor({ state: 'detached' });
  check('sign-out: this device\'s copy of the cart is removed (a shared computer keeps nothing)', (await A1.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('cc.cart.v2:')).length)) === 0);
  await signIn(A1, A1.email);
  await openCart(A1.page);
  check('sign-out then sign-in: the cart is all there', JSON.stringify(await accountCart(A1.page)) === JSON.stringify(before) && (await A1.page.getByTestId('cart-line').count()) === before.length, JSON.stringify(before));
});

report.data.carts = { before: cartsBefore, after: Number(sql('select count(*) from clothcraft_cart')) };
for (const c of [A1, A2, B1, B2]) await c.ctx.close();
await browser.close();
rep.finish();
