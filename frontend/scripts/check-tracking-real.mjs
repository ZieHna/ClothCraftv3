// Step 11e: order tracking (customer) and the staff board against the REAL API service and Odoo, in real Edge, through the Vite proxy.
// It REGISTERS REAL CUSTOMERS, PLACES REAL ORDERS and MOVES THEM, so point it at a THROWAWAY COPY only (the same setup as check-staff-real.mjs).
//   node scripts/check-tracking-real.mjs http://localhost:4175 <outDir> --db-container <db container> --db clothcraft_e2e --env <env file>
// With --archive-proof it only signs in as Inventory Staff and proves, on a copy of clothcraft_dev, that the closed orders are in the archive
// (list view) and never on the board; it creates nothing.
// The staff test users' emails and passwords are read from --env (STAFF_INVENTORY_*, STAFF_ADMIN_*), typed into the sign-in form and never printed.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createReport, launch, seedCart } from './lib/e2e-common.mjs';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const [base, out] = args;
const dbContainer = flag('--db-container');
const db = flag('--db');
const envFile = flag('--env');
const archiveOnly = args.includes('--archive-proof');
if (!base || !out || !dbContainer || !db || !envFile) throw new Error('usage: node scripts/check-tracking-real.mjs <baseUrl> <outDir> --db-container <name> --db <throwaway database> --env <env file> [--archive-proof]');
if (!/^clothcraft_(e2e|ctest|throwaway)/.test(db)) throw new Error(`refusing to run against "${db}": only a throwaway copy (clothcraft_e2e...) may be used`);

const env = Object.fromEntries(
  readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^(['"])(.*)\1$/, '$2')]),
);
const STAFF = {
  inventory: { email: env.STAFF_INVENTORY_EMAIL, password: env.STAFF_INVENTORY_PASSWORD },
  admin: { email: env.STAFF_ADMIN_EMAIL, password: env.STAFF_ADMIN_PASSWORD },
};
if (!Object.values(STAFF).every((s) => s.email && s.password)) throw new Error('the staff test users are not in the env file');

const rep = createReport(out, archiveOnly ? 'tracking-archive' : 'tracking-real');
const { check, report } = rep;
const browser = await launch();
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(out, 'shots', name), fullPage: true, ...opts });
const PASSWORD = 'a long and careful e2e password';
const ipOf = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const sql = (q) => execFileSync('docker', ['exec', dbContainer, 'sh', '-c', `psql -U "$POSTGRES_USER" -d ${db} -At -c "${q}"`], { encoding: 'utf8' }).trim();
const PROMISES = /\b(within|days?|hours?|minutes?|weeks?|tomorrow|estimated|expected|eta|guarantee[sd]?|refund(ed|s)?|deadline)\b/i;
const expected4xx = /Failed to load resource: the server responded with a status of (401|403|404|409|422)/;
const watch = (page, label) => {
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !expected4xx.test(m.text()) && report.console.push(`${label} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => report.console.push(`${label} pageerror: ${e.message}`));
};
const go = async (page, url) => {
  await page.goto(base + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
};
const apiStatus = (page, p, init) => page.evaluate(async ({ u, i }) => { const r = await fetch(u, i); return { status: r.status, body: await r.json().catch(() => null) }; }, { u: p, i: init });
const apiGet = (page, p) => page.evaluate(async (u) => (await fetch(u)).json(), p);
async function section(name, fn) {
  try { await fn(); } catch (error) { check(`${name}: ran to the end`, false, error.message.split('\n')[0]); }
}
const stateOf = (ref) => sql(`select clothcraft_state from sale_order where name='${ref}'`);
const closing = (ref) => sql(`select string_agg(a.actor_type||':'||a.via, ',' order by a.id) from clothcraft_order_audit a join sale_order o on o.id=a.order_id where o.name='${ref}' and a.to_state='closed'`);

async function customer(label) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': ipOf() } });
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(base + '/category', { waitUntil: 'networkidle' });
  const email = `e2e-${randomUUID().slice(0, 12)}@example.test`;
  await page.getByTestId('account-menu-button').click();
  await page.getByRole('menuitem', { name: 'Register' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your name').fill('Tracking Check Customer');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await page.getByTestId('signed-in-name').waitFor({ state: 'attached' });
  return { ctx, page, email };
}
async function staff(label, role, width = 1366) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': ipOf() } });
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(base + '/staff', { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(STAFF[role].email);
  await page.getByLabel('Password').fill(STAFF[role].password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByTestId('staff-who').waitFor();
  return { ctx, page };
}
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
async function order(c, variant, method) {
  // the customer's own cart (step 8a), kept on the account (step 12): seeded through the API, ticked so the checkout orders it (step 10)
  await seedCart(c.page, [{ sku: variant.sku, productId: variant.productId, quantity: 1, selected: true }]);
  await go(c.page, '/checkout');
  await c.page.waitForFunction(() => /₱/.test(document.querySelector('[data-testid="quote-total"]')?.textContent ?? ''));
  await fillForm(c.page);
  await c.page.getByRole('radio', { name: method === 'cod' ? /Cash on delivery/ : /Bank transfer/ }).check();
  await c.page.getByRole('button', { name: 'Place order' }).click();
  await c.page.getByTestId('order-heading').waitFor();
  const heading = (await c.page.getByTestId('order-heading').textContent()).trim();
  return { id: c.page.url().split('/orders/')[1].split(/[?#]/)[0], ref: /S\d{5,}/.exec(heading)?.[0] };
}
const column = (page, state) => page.locator(`[data-testid="board-column"][data-state="${state}"]`);
const cardOf = (page, o) => page.locator(`[data-testid="board-card"][data-order="${o.id}"]`);
/** the tracker as the customer sees it: [step, kind, aria-current, text] */
const tracker = (page) => page.getByTestId('tracker-step').evaluateAll((els) => els.map((e) => [e.dataset.step, e.dataset.kind, e.getAttribute('aria-current'), e.textContent]));
/** the customer's page asks again as it does when the tab comes back (focus), and waits until the step shown is `step` */
async function customerSeesStep(c, step) {
  await c.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await c.page.waitForFunction((s) => document.querySelector('[data-testid="tracker-step"][aria-current="step"]')?.getAttribute('data-step') === s, step, { timeout: 15000 });
  return tracker(c.page);
}
async function bothWidths(page, name) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await shot(page, `${name}-390.png`);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.waitForTimeout(300);
  await shot(page, `${name}-1366.png`);
  return wide;
}

if (archiveOnly) {
  // ================================================================= a copy of clothcraft_dev: the closed orders are in the archive, never on the board
  await section('archive', async () => {
    const counts = Object.fromEntries(sql("select clothcraft_state||'='||count(*) from sale_order where state in ('sale','cancel') group by clothcraft_state").split('\n').map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));
    report.data.counts = counts;
    const inv = await staff('inventory', 'inventory');
    const asked = [];
    inv.page.on('request', (r) => r.url().includes('/api/staff/orders?') && asked.push(new URL(r.url()).searchParams));
    await go(inv.page, '/staff');
    await inv.page.waitForFunction(() => document.querySelectorAll('[data-testid="column-total"]').length === 5 && /closed/.test(document.querySelector('[data-testid="board-archive"]')?.textContent ?? ''));
    const totals = Object.fromEntries(await inv.page.locator('[data-testid="board-column"]').evaluateAll((cols) => cols.map((c) => [c.dataset.state, Number(c.querySelector('[data-testid="column-total"]').textContent)])));
    report.data.boardTotals = totals;
    check('archive: the database has the 1,972 closed orders the migration made', counts.closed === 1972, JSON.stringify(counts));
    check('archive: the board columns hold exactly the open orders of their state (as Odoo counts them)', ['awaiting_payment', 'confirmed', 'shipped', 'out_for_delivery', 'delivered'].every((s) => totals[s] === (counts[s] ?? 0)), JSON.stringify(totals));
    check('archive: no board column is "closed" or "cancelled"', !('closed' in totals) && !('cancelled' in totals), JSON.stringify(totals));
    check('archive: the board asked for closed and cancelled orders only to count them (one row each), never as cards', asked.filter((p) => ['closed', 'cancelled'].includes(p.get('state'))).every((p) => p.get('pageSize') === '1'), asked.map((p) => `${p.get('state')}/${p.get('pageSize')}`).join(' '));
    const cardsShown = await inv.page.getByTestId('board-card').count();
    const shownIds = await inv.page.getByTestId('board-card').evaluateAll((els) => els.map((e) => e.dataset.order));
    const closedShown = shownIds.length ? Number(sql(`select count(*) from sale_order where id in (${shownIds.join(',')}) and clothcraft_state in ('closed','cancelled')`)) : 0;
    check('archive: none of the cards on the board is a closed or cancelled order', closedShown === 0, `${cardsShown} cards, ${closedShown} closed`);
    check('archive: the archive link counts them: 1,972 closed and the cancelled ones', (await inv.page.getByTestId('board-archive').textContent()).includes(`1,972 closed, ${(counts.cancelled ?? 0).toLocaleString('en-US')} cancelled`), await inv.page.getByTestId('board-archive').textContent());
    await shot(inv.page, 'board-dev-copy-1366.png');
    await inv.page.getByTestId('board-archive').click();
    await inv.page.waitForURL('**/staff/orders?state=closed');
    await inv.page.getByTestId('staff-count').waitFor();
    check('archive: the archive (list view, Closed) shows all 1,972 of them', /of 1972 orders/.test(await inv.page.getByTestId('staff-count').textContent()), await inv.page.getByTestId('staff-count').textContent());
    check('archive: every row it shows is closed', (await inv.page.getByTestId('staff-row').evaluateAll((rows) => rows.every((r) => r.dataset.state === 'closed'))) === true);
    await shot(inv.page, 'archive-dev-copy-1366.png');
    await inv.ctx.close();
  });
  await browser.close();
  rep.finish();
  process.exit(0);
}

// ---------------------------------------------------------------- variants, people
const probe = await customer('probe');
const variants = [];
for (const p of (await apiGet(probe.page, '/api/catalogue/products')).data.products) {
  for (const v of (await apiGet(probe.page, `/api/catalogue/products/${p.id}`)).data.variants) variants.push({ ...v, productId: p.id });
}
await probe.ctx.close();
const plenty = variants.filter((v) => v.stock >= 5 && v.stock <= 40);
check('the throwaway database has variants to test with', plenty.length >= 6, String(plenty.length));
const [vMain, vRace, vRules, vCancel] = plenty;
const cust = await customer('customer');
const other = await customer('other customer');
const inv = await staff('inventory', 'inventory');
const adm = await staff('admin', 'admin');

// =================================================================== 1. the customer follows one order through every step; staff move it on the board
let main = null;
await section('journey', async () => {
  main = await order(cust, vMain, 'cod');
  let steps = await tracker(cust.page);
  check('journey: right after ordering, the tracker shows step 1 "Order received and preparing" as the current step, with its time', steps.length === 4 && steps[0][1] === 'now' && steps[0][2] === 'step' && /Order received and preparing/.test(steps[0][3]) && /\d{4}/.test(steps[0][3]) && steps.slice(1).every((s) => s[1] === 'next' && s[2] === null), JSON.stringify(steps));
  check('journey: the page promises no time or date', !PROMISES.test(await cust.page.getByTestId('order-status').textContent()), await cust.page.getByTestId('order-status').textContent());
  check('journey: step 1 at 390 px has no sideways scroll', await bothWidths(cust.page, 'tracker-step1'));

  await go(inv.page, '/staff');
  await cardOf(inv.page, main).waitFor();
  check('journey: the new order is on the board under "Received & preparing"', (await column(inv.page, 'confirmed').locator(`[data-order="${main.id}"]`).count()) === 1);
  // keyboard only: from the order's link, Tab reaches "Move to next step", Enter presses it (no mouse)
  await cardOf(inv.page, main).getByRole('link', { name: main.ref }).focus();
  await inv.page.keyboard.press('Tab');
  const focused = await inv.page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  check('journey: keyboard only: Tab from the order\'s link lands on its "Move to next step" button', focused === `Move ${main.ref} to next step: Shipped`, String(focused));
  await inv.page.keyboard.press('Enter');
  await column(inv.page, 'shipped').locator(`[data-order="${main.id}"]`).waitFor();
  check('journey: Enter moved it to "Shipped" on the board and in Odoo (the delivery validated)', stateOf(main.ref) === 'shipped' && sql(`select string_agg(distinct sp.state, ',') from stock_picking sp join sale_order so on so.id=sp.sale_id where so.name='${main.ref}'`) === 'done');
  steps = await customerSeesStep(cust, 'shipped');
  check('journey: the customer\'s page shows step 2 "Shipped out" with its time, without a reload (it asks again on focus)', steps[0][1] === 'done' && steps[1][1] === 'now' && /\d{4}/.test(steps[1][3]), JSON.stringify(steps));

  // keyboard only again, with Space
  await cardOf(inv.page, main).getByRole('link', { name: main.ref }).focus();
  await inv.page.keyboard.press('Tab');
  await inv.page.keyboard.press(' ');
  await column(inv.page, 'out_for_delivery').locator(`[data-order="${main.id}"]`).waitFor();
  check('journey: Space moved it to "On delivery"', stateOf(main.ref) === 'out_for_delivery');
  steps = await customerSeesStep(cust, 'on_delivery');
  check('journey: the customer sees step 3 "On delivery" as current, with steps 1 and 2 done and their times', steps[2][1] === 'now' && steps[2][2] === 'step' && steps[0][1] === 'done' && steps[1][1] === 'done', JSON.stringify(steps));
  check('journey: step 3 says a cash-on-delivery order is paid on arrival', /on its way to you\. Please pay in cash when it arrives\./.test(await cust.page.getByTestId('order-status').textContent()));
  await bothWidths(cust.page, 'tracker-step3');

  // the mouse: drag the card onto the next column
  await cardOf(inv.page, main).dragTo(column(inv.page, 'delivered'));
  await column(inv.page, 'delivered').locator(`[data-order="${main.id}"]`).waitFor({ timeout: 10000 });
  check('journey: dragging the card onto "Delivered" made the same move (the cash is collected)', stateOf(main.ref) === 'delivered' && sql(`select pt.state from payment_transaction pt join sale_order_transaction_rel r on r.transaction_id=pt.id join sale_order so on so.id=r.sale_order_id where so.name='${main.ref}'`) === 'done');
  check('journey: a delivered card has no move button, it waits for the customer', (await cardOf(inv.page, main).getByTestId('card-move').count()) === 0);
  steps = await customerSeesStep(cust, 'delivered');
  const box = await cust.page.getByTestId('order-status').textContent();
  check('journey: at step 4 the customer is asked to confirm, and told it closes by itself, with no number of days', (await cust.page.getByRole('button', { name: 'Confirm I received my order' }).count()) === 1 && box.includes("If you don't confirm, we'll close the order automatically.") && !/\d+\s*day/i.test(box), box);
  await bothWidths(cust.page, 'tracker-step4');

  // the customer confirms (through the dialog)
  await cust.page.getByRole('button', { name: 'Confirm I received my order' }).click();
  const dialog = cust.page.getByTestId('confirm-received-dialog');
  check('journey: the confirmation dialog opens with the safe choice focused', (await cust.page.evaluate(() => document.activeElement?.textContent)) === 'Not yet');
  await dialog.getByRole('button', { name: 'Yes, I received it' }).click();
  await cust.page.getByTestId('closed-note').waitFor();
  check('journey: confirmed: the page says so, every step is done, and Odoo closed it once, as the customer, through the shop', stateOf(main.ref) === 'closed' && closing(main.ref) === 'customer:shop' && (await tracker(cust.page)).every((s) => s[1] === 'done'), `${stateOf(main.ref)} ${closing(main.ref)}`);
  await bothWidths(cust.page, 'tracker-closed');
  await go(cust.page, '/account');
  await cust.page.getByTestId('orders-list').waitFor();
  check('journey: the orders list labels it "Completed"', /Completed/.test(await cust.page.getByTestId('order-row').filter({ hasText: main.ref }).textContent()));
  await inv.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await cardOf(inv.page, main).waitFor({ state: 'detached', timeout: 10000 });
  check('journey: the closed order left the board (it is in the archive)', (await cardOf(inv.page, main).count()) === 0);
  await go(inv.page, `/staff/orders/${main.id}`);
  check('journey: the staff history names the customer\'s confirmation as theirs', /the customer, confirming they received it/.test(await inv.page.getByTestId('staff-history').textContent()));
});

// =================================================================== 2. two staff on the board at once
await section('conflict', async () => {
  const race = await order(cust, vRace, 'cod');
  await go(inv.page, '/staff');
  await go(adm.page, '/staff');
  await cardOf(inv.page, race).waitFor();
  await cardOf(adm.page, race).waitFor();
  await cardOf(inv.page, race).getByTestId('card-move').click();
  await column(inv.page, 'shipped').locator(`[data-order="${race.id}"]`).waitFor();
  await cardOf(adm.page, race).getByTestId('card-move').click();          // the Administrator's board still shows it under "Received"
  const problem = cardOf(adm.page, race).getByTestId('card-problem');
  await problem.waitFor();
  const text = await problem.textContent();
  check('conflict: the second move is refused on the card in the shop\'s words, naming who got there first and what it is now', /This order is now shipped; it was changed by Staff Inventory \(test\)\. Nothing was done\./.test(text) && /Now:\s*Shipped/.test(text), text);
  check('conflict: Odoo has ONE history line', sql(`select count(*) from clothcraft_order_audit a join sale_order o on o.id=a.order_id where o.name='${race.ref}'`) === '1');
  await cardOf(adm.page, race).screenshot({ path: path.join(out, 'shots', 'board-card-409-1366.png') });
  await shot(adm.page, 'board-409-1366.png');
});

// =================================================================== 3. Inventory Staff vs Administrator; the customer cannot move orders
await section('rules', async () => {
  const o = await order(cust, vRules, 'cod');
  await go(inv.page, '/staff');
  for (const to of ['shipped', 'out_for_delivery']) {
    await cardOf(inv.page, o).getByTestId('card-move').click();
    await column(inv.page, to).locator(`[data-order="${o.id}"]`).waitFor();
  }
  await go(inv.page, `/staff/orders/${o.id}`);
  check('rules: Inventory Staff are offered no step back', (await inv.page.getByTestId('staff-move-shipped').count()) === 0);
  const forced = await apiStatus(inv.page, `/api/staff/orders/${o.id}/transition`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'shipped', expectedState: 'out_for_delivery', note: 'trying' }) });
  check('rules: ...and the service refuses one (403 forbidden)', forced.status === 403 && forced.body?.error?.code === 'forbidden', JSON.stringify(forced));
  await go(adm.page, `/staff/orders/${o.id}`);
  await adm.page.getByTestId('staff-move-shipped').click();
  await adm.page.getByTestId('staff-confirm').waitFor();
  check('rules: an Administrator\'s step back asks for a note and says nothing is undone', /Nothing is undone in stock or payment/.test(await adm.page.getByTestId('staff-confirm').textContent()) && /required: say why/.test(await adm.page.getByTestId('staff-confirm').textContent()));
  await adm.page.getByTestId('staff-confirm-yes').click();
  await adm.page.getByTestId('staff-note-error').waitFor();
  check('rules: without a note it is refused, in words', /say why the order is stepped back/.test(await adm.page.getByTestId('staff-note-error').textContent()));
  await adm.page.getByLabel(/^Note/).fill('The courier has not picked it up yet.');
  await adm.page.getByTestId('staff-confirm-yes').click();
  await adm.page.waitForFunction(() => document.querySelector('[data-testid="staff-order-status"]')?.textContent?.trim() === 'Shipped');
  check('rules: with a note the order is back at Shipped, and the history says it was a step back', stateOf(o.ref) === 'shipped' && /stepped back by an Administrator/.test(await adm.page.getByTestId('staff-history').textContent()) && sql(`select step_back from clothcraft_order_audit a join sale_order s on s.id=a.order_id where s.name='${o.ref}' order by a.id desc limit 1`) === 't');
  await go(cust.page, `/orders/${o.id}`);
  check('rules: the customer\'s tracker followed it back to step 2 and shows no note', (await tracker(cust.page))[1][1] === 'now' && !/courier/.test(await cust.page.getByTestId('order-status').textContent()));
  const byCustomer = await apiStatus(cust.page, `/api/staff/orders/${o.id}/transition`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'out_for_delivery', expectedState: 'shipped' }) });
  check('rules: a customer cannot move an order (the staff route says 401 to a customer cookie)', byCustomer.status === 401, JSON.stringify(byCustomer));
  const early = await apiStatus(cust.page, `/api/orders/${o.id}/received`, { method: 'POST' });
  check('rules: the customer cannot confirm before delivery (409 invalid_transition)', early.status === 409 && early.body?.error?.code === 'invalid_transition', JSON.stringify(early));
  const stranger = await apiStatus(other.page, `/api/orders/${o.id}/received`, { method: 'POST' });
  check('rules: another customer confirming this order gets 404, not a hint', stranger.status === 404, JSON.stringify(stranger));
  check('rules: still shipped after all that', stateOf(o.ref) === 'shipped');
});

// =================================================================== 4. a cancelled order, as the customer sees it
await section('cancelled', async () => {
  const o = await order(cust, vCancel, 'bank_transfer');
  check('cancelled: a bank transfer waits for payment before step 1 (no current step)', (await tracker(cust.page)).every((s) => s[1] === 'next' && s[2] === null) && (await cust.page.getByTestId('wait-note').count()) === 1);
  await go(inv.page, `/staff/orders/${o.id}`);
  await inv.page.getByTestId('staff-move-cancelled').click();
  await inv.page.getByTestId('staff-confirm-yes').click();
  await inv.page.waitForFunction(() => document.querySelector('[data-testid="staff-order-status"]')?.textContent?.trim() === 'Cancelled');
  await go(cust.page, `/orders/${o.id}`);
  check('cancelled: the customer sees a clear cancelled message and no tracker', (await cust.page.getByTestId('order-tracker').count()) === 0 && /This order was cancelled\. Its items went back into stock\./.test(await cust.page.getByTestId('order-status').textContent()));
});

// =================================================================== 5. the board at 1366 and as tabs on a phone
await section('board', async () => {
  await go(inv.page, '/staff');
  await inv.page.waitForFunction(() => document.querySelectorAll('[data-testid="column-total"]').length === 5);
  await shot(inv.page, 'board-1366.png');
  const phone = await staff('inventory phone', 'inventory', 390);
  await go(phone.page, '/staff');
  const tabs = phone.page.getByRole('tab');
  check('board: on a phone the columns are tabs (five), one column shown at a time', (await tabs.count()) === 5 && (await phone.page.locator('[data-testid="board-column"]:not([hidden])').count()) === 1);
  check('board: no sideways page scroll at 390 px', await phone.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await tabs.nth(1).focus();
  await phone.page.keyboard.press('ArrowRight');
  check('board: the arrow keys move between the tabs', (await tabs.nth(2).getAttribute('aria-selected')) === 'true' && (await phone.page.locator('[data-testid="board-column"]:not([hidden])').getAttribute('data-state')) === 'shipped');
  const targets = await phone.page.locator('[data-testid="card-move"], [role="tab"]').evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height)));
  check('board: tabs and move buttons are at least 44 px tall', targets.length > 0 && targets.every((h) => h >= 44), JSON.stringify(targets));
  await shot(phone.page, 'board-phone-tabs-390.png');
  await phone.ctx.close();
});

report.data.audit = sql("select actor_type||'='||count(*) from clothcraft_order_audit group by actor_type order by actor_type");
for (const c of [cust, other, inv, adm]) await c.ctx.close();
await browser.close();
rep.finish();
