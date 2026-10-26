// Step 7e: the staff dashboard against the REAL API service and Odoo, in real Edge, through the Vite proxy.
// It REGISTERS REAL CUSTOMERS, PLACES REAL ORDERS and MOVES THEM through the real staff screens, in whatever database the API serves, so point
// it at a THROWAWAY COPY only (never clothcraft_sim, clothcraft_dev or the live clothcraft). Setup, from the repo root:
//   1. pg_dump clothcraft_dev into backups/ (verify it with pg_restore --list), restore it into clothcraft_e2e, copy the filestore folder;
//   2. start a second Odoo (-d clothcraft_e2e --db-filter) and a second API (ODOO_DB=clothcraft_e2e, TRUSTED_PROXIES=* so each browser context
//      can present its own client address, ALLOWED_ORIGINS=http://localhost:4175, published on 127.0.0.1:8001) as separate, named containers;
//   3. VITE_API=odoo npx vite build --outDir <dir>, then
//      VITE_API=odoo VITE_PROXY_TARGET=http://127.0.0.1:8001 npx vite preview --outDir <dir> --port 4175
//   4. node scripts/check-staff-real.mjs http://localhost:4175 <outDir> --db-container <db container> --db clothcraft_e2e --env ../backend/.env
// The two staff test users' emails and passwords are read from --env (STAFF_INVENTORY_*, STAFF_ADMIN_*), used in the sign-in form and NEVER
// printed or written anywhere. The script reads the throwaway database with psql inside the db container, and at the very end proves two facts
// about the audit table on it (UPDATE and DELETE are refused; TRUNCATE is not).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createReport, launch, seedCart } from './lib/e2e-common.mjs';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const [base, out] = args;
const dbContainer = flag('--db-container');
const db = flag('--db');
const envFile = flag('--env');
if (!base || !out || !dbContainer || !db || !envFile) throw new Error('usage: node scripts/check-staff-real.mjs <baseUrl> <outDir> --db-container <name> --db <throwaway database> --env <backend/.env>');
if (!/^clothcraft_(e2e|ctest|throwaway)/.test(db)) throw new Error(`refusing to run against "${db}": only a throwaway copy (clothcraft_e2e...) may be used`);

const env = Object.fromEntries(
  readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^(['"])(.*)\1$/, '$2')]),
);
const STAFF = {
  inventory: { email: env.STAFF_INVENTORY_EMAIL, password: env.STAFF_INVENTORY_PASSWORD },
  admin: { email: env.STAFF_ADMIN_EMAIL, password: env.STAFF_ADMIN_PASSWORD },
};
if (!Object.values(STAFF).every((s) => s.email && s.password)) throw new Error('the staff test users are not in the env file (scripts/create_staff_users.py writes them)');

const rep = createReport(out, 'staff-real');
const { check, report } = rep;
const browser = await launch();
const PASSWORD = 'a long and careful e2e password';
const ipOf = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const sql = (q) => execFileSync('docker', ['exec', dbContainer, 'sh', '-c', `psql -U "$POSTGRES_USER" -d ${db} -At -c "${q}"`], { encoding: 'utf8' }).trim();
/** a statement that is EXPECTED to be refused: the database's own words, or null when it was not refused */
const refusal = (q) => {
  try {
    sql(q);
    return null;
  } catch (error) {
    return String(error.stderr ?? error.message);
  }
};
const PROMISES = /\b(within|days?|hours?|minutes?|weeks?|tomorrow|estimated|expected|eta|guarantee[sd]?|refund(ed|s)?|deadline)\b/i;
// Chrome logs every 4xx answer as a console error; the cases below PROVOKE these on purpose
const expected4xx = /Failed to load resource: the server responded with a status of (401|403|409|422)/;
const watch = (page, label) => {
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !expected4xx.test(m.text()) && report.console.push(`${label} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => report.console.push(`${label} pageerror: ${e.message}`));
};
const go = async (page, url) => {
  await page.goto(base + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
};
const apiGet = (page, p) => page.evaluate(async (u) => (await fetch(u)).json(), p);
const apiStatus = (page, p, init) => page.evaluate(async ({ u, i }) => { const r = await fetch(u, i); return { status: r.status, body: await r.json().catch(() => null) }; }, { u: p, i: init });
async function section(name, fn) {
  const label = name.split(':')[0];
  try { await fn(label); } catch (error) { check(`${name}: ran to the end`, false, error.message.split('\n')[0]); }
}

// ---------------------------------------------------------------- the people
/** a registered, signed-in customer in a browser of their own */
async function customer(label) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': ipOf() } });
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(base + '/category', { waitUntil: 'networkidle' });
  const email = `e2e-${randomUUID().slice(0, 12)}@example.test`;
  await page.getByTestId('account-menu-button').click();
  await page.getByRole('menuitem', { name: 'Register' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your name').fill('Staff Check Customer');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await page.getByTestId('signed-in-name').waitFor({ state: 'attached' });
  return { ctx, page, email };
}
/** a staff member signed in through the real sign-in form, in a browser of their own */
async function staff(label, role) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': ipOf() } });
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
/** the customer orders one unit of a variant through the real checkout; returns the order's id and number */
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
const stockOf = async (page, v) => (await apiGet(page, `/api/catalogue/products/${v.productId}`)).data.variants.find((x) => x.sku === v.sku).stock;
const stateOf = (ref) => sql(`select clothcraft_state from sale_order where name='${ref}'`);
const audit = (ref) => sql(`select string_agg(a.from_state||'>'||a.to_state||'|'||a.via||'|'||a.staff_name, ';' order by a.id) from clothcraft_order_audit a join sale_order o on o.id=a.order_id where o.name='${ref}'`);
const status = async (page) => (await page.getByTestId('staff-order-status').textContent()).trim();
async function customerSees(c, o, word) {
  await go(c.page, `/orders/${o.id}`);
  const box = await c.page.getByTestId('order-status').textContent();
  return { ok: box.includes(word) && !PROMISES.test(box), box };
}
async function openOrder(s, o) {
  await go(s.page, `/staff/orders/${o.id}`);
  await s.page.getByTestId('staff-order-heading').waitFor();
}
const click = async (s, to, word) => {
  await s.page.getByTestId(`staff-move-${to}`).click();
  await s.page.waitForFunction((w) => document.querySelector('[data-testid="staff-order-status"]')?.textContent?.trim() === w, word);
};

// ---------------------------------------------------------------- variants to use, found through the API: each case gets one of its own
const probe = await customer('probe');
const variants = [];
for (const p of (await apiGet(probe.page, '/api/catalogue/products')).data.products) {
  for (const v of (await apiGet(probe.page, `/api/catalogue/products/${p.id}`)).data.variants) variants.push({ ...v, productId: p.id });
}
await probe.ctx.close();
const plenty = variants.filter((v) => v.stock >= 5 && v.stock <= 40);
check('the throwaway database has variants to test with', plenty.length >= 6, `${plenty.length}`);
const [vCod, vRace, vRaceSim, vPaid, vUnpaid] = plenty;
report.data.before = { orders: Number(sql('select count(*) from sale_order')), audit: Number(sql('select count(*) from clothcraft_order_audit')) };
check('the throwaway database starts with no history lines', report.data.before.audit === 0, String(report.data.before.audit));

const cust = await customer('customer');
const staffs = { inventory: await staff('inventory', 'inventory'), admin: await staff('admin', 'admin') };
check('both staff test users sign in through the real form and the header says who and which role', /Inventory Staff/.test(await staffs.inventory.page.getByTestId('staff-who').textContent()) && /Administrator/.test(await staffs.admin.page.getByTestId('staff-who').textContent()));
const inv = staffs.inventory;
const adm = staffs.admin;

// =================================================================== 1. cash on delivery: the customer orders, staff move it to delivered, the customer sees every status
let cod = null;
await section('cod: ordered by the customer, delivered by staff', async () => {
  const stockBefore = await stockOf(cust.page, vCod);
  cod = await order(cust, vCod, 'cod');
  check('cod: the customer placed it and Odoo holds it as confirmed', /^S\d{5,}$/.test(cod.ref) && stateOf(cod.ref) === 'confirmed', `${cod.ref} ${stateOf(cod.ref)}`);
  check('cod: placing it took one unit of stock', (await stockOf(cust.page, vCod)) === stockBefore - 1);
  await go(inv.page, '/staff/orders'); // step 11: the list (search) is /staff/orders; /staff is the board
  await inv.page.getByLabel('Search').fill(cod.ref);
  await inv.page.getByRole('button', { name: 'Show orders' }).click();
  await inv.page.waitForFunction(() => document.querySelectorAll('[data-testid="staff-row"]').length === 1);
  const row = await inv.page.getByTestId('staff-row').textContent();
  check('cod: staff find it by its number: the customer, Cash on delivery, Confirmed, not paid yet', row.includes(cod.ref) && row.includes(cust.email) && /Cash on delivery/.test(row) && /Confirmed/.test(row) && /Not paid yet/.test(row), row);
  await openOrder(inv, cod);
  check('cod: the order shows the delivery details typed by the customer, with the phone', /12 Rizal Street/.test(await inv.page.getByTestId('staff-delivery').textContent()) && /0917 123 4567/.test(await inv.page.getByTestId('staff-customer').textContent()));
  // step 11: packed is no longer a step; the order goes shipped, out for delivery, delivered
  check('cod: staff are offered exactly "Mark as shipped" and "Cancel order"', (await inv.page.getByTestId('staff-actions').getByRole('button').allTextContents()).join('|') === 'Mark as shipped|Cancel order');
  const steps = [['shipped', 'Shipped'], ['out_for_delivery', 'On delivery'], ['delivered', 'Delivered']];
  for (const [to, word] of steps) {
    await click(inv, to, word);
    check(`cod: staff marked it ${to}; Odoo agrees`, stateOf(cod.ref) === to, stateOf(cod.ref));
    const seen = await customerSees(cust, cod, word);
    check(`cod: the customer's order page says "${word}" and promises no time, date or refund`, seen.ok, seen.box);
    await openOrder(inv, cod);
  }
  check('cod: shipping validated the delivery in Odoo, and delivering collected the cash', sql(`select string_agg(distinct sp.state, ',') from stock_picking sp join sale_order so on so.id=sp.sale_id where so.name='${cod.ref}'`) === 'done' && sql(`select pt.state from payment_transaction pt join sale_order_transaction_rel r on r.transaction_id=pt.id join sale_order so on so.id=r.sale_order_id where so.name='${cod.ref}'`) === 'done');
  check('cod: the stock stayed taken (the goods left)', (await stockOf(cust.page, vCod)) === stockBefore - 1);
  check('cod: the history on the screen has three lines, and Odoo has them as dashboard moves by the staff member', (await inv.page.getByTestId('staff-history-row').count()) === 3 && audit(cod.ref) === 'confirmed>shipped|dashboard|Staff Inventory (test);shipped>out_for_delivery|dashboard|Staff Inventory (test);out_for_delivery>delivered|dashboard|Staff Inventory (test)', audit(cod.ref));
  check('cod: a delivered order has nothing more to do', (await inv.page.getByTestId('staff-final').count()) === 1);
  await go(cust.page, '/account');
  await cust.page.getByTestId('orders-list').waitFor();
  check('cod: the customer\'s orders list shows it as Delivered', /Delivered/.test(await cust.page.getByTestId('order-row').filter({ hasText: cod.ref }).textContent()));
  const hand = await apiStatus(inv.page, `/api/staff/orders/${cod.id}/transition`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'cancelled', expectedState: 'delivered' }) });
  check('cod: a hand-made cancel of a delivered order is refused (409 invalid_transition) and nothing changes', hand.status === 409 && hand.body.error.code === 'invalid_transition' && stateOf(cod.ref) === 'delivered', JSON.stringify(hand));
});

// =================================================================== 2. two staff: a stale screen, and two at the very same moment
await section('conflict: two staff on one order', async () => {
  const stale = await order(cust, vRace, 'cod');
  await openOrder(inv, stale);
  await openOrder(adm, stale);
  check('conflict: both screens show the order as Confirmed', (await status(inv.page)) === 'Confirmed' && (await status(adm.page)) === 'Confirmed');
  await click(inv, 'shipped', 'Shipped'); // step 11: the first staff move is shipped
  await adm.page.getByTestId('staff-move-shipped').click();
  await adm.page.getByTestId('staff-problem').waitFor();
  const message = await adm.page.getByTestId('staff-problem').textContent();
  check('conflict: the second person is told nothing was done, by whom, and the screen catches up to Shipped', /This order is now shipped; it was changed by Staff Inventory \(test\)\. Nothing was done\./.test(message) && (await status(adm.page)) === 'Shipped', message);
  check('conflict: Odoo has ONE history line, not two', audit(stale.ref) === 'confirmed>shipped|dashboard|Staff Inventory (test)', audit(stale.ref));

  const sim = await order(cust, vRaceSim, 'cod');
  await openOrder(inv, sim);
  await openOrder(adm, sim);
  const calls = [];
  for (const s of [inv, adm]) s.page.on('response', (r) => r.url().includes('/transition') && calls.push(r.status()));
  await Promise.all([inv.page.getByTestId('staff-move-shipped').click(), adm.page.getByTestId('staff-move-shipped').click()]);
  await Promise.all([inv, adm].map((s) => s.page.waitForFunction(() => document.querySelector('[data-testid="staff-done"]') || document.querySelector('[data-testid="staff-problem"]'))));
  const outcomes = await Promise.all([inv, adm].map(async (s) => ((await s.page.getByTestId('staff-done').count()) ? 'done' : (await s.page.getByTestId('staff-problem').count()) ? 'conflict' : '?')));
  check('conflict: pressed at the same moment, exactly one is done and one is a conflict (one 200, one 409)', outcomes.slice().sort().join(',') === 'conflict,done' && calls.slice().sort().join(',') === '200,409', `${outcomes} ${calls}`);
  check('conflict: both screens now show Shipped, and Odoo has ONE history line', (await status(inv.page)) === 'Shipped' && (await status(adm.page)) === 'Shipped' && /^confirmed>shipped\|dashboard\|Staff (Inventory|Administrator) \(test\)$/.test(audit(sim.ref)), audit(sim.ref));
});

// =================================================================== 3. a paid bank-transfer order: Inventory Staff cannot cancel it, an Administrator can with a note
await section('paid: cancelling a paid bank-transfer order', async () => {
  const before = await stockOf(cust.page, vPaid);
  const bank = await order(cust, vPaid, 'bank_transfer');
  check('paid: an unpaid bank-transfer order is awaiting payment in Odoo and holds a unit of stock', stateOf(bank.ref) === 'awaiting_payment' && (await stockOf(cust.page, vPaid)) === before - 1);
  await openOrder(inv, bank);
  check('paid: staff see "Awaiting payment" and "Mark payment received"', (await status(inv.page)) === 'Awaiting payment' && (await inv.page.getByTestId('staff-move-confirmed').textContent()).trim() === 'Mark payment received');
  await click(inv, 'confirmed', 'Paid');
  check('paid: it reads "Paid", and Odoo has the transfer as received (a done transaction)', sql(`select pt.state from payment_transaction pt join sale_order_transaction_rel r on r.transaction_id=pt.id join sale_order so on so.id=r.sale_order_id where so.name='${bank.ref}'`) === 'done' && stateOf(bank.ref) === 'confirmed');
  const seenPaid = await customerSees(cust, bank, 'Confirmed');
  check('paid: the customer sees "Confirmed" and that the payment was received, not told to pay in cash', seenPaid.ok && /received your payment/.test(seenPaid.box) && !/pay in cash/i.test(seenPaid.box), seenPaid.box);
  await openOrder(inv, bank);
  check('paid: Inventory Staff have no cancel button, and are told why', (await inv.page.getByTestId('staff-move-cancelled').count()) === 0 && /Only an Administrator can cancel an order that has been paid\./.test(await inv.page.getByTestId('staff-blocked').textContent()));
  const hand = await apiStatus(inv.page, `/api/staff/orders/${bank.id}/transition`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'cancelled', expectedState: 'confirmed', note: 'trying it by hand' }) });
  check('paid: a hand-made cancel by Inventory Staff is refused by Odoo (403 forbidden) and nothing changes', hand.status === 403 && hand.body.error.code === 'forbidden' && stateOf(bank.ref) === 'confirmed' && audit(bank.ref) === 'awaiting_payment>confirmed|dashboard|Staff Inventory (test)', JSON.stringify(hand));
  await openOrder(adm, bank);
  check('paid: the Administrator has the cancel button', (await adm.page.getByTestId('staff-move-cancelled').count()) === 1 && (await adm.page.getByTestId('staff-blocked').count()) === 0);
  await adm.page.getByTestId('staff-move-cancelled').click();
  check('paid: the Administrator is asked first, and told a refund has to be arranged outside the system', /refund to arrange outside this system/.test(await adm.page.getByTestId('staff-confirm').textContent()));
  await adm.page.getByTestId('staff-confirm-yes').click();
  await adm.page.getByTestId('staff-note-error').waitFor();
  check('paid: with no note it is refused on the note field and nothing changes', /refund has to be arranged/.test(await adm.page.getByTestId('staff-note-error').textContent()) && stateOf(bank.ref) === 'confirmed');
  await adm.page.getByLabel(/Note/).fill('Customer asked to cancel; finance refunds by transfer, ticket 42');
  await adm.page.getByTestId('staff-confirm-yes').click();
  await adm.page.waitForFunction(() => document.querySelector('[data-testid="staff-order-status"]')?.textContent?.trim() === 'Cancelled');
  const last = sql(`select a.note||'|'||a.staff_name from clothcraft_order_audit a join sale_order o on o.id=a.order_id where o.name='${bank.ref}' order by a.id desc limit 1`);
  check('paid: it is cancelled; Odoo\'s history says REFUND DUE with the note and the Administrator\'s name', stateOf(bank.ref) === 'cancelled' && last === 'REFUND DUE. Customer asked to cancel; finance refunds by transfer, ticket 42|Staff Administrator (test)', last);
  check('paid: the screen shows the same note', /Note: REFUND DUE\. Customer asked to cancel/.test((await adm.page.getByTestId('staff-history-row').last().textContent()) ?? ''));
  check('paid: cancelling gave the unit of stock back', (await stockOf(cust.page, vPaid)) === before);
  const seenCancelled = await customerSees(cust, bank, 'Cancelled');
  check('paid: the customer sees "Cancelled" and no promise of a refund', seenCancelled.ok, seenCancelled.box);

  // and the other way round: unpaid, Inventory Staff may cancel, no note, no REFUND DUE
  const unpaidBefore = await stockOf(cust.page, vUnpaid);
  const unpaid = await order(cust, vUnpaid, 'bank_transfer');
  await openOrder(inv, unpaid);
  await inv.page.getByTestId('staff-move-cancelled').click();
  check('unpaid: cancelling an unpaid order asks first but needs no note', /gives the items back to stock/.test(await inv.page.getByTestId('staff-confirm').textContent()) && /optional/.test(await inv.page.getByLabel(/Note/).evaluate((e) => e.labels[0].textContent)));
  await inv.page.getByTestId('staff-confirm-yes').click();
  await inv.page.waitForFunction(() => document.querySelector('[data-testid="staff-order-status"]')?.textContent?.trim() === 'Cancelled');
  check('unpaid: Inventory Staff cancelled it, the history has no REFUND DUE, and the stock is back', stateOf(unpaid.ref) === 'cancelled' && !/REFUND/.test(sql(`select coalesce(string_agg(a.note, ';'), '') from clothcraft_order_audit a join sale_order o on o.id=a.order_id where o.name='${unpaid.ref}'`)) && (await stockOf(cust.page, vUnpaid)) === unpaidBefore);
});

// =================================================================== 4. the customer's cookie cannot open /staff, and the sessions are separate in both directions
await section('cookies: customer and staff are separate', async () => {
  await go(cust.page, '/staff');
  check('cookies: a signed-in CUSTOMER who opens /staff gets the staff sign-in form and no orders', (await cust.page.getByRole('heading', { name: 'Staff sign in' }).count()) === 1 && (await cust.page.getByTestId('staff-orders').count()) === 0);
  check('cookies: the real sign-in form has no demo accounts and no demo wording', (await cust.page.getByTestId('staff-demo-hint').count()) === 0 && !/demo/i.test(await cust.page.locator('main').innerText()));
  const asCustomer = await Promise.all(['/api/staff/auth/me', '/api/staff/orders', `/api/staff/orders/${cod.id}`].map((p) => apiStatus(cust.page, p)));
  check('cookies: with the customer session, every staff route is 401 unauthorised', asCustomer.every((r) => r.status === 401 && r.body.error.code === 'unauthorised'), JSON.stringify(asCustomer.map((r) => r.status)));
  const customerPost = await apiStatus(cust.page, `/api/staff/orders/${cod.id}/transition`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'cancelled', expectedState: 'delivered' }) });
  check('cookies: a customer cannot make a staff move either (401)', customerPost.status === 401);
  const asStaff = await Promise.all(['/api/orders', '/api/auth/me', `/api/orders/${cod.id}`].map((p) => apiStatus(inv.page, p)));
  check('cookies: with the STAFF session, the customer routes are 401 as well', asStaff.every((r) => r.status === 401), JSON.stringify(asStaff.map((r) => r.status)));
  // a copy of one kind of cookie under the other kind's name (the same value, as a thief might try): the signature is not valid for it
  const cookies = { customer: (await cust.ctx.cookies()).find((c) => /cc_session/.test(c.name)), staff: (await inv.ctx.cookies()).find((c) => /cc_staff/.test(c.name)) };
  check('cookies: each session is an httpOnly cookie of its own name', cookies.customer?.httpOnly === true && cookies.staff?.httpOnly === true && cookies.customer.name !== cookies.staff.name, `${cookies.customer?.name} ${cookies.staff?.name}`);
  const forged = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': ipOf() } });
  await forged.addCookies([
    { name: 'cc_staff', value: cookies.customer.value, url: base },
    { name: 'cc_session', value: cookies.staff.value, url: base },
  ]);
  const fp = await forged.newPage();
  await fp.goto(base + '/category', { waitUntil: 'networkidle' });
  const swapped = [await apiStatus(fp, '/api/staff/auth/me'), await apiStatus(fp, '/api/auth/me')];
  check('cookies: the customer cookie value as a staff cookie, and the staff cookie value as a customer cookie, are both turned away (401)', swapped.every((r) => r.status === 401), JSON.stringify(swapped.map((r) => r.status)));
  await forged.close();
  // a state-changing request from another site is refused before anything else
  const evil = await inv.ctx.request.post(`${base}/api/staff/orders/${cod.id}/transition`, { headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, data: { to: 'cancelled', expectedState: 'delivered' } });
  check('cookies: a staff move that says it came from another site is refused (403 forbidden_origin)', evil.status() === 403 && (await evil.json()).error.code === 'forbidden_origin');
  // signing out ends the staff session for real, also for a copy of the old cookie
  const old = await inv.ctx.cookies();
  await inv.page.getByRole('button', { name: 'Sign out' }).click();
  await inv.page.getByRole('heading', { name: 'Staff sign in' }).waitFor();
  const ghost = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': ipOf() } });
  await ghost.addCookies(old.filter((c) => /cc_staff/.test(c.name)).map((c) => ({ name: c.name, value: c.value, url: base })));
  const gp = await ghost.newPage();
  await gp.goto(base + '/category', { waitUntil: 'networkidle' });
  const after = await apiStatus(gp, '/api/staff/auth/me');
  check('cookies: after signing out, a copy of the old staff cookie is dead (401)', after.status === 401, String(after.status));
  await ghost.close();
});

// =================================================================== 5. the audit table, on the throwaway database
await section('audit: the table', async () => {
  const rows = Number(sql('select count(*) from clothcraft_order_audit'));
  check('audit: the journeys above left exactly their history lines in Odoo (3 + 1 + 1 + 2 + 1)', rows === 8, String(rows));
  const update = refusal("update clothcraft_order_audit set note='changed' where id=(select min(id) from clothcraft_order_audit)");
  const del = refusal('delete from clothcraft_order_audit where id=(select min(id) from clothcraft_order_audit)');
  check('audit: the database refuses to UPDATE or DELETE a history line of an order that exists', /cannot be changed/.test(update ?? '') && /cannot be deleted/.test(del ?? ''), `${update?.slice(0, 80)} | ${del?.slice(0, 80)}`);
  check('audit: ...and the rows are all still there', Number(sql('select count(*) from clothcraft_order_audit')) === rows);
  // README fact, shown here and nowhere else: the trigger is row-level and does not fire for TRUNCATE
  const truncated = refusal('truncate clothcraft_order_audit');
  check('audit: TRUNCATE is NOT refused (the trigger does not cover it; backend/README.md says so)', truncated === null && Number(sql('select count(*) from clothcraft_order_audit')) === 0, String(truncated));
});

for (const c of [cust, ...Object.values(staffs)]) await c.ctx.close();
await browser.close();
rep.finish();
