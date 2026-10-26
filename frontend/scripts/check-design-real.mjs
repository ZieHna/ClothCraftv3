// Step 9f: customized garments against the REAL API service and Odoo, in real Edge, through the Vite proxy (the same stack as check-shop-real).
// It REGISTERS REAL CUSTOMERS, UPLOADS DESIGNS and PLACES A REAL ORDER, so point it at a THROWAWAY COPY only. Setup: see check-shop-real.mjs,
// then
//   node scripts/check-design-real.mjs http://localhost:4175 <outDir> --db-container <db container> --db clothcraft_e2e --env ../backend/.env
// The staff test user's email and password are read from --env (STAFF_INVENTORY_*), typed into the sign-in form and never printed.
// What it proves: the Design page's estimate equals the shop's figure for 0, 1 and 3 elements at sizes S, M and L; the cart shows the
// server's fee (per piece and for quantity 2) and the note when the stored estimate is tampered with, while the total stays the server's;
// "Edit design" replaces the line's design and removes the old one; the order keeps a fee line per design in Odoo; staff see the preview and
// download the print file named after the order line; another customer, no one, and a staff cookie cannot open a customer's design.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { cartCopyKey, createReport, launch, savedCart } from './lib/e2e-common.mjs';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const [base, out] = args;
const dbContainer = flag('--db-container');
const db = flag('--db');
const envFile = flag('--env');
if (!base || !out || !dbContainer || !db || !envFile) throw new Error('usage: node scripts/check-design-real.mjs <baseUrl> <outDir> --db-container <name> --db <throwaway database> --env <backend/.env>');
if (!/^clothcraft_(e2e|ctest|throwaway)/.test(db)) throw new Error(`refusing to run against "${db}": only a throwaway copy (clothcraft_e2e...) may be used`);
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^(['"])(.*)\1$/, '$2')]),
);
const STAFF = { email: env.STAFF_INVENTORY_EMAIL, password: env.STAFF_INVENTORY_PASSWORD };
if (!STAFF.email || !STAFF.password) throw new Error('the staff test user is not in the env file (scripts/create_staff_users.py writes it)');

const rep = createReport(out, 'design-real');
const { check, report } = rep;
const browser = await launch();
const shot = (page, name) => page.screenshot({ path: path.join(out, 'shots', name) });
const PASSWORD = 'a long and careful e2e password';
const ipOf = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const sql = (q) => execFileSync('docker', ['exec', dbContainer, 'sh', '-c', `psql -U "$POSTGRES_USER" -d ${db} -At -c "${q}"`], { encoding: 'utf8' }).trim();
// Chrome logs every 4xx answer as a console error; the isolation cases provoke 401 and 404 on purpose
const expected4xx = /Failed to load resource: the server responded with a status of (401|404)/;
const watch = (page, label) => {
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !expected4xx.test(m.text()) && report.console.push(`${label} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => report.console.push(`${label} pageerror: ${e.message}`));
};
const go = async (page, url) => {
  await page.goto(base + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
};
const apiGet = (page, p) => page.evaluate(async (u) => (await fetch(u)).json(), p);
const status = (page, p) => page.evaluate(async (u) => (await fetch(u)).status, p);
const money = (text) => Number(String(text).replace(/[^\d.]/g, ''));
async function section(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(`${name}: ran to the end`, false, error.message.split('\n')[0]);
  }
}

async function customer(label, viewport = { width: 1366, height: 800 }) {
  const ctx = await browser.newContext({ viewport, extraHTTPHeaders: { 'X-Forwarded-For': ipOf() }, acceptDownloads: true });
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(base + '/category', { waitUntil: 'networkidle' });
  await page.getByTestId('account-menu-button').click();
  await page.getByRole('menuitem', { name: 'Register' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your name').fill('Design Check Customer');
  await dialog.getByLabel('Email').fill(`e2e-${randomUUID().slice(0, 12)}@example.test`);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await page.getByTestId('signed-in-name').waitFor({ state: 'attached' });
  return { ctx, page };
}
/** step 12: the cart is kept on the account; this device's copy (cc.cart.v2:<id>) also holds the editor's estimates */
const cartKey = (page) => cartCopyKey(page);
/** the page's copy, once it is saved and the account's cart agrees with it */
const storedCart = (page) => savedCart(page);
const quoteOf = (page, lines) => page.evaluate(async (l) => (await (await fetch('/api/cart/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: l }) })).json()).data, lines);

// ---- a garment with sizes S, M and L in one colour, enough of each in stock, and a print box
const probe = await customer('probe');
let chosen = null;
for (const p of (await apiGet(probe.page, '/api/catalogue/products')).data.products) {
  const detail = (await apiGet(probe.page, `/api/catalogue/products/${p.id}`)).data;
  for (const color of detail.colors) {
    const bySize = Object.fromEntries(detail.variants.filter((v) => v.color === color && v.stock >= 4 && v.stock <= 60).map((v) => [v.size, v]));
    if (bySize.S && bySize.M && bySize.L && (await apiGet(probe.page, `/api/designs/pricing?product=${p.id}`)).data.designable) {
      chosen = { productId: p.id, name: p.name, color, bySize };
      break;
    }
  }
  if (chosen) break;
}
await probe.ctx.close();
check('the throwaway database has a customizable garment with S, M and L in stock', !!chosen);
if (!chosen) rep.finish();
report.data.garment = { productId: chosen.productId, color: chosen.color, skus: Object.fromEntries(Object.entries(chosen.bySize).map(([s, v]) => [s, v.sku])) };
const designUrl = `/design?product=${chosen.productId}&variant=${chosen.bySize.M.sku}`;

const A = await customer('A');
const page = A.page;
const add = () => page.getByRole('button', { name: 'Add this customization to cart' });
const estimateText = async () => (await page.getByTestId('design-estimate').textContent()).trim();
const shownFee = async () => {
  const m = /\(print (₱[\d,.]+), ([\d.]+) sq in\)/.exec(await estimateText());
  return m ? { fee: money(m[1]), area: Number(m[2]) } : null;
};
/** the numeric fields are labelled with their unit: "Width (px)" */
const setField = async (label, value) => {
  const field = page.getByLabel(`${label} (px)`, { exact: true });
  await field.fill(String(value));
  await field.press('Enter');
};
async function addToCart() {
  const before = (await storedCart(page)).length;
  await add().click();
  await page.waitForFunction((n) => {
    const said = document.querySelector('[data-testid="design-cart-said"]')?.textContent ?? '';
    return /Added to your cart|now has this version/.test(said) || /role="alert"/.test(document.querySelector('[data-testid="design-cart-said"]')?.outerHTML ?? '') || n < 0;
  }, before);
  // the message and its "View cart" button are read apart: the paragraph's text is both
  const { said, button } = await page.getByTestId('design-cart-said').evaluate((p) => {
    const b = p.querySelector('button');
    return { said: (p.textContent ?? '').slice(0, b ? (p.textContent ?? '').lastIndexOf(b.textContent ?? '') : undefined).trim(), button: b?.textContent?.trim() ?? null };
  });
  return { said, button, lines: await storedCart(page) };
}
const pickSize = async (size) => {
  await page.locator(`label[for$="-size-${size}"]`).first().click();
  await page.waitForFunction((s) => new URLSearchParams(location.search).get('variant')?.endsWith(`-${s}`), size);
  await page.waitForTimeout(150);
};
const estimates = {};

await section('design: the Design page', async () => {
  await go(page, designUrl);
  await page.getByRole('button', { name: 'Add rectangle' }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="design-actions-reason"]')?.textContent === 'Add something to your design first.');
  check('design: with nothing to print the buttons are off and say why', (await add().getAttribute('aria-disabled')) === 'true' && (await page.getByRole('button', { name: 'Proceed to checkout' }).getAttribute('aria-disabled')) === 'true');
  check('design: the rule is stated in words', (await estimateText()) === 'Every element is priced by the rectangle around it.', await estimateText());

  // 0: one element entirely off the garment's print box costs nothing, at any size
  await page.getByRole('button', { name: 'Add rectangle' }).click();
  await setField('Width', 30);
  await setField('Height', 30);
  await setField('X', 20);
  await setField('Y', 20);
  await page.waitForTimeout(200);
  estimates.zero = await shownFee();
  check('design: an element off the garment is estimated at ₱0 (0.00 sq in), even at size M', estimates.zero?.fee === 0 && estimates.zero?.area === 0, await estimateText());
  const zero = await addToCart();
  check('design: Add this customization to cart puts it in the cart with its own design', zero.said === 'Added to your cart.' && zero.button === 'View cart' && zero.lines.length === 1 && /^\d+$/.test(zero.lines[0].designId), JSON.stringify(zero));

  // 1 element, sizes M, S and L
  await setField('X', 400);
  await setField('Y', 400);
  await setField('Width', 180);
  await setField('Height', 120);
  await page.waitForTimeout(200);
  for (const size of ['M', 'S', 'L']) {
    if (size !== 'M') await pickSize(size);
    estimates[`one${size}`] = await shownFee();
    const r = await addToCart();
    check(`design: one element at size ${size} is added (${r.lines.length} lines)`, r.lines.length === { M: 2, S: 3, L: 4 }[size], JSON.stringify(r.lines.map((l) => l.sku)));
  }
  check('design: the estimate goes up by the size step from S to M to L', estimates.oneM.fee - estimates.oneS.fee === estimates.oneL.fee - estimates.oneM.fee && estimates.oneM.fee > estimates.oneS.fee, JSON.stringify(estimates));

  // 3 elements, back at M
  await pickSize('M');
  await page.getByRole('button', { name: 'Add text' }).click();
  await page.getByRole('button', { name: 'Add circle' }).click();
  await page.waitForTimeout(200);
  estimates.three = await shownFee();
  const three = await addToCart();
  check('design: three elements are added as a fifth line', three.lines.length === 5 && new Set(three.lines.map((l) => l.designId)).size === 5, JSON.stringify(three.lines.map((l) => l.designId)));
  check('design: inches are shown beside px (display only)', /Printed about [\d.]+ × [\d.]+ in on size Small\./.test((await page.getByTestId('geometry-inches').textContent()) ?? ''));
  await shot(page, 'design-1366.png');

  // Proceed to checkout right after adding sends nothing new
  const uploadsBefore = Number(sql('select count(*) from clothcraft_design'));
  await page.getByRole('button', { name: 'Proceed to checkout' }).click();
  await page.waitForURL('**/checkout');
  check('design: Proceed to checkout right after adding does not upload the design again', Number(sql('select count(*) from clothcraft_design')) === uploadsBefore);

  // step 10: Proceed to checkout ticks this design alone; the four others stay in the cart, unticked, and stay drafts in Odoo
  const stored = await storedCart(page);
  check('step 10: Proceed to checkout ticks only the design just made; the other four stay in the cart, unticked', stored.length === 5 && JSON.stringify(stored.map((l) => !!l.selected)) === '[false,false,false,false,true]', JSON.stringify(stored.map((l) => !!l.selected)));
  const states = sql(`select string_agg(state, ',' order by id) from clothcraft_design where id in (${stored.slice(0, 4).map((l) => Number(l.designId)).join(',')})`);
  check('step 10: the unticked designs are still drafts in the shop', states === 'draft,draft,draft,draft', states);
  await page.getByTestId('summary-lines').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="summary-lines"] li').length > 0);
  check('step 10: checkout lists only that design, with the note', (await page.getByTestId('summary-lines').locator(':scope > li').count()) === 1 && (await page.getByTestId('just-made-note').textContent()).includes('Checking out the design you just made. Your other items are still in your cart.'));
  await shot(page, 'checkout-partial.png');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Checkout' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="summary-lines"] li').length > 0);
  check('step 10: after a reload the note is not shown again (the tick stays)', (await page.getByTestId('just-made-note').count()) === 0 && (await page.getByTestId('summary-lines').locator(':scope > li').count()) === 1);
});

let quoted = null;
const lines = await storedCart(page);
await section('cart: the shop prices every design', async () => {
  quoted = await quoteOf(page, lines.map((l) => ({ sku: l.sku, quantity: l.quantity, designId: l.designId })));
  const fees = quoted.lines.map((l) => l.printFee?.unit);
  const want = [estimates.zero, estimates.oneM, estimates.oneS, estimates.oneL, estimates.three].map((e) => e?.fee);
  check('cart: the shop\'s fee equals the editor\'s estimate for 0, 1 (S, M, L) and 3 elements', JSON.stringify(fees) === JSON.stringify(want), `shop ${JSON.stringify(fees)} editor ${JSON.stringify(want)}`);
  check('cart: the stored estimates are those the page showed', JSON.stringify(lines.map((l) => l.estimate)) === JSON.stringify(want), JSON.stringify(lines.map((l) => l.estimate)));
  check('cart: nothing on the garment costs nothing (no size step either)', quoted.lines[0].printFee.unit === 0 && quoted.lines[0].printFee.coveredSqIn === 0);
  await go(page, '/cart');
  await page.getByRole('checkbox', { name: 'Select all' }).check(); // step 10: the cart totals the ticked lines; here all five
  await page.waitForFunction(() => /₱/.test(document.querySelector('[data-testid="quote-total"]')?.textContent ?? ''));
  check('cart: every designed line shows its design and its fee', (await page.getByTestId('line-design-preview').count()) === 5 && (await page.getByTestId('line-print-fee').count()) === 5);
  check('cart: no estimate note while the figures agree', (await page.getByTestId('line-estimate-note').count()) === 0);
  check('cart: no VAT line in the cart', (await page.getByTestId('quote-vat').count()) === 0);
  check('cart: the total is the shop\'s', money(await page.getByTestId('quote-total').textContent()) === quoted.total, `${await page.getByTestId('quote-total').textContent()} vs ${quoted.total}`);
  const previews = await page.getByTestId('line-design-preview').evaluateAll((imgs) => imgs.map((i) => i.naturalWidth));
  check('cart: the design pictures load (800 px)', previews.every((w) => w === 800), JSON.stringify(previews));

  // quantity 2 on the one-element M line
  const row = page.locator(`[data-testid="cart-line"][data-design="${lines[1].designId}"]`);
  await row.getByRole('button', { name: 'One more' }).click();
  await page.waitForFunction((d) => document.querySelector(`[data-testid="cart-line"][data-design="${d}"] [data-testid="line-print-fee"]`)?.textContent?.includes('× 2'), lines[1].designId);
  await page.waitForTimeout(400);
  const feeTotal = money(await row.getByTestId('line-fee-total').textContent());
  check('cart: quantity 2 doubles the print fee (the shop\'s figure)', feeTotal === Math.round(estimates.oneM.fee * 2 * 100) / 100, `${feeTotal} vs ${estimates.oneM.fee} × 2`);

  // a tampered estimate changes nothing but the note
  const totalBefore = money(await page.getByTestId('quote-total').textContent());
  const key = await cartKey(page);
  await page.evaluate((k) => {
    const c = JSON.parse(localStorage.getItem(k));
    c.lines[4].estimate = 1; // this device's copy: the estimate is never sent to the shop
    localStorage.setItem(k, JSON.stringify(c));
  }, key);
  await go(page, '/cart');
  await page.waitForFunction(() => /₱/.test(document.querySelector('[data-testid="quote-total"]')?.textContent ?? ''));
  const note = await page.getByTestId('line-estimate-note').allTextContents();
  check('cart: a tampered estimate shows the note with the shop\'s figure', note.length === 1 && note[0].startsWith('Estimated ₱1 in the editor; the shop\'s figure is ₱'), JSON.stringify(note));
  check('cart: and the total stays the shop\'s', money(await page.getByTestId('quote-total').textContent()) === totalBefore);
  const sneaky = await page.evaluate(async (l) => (await fetch('/api/cart/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: [{ ...l, printFee: { unit: 0, total: 0 }, unitPrice: 1 }] }) })).json(), { sku: lines[4].sku, quantity: 1, designId: lines[4].designId });
  check('cart: a price sent with a line is ignored by the shop', sneaky.data?.lines?.[0]?.printFee?.unit === estimates.three.fee, JSON.stringify(sneaky).slice(0, 200));
  await shot(page, 'cart-designed.png');
});

await section('edit: Edit design replaces the line\'s design', async () => {
  const before = await storedCart(page);
  const old = before[4].designId;
  await page.locator(`[data-testid="cart-line"][data-design="${old}"]`).getByTestId('line-edit-design').click();
  await page.waitForURL(`**/design?**design=${old}**`);
  await page.getByRole('button', { name: 'Update this customization in the cart' }).waitFor();
  await page.waitForFunction(() => /Your design was opened/.test(document.querySelector('[data-testid="live-region"]')?.textContent ?? ''));
  check('edit: the saved design opens (3 layers)', (await page.getByTestId('layers-list').locator(':scope > li').count()) === 3, String(await page.getByTestId('layers-list').locator(':scope > li').count()));
  check('edit: no draft prompt (a cart design is not the product\'s draft)', (await page.getByTestId('draft-prompt').count()) === 0);
  await page.getByRole('button', { name: 'Add rectangle' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Update this customization in the cart' }).click();
  // the shown message, not the screen-reader live region that repeats it (getByText would match both)
  await page.waitForFunction(() => document.querySelector('[data-testid="design-cart-said"]')?.firstChild?.textContent === 'Your cart now has this version of the design.');
  const after = await storedCart(page);
  check('edit: the line keeps its place and quantity and names the new design', after.length === 5 && after[4].designId !== old && after[4].quantity === before[4].quantity, JSON.stringify(after.map((l) => l.designId)));
  check('edit: the old design is removed in the shop', sql(`select state from clothcraft_design where id=${Number(old)}`) === 'void');
});

let order = null;
await section('order: checkout keeps a fee line per design', async () => {
  await go(page, '/checkout');
  await page.waitForFunction(() => /₱/.test(document.querySelector('[data-testid="quote-total"]')?.textContent ?? ''));
  check('checkout: each design\'s fee is in the summary, and the VAT is stated', (await page.getByTestId('summary-print-fee').count()) === 5 && (await page.getByTestId('quote-vat').count()) === 1);
  await page.getByRole('option', { name: 'Metro Manila (NCR)' }).waitFor({ state: 'attached' });
  await page.getByLabel('Full name').fill('Juana Dela Cruz');
  await page.getByLabel('Email').fill('juana@example.com');
  await page.getByLabel('Mobile number').fill('0917 123 4567');
  await page.getByLabel('House number and street').fill('12 Rizal Street');
  await page.getByLabel('City or municipality').fill('Quezon City');
  await page.getByLabel('Province').selectOption({ label: 'Metro Manila (NCR)' });
  await page.getByLabel('Postal code').fill('1100');
  await page.getByRole('radio', { name: /Cash on delivery/ }).check();
  const total = money(await page.getByTestId('quote-total').textContent());
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByTestId('order-heading').waitFor();
  const ref = /S\d{5,}/.exec(await page.getByTestId('order-heading').textContent())?.[0];
  const id = page.url().split('/orders/')[1].split(/[?#]/)[0];
  order = { id, ref };
  check('order: placed, with the five designed lines and their fees', (await page.getByTestId('order-designed-line').count()) === 5 && (await page.getByTestId('order-print-fee').count()) === 5);
  check('order: the total is the one quoted at checkout', (await page.locator('body').innerText()).includes((await page.getByTestId('quote-total').textContent()).trim()) && money(await page.getByTestId('quote-total').textContent()) === total);
  const fees = sql(`select count(*) from sale_order_line l join sale_order o on o.id=l.order_id where o.name='${ref}' and l.clothcraft_fee_for_id is not null`);
  check('odoo: one Customization fee line per designed garment line', fees === '5', fees);
  const states = sql(`select string_agg(distinct d.state, ',') from clothcraft_design d join sale_order_line l on l.clothcraft_design_id=d.id join sale_order o on o.id=l.order_id where o.name='${ref}'`);
  check('odoo: the ordered designs are fixed (ordered)', states === 'ordered', states);
});

await section('isolation: a customer\'s design is theirs alone', async () => {
  const design = lines[1].designId;
  const B = await customer('B');
  check('isolation: another customer gets 404 for the design and its pictures', (await status(B.page, `/api/designs/${design}`)) === 404 && (await status(B.page, `/api/designs/${design}/preview.png`)) === 404 && (await status(B.page, `/api/designs/${design}/state`)) === 404);
  await B.ctx.close();
  const anon = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': ipOf() } });
  const ap = await anon.newPage();
  watch(ap, 'anonymous');
  await ap.goto(base + '/category', { waitUntil: 'networkidle' });
  check('isolation: no session gets 401', (await status(ap, `/api/designs/${design}/preview.png`)) === 401);
  await anon.close();
  check('isolation: the owner\'s cookie does not open the staff route', (await status(page, `/api/staff/designs/${design}/print.png`)) === 401);
});

await section('staff: the order detail shows each design and downloads its print file', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': ipOf() }, acceptDownloads: true });
  const sp = await ctx.newPage();
  watch(sp, 'staff');
  await sp.goto(base + '/staff', { waitUntil: 'networkidle' });
  await sp.getByLabel('Email').fill(STAFF.email);
  await sp.getByLabel('Password').fill(STAFF.password);
  await sp.getByRole('button', { name: 'Sign in' }).click();
  await sp.getByTestId('staff-who').waitFor();
  await go(sp, `/staff/orders/${order.id}`);
  await sp.getByTestId('staff-order-heading').waitFor();
  check('staff: five designed lines with the fee as ordered', (await sp.getByTestId('staff-designed-line').count()) === 5 && (await sp.getByTestId('staff-print-fee').count()) === 5);
  await sp.waitForFunction(() => [...document.querySelectorAll('[data-testid="staff-design-preview"]')].every((i) => i.complete && i.naturalWidth > 0));
  check('staff: the design previews load', (await sp.getByTestId('staff-design-preview').evaluateAll((imgs) => imgs.every((i) => i.naturalWidth === 800))) === true);
  check('staff: a reminder to check the print file before packing', /Check the print file before packing/.test(await sp.locator('body').innerText()));
  const [download] = await Promise.all([sp.waitForEvent('download'), sp.getByTestId('staff-download-print').first().click()]);
  const name = download.suggestedFilename();
  const file = path.join(out, name);
  await download.saveAs(file);
  const meta = await sharp(file).metadata();
  check('staff: the print file downloads as <order>-<line>-<sku>.png', new RegExp(`^${order.ref}-1-[A-Z0-9-]+\\.png$`).test(name), name);
  check('staff: the print file is a transparent 3200 px PNG', meta.format === 'png' && meta.width === 3200 && meta.height === 3200 && meta.hasAlpha === true, JSON.stringify({ f: meta.format, w: meta.width, h: meta.height, a: meta.hasAlpha }));
  check('staff: the staff cookie does not open the customer route', (await status(sp, `/api/designs/${lines[1].designId}/preview.png`)) === 401);
  await shot(sp, 'staff-order-designed.png');
  await ctx.close();
});

await section('phone: the Design page at 390 px', async () => {
  const phone = await A.ctx.newPage();
  watch(phone, 'phone');
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(base + designUrl, { waitUntil: 'networkidle' });
  const prompt = phone.getByTestId('draft-prompt');
  if (await prompt.count()) await phone.getByRole('button', { name: 'Start fresh' }).click();
  await phone.getByTestId('design-action-row').waitFor();
  await phone.getByRole('button', { name: 'Text', exact: true }).click();
  await phone.waitForTimeout(300);
  check('phone: Add to cart and Checkout sit in a row in the bottom bar', (await phone.getByTestId('design-action-row').getByRole('button').count()) === 2);
  const row = await phone.getByTestId('design-action-row').boundingBox();
  const host = await phone.getByTestId('editor-host').boundingBox();
  check('phone: the canvas is above the action row', !!row && !!host && host.y + host.height <= row.y + 1, JSON.stringify({ row, host }));
  await shot(phone, 'design-390.png');
  await phone.close();
});

await A.ctx.close();
report.data.estimates = estimates;
report.data.order = order;
await browser.close();
rep.finish();
