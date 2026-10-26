// FROZEN in step 8 (not run): it drives the MOCK build through the old header (separate Sign in and Register buttons), the guest
// cart and mock-only wording, all of which step 8 removes. Its journeys are covered against the real service by check-shop-real.mjs and
// check-staff-real.mjs. Kept for reference; see frontend/README.md "Frozen checks".
// Step 7d: the staff dashboard (/staff) in real Edge, against the MOCK (VITE_API=mock, preview on 4173), and the same page in a build made
// with VITE_API=odoo (--odoo, preview on 4174) to prove the demo staff login is not there.
//   node scripts/check-staff-ui.mjs http://localhost:4173 <outDir> [--odoo http://localhost:4174]
// Everything happens in ONE tab: the mock server's orders, accounts and sessions live in that tab's sessionStorage.
// Screenshots (only these six): staff sign-in, orders table and order detail, each at 390 and 1366 px, in <outDir>/shots.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createReport, launch } from './lib/e2e-common.mjs';

const args = process.argv.slice(2);
const [base, out] = args;
const odooBase = args.includes('--odoo') ? args[args.indexOf('--odoo') + 1] : null;
if (!base || !out) throw new Error('usage: node scripts/check-staff-ui.mjs <mockBaseUrl> <outDir> [--odoo <odooBaseUrl>]');

const rep = createReport(out, 'staff-ui');
const { check, report } = rep;
mkdirSync(path.join(out, 'shots'), { recursive: true });
const browser = await launch();
// the 4xx answers this check provokes on purpose are logged by Chrome as console errors
const expected4xx = /Failed to load resource: the server responded with a status of (401|403|409|422)/;
const PROMISES = /\b(within|days?|hours?|minutes?|weeks?|tomorrow|estimated|expected|eta|guarantee[sd]?|refund(ed|s)?|deadline)\b/i;
const INVENTORY = { email: 'inventory.demo@clothcraft.test', password: 'demo inventory staff' };
const ADMIN = { email: 'admin.demo@clothcraft.test', password: 'demo administrator' };

const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
const page = await ctx.newPage();
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !expected4xx.test(m.text()) && report.console.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => report.console.push(`pageerror: ${e.message}`));
// every staff call and what the server answered, kept in the report: the first thing needed when a step fails
report.data.staffCalls = [];
page.on('response', (r) => {
  const p = new URL(r.url()).pathname;
  if (p.startsWith('/api/staff/')) report.data.staffCalls.push(`${r.request().method()} ${p.slice('/api/staff/'.length)} ${r.status()}`);
});
const shot = (name) => page.screenshot({ path: path.join(out, 'shots', name) });
const go = async (url) => {
  await page.goto(base + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(200);
};
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const text = (id) => page.getByTestId(id).textContent();
const status = async () => (await text('staff-order-status')).trim();

try {
// ---------------------------------------------------------------- 0. orders to look at, made through the mock's own API in this tab
await go('/staff');
const seeded = await page.evaluate(async () => {
  const json = async (url, init) => {
    const r = await fetch(url, init);
    return { r, body: await r.json() };
  };
  const post = (url, body, headers = {}) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const email = `staff-check-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const reg = await post('/api/auth/register', { name: 'Staff Check Customer', email, password: 'a long and careful e2e password' });
  const token = reg.r.headers.get('X-Mock-Session');
  const list = (await json('/api/catalogue/products')).body.data.products;
  const skus = [];
  for (const p of list) {
    for (const v of (await json(`/api/catalogue/products/${p.id}`)).body.data.variants) if (v.stock >= 5 && v.stock <= 90 && skus.length < 6) skus.push({ sku: v.sku, price: v.price });
    if (skus.length >= 6) break;
  }
  const delivery = { fullName: 'Juana Dela Cruz', email: 'juana@example.com', phone: '0917 123 4567', street: '12 Rizal Street', city: 'Quezon City', province: 'PH-00', postalCode: '1100', note: 'Leave with the guard' };
  const made = [];
  for (const [i, method] of ['cod', 'bank_transfer', 'cod', 'bank_transfer', 'cod'].entries()) {
    const placed = await post('/api/orders', { lines: [{ sku: skus[i].sku, quantity: 1 }], delivery, paymentMethod: method, quotedTotal: skus[i].price }, { 'X-Mock-Session': token, 'Idempotency-Key': crypto.randomUUID() });
    made.push({ id: placed.body.data.id, reference: placed.body.data.reference, method, sku: skus[i].sku, price: skus[i].price });
  }
  return { token, made };
});
check('seeded five orders (three cash on delivery, two bank transfer)', seeded.made.length === 5 && seeded.made.every((o) => o.id), JSON.stringify(seeded.made));
const [cod1, bank1, cod2, bank2] = seeded.made;

// ---------------------------------------------------------------- 1. signing in
// a customer session alone must open nothing: give this tab one, then ask for the dashboard
await page.evaluate((t) => sessionStorage.setItem('cc.mock.session', t), seeded.token);
await go('/staff');
check('with only a customer session, /staff asks for a staff sign-in and shows no orders', (await page.getByRole('heading', { name: 'Staff sign in' }).count()) === 1 && (await page.getByTestId('staff-orders').count()) === 0);
check('the staff page is not part of the shop: no cart, no shop navigation, no shop footer', (await page.getByTestId('cart-count').count()) === 0 && (await page.getByRole('navigation', { name: 'Main' }).count()) === 0 && (await page.getByText('Shop by category').count()) === 0);
check('the tab is called "ClothCraft staff" and search engines are told to stay away', (await page.title()) === 'ClothCraft staff' && (await page.locator('meta[name="robots"]').getAttribute('content')) === 'noindex, nofollow');
check('the mock shows its two demo staff accounts on the sign-in form', (await page.getByTestId('staff-demo-hint').count()) === 1 && (await page.getByRole('button', { name: /^Use / }).count()) === 2);
check('no horizontal scroll on the sign-in page at 1366', (await overflow()) <= 0, String(await overflow()));
await shot('staff-signin-1366.png');

await page.getByLabel('Email').fill(INVENTORY.email);
await page.getByLabel('Password').fill('not the password');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByTestId('staff-signin-error').getByText('The email or password is not right.').waitFor();
await page.waitForTimeout(100);
check('a wrong password is one sentence in an alert that takes focus, and the password field is emptied', (await page.getByRole('alert').count()) === 1 && (await page.getByLabel('Password').inputValue()) === '' && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'staff-signin-error');
await page.getByRole('button', { name: /Use Inventory Staff account/ }).click();
check('"Use" fills the form', (await page.getByLabel('Email').inputValue()) === INVENTORY.email && (await page.getByLabel('Password').inputValue()) === INVENTORY.password);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByTestId('staff-orders').waitFor();
check('signed in: who and role are shown in the header', /Demo Inventory Staff/.test(await text('staff-who')) && /Inventory Staff/.test(await text('staff-who')));
check('signing in as staff leaves the customer session as it was, and the two tokens are different', (await page.evaluate(() => sessionStorage.getItem('cc.mock.session'))) === seeded.token && (await page.evaluate(() => sessionStorage.getItem('cc.mock.staff.session'))) !== seeded.token);

// ---------------------------------------------------------------- 2. the orders table
const rows = page.getByTestId('staff-row');
check('the table lists the five orders, newest first', (await rows.count()) === 5 && (await rows.first().textContent()).includes(seeded.made[4].reference), String(await rows.count()));
check('a table header is shown on a desktop screen, with seven columns', (await page.locator('thead th').count()) === 7 && (await page.locator('thead').evaluate((el) => getComputedStyle(el).display)) !== 'none');
check('each row says who, how they pay, the status in words and whether payment arrived', /Juana Dela Cruz|Staff Check Customer/.test(await rows.nth(1).textContent()) && /Bank transfer/.test(await rows.nth(1).textContent()) && /Awaiting payment/.test(await rows.nth(1).textContent()) && /Not paid yet/.test(await rows.nth(1).textContent()));
check('the count line says what is shown', /Showing 1 to 5 of 5 orders/.test(await text('staff-count')));
check('no horizontal scroll on the orders page at 1366', (await overflow()) <= 0);
await shot('staff-orders-1366.png');
await page.getByRole('button', { name: 'Awaiting payment' }).click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="staff-row"]').length === 2);
check('the status tab filters at once and puts the filter in the address', page.url().includes('state=awaiting_payment') && (await rows.count()) === 2);
await page.getByRole('button', { name: 'All' }).click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="staff-row"]').length === 5);
await page.getByLabel('Search').fill(cod2.reference);
await page.getByRole('button', { name: 'Show orders' }).click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="staff-row"]').length === 1);
check('searching by order number finds exactly that order', (await rows.first().textContent()).includes(cod2.reference) && page.url().includes('q='));
await page.getByLabel('Search').fill('nobody by this name');
await page.getByRole('button', { name: 'Show orders' }).click();
await page.getByTestId('staff-empty').waitFor();
check('an empty result says so and offers to clear the filters', /No orders match these filters/.test(await text('staff-empty')));
await page.getByRole('button', { name: 'Clear the filters' }).click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="staff-row"]').length === 5);
await page.getByLabel('Payment').selectOption('cod');
await page.getByRole('button', { name: 'Show orders' }).click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="staff-row"]').length === 3);
check('the payment filter keeps only cash on delivery', (await rows.allTextContents()).every((t) => /Cash on delivery/.test(t)));
await page.getByRole('button', { name: 'Clear' }).click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="staff-row"]').length === 5);

// ---------------------------------------------------------------- 3. one order, cash on delivery, all the way, and what the customer sees at each step
await rows.filter({ hasText: cod1.reference }).getByRole('link').click();
await page.getByTestId('staff-order-heading').waitFor();
check('the detail page names the order and its status', (await text('staff-order-heading')).includes(cod1.reference) && (await status()) === 'Confirmed');
check('it shows the customer, the delivery address with the note, and the items', /Staff Check Customer/.test(await text('staff-customer')) && /Leave with the guard/.test(await text('staff-delivery')) && (await page.getByTestId('staff-lines').locator('li').count()) === 1);
check('it offers exactly "Mark as packed" and "Cancel order"', (await page.getByTestId('staff-actions').getByRole('button').allTextContents()).join('|') === 'Mark as packed|Cancel order');
check('no horizontal scroll on the detail page at 1366', (await overflow()) <= 0);
await shot('staff-order-1366.png');
const customerSees = async (id, word) => {
  await go(`/orders/${id}`);
  const box = await text('order-status');
  return { word: box.includes(word), promises: PROMISES.test(box), box };
};
for (const [button, word, shown] of [['packed', 'Packed', 'Packed'], ['shipped', 'Shipped', 'Shipped'], ['delivered', 'Delivered', 'Delivered']]) {
  await page.getByTestId(`staff-move-${button}`).click();
  await page.waitForFunction((w) => document.querySelector('[data-testid="staff-order-status"]')?.textContent?.trim() === w, shown);
  check(`one click marks it ${button}, and it says so`, /Marked as/.test(await text('staff-done')));
  const c = await customerSees(cod1.id, word);
  check(`the customer's order page says "${word}", and promises no time, date or refund`, c.word && !c.promises, c.box);
  await go(`/staff/orders/${cod1.id}`);
  check(`back on the staff page the order is still ${button}`, (await status()) === shown);
}
check('a delivered order has nothing more to do, and the history has three lines', (await page.getByTestId('staff-final').count()) === 1 && (await page.getByTestId('staff-history-row').count()) === 3);
check('cash is said to be collected', /Cash collected on delivery/.test(await text('staff-payment')));

// ---------------------------------------------------------------- 4. a bank-transfer order: Inventory Staff cannot cancel it once paid, an Administrator can with a note
await go(`/staff/orders/${bank1.id}`);
check('an unpaid bank-transfer order starts as "Awaiting payment" and offers "Mark payment received"', (await status()) === 'Awaiting payment' && (await page.getByTestId('staff-move-confirmed').textContent()).trim() === 'Mark payment received');
await page.getByTestId('staff-move-confirmed').click();
await page.waitForFunction(() => document.querySelector('[data-testid="staff-order-status"]')?.textContent?.trim() === 'Paid');
check('once paid it reads "Paid", and Inventory Staff have no cancel button but are told why', (await page.getByTestId('staff-move-cancelled').count()) === 0 && /Only an Administrator can cancel an order that has been paid\./.test(await text('staff-blocked')));
// the person who may not is also refused by the server, even with a hand-made request
const refused = await page.evaluate(async (id) => {
  const token = sessionStorage.getItem('cc.mock.staff.session');
  const r = await fetch(`/api/staff/orders/${id}/transition`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mock-Staff-Session': token }, body: JSON.stringify({ to: 'cancelled', expectedState: 'confirmed', note: 'trying anyway' }) });
  return { status: r.status, code: (await r.json()).error?.code };
}, bank1.id);
check('a hand-made cancel by Inventory Staff is refused with 403 forbidden', refused.status === 403 && refused.code === 'forbidden', JSON.stringify(refused));
await page.getByRole('button', { name: 'Sign out' }).click();
await page.getByRole('heading', { name: 'Staff sign in' }).waitFor();
await page.waitForFunction(() => sessionStorage.getItem('cc.mock.staff.session') === null);
check('signing out returns to the sign-in form and ends the staff session (the server answer clears the token)', true);
await page.getByRole('button', { name: /Use Administrator account/ }).click();
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByTestId('staff-who').waitFor(); // signing in on a deep link stays on that order
await go(`/staff/orders/${bank1.id}`);
await page.getByTestId('staff-move-cancelled').click();
check('the Administrator is asked first, and the note box takes focus', (await page.getByTestId('staff-confirm').count()) === 1 && /refund to arrange outside this system/.test(await text('staff-confirm')) && (await page.evaluate(() => document.activeElement?.tagName)) === 'TEXTAREA');
await page.getByTestId('staff-confirm-yes').click();
await page.getByTestId('staff-note-error').waitFor({ timeout: 5000 }).catch(async () => {
  throw new Error(`no note error after "Yes": panel=${await page.getByTestId('staff-confirm').count()} calls=${report.data.staffCalls.slice(-3).join(',')} active=${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`);
});
check('with no note it is refused on the note field and nothing changes', /a refund has to be arranged/.test(await text('staff-note-error')) && (await status()) === 'Paid');
await page.getByLabel(/Note/).fill('Finance refunds by transfer, ticket 42');
await page.getByTestId('staff-confirm-yes').click();
await page.waitForFunction(() => document.querySelector('[data-testid="staff-order-status"]')?.textContent?.trim() === 'Cancelled');
check('with a note it is cancelled and the history says REFUND DUE with the note', /Note: REFUND DUE\. Finance refunds by transfer, ticket 42/.test((await page.getByTestId('staff-history-row').last().textContent()) ?? ''));
const cancelledView = await customerSees(bank1.id, 'Cancelled');
check('the customer sees "Cancelled" and no promise of a refund', cancelledView.word && !PROMISES.test(cancelledView.box), cancelledView.box);

// ---------------------------------------------------------------- 5. two staff at once: the screen that is out of date gets "nothing was done" and catches up
await go(`/staff/orders/${cod2.id}`);
await page.getByTestId('staff-order-status').waitFor();
const other = await page.evaluate(async ({ id, creds }) => {
  const login = await fetch('/api/staff/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) });
  const token = login.headers.get('X-Mock-Staff-Session');
  const move = await fetch(`/api/staff/orders/${id}/transition`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mock-Staff-Session': token }, body: JSON.stringify({ to: 'packed', expectedState: 'confirmed' }) });
  return move.status;
}, { id: cod2.id, creds: INVENTORY });
check('another staff member packs the order while this screen still shows "Confirmed"', other === 200 && (await status()) === 'Confirmed');
await page.getByTestId('staff-move-packed').click();
await page.getByTestId('staff-problem').waitFor();
check('this screen is told "Nothing was done" and who changed it, and catches up to "Packed"', /This order is now packed; it was changed by Demo Inventory Staff\. Nothing was done\./.test(await text('staff-problem')) && (await status()) === 'Packed');
check('the history has one line, not two', (await page.getByTestId('staff-history-row').count()) === 1);

// ---------------------------------------------------------------- 6. the phone
await page.setViewportSize({ width: 390, height: 844 });
await page.getByRole('button', { name: 'Sign out' }).click();
await page.getByRole('heading', { name: 'Staff sign in' }).waitFor();
await page.getByTestId('staff-demo-hint').waitFor();
check('no horizontal scroll on the sign-in page at 390', (await overflow()) <= 0, String(await overflow()));
await shot('staff-signin-390.png');
await page.getByRole('button', { name: /Use Inventory Staff account/ }).click();
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByTestId('staff-who').waitFor();
await page.goto(base + '/staff', { waitUntil: 'networkidle' });
await page.getByTestId('staff-orders').waitFor();
check('no horizontal scroll on the orders page at 390', (await overflow()) <= 0, String(await overflow()));
check('on a phone the table header is hidden and each order is a card', (await page.locator('thead').evaluate((el) => getComputedStyle(el).position)) === 'absolute' && (await rows.first().evaluate((el) => getComputedStyle(el).display)) === 'block');
check('every card line is labelled (the label comes from the column name)', (await page.locator('td[data-label]').first().evaluate((el) => getComputedStyle(el, '::before').content)).includes('Order'));
check('the filter buttons and the order links are at least 44 px tall', (await page.getByTestId('staff-tabs').getByRole('button').evaluateAll((els) => els.every((e) => e.getBoundingClientRect().height >= 44))) && (await page.getByRole('button', { name: 'Show orders' }).evaluate((e) => e.getBoundingClientRect().height)) >= 44);
await shot('staff-orders-390.png');
await rows.filter({ hasText: bank2.reference }).getByRole('link').click();
await page.getByTestId('staff-order-heading').waitFor();
check('no horizontal scroll on the detail page at 390', (await overflow()) <= 0, String(await overflow()));
check('the action buttons are at least 44 px tall on a phone', await page.getByTestId('staff-actions').getByRole('button').evaluateAll((els) => els.length > 0 && els.every((e) => e.getBoundingClientRect().height >= 44)));
await shot('staff-order-390.png');
await page.getByTestId('staff-move-cancelled').click();
check('on a phone the cancel question appears under the buttons and the note is not covered', await page.getByTestId('staff-confirm-yes').isVisible());
await page.getByRole('button', { name: 'Go back' }).click();

// ---------------------------------------------------------------- 7. an unknown page inside the dashboard
await go('/staff/nothing-here');
check('an unknown /staff address is a page of its own, not the shop\'s', (await page.getByRole('heading', { name: 'Page not found' }).count()) === 1 && (await page.getByTestId('cart-count').count()) === 0);

} catch (error) {
  // a step that could not run is a failure, and what was on screen is the first thing needed to understand it
  check('the run reached its end', false, `${String(error.message).split('\n')[0]} | ${page.url()} | ${(await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 700)}`);
}

// ---------------------------------------------------------------- 8. the same page in a build made with VITE_API=odoo
if (odooBase) {
  const odoo = await ctx.newPage();
  const requests = [];
  odoo.on('request', (r) => requests.push(new URL(r.url()).pathname));
  odoo.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && report.console.push(`odoo ${m.type()}: ${m.text()}`));
  odoo.on('pageerror', (e) => report.console.push(`odoo pageerror: ${e.message}`));
  await odoo.goto(odooBase + '/staff', { waitUntil: 'networkidle' });
  await odoo.getByRole('heading', { name: 'Staff sign in' }).waitFor();
  await odoo.waitForTimeout(400);
  const html = await odoo.content();
  check('odoo build: /staff shows the sign-in form', (await odoo.getByTestId('staff-signin').count()) === 1);
  check('odoo build: there is no demo staff hint, no demo account, no demo password anywhere in the rendered page', (await odoo.getByTestId('staff-demo-hint').count()) === 0 && !/demo|inventory\.demo|admin\.demo|demo administrator|demo inventory staff/i.test(html), html.length + ' chars');
  check('odoo build: no code for the demo accounts or the mock server was even downloaded', !requests.some((p) => /DemoStaffHint|\/assets\/browser-|mockServiceWorker/.test(p)), requests.filter((p) => p.startsWith('/assets')).join(' '));
  check('odoo build: a first visit makes no staff call (so no 401 is logged)', !requests.some((p) => p.startsWith('/api/')), requests.filter((p) => p.startsWith('/api')).join(' '));
  check('odoo build: no service worker is registered', (await odoo.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)) === 0);
  await odoo.goto(odooBase + '/staff/orders/1', { waitUntil: 'networkidle' });
  check('odoo build: a deep link to an order also asks for the staff sign-in first', (await odoo.getByRole('heading', { name: 'Staff sign in' }).count()) === 1 && (await odoo.getByTestId('staff-who').count()) === 0);
  await odoo.close();
} else {
  report.data.odoo = 'skipped (no --odoo base given)';
}

report.data.run = randomUUID().slice(0, 8);
await browser.close();
rep.finish();
