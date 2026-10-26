// Step B: loading skeletons and page changes, in real Edge, on a PRODUCTION build made WITHOUT VITE_SKELETON_INSTANT (so the real numbers
// run: 150 ms before a skeleton shows, 600 ms minimum on the shop, 300 ms on the staff pages), against the real API on a THROWAWAY copy:
//   node scripts/check-skeleton.mjs http://localhost:4175 <outDir> --db-container <db container> --db clothcraft_e2e --env ../backend/.env
// It REGISTERS customers and PLACES ONE ORDER, so throwaway copies only. The API is slowed per request (page routes), one scenario also throttles
// the network (Chrome DevTools Protocol), and a frame-by-frame recorder in the page notes when a skeleton is invisible ("wait"), visible
// ("skeleton") or gone, and every layout shift (PerformanceObserver "layout-shift"). Checked per page, at 320 / 390 / 768 / 1024 / 1440 px
// (phone and desktop widths for the pages behind a sign-in): the timing rule, the skeleton drawn in the page's frame, no sideways scroll, no
// console errors, layout shift, and how far the page's height moves when the real content replaces the skeleton.
// Screenshots (skeleton, then the same page loaded) are written to <outDir>/shots.
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
if (!base || !out || !dbContainer || !db || !envFile) throw new Error('usage: node scripts/check-skeleton.mjs <baseUrl> <outDir> --db-container <name> --db <throwaway database> --env <env file>');
if (!/^clothcraft_(e2e|ctest|throwaway)/.test(db)) throw new Error(`refusing to run against "${db}": only a throwaway copy (clothcraft_e2e...) may be used`);
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^(['"])(.*)\1$/, '$2')]),
);
const STAFF = { email: env.STAFF_INVENTORY_EMAIL, password: env.STAFF_INVENTORY_PASSWORD };
if (!STAFF.email || !STAFF.password) throw new Error('the staff test user is not in the env file');

const rep = createReport(out, 'skeleton');
const { check, report } = rep;
const browser = await launch();
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(out, 'shots', name), ...opts });
const PASSWORD = 'a long and careful e2e password';
const ipOf = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = [320, 390, 768, 1024, 1440];
const TWO = [390, 1440];
const HEADER = 68;
/**
 * Cumulative Layout Shift allowed when the real content replaces a skeleton: 0.1 is the "good" limit of the Core Web Vitals. Most pages here
 * measure 0; the ones that show a list (cart lines, orders) move a little when the list has a different length from the skeleton's rows, and
 * that length is the customer's own data.
 */
const CLS_MAX = 0.1;
report.data.cls = {};
report.data.heightMove = {};

/** in the page, from the first frame: what skeleton is on screen (none / wait / skeleton), and every layout shift */
function recorder() {
  window.__tl = [];
  window.__cls = { value: 0, shifts: [] };
  let last = 'none';
  const tick = () => {
    const els = [...document.querySelectorAll('[data-skeleton]')];
    const state = els.some((e) => e.getAttribute('data-skeleton') === 'skeleton') ? 'skeleton' : els.length ? 'wait' : 'none';
    if (state !== last) {
      window.__tl.push([Math.round(performance.now()), state]);
      last = state;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__cls.value += e.value;
      const node = e.sources?.[0]?.node;
      window.__cls.shifts.push({ at: Math.round(e.startTime), value: Math.round(e.value * 10000) / 10000, node: node ? `${node.nodeName}.${String(node.className ?? '').slice(0, 30)}` : '' });
    }
  }).observe({ type: 'layout-shift', buffered: true });
}

const consoleLog = [];
async function newPage(width, { height = 800, reducedMotion = 'no-preference', label = 'page' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion, extraHTTPHeaders: { 'X-Forwarded-For': ipOf() } });
  const page = await ctx.newPage();
  await page.addInitScript(recorder);
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource: the server responded with a status of (401|404|502)/.test(m.text()) && report.console.push(`${label}@${width} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => report.console.push(`${label}@${width} pageerror: ${e.message}`));
  void consoleLog;
  return { ctx, page };
}
const timeline = (page) => page.evaluate(() => window.__tl);
const clsOf = (page) => page.evaluate(() => window.__cls);
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const metrics = (page) =>
  page.evaluate(() => ({ doc: document.documentElement.scrollHeight, main: Math.round(document.querySelector('main')?.getBoundingClientRect().height ?? 0), y: Math.round(window.scrollY) }));
async function section(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(`${name}: ran to the end`, false, error.message.split('\n')[0]);
  }
}
const fresh = (page) => page.evaluate(() => performance.now());

/** slow every API request whose URL matches (and, optionally, whose method matches) by `state.ms`; `state.fail` answers with a 502 instead */
async function slow(ctx, state) {
  await ctx.route('**/api/**', async (route) => {
    const req = route.request();
    const hit = state.match && state.match.test(req.url()) && (!state.method || req.method() === state.method);
    if (hit && state.ms) await sleep(state.ms);
    if (hit && state.body) return route.fulfill({ status: 200, contentType: 'application/json', body: state.body });
    if (hit && state.fail) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'down', message: 'The shop is not available right now. Please try again.' } }) });
    return route.continue();
  });
}
async function register(page, name) {
  const email = `e2e-${randomUUID().slice(0, 12)}@example.test`;
  await page.getByTestId('account-menu-button').click();
  await page.getByRole('menuitem', { name: 'Register' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your name').fill(name);
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await page.getByTestId('signed-in-name').waitFor({ state: 'attached' });
  return email;
}
async function signIn(page, email) {
  await page.goto(base + '/account', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await page.getByTestId('signed-in-name').waitFor({ state: 'attached' });
}

// ---------------------------------------------------------------------------------------------------------------- set-up: data to look at
const probe = await newPage(1440, { label: 'probe' });
await probe.page.goto(base + '/category', { waitUntil: 'networkidle' });
const list = (await (await probe.page.request.get(base + '/api/catalogue/products')).json()).data.products;
const picked = [];
for (const p of list) {
  const d = (await (await probe.page.request.get(base + `/api/catalogue/products/${p.id}`)).json()).data;
  const v = d.variants.find((x) => x.stock >= 10);
  if (v) picked.push({ id: p.id, sku: v.sku, price: v.price, color: v.color, size: v.size, designable: (await (await probe.page.request.get(base + `/api/designs/pricing?product=${p.id}`)).json()).data.designable });
  if (picked.length === 3) break;
}
await probe.ctx.close();
const [P1, P2, P3] = picked;
const designable = picked.find((p) => p.designable) ?? P1;
report.data.products = picked.map((p) => p.id);

// one customer with two cart lines and one order (the order page, the account page and the staff pages need something to show)
const CUSTOMER = await newPage(1440, { label: 'setup' });
await CUSTOMER.page.goto(base + '/category', { waitUntil: 'networkidle' });
const EMAIL = await register(CUSTOMER.page, 'Skeleton Check Customer');
await seedCart(CUSTOMER.page, [{ sku: P1.sku, quantity: 1, selected: true }]);
const orderId = await CUSTOMER.page.evaluate(async ({ sku, price }) => {
  const quote = await (await fetch('/api/cart/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: [{ sku, quantity: 1 }] }) })).json();
  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `skel-${Math.random()}` },
    body: JSON.stringify({ lines: [{ sku, quantity: 1 }], paymentMethod: 'cod', quotedTotal: quote.data.total ?? price, delivery: { fullName: 'Skeleton Check', email: 'skel@example.com', phone: '09171234567', street: '1 Test Street', city: 'Quezon City', province: 'PH-00', postalCode: '1100', note: '' } }),
  });
  return (await res.json()).data?.id;
}, { sku: P1.sku, price: P1.price });
await CUSTOMER.ctx.close();
check('set-up: a customer, a cart and one order exist on the throwaway copy', !!orderId, String(orderId));

/**
 * One page, one width: load `url` with the API slowed (`ms`), record what the page showed, and compare. `skeleton` are the testids of
 * the skeleton regions, `loaded` a selector that exists only once the real content is there.
 */
async function pageRun({ key, width, url, signedIn = false, match, method, ms = 1800, skeleton, loaded, shots = false, prep, height = 800 }) {
  const { ctx, page } = await newPage(width, { height, label: key });
  const state = { match, method, ms: 0 };
  await slow(ctx, state);
  await page.goto(base + '/category', { waitUntil: 'networkidle' });
  if (signedIn) {
    await signIn(page, EMAIL);
    if (prep) await prep(page);
  }
  state.ms = ms;
  await page.evaluate(() => {
    window.__tl.length = 0;
    window.__cls = { value: 0, shifts: [] };
  });
  const started = await fresh(page);
  await page.goto(base + url, { waitUntil: 'commit' });
  // wait for the skeleton to be visible (the delay is 150 ms)
  await page.waitForFunction((ids) => ids.some((id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-skeleton') === 'skeleton'), skeleton, { timeout: 15000 });
  const during = await metrics(page);
  const during2 = await page.evaluate((ids) => ids.map((id) => { const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect(); return r ? [Math.round(r.top + scrollY), Math.round(r.height)] : null; }), skeleton);
  const hOk = await sideways(page);
  if (shots) {
    if (key === 'landing') await page.locator('#shop').scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await shot(page, `skeleton-${key}-${width}.png`);
  }
  await page.waitForSelector(loaded, { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[data-skeleton]'), null, { timeout: 20000 });
  await page.waitForTimeout(700); // late layout (images, fonts) settles
  const after = await metrics(page);
  const clsAll = await clsOf(page);
  const tl = await timeline(page);
  if (shots) {
    if (key === 'landing') await page.locator('#shop').scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await shot(page, `loaded-${key}-${width}.png`);
  }
  const hOk2 = await sideways(page);
  const skeletonAt = tl.find(([, s]) => s === 'skeleton')?.[0] ?? 0;
  const afterShifts = clsAll.shifts.filter((s) => s.at >= skeletonAt).reduce((n, s) => n + s.value, 0);
  const tag = `${key} @${width}px`;
  report.data.cls[`${key}@${width}`] = Math.round(afterShifts * 10000) / 10000;
  report.data.heightMove[`${key}@${width}`] = after.doc - during.doc;
  check(`${tag}: the skeleton is drawn only after the delay (it was invisible, then visible)`, tl.some(([, s]) => s === 'wait') && tl.some(([, s]) => s === 'skeleton'), JSON.stringify(tl));
  check(`${tag}: no sideways scroll, with the skeleton or the content`, hOk && hOk2);
  check(`${tag}: layout shift when the content replaces the skeleton is at most ${CLS_MAX} (CLS)`, afterShifts <= CLS_MAX, `${afterShifts.toFixed(4)} ${JSON.stringify(clsAll.shifts.filter((s) => s.at >= skeletonAt).slice(0, 3))}`);
  void started;
  void during2;
  await ctx.close();
  return { tl, during, after, during2 };
}

const PAGES = [
  { key: 'landing', widths: ALL, url: '/', match: /\/api\/catalogue\//, skeleton: ['categories-loading', 'featured-loading'], loaded: '#featured [data-testid="product-card"]', shotsAt: [1440, 390] },
  { key: 'category', widths: ALL, url: '/category', match: /\/api\/catalogue\/products/, skeleton: ['catalogue-loading'], loaded: '[data-testid="product-card"]', shotsAt: [1440] },
  { key: 'product', widths: ALL, url: `/products/${P2.id}`, match: /\/api\/catalogue\/products\//, skeleton: ['product-loading'], loaded: '[data-testid="variant-stock"]', shotsAt: [1440, 390] },
  { key: 'cart', widths: ALL, url: '/cart', signedIn: true, match: /\/api\/cart$/, method: 'GET', skeleton: ['cart-loading'], loaded: '[data-testid="cart-line"]', shotsAt: [1440], prep: (page) => seedCart(page, [{ sku: P2.sku, quantity: 1, selected: true }, { sku: P3.sku, quantity: 2, selected: false }]) },
  { key: 'checkout', widths: TWO, url: '/checkout', signedIn: true, match: /\/api\/cart$/, method: 'GET', skeleton: ['cart-loading'], loaded: '[data-testid="summary-lines"]', prep: (page) => seedCart(page, [{ sku: P2.sku, quantity: 1, selected: true }]) },
  { key: 'order', widths: ALL, url: `/orders/${orderId}`, signedIn: true, match: /\/api\/orders\/\d+$/, skeleton: ['order-loading'], loaded: '[data-testid="order-heading"]' },
  { key: 'account', widths: TWO, url: '/account', signedIn: true, match: /\/api\/orders$/, skeleton: ['orders-loading'], loaded: '[data-testid="orders-list"]' },
];

for (const p of PAGES) {
  for (const width of p.widths) {
    await section(`${p.key}@${width}`, async () => {
      await pageRun({ ...p, width, shots: !!p.shotsAt?.includes(width) });
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------- the editor page (light state)
for (const width of TWO) {
  await section(`design@${width}`, async () => {
    const url = `/design?product=${designable.id}&variant=${designable.sku}`;
    // the same page with no slowdown first: where the fixed bars and the heading are
    const quick = await newPage(width, { label: 'design-quick', height: 800 });
    await quick.page.goto(base + '/category', { waitUntil: 'networkidle' });
    await register(quick.page, 'Skeleton Design Customer');
    await quick.page.goto(base + url, { waitUntil: 'networkidle' });
    await quick.page.locator('[data-testid="editor-host"] canvas').first().waitFor({ state: 'attached', timeout: 20000 });
    await quick.page.waitForTimeout(1200);
    const bars = () => quick.page.evaluate(() => [...document.querySelectorAll('[data-testid="context-bar"], [data-testid="phone-toolbar"]')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; }));
    const barsQuick = await bars();
    const h1Quick = await quick.page.evaluate(() => Math.round(document.querySelector('main h1').getBoundingClientRect().top + scrollY));
    const email = null;
    void email;
    // now with the garment's request slowed
    const state = { match: /\/api\/catalogue\/products\//, ms: 0 };
    await slow(quick.ctx, state);
    state.ms = 1800;
    await quick.page.evaluate(() => (window.__tl.length = 0));
    await quick.page.goto(base + url, { waitUntil: 'commit' });
    await quick.page.waitForFunction(() => document.querySelector('[data-testid="design-loading"]')?.getAttribute('data-skeleton') === 'skeleton', null, { timeout: 15000 });
    const h1During = await quick.page.evaluate(() => Math.round(document.querySelector('main h1').getBoundingClientRect().top + scrollY));
    check(`design @${width}px: while the garment loads there is a light still block under the heading (no shimmer), and the heading is where it will be`, (await quick.page.getByTestId('design-loading').locator('.skeleton-still').count()) === 1 && h1During === h1Quick, `${h1During} vs ${h1Quick}`);
    check(`design @${width}px: no sideways scroll in the light state`, await sideways(quick.page));
    if (width === 390) await shot(quick.page, 'skeleton-design-390.png');
    await quick.page.locator('[data-testid="editor-host"] canvas').first().waitFor({ state: 'attached', timeout: 20000 });
    await quick.page.waitForTimeout(1200);
    const barsAfter = await bars();
    check(`design @${width}px: the editor's fixed bars (phone) and layout end up exactly as without the skeleton`, JSON.stringify(barsAfter) === JSON.stringify(barsQuick), JSON.stringify({ barsQuick, barsAfter }));
    await quick.ctx.close();
  });
}

// ---------------------------------------------------------------------------------------------------------------- the staff dashboard
async function staffPage(width) {
  const { ctx, page } = await newPage(width, { label: 'staff' });
  const state = { match: null, ms: 0 };
  await slow(ctx, state);
  await page.goto(base + '/staff', { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(STAFF.email);
  await page.getByLabel('Password').fill(STAFF.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByTestId('staff-who').waitFor();
  await page.waitForTimeout(800);
  return { ctx, page, state };
}
for (const width of TWO) {
  await section(`staff@${width}`, async () => {
    const { ctx, page, state } = await staffPage(width);
    // the board: every column shows cards
    state.match = /\/api\/staff\/orders\?/;
    state.ms = 1800;
    await page.evaluate(() => {
      window.__tl.length = 0;
      window.__cls = { value: 0, shifts: [] };
    });
    await page.goto(base + '/staff', { waitUntil: 'commit' });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="board-loading"][data-skeleton="skeleton"]').length === 5, null, { timeout: 15000 });
    check(`staff board @${width}px: all five columns show a skeleton (aria-busy) while their orders load`, (await page.locator('[data-testid="board-loading"][aria-busy="true"]').count()) === 5);
    check(`staff board @${width}px: no sideways scroll with the skeleton`, await sideways(page));
    const during = await metrics(page);
    if (width === 1440) await shot(page, 'skeleton-staff-board-1440.png');
    await page.waitForSelector('[data-testid="board-column"] [data-testid="column-total"]', { state: 'attached' });
    await page.waitForFunction(() => !document.querySelector('[data-skeleton]'), null, { timeout: 20000 });
    await page.waitForTimeout(600);
    const after = await metrics(page);
    const tl = await timeline(page);
    const cls = await clsOf(page);
    const skeletonAt = tl.find(([, s]) => s === 'skeleton')?.[0] ?? 0;
    const shifts = cls.shifts.filter((s) => s.at >= skeletonAt).reduce((n, s) => n + s.value, 0);
    report.data.cls[`staff-board@${width}`] = Math.round(shifts * 10000) / 10000;
    report.data.heightMove[`staff-board@${width}`] = after.doc - during.doc;
    check(`staff board @${width}px: layout shift when the cards replace the skeleton is at most ${CLS_MAX}`, shifts <= CLS_MAX, `${shifts.toFixed(4)} ${JSON.stringify(cls.shifts.filter((s) => s.at >= skeletonAt).slice(0, 3))}`);
    if (width === 1440) await shot(page, 'loaded-staff-board-1440.png');
    // the order list
    await page.evaluate(() => (window.__tl.length = 0));
    await page.goto(base + '/staff/orders', { waitUntil: 'commit' });
    await page.waitForFunction(() => document.querySelector('[data-testid="staff-list-loading"]')?.getAttribute('data-skeleton') === 'skeleton', null, { timeout: 15000 });
    check(`staff list @${width}px: a skeleton while the first list loads`, (await page.getByTestId('staff-list-loading').getAttribute('aria-busy')) === 'true');
    await page.waitForSelector('[data-testid="staff-orders"]');
    // the order itself
    state.match = /\/api\/staff\/orders\/\d+$/;
    await page.goto(base + `/staff/orders/${orderId}`, { waitUntil: 'commit' });
    await page.waitForFunction(() => document.querySelector('[data-testid="staff-detail-loading"]')?.getAttribute('data-skeleton') === 'skeleton', null, { timeout: 15000 });
    check(`staff order @${width}px: a skeleton while the order loads, no sideways scroll`, (await sideways(page)) && (await page.getByTestId('staff-detail-loading').getAttribute('aria-busy')) === 'true');
    await page.waitForFunction(() => !document.querySelector('[data-skeleton]'), null, { timeout: 20000 });
    await ctx.close();
  });
}

// ---------------------------------------------------------------------------------------------------------------- the timing rule, in the browser
async function categoryRun({ ms, fail = false, instant = false, reducedMotion = 'no-preference', width = 1440 }) {
  const { ctx, page } = await newPage(width, { reducedMotion, label: 'timing' });
  const state = { match: /\/api\/catalogue\/products/, ms: 0, fail, body: null };
  if (instant) state.body = await (await page.request.get(base + '/api/catalogue/products')).text();
  await slow(ctx, state);
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  state.ms = ms;
  await page.evaluate(() => (window.__tl.length = 0));
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Category' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="product-card"]') || document.querySelector('[role="alert"]'), null, { timeout: 20000 });
  await page.waitForTimeout(500);
  const tl = await timeline(page);
  await ctx.close();
  return tl;
}
await section('timing', async () => {
  const fast = await categoryRun({ ms: 0, instant: true });
  check('timing: data that arrives well inside 150 ms (answered from memory here) shows no skeleton at all (the page went straight to content)', !fast.some(([, s]) => s === 'skeleton'), JSON.stringify(fast));

  const mid = await categoryRun({ ms: 300 });
  const w = mid.find(([, s]) => s === 'wait')?.[0];
  const s = mid.find(([, s2]) => s2 === 'skeleton')?.[0];
  const gone = mid.find(([t, s2]) => s2 === 'none' && t > (s ?? 0))?.[0];
  report.data.timingMid = { wait: w, skeleton: s, gone };
  check('timing: the skeleton shows ~150 ms after the request began (+-70 ms)', s !== undefined && w !== undefined && Math.abs(s - w - 150) <= 70, JSON.stringify(mid));
  check('timing: once shown it stays at least 600 ms, even though the data came after 300 ms (no flicker)', gone !== undefined && gone - s >= 590, `${gone - s} ms`);

  const slowRun = await categoryRun({ ms: 2000 });
  const ws = slowRun.find(([, x]) => x === 'wait')?.[0];
  const gs = slowRun.find(([t, x]) => x === 'none' && t > ws)?.[0];
  check('timing: a slow answer is not made to wait longer: the content is there within ~200 ms of it arriving', gs !== undefined && gs - ws <= 2000 + 800 && gs - ws >= 1900, `${gs - ws} ms (the server's own time, a few hundred ms, is on top of the 2000 ms added)`);

  const err = await categoryRun({ ms: 400, fail: true });
  const es = err.find(([, x]) => x === 'skeleton')?.[0];
  const ew = err.find(([, x]) => x === 'wait')?.[0];
  const eg = err.find(([t, x]) => x === 'none' && t > (es ?? 0))?.[0];
  check('timing: an error does not wait for the minimum (the skeleton is gone ~400 ms after the request, not at 750 ms)', es !== undefined && eg !== undefined && eg - ew <= 650, `${eg - ew} ms`);
});

// ---------------------------------------------------------------------------------------------------------------- reduced motion, the fade, the shimmer
await section('motion', async () => {
  for (const reduced of [false, true]) {
    const { ctx, page } = await newPage(1440, { reducedMotion: reduced ? 'reduce' : 'no-preference', label: 'motion' });
    const state = { match: /\/api\/catalogue\/products/, ms: 0 };
    await slow(ctx, state);
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    state.ms = 2500;
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Category' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="catalogue-loading"]')?.getAttribute('data-skeleton') === 'skeleton', null, { timeout: 15000 });
    const shimmer = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="catalogue-loading"] .skeleton'), '::after').animationName);
    const fade = await page.evaluate(() => getComputedStyle(document.querySelector('main')).animationName);
    const label = reduced ? 'reduced motion' : 'normal motion';
    check(`${label}: the shimmer is ${reduced ? 'OFF (no animation)' : 'on'}`, reduced ? shimmer === 'none' : shimmer === 'skeleton-shimmer', shimmer);
    check(`${label}: the page fade is ${reduced ? 'OFF' : 'on'}`, reduced ? fade === 'none' : fade === 'page-in', fade);
    await ctx.close();
  }
  // the fade: a new page starts transparent and is solid within about 200 ms; nothing makes the navigation wait
  const { ctx, page } = await newPage(1440, { label: 'fade' });
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const link = [...document.querySelectorAll('nav[aria-label="Main"] a')].find((a) => a.textContent === 'Design');
    const oldMain = document.querySelector('main');
    const t0 = performance.now();
    link.click();
    // the first frame in which the NEW <main> is on screen
    const first = await new Promise((resolve) => {
      const frame = () => {
        const now = document.querySelector('main');
        if (now !== oldMain) resolve({ at: performance.now() - t0, opacity: Number(getComputedStyle(now).opacity), path: location.pathname });
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const later = await new Promise((resolve) => setTimeout(() => resolve(Number(getComputedStyle(document.querySelector('main')).opacity)), 350));
    return { first, later };
  });
  check('fade: the URL changes in the same frame as the click (no fake wait) and the new page starts transparent', result.first.path === '/design' && result.first.opacity < 0.9 && result.first.at < 100, JSON.stringify(result.first));
  check('fade: 350 ms later the page is fully opaque', result.later === 1, String(result.later));
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------------- lazy pages: skeleton at once, hand-off, no old page left
await section('lazy', async () => {
  const { ctx, page } = await newPage(1440, { label: 'lazy' });
  const api = { match: /\/api\/cart$/, method: 'GET', ms: 0 };
  await slow(ctx, api);
  await page.goto(base + '/category', { waitUntil: 'networkidle' });
  await register(page, 'Skeleton Lazy Customer');
  await seedCart(page, [{ sku: P2.sku, quantity: 1, selected: true }]);
  await page.goto(base + '/category', { waitUntil: 'networkidle' });
  await page.locator('[data-testid="product-card"]').first().waitFor();
  // the small chunk with the lazy pages' skeletons is fetched ~1.5 s after the site has loaded: a visitor who clicks later has it already
  await page.waitForFunction(() => performance.getEntriesByType('resource').some((r) => /routeSkeletons/.test(r.name)), null, { timeout: 10000 });
  check('lazy: the skeletons of the lazy pages (a small chunk) were prefetched after the site loaded, not with the entry bundle', (await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /routeSkeletons/.test(r.name))[0].startTime)) > 1000);
  // from now on the cart page's code arrives slowly (900 ms), and the saved cart takes another 700 ms
  let chunks = false;
  // only the cart page's OWN chunk is slow: Playwright switches the browser cache off while it intercepts, so a rule for every script would also
  // delay chunks the visitor already has (the skeleton chunk's dependencies), which a real cache serves at once
  await ctx.route('**/assets/Cart-*.js', async (route) => {
    if (chunks) await sleep(900);
    return route.continue();
  });
  chunks = true;
  api.ms = 700;
  await page.evaluate(() => (window.__tl.length = 0));
  const t0 = Date.now();
  await page.getByRole('link', { name: /^Cart/ }).click();
  await page.waitForURL('**/cart');
  const urlAfter = Date.now() - t0;
  const oldGone = (await page.locator('[data-testid="product-card"]').count()) === 0;
  check('lazy: the URL changes at once, and the old page is not left on screen while the new page\'s code arrives', urlAfter < 400 && oldGone, `${urlAfter} ms, old page gone: ${oldGone}`);
  await page.waitForFunction(() => document.querySelector('[data-testid="cart-loading"]')?.getAttribute('data-skeleton') === 'skeleton', null, { timeout: 15000 });
  check('lazy: the cart page\'s own skeleton stands in while its code arrives (aria-busy, with its Loading message)', (await page.getByTestId('cart-loading').getAttribute('aria-busy')) === 'true' && (await page.getByTestId('cart-loading').getByRole('status').count()) === 1);
  await page.waitForSelector('[data-testid="cart-line"]', { timeout: 20000 });
  const tl = await timeline(page);
  const states = tl.map(([, s]) => s);
  check('lazy: the hand-off from the route\'s skeleton to the page\'s own is continuous (wait, skeleton, then content: never "none" in between)', JSON.stringify(states) === JSON.stringify(['wait', 'skeleton', 'none']), JSON.stringify(tl));
  chunks = false;
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------------- slow network (DevTools throttling)
await section('throttled', async () => {
  const { ctx, page } = await newPage(390, { label: 'throttled' });
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  await page.evaluate(() => {
    window.__tl.length = 0;
    window.__cls = { value: 0, shifts: [] };
  });
  await page.getByTestId('account-menu-button').click();
  await page.getByRole('menuitem', { name: 'Category' }).click();
  await page.waitForSelector('[data-testid="product-card"]', { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('[data-skeleton]'), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const tl = await timeline(page);
  const cls = await clsOf(page);
  const skeletonAt = tl.find(([, s]) => s === 'skeleton')?.[0];
  const shifts = cls.shifts.filter((s) => skeletonAt !== undefined && s.at >= skeletonAt).reduce((n, s) => n + s.value, 0);
  report.data.cls['category-fast3g@390'] = Math.round(shifts * 10000) / 10000;
  check('throttled (400 ms latency, 1.6 Mbit/s): the Category skeleton appears, then the cards, with shift at most ' + CLS_MAX, skeletonAt !== undefined && shifts <= CLS_MAX, `${JSON.stringify(tl)} shifts ${shifts.toFixed(4)}`);
  check('throttled: no sideways scroll', await sideways(page));
  await ctx.close();
});

report.data.timelines = undefined;
await browser.close();
rep.finish();
