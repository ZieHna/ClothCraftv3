// End-to-end check of the Simple editor in the REAL installed Microsoft Edge (playwright-core, channel "msedge"; no browser
// is downloaded), against a running build:   npm run build:mock && npx vite preview --port 4173
//   node scripts/check-editor-browser.mjs http://localhost:4173 <outDir>
// It drives the page like a person (real mouse, real keyboard), asserts what it should see, writes screenshots to <outDir>
// and prints a JSON report. Exit code 1 if any check fails. Not part of `npm test` (it needs a running server).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedAccount } from './lib/e2e-common.mjs';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: node scripts/check-editor-browser.mjs <baseUrl> <outDir>');
mkdirSync(out, { recursive: true });

const DESIGN = '/design?product=m-tee&variant=SIM-M-TEE-NVY-M';
const report = { checks: [], failures: [], console: [], fonts: {}, contrast: {}, motion: {}, overflow: {}, product: {} };
const check = (name, ok, detail = '') => {
  report.checks.push({ name, ok, detail });
  if (!ok) report.failures.push(`${name} ${detail}`);
};

// ---- fixtures made on the fly: a real "logo" PNG, a renamed SVG, a text file called .png, a >10 MB file, a header-only 48 MP PNG
const fx = path.join(out, 'fixtures');
mkdirSync(fx, { recursive: true });
const logo = path.join(fx, 'logo.png');
await sharp({ create: { width: 420, height: 300, channels: 4, background: { r: 201, g: 162, b: 39, alpha: 1 } } })
  .composite([{ input: Buffer.from('<svg width="420" height="300"><circle cx="210" cy="150" r="110" fill="#fffdf8"/><circle cx="210" cy="150" r="70" fill="#a8353a"/><rect x="40" y="130" width="340" height="40" fill="#243049" opacity="0.85"/></svg>') }])
  .png()
  .toFile(logo);
writeFileSync(path.join(fx, 'fake.png'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
writeFileSync(path.join(fx, 'notes.png'), 'just some text, not a picture');
writeFileSync(path.join(fx, 'anim.gif'), Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'));
const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const dims = (w, h) => Buffer.from([(w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, (h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 6, 0, 0, 0]);
writeFileSync(path.join(fx, 'huge-4MB-header.png'), Buffer.concat([pngSig, dims(8000, 6000)])); // claims 48 megapixels, has no pixels at all
writeFileSync(path.join(fx, 'too-heavy.png'), Buffer.concat([pngSig, dims(10, 10), Buffer.alloc(10 * 1024 * 1024 + 1)]));
const bigPhoto = path.join(fx, 'photo-4000.jpg');
await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 60, g: 120, b: 180 } } }).jpeg({ quality: 70 }).toFile(bigPhoto);

const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function open(width, { reducedMotion } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: reducedMotion ?? 'no-preference' });
  await seedAccount(ctx);
  const page = await ctx.newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && report.console.push(`${width}px ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => report.console.push(`${width}px pageerror: ${e.message}`));
  const fonts = [];
  page.on('response', async (r) => {
    if (r.url().endsWith('.woff2')) fonts.push({ file: r.url().replace(/^.*\//, ''), bytes: (await r.body().catch(() => Buffer.alloc(0))).length, at: Date.now() });
  });
  await page.goto(base + DESIGN, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="editor-host"] canvas.upper-canvas').waitFor({ state: 'attached' });
  await page.waitForFunction(() => !document.querySelector('nav[aria-label="Design tools"] button')?.disabled);
  await page.waitForTimeout(300);
  return { ctx, page, fonts };
}

/** alpha statistics of the Fabric design canvas: how many pixels are drawn, and where their centre is */
const ink = (page) =>
  page.evaluate(async () => {
    // Fabric draws on the next animation frame: wait two, so we read what a person would see
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = document.querySelector('[data-testid="editor-host"] canvas.lower-canvas');
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    const cx = copy.getContext('2d', { willReadFrequently: true });
    cx.drawImage(c, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sx = 0, sy = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 20) { n++; sx += x; sy += y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    // backing pixels -> CSS px -> design units (the design area is 800 wide and fits the view at the fit)
    const back = c.width / c.clientWidth;
    const toDesign = 800 / c.clientWidth;
    const k = toDesign / back;
    return { n: n / (back * back) / (toDesign * toDesign) , cx: n ? (sx / n) * k : 0, cy: n ? (sy / n) * k : 0, w: (x1 - x0) * k, h: (y1 - y0) * k };
  });
const live = (page) => page.getByTestId('live-region').textContent();
const heading = (page) => page.locator('[data-testid="properties-panel"] h2').textContent();
const canvasPos = async (page, x, y) => {
  await page.locator('canvas.upper-canvas').scrollIntoViewIfNeeded(); // a Tab to a control far down the panel scrolls the page: bring the design back first
  const r = await page.locator('canvas.upper-canvas').boundingBox();
  return { x: r.x + (x / 800) * r.width, y: r.y + (y / 800) * r.height };
};
const focusRing = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    const s = getComputedStyle(el);
    return { tag: el.tagName.toLowerCase(), width: parseFloat(s.outlineWidth), style: s.outlineStyle, name: (el.getAttribute('aria-label') || el.textContent || el.id || '').trim().slice(0, 30) };
  });

// =========================================================================================================== A. MOUSE
{
  const { ctx, page, fonts } = await open(1440);
  const early = fonts.map((f) => f.file);
  report.fonts.atLoad = fonts.map(({ file, bytes }) => ({ file, bytes }));
  check('A0 no editor-only font is fetched before the text tool is used', !early.some((f) => /bebas|caveat|pacifico/.test(f)), early.join(', '));
  // step 9: the mock shop has no print prices, so the designer states the rule and shows no figure (its cart buttons say why they are off)
  check('A0 the editor states the pricing rule and shows no price or fee (mock shop)', !/₱|PHP|\$|USD|\bprice\b.{0,25}\d/i.test((await page.locator('main, section').first().textContent()) ?? '') && /Every element is priced by the rectangle around it\./.test((await page.textContent('body')) ?? ''));

  const blank = await ink(page);
  check('A1 garment canvas is not part of the design (design canvas starts empty)', blank.n === 0, `${blank.n}`);

  await page.getByRole('button', { name: 'Add text' }).click();
  check('A2 add text selects it and shows its settings', (await heading(page)) === 'Text settings');
  check('A2 live region announces it', /Text added/.test((await live(page)) ?? ''), await live(page));
  const t0 = await ink(page);
  check('A2 text is drawn on the garment', t0.n > 500, `${t0.n} px`);

  const box = page.getByLabel('Your words');
  await box.fill('Hello Kenzie');
  const t1 = await ink(page);
  check('A3 typing in the panel changes the text on the garment', t1.w > t0.w * 0.5 && t1.n !== t0.n, `${t0.w}->${t1.w}`);

  await page.getByLabel('Font', { exact: true }).selectOption('Bebas Neue');
  await page.waitForFunction(() => document.fonts.check('400 64px "Bebas Neue"'));
  await page.waitForTimeout(250);
  report.fonts.afterBebas = fonts.map(({ file, bytes }) => ({ file, bytes })).filter((f) => !early.includes(f.file));
  check('A4 choosing Bebas Neue fetches its file then (and only then)', report.fonts.afterBebas.some((f) => /bebas/.test(f.file)) && !report.fonts.afterBebas.some((f) => /caveat|pacifico/.test(f.file)), JSON.stringify(report.fonts.afterBebas));
  const t2 = await ink(page);
  check('A4 the box re-measures to the new font (not the fallback width)', Math.abs(t2.w - t1.w) > 8, `${t1.w}->${t2.w}`);
  await page.getByLabel('Font', { exact: true }).selectOption('Caveat');
  await page.getByLabel('Font', { exact: true }).selectOption('Pacifico');
  await page.waitForFunction(() => document.fonts.check('400 64px "Pacifico"') && document.fonts.check('400 64px "Caveat"'));
  report.fonts.afterAll = fonts.map(({ file, bytes }) => ({ file, bytes })).filter((f) => !early.includes(f.file));
  await page.getByLabel('Font', { exact: true }).selectOption('Bebas Neue');

  await page.getByLabel('Font size (8 to 400)').fill('140');
  const t3 = await ink(page);
  check('A5 size change is applied', t3.h > t2.h * 1.5, `${t2.h}->${t3.h}`);
  await page.getByLabel('Font size (8 to 400)').fill('3');
  check('A5 an out-of-range size says so in text and is not applied', (await page.getByText('Problem: use a whole number from 8 to 400.').count()) === 1 && (await ink(page)).h === t3.h);
  await page.getByLabel('Font size (8 to 400)').fill('120');
  await page.getByRole('button', { name: 'Text colour: Red' }).click();
  check('A6 colour swatch is pressed and named', (await page.getByRole('button', { name: 'Text colour: Red' }).getAttribute('aria-pressed')) === 'true');
  await page.getByRole('button', { name: 'Right' }).click();
  check('A6 alignment is pressed', (await page.getByRole('button', { name: 'Right' }).getAttribute('aria-pressed')) === 'true');
  await page.getByLabel(/Opacity/).fill('50');

  for (const [i, kind] of ['Rectangle', 'Circle', 'Triangle', 'Star', 'Line'].entries()) {
    const before = (await ink(page)).n;
    await page.getByRole('button', { name: `Add ${kind.toLowerCase()}` }).click();
    // a thin line can lie wholly over an earlier shape, so only the bigger shapes must add visible ink; (each kind is drawn: see the unit tests)
    check(`A7 ${kind} added and selected`, (await heading(page)) === 'Shape settings' && (kind === 'Line' || (await ink(page)).n > before));
    check(`A7 ${kind} has the right controls`, kind === 'Line' ? (await page.getByText(/Line colour/).count()) > 0 && (await page.getByText('Outline colour').count()) === 0 : (await page.getByText('Fill colour').count()) > 0 && (await page.getByText('Outline colour').count()) > 0);
    if (i === 1) await page.getByRole('button', { name: 'Fill colour: Navy' }).click();
  }

  // upload
  const chooser = async (file) => {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Add picture' }).click()]);
    await fc.setFiles(file);
  };
  await chooser(logo);
  await page.getByRole('heading', { name: 'Picture settings' }).waitFor();
  check('A8 a valid PNG is added', (await live(page))?.includes('Picture added') === true, await live(page));
  const withLogo = (await ink(page)).n;
  for (const [file, expectText] of [['fake.png', /SVG/], ['notes.png', /not a picture/], ['anim.gif', /GIF/], ['huge-4MB-header.png', /48 megapixels/], ['too-heavy.png', /10\.0 MB.*10 MB|MB/]]) {
    await chooser(path.join(fx, file));
    await page.getByTestId('upload-problem').waitFor();
    const msg = (await page.getByTestId('upload-problem').textContent()) ?? '';
    check(`A8 ${file} is refused with a clear message`, expectText.test(msg) && /Picture not added\./.test(msg), msg);
    check(`A8 ${file}: refusal announced, design unchanged`, /Picture not added/.test((await live(page)) ?? '') && (await ink(page)).n === withLogo && (await heading(page)) === 'Picture settings');
  }
  await chooser(path.join(fx, 'logo.png'));
  await page.waitForTimeout(200);
  check('A8 a later good picture clears the old message', (await page.getByTestId('upload-problem').count()) === 0);
  await chooser(bigPhoto);
  await page.waitForTimeout(400);
  check('A8 a 4000x3000 photo is accepted (shrunk on load)', (await page.locator('[data-testid="properties-panel"] h2').textContent()) === 'Picture settings' && (await ink(page)).n > withLogo);

  const shot = async (name) => page.screenshot({ path: path.join(out, name), fullPage: true });
  await shot('mouse-flow-1440.png');
  await ctx.close();
}

// ====================================================================================== A2. double-click on the canvas
{
  const { ctx, page } = await open(1440);
  await page.getByRole('button', { name: 'Add text' }).click(); // the first layer: placed at (320, 280) in design units
  await page.getByLabel('Your words').fill('Canvas');
  await page.getByLabel('Font size (8 to 400)').fill('90');
  await page.keyboard.press('Tab'); // leave the field
  const at = await canvasPos(page, 320, 280);
  const away = await canvasPos(page, 40, 40); // an empty corner of the design area: nothing there to select
  await page.mouse.click(away.x, away.y);
  await page.mouse.dblclick(at.x, at.y);
  await page.keyboard.type('Zed');
  await page.keyboard.press('Escape');
  const value = await page.getByLabel('Your words').inputValue().catch(() => '(no panel)');
  check('A9 double-click edits the text on the canvas, and the panel follows', value === 'Zed', value);
  await ctx.close();
}

// =================================================================================== A3. arrow keys nudge (alone on the garment)
{
  const { ctx, page } = await open(1440);
  await page.getByRole('button', { name: 'Add star' }).focus();
  await page.keyboard.press('Enter');
  const a = await ink(page);
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('ArrowDown');
  const b = await ink(page);
  check('A10 Shift+Arrow moves the selected element 10 units, Arrow 1 unit', Math.abs(b.cx - a.cx - 20) < 2.5 && Math.abs(b.cy - a.cy - 1) < 2.5 && Math.abs(b.n - a.n) / a.n < 0.02, `${a.cx.toFixed(1)},${a.cy.toFixed(1)} -> ${b.cx.toFixed(1)},${b.cy.toFixed(1)}`);
  await ctx.close();
}

// ============================================================================================ B. KEYBOARD ONLY + focus
{
  const { ctx, page, fonts } = await open(1440);
  await page.evaluate(() => document.activeElement?.blur());
  const stops = [];
  const tabTo = async (matcher, cap = 60) => {
    for (let i = 0; i < cap; i++) {
      await page.keyboard.press('Tab');
      const f = await focusRing(page);
      stops.push(f.name);
      if (matcher(f)) return f;
    }
    throw new Error('Tab never reached the target; stops: ' + stops.slice(-8).join(' | '));
  };
  const ringOk = (f) => f.style !== 'none' && f.width >= 2;

  const addText = await tabTo((f) => f.name === 'Add text');
  check('B1 Tab reaches "Add text" with a visible focus ring', ringOk(addText), JSON.stringify(addText));
  await page.keyboard.press('Enter');
  check('B2 Enter adds text', (await heading(page)) === 'Text settings' && /Text added/.test((await live(page)) ?? ''));

  const picture = await tabTo((f) => f.name === 'Add picture');
  check('B3 "Add picture" is reached next and has a focus ring', ringOk(picture));
  for (const kind of ['rectangle', 'circle', 'triangle', 'star', 'line']) {
    const f = await tabTo((x) => x.name === `Add ${kind}`);
    check(`B3 "Add ${kind}" reachable with a focus ring`, ringOk(f));
  }
  await page.keyboard.press('Enter'); // the line, the last tool
  check('B4 Enter adds a line', (await heading(page)) === 'Shape settings');

  // back to the text: click-free selection is not offered, so re-add text and edit it from the panel by keyboard
  await page.getByRole('button', { name: 'Add text' }).focus();
  await page.keyboard.press('Enter');
  const words = await tabTo((f) => f.tag === 'textarea');
  check('B6 Tab reaches the text box with a focus ring', ringOk(words));
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Typed with keys');
  check('B6 typing in the box changes the layer', (await page.getByLabel('Your words').inputValue()) === 'Typed with keys');
  const fontSel = await tabTo((f) => f.tag === 'select');
  check('B7 Tab reaches the font list with a focus ring', ringOk(fontSel));
  await page.keyboard.type('Pa');
  await page.waitForFunction(() => document.fonts.check('400 64px "Pacifico"'));
  check('B7 choosing a font by keyboard works', (await page.getByLabel('Font', { exact: true }).inputValue()) === 'Pacifico');
  const size = await tabTo((f) => f.tag === 'input');
  check('B8 Tab reaches the size field with a focus ring', ringOk(size));
  await page.keyboard.press('Control+A');
  await page.keyboard.type('100');
  const sw = await tabTo((f) => /Text colour: Ink/.test(f.name));
  check('B9 swatches are reachable with a focus ring', ringOk(sw));
  const tFor = await tabTo((f) => /Text colour: Red/.test(f.name));
  await page.keyboard.press('Enter');
  check('B9 Enter on a swatch sets the colour', (await page.getByRole('button', { name: 'Text colour: Red' }).getAttribute('aria-pressed')) === 'true', tFor.name);
  const align = await tabTo((f) => f.name === 'Centre');
  check('B10 alignment buttons reachable', ringOk(align));
  const range = await tabTo((f) => f.tag === 'input' && /Opacity/.test(f.name || 'Opacity'), 12).catch(() => null);
  const del = await tabTo((f) => /^Delete text/.test(f.name));
  check('B11 "Delete text" reachable with a focus ring', ringOk(del));
  const beforeDel = (await ink(page)).n;
  await page.keyboard.press('Enter');
  check('B12 Enter on Delete removes it, announces it, and moves focus into the panel', /Deleted text/.test((await live(page)) ?? '') && (await ink(page)).n < beforeDel && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'properties-panel');
  void range;

  // Delete key on the design
  await page.getByRole('button', { name: 'Add star' }).focus();
  await page.keyboard.press('Enter');
  const withStar = (await ink(page)).n;
  await page.keyboard.press('Delete');
  check('B13 the Delete key removes the selected element (focus in the editor)', (await ink(page)).n < withStar && /Deleted star/.test((await live(page)) ?? ''));

  // picture with the keyboard only
  await page.getByRole('button', { name: 'Add picture' }).focus();
  await page.waitForTimeout(150); // let a pending re-render settle before the key press
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await fc.setFiles(logo);
  await page.getByRole('heading', { name: 'Picture settings' }).waitFor();
  check('B14 a picture can be added from the keyboard', true);
  const delPic = await tabTo((f) => /^Delete picture/.test(f.name));
  await page.keyboard.press('Enter');
  check('B14 and deleted from the keyboard', /Deleted picture/.test((await live(page)) ?? '') && ringOk(delPic));
  await ctx.close();
}

// ============================================================================================ H. history, layers, numbers
const rows = (page) =>
  page.locator('[data-testid="layers-list"] > li').evaluateAll((lis) =>
    lis.map((li) => ({
      id: li.dataset.layerId,
      name: li.querySelector('button .truncate')?.textContent ?? '',
      current: !!li.querySelector('[aria-current="true"]'),
      hidden: /Hidden/.test(li.textContent ?? ''),
      locked: /Locked/.test(li.textContent ?? ''),
    })),
  );
const names = async (page) => (await rows(page)).map((r) => r.name);
const num = async (page, label) => Number(await page.getByLabel(label, { exact: true }).inputValue());
const centre = async (page) => ({ x: await num(page, 'X (px)'), y: await num(page, 'Y (px)') });
const clientOf = async (page, x, y) => canvasPos(page, x, y);
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

{
  const { ctx, page } = await open(1440);

  // ---- the list mirrors the design, top layer first, and the garment is never in it
  await page.getByRole('button', { name: 'Add rectangle' }).click();
  await page.getByRole('button', { name: 'Add star' }).click();
  await page.getByRole('button', { name: 'Add text' }).click();
  check('H1 the layers list shows the layers top first, without the garment', JSON.stringify(await names(page)) === JSON.stringify(['Your text', 'Star', 'Rectangle']), JSON.stringify(await names(page)));
  check('H1 the selected layer is marked in the list', (await rows(page)).filter((r) => r.current).map((r) => r.name).join() === 'Your text');

  // ---- undo / redo by shortcut and by button
  const inkAll = (await ink(page)).n;
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="layers-list"] > li').length === 2);
  check('H2 Ctrl+Z undoes the last action (the text goes) and says so', (await names(page)).join() === 'Star,Rectangle' && /Undone/.test((await live(page)) ?? '') && (await ink(page)).n < inkAll);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="layers-list"] > li').length === 3);
  check('H2 Ctrl+Shift+Z redoes it', (await names(page)).join() === 'Your text,Star,Rectangle' && /Redone/.test((await live(page)) ?? ''));
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="layers-list"] > li').length === 3);
  check('H2 Ctrl+Y redoes as well', (await names(page)).length === 3);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="layers-list"] > li').length === 2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="layers-list"] > li').length === 3);
  check('H2 the Undo and Redo buttons work too', true);

  // ---- hide, show, lock, reorder, rename, delete from the list
  const before = (await ink(page)).n;
  await page.getByRole('button', { name: 'Hide Star' }).click();
  check('H3 Hide removes it from the picture, lists it dimmed as "Hidden", and says so', (await rows(page)).find((r) => r.name === 'Star')?.hidden === true && (await ink(page)).n < before && /Hid Star/.test((await live(page)) ?? ''));
  await page.getByRole('button', { name: 'Show Star' }).click();
  check('H3 Show brings it back', (await rows(page)).find((r) => r.name === 'Star')?.hidden === false && (await ink(page)).n === before);

  await page.getByRole('button', { name: 'Up Rectangle' }).click();
  check('H4 Up moves it a place up the list and announces the new place', (await names(page)).join() === 'Your text,Rectangle,Star' && /Moved Rectangle up\. Now layer 2 of 3/.test((await live(page)) ?? ''), `${(await names(page)).join()} / ${await live(page)}`);
  await page.getByRole('button', { name: 'Down Rectangle' }).click();
  check('H4 Down moves it back', (await names(page)).join() === 'Your text,Star,Rectangle');

  await page.getByRole('button', { name: 'Rename Star' }).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Gold star');
  await page.keyboard.press('Enter');
  check('H5 a layer can be renamed in the list', (await names(page)).includes('Gold star') && /Renamed/.test((await live(page)) ?? ''), (await names(page)).join());
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForTimeout(150);
  check('H5 and the rename is ONE undo step, not one per letter', (await names(page)).includes('Star') && !(await names(page)).includes('G'), (await names(page)).join());
  await page.getByRole('button', { name: 'Redo', exact: true }).click();

  // lock: it cannot be picked on the canvas, cannot be deleted from the list, but can be selected from the list
  await page.getByRole('button', { name: 'Lock Rectangle' }).click();
  check('H6 Lock marks the layer "Locked" in words', (await rows(page)).find((r) => r.name === 'Rectangle')?.locked === true && /Locked Rectangle/.test((await live(page)) ?? ''));
  await page.getByRole('button', { name: 'Delete Rectangle' }).click();
  const notice = (await page.getByTestId('layer-notice').textContent()) ?? '';
  check('H6 deleting a locked layer says why, and does not delete it', /locked/i.test(notice) && /Unlock/.test(notice) && (await names(page)).includes('Rectangle'), notice);
  check('H6 the refusal is announced', /Not changed.*locked/i.test((await live(page)) ?? ''));
  await page.getByRole('button', { name: /^Rectangle, shape, locked/ }).click();
  check('H6 a locked layer can be selected from the list', (await rows(page)).find((r) => r.name === 'Rectangle')?.current === true && (await heading(page)) === 'Shape settings');
  check('H6 its settings are shown but cannot be changed, and it says so', (await page.getByTestId('locked-note').count()) === 1 && (await page.getByLabel('X (px)', { exact: true }).isDisabled()));
  await page.getByRole('button', { name: 'Delete shape' }).click();
  check('H6 the panel Delete button refuses too', /locked/i.test((await page.getByTestId('layer-notice').textContent()) ?? '') && (await names(page)).includes('Rectangle'));
  // a locked layer cannot be picked or dragged on the canvas
  await page.keyboard.press('Escape');
  const lockedAt = await clientOf(page, 400 - 80, 432 + 40); // the rectangle was the first layer added
  await page.mouse.click(lockedAt.x, lockedAt.y);
  check('H6 clicking a locked layer on the canvas selects nothing', (await rows(page)).every((r) => !r.current) || (await rows(page)).find((r) => r.current)?.name !== 'Rectangle');
  await page.getByRole('button', { name: 'Unlock Rectangle' }).click();
  await page.getByRole('button', { name: 'Delete Rectangle' }).click();
  check('H6 after unlocking, Delete works', !(await names(page)).includes('Rectangle'));

  // ---- selection both ways
  await page.getByRole('button', { name: /^Gold star/ }).click();
  check('H7 choosing a layer in the list selects it on the canvas (its settings appear)', (await heading(page)) === 'Shape settings');
  await page.getByRole('button', { name: /^Your text, text/ }).click();
  check('H7 choosing the text shows the text settings', (await heading(page)) === 'Text settings');
  const starXY = await (async () => {
    await page.getByRole('button', { name: /^Gold star/ }).click();
    return centre(page);
  })();
  await page.keyboard.press('Escape');
  check('H7 Esc deselects (list and panel)', (await heading(page)) === 'Settings' && (await rows(page)).every((r) => !r.current));
  const at = await clientOf(page, starXY.x, starXY.y);
  await page.mouse.click(at.x, at.y);
  check('H7 clicking the star on the canvas selects it in the list', (await rows(page)).find((r) => r.current)?.name === 'Gold star', JSON.stringify((await rows(page)).filter((r) => r.current)));
  await ctx.close();
}

// ---- drag, typed text, panel text: each ONE step
{
  const { ctx, page } = await open(1440);
  await page.getByRole('button', { name: 'Add rectangle' }).click();
  const start = await centre(page);
  const from = await clientOf(page, start.x, start.y);
  const r = await page.locator('canvas.upper-canvas').boundingBox();
  const k = r.width / 800;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 40 * k, from.y + 20 * k, { steps: 6 });
  await page.mouse.move(from.x + 100 * k, from.y + 60 * k, { steps: 6 });
  await page.mouse.up();
  const moved = await centre(page);
  check('H8 dragging moves the layer, and the number fields follow', near(moved.x, start.x + 100, 3) && near(moved.y, start.y + 60, 3), `${start.x},${start.y} -> ${moved.x},${moved.y}`);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  const back = await centre(page);
  check('H8 ONE Ctrl+Z undoes the whole drag (not one frame of it)', near(back.x, start.x) && near(back.y, start.y), `${back.x},${back.y}`);
  check('H8 and the layer is still there (the drag was one step, the add another)', (await names(page)).length === 1);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check('H8 a second Ctrl+Z removes the layer', (await names(page)).length === 0);
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(250);
  const redone = await centre(page);
  check('H8 redo twice brings back the layer where the drag left it', near(redone.x, moved.x) && near(redone.y, moved.y), `${redone.x},${redone.y}`);

  // resize with the handles and rotate: one step each. The bottom-right handle of the selected rectangle.
  const w0 = await num(page, 'Width (px)');
  const corner = await clientOf(page, moved.x + w0 / 2, moved.y + (await num(page, 'Height (px)')) / 2);
  const box = { x: corner.x + 4, y: corner.y + 4 }; // the handle sits on the corner of the box padded by 4 px
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 30 * k, box.y + 20 * k, { steps: 5 });
  await page.mouse.up();
  const w1 = await num(page, 'Width (px)');
  check('H9 dragging a handle resizes it', w1 > w0 + 15, `${w0} -> ${w1}`);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check('H9 one Ctrl+Z undoes the resize', near(await num(page, 'Width (px)'), w0));
  await ctx.close();
}

{
  const { ctx, page } = await open(1440);
  await page.getByRole('button', { name: 'Add text' }).click();
  const textXY = await centre(page);
  // typing on the canvas: double-click, select all, type, Escape: ONE step
  const at = await clientOf(page, textXY.x, textXY.y);
  await page.mouse.click(at.x + 500, at.y + 200);
  await page.mouse.dblclick(at.x, at.y);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Typed on the shirt');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('H10 typing on the canvas shows in the panel', (await page.getByLabel('Your words').inputValue()) === 'Typed on the shirt', await page.getByLabel('Your words').inputValue().catch(() => '?'));
  check('H10 and the list name follows', (await names(page))[0] === 'Typed on the shirt');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForTimeout(200);
  check('H10 ONE undo reverts everything typed on the canvas (not one letter)', (await names(page))[0] === 'Your text' && (await names(page)).length === 1, (await names(page)).join());

  // typing in the panel box: ONE step, committed when the field loses focus
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByLabel('Your words').focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Panel words here');
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForTimeout(200);
  check('H11 text typed in the panel is ONE undo step', (await names(page))[0] === 'Typed on the shirt', (await names(page)).join());

  // slider: one step per drag
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const slider = page.getByLabel(/Opacity/);
  await slider.scrollIntoViewIfNeeded();
  const sb = await slider.boundingBox();
  await page.mouse.move(sb.x + sb.width - 3, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width * 0.5, sb.y + sb.height / 2, { steps: 8 });
  await page.mouse.move(sb.x + sb.width * 0.2, sb.y + sb.height / 2, { steps: 8 });
  await page.mouse.up();
  const dragged = Number(await slider.inputValue());
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForTimeout(200);
  check('H12 a slider drag is ONE undo step', dragged < 40 && Number(await page.getByLabel(/Opacity/).inputValue()) === 100, `${dragged} -> ${await page.getByLabel(/Opacity/).inputValue()}`);

  // shortcuts must NOT fire while typing
  await page.getByRole('button', { name: 'Add rectangle' }).click();
  const count = (await names(page)).length;
  await page.getByLabel('Y (px)', { exact: true }).focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Escape');
  check('H13 Delete, Backspace, Ctrl+Z and Esc do nothing to the design while typing in a number field', (await names(page)).length === count && (await heading(page)) === 'Shape settings');
  await page.getByRole('button', { name: 'Add text' }).click();
  await page.getByLabel('Your words').focus();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+z');
  check('H13 ...nor in the text box (Backspace edits the words, it does not delete the layer)', (await names(page)).length === count + 1);
  await ctx.close();
}

{
  // while editing text ON the canvas, Backspace/Delete/Ctrl+Z belong to the text
  const { ctx, page } = await open(1440);
  await page.getByRole('button', { name: 'Add text' }).click();
  const c = await centre(page);
  const at = await clientOf(page, c.x, c.y);
  await page.mouse.click(at.x + 500, at.y + 200);
  await page.mouse.dblclick(at.x, at.y);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('H14 Fabric text editing keeps Backspace, Delete, Ctrl+Z and Esc to itself: the layer survives', (await names(page)).length === 1, (await names(page)).join());
  await ctx.close();
}

// ---- numeric fields
{
  const { ctx, page } = await open(1440);
  await page.getByRole('button', { name: 'Add rectangle' }).click();
  const set = async (label, value) => {
    const f = page.getByLabel(label, { exact: true });
    await f.fill(String(value));
    await f.press('Enter');
  };
  await set('X (px)', 300);
  await set('Y (px)', 450);
  await set('Width (px)', 200);
  await set('Height (px)', 80);
  await set('Rotation (°)', 30);
  const l = { x: await num(page, 'X (px)'), y: await num(page, 'Y (px)'), w: await num(page, 'Width (px)'), h: await num(page, 'Height (px)'), r: await num(page, 'Rotation (°)') };
  check('I1 the numeric fields set the centre, size and rotation exactly', l.x === 300 && l.y === 450 && l.w === 200 && l.h === 80 && l.r === 30, JSON.stringify(l));
  const picture = await ink(page);
  check('I1 and the garment shows it (the shape is where the numbers say)', near(picture.cx, 300, 3) && near(picture.cy, 450, 3), `${picture.cx.toFixed(1)},${picture.cy.toFixed(1)}`);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForTimeout(150);
  check('I2 each applied value is ONE undo step (undo reverts rotation only)', (await num(page, 'Rotation (°)')) === 0 && (await num(page, 'Height (px)')) === 80);
  // an out-of-range value says so and is not applied
  const wf = page.getByLabel('Width (px)', { exact: true });
  await wf.fill('99999');
  check('I3 an out-of-range number says so in words', (await page.getByText('Problem: use a whole number from 1 to 4000.').count()) === 1 && (await wf.getAttribute('aria-invalid')) === 'true');
  await wf.press('Tab');
  check('I3 ...and the field returns to the real value when it loses focus', (await num(page, 'Width (px)')) === 200);
  await wf.fill('12.5');
  check('I3 a number with a fraction is refused too', (await page.getByText(/Problem: use a whole number/).count()) === 1);
  await wf.press('Tab');
  await wf.fill('');
  check('I3 an empty field is an error, not a zero', (await page.getByText(/Problem: use a whole number/).count()) === 1);
  await wf.press('Tab');

  // proportions: pictures start locked, a toggle changes it
  await page.getByRole('button', { name: 'Add picture' }).focus();
  await page.waitForTimeout(150); // let a pending re-render settle before the key press
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await fc.setFiles(logo);
  await page.getByRole('heading', { name: 'Picture settings' }).waitFor();
  const ratio = (await num(page, 'Width (px)')) / (await num(page, 'Height (px)'));
  check('I4 "Keep proportions" starts ticked for a picture', await page.getByLabel('Keep proportions').isChecked());
  await set('Width (px)', 280);
  const afterW = { w: await num(page, 'Width (px)'), h: await num(page, 'Height (px)') };
  check('I4 changing the width of a picture changes its height to match', near(afterW.w / afterW.h, ratio, 0.03), JSON.stringify(afterW));
  await set('Height (px)', 100);
  const afterH = { w: await num(page, 'Width (px)'), h: await num(page, 'Height (px)') };
  check('I4 and the other way round', near(afterH.w / afterH.h, ratio, 0.05), JSON.stringify(afterH));
  await page.getByLabel('Keep proportions').uncheck();
  await set('Width (px)', 150);
  check('I4 with the toggle off, width and height are independent', (await num(page, 'Height (px)')) === afterH.h && (await num(page, 'Width (px)')) === 150);
  await page.getByRole('button', { name: 'Add rectangle' }).click();
  check('I4 shapes start with it off', !(await page.getByLabel('Keep proportions').isChecked()));
  await ctx.close();
}

// ---- a keyboard-only walk through all of it
{
  const { ctx, page } = await open(1440);
  await page.evaluate(() => document.activeElement?.blur());
  const stops = [];
  const tabTo = async (matcher, cap = 80) => {
    for (let i = 0; i < cap; i++) {
      await page.keyboard.press('Tab');
      const f = await focusRing(page);
      stops.push(f.name);
      if (matcher(f)) return f;
    }
    throw new Error('Tab never reached the target; last stops: ' + stops.slice(-8).join(' | '));
  };
  const ringOk = (f) => f.style !== 'none' && f.width >= 2;

  await tabTo((f) => f.name === 'Add rectangle');
  await page.keyboard.press('Enter');
  await tabTo((f) => f.name === 'Add star');
  await page.keyboard.press('Enter');
  check('K1 two layers added from the keyboard', (await names(page)).join() === 'Star,Rectangle');

  const undoBtn = await tabTo((f) => f.name === 'Undo');
  check('K2 Undo is reached by Tab, with a focus ring', ringOk(undoBtn));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="layers-list"] > li').length === 1);
  const redoBtn = await tabTo((f) => f.name === 'Redo');
  check('K2 Redo is next, with a focus ring', ringOk(redoBtn));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="layers-list"] > li').length === 2);

  const help = await tabTo((f) => f.name === 'Shortcuts');
  check('K3 Shortcuts is reached by Tab, with a focus ring', ringOk(help));
  await page.keyboard.press('Enter');
  const open1 = await page.evaluate(() => document.querySelectorAll(':popover-open').length);
  const helpText = (await page.locator('#editor-shortcuts').textContent()) ?? '';
  check('K3 Enter opens the shortcuts list, with every shortcut in it', open1 === 1 && /Ctrl\+Z/.test(helpText) && /Ctrl\+Y/.test(helpText) && /Delete/.test(helpText) && /Esc/.test(helpText) && /Arrow keys/.test(helpText), helpText.slice(0, 80));
  await page.keyboard.press('Escape');
  check('K3 Esc closes it, and focus returns to the Shortcuts button', (await page.evaluate(() => document.querySelectorAll(':popover-open').length)) === 0 && /Shortcuts/.test((await focusRing(page)).name));

  const sel = await tabTo((f) => /^Star, shape/.test(f.name));
  check('K4 a layer in the list is reached by Tab, with a focus ring and its state in its name', ringOk(sel) && /selected/.test(sel.name), sel.name);
  const hideBtn = await tabTo((f) => /^Hide Star/.test(f.name));
  await page.keyboard.press('Enter');
  check('K5 Hide by keyboard, announced', (await rows(page)).find((r) => r.name === 'Star')?.hidden === true && /Hid Star/.test((await live(page)) ?? ''), JSON.stringify(hideBtn));
  const lockBtn = await tabTo((f) => /^Lock Star/.test(f.name) || /^Unlock Star/.test(f.name));
  await page.keyboard.press('Enter');
  check('K5 Lock by keyboard, announced', (await rows(page)).find((r) => r.name === 'Star')?.locked === true && /Locked Star/.test((await live(page)) ?? ''), lockBtn.name);
  await page.getByRole('button', { name: /^Rectangle, shape/ }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('X (px)', { exact: true }).focus();
  check('K6 the X field has a visible focus ring', ringOk(await focusRing(page)));
  await page.keyboard.press('Control+A');
  await page.keyboard.type('350');
  await page.keyboard.press('Enter');
  check('K6 a number typed with the keyboard moves the layer', (await num(page, 'X (px)')) === 350);
  for (const label of ['Y (px)', 'Width (px)', 'Height (px)', 'Rotation (°)']) {
    await page.getByLabel(label, { exact: true }).focus();
    check(`K6 ${label} has a visible focus ring`, ringOk(await focusRing(page)));
  }
  await page.getByRole('button', { name: 'Add rectangle' }).focus();
  await page.keyboard.press('Escape');
  check('K7 Esc deselects when focus is on a tool', (await heading(page)) === 'Settings');
  await ctx.close();
}

// ================================================================================== C. contrast, motion, overflow, showcase
for (const width of [1440]) {
  const { ctx, page } = await open(width, { reducedMotion: 'reduce' });
  // the showcase design: navy tee, a headline, a star, a picture
  await page.getByRole('button', { name: 'Add text' }).click();
  await page.getByLabel('Your words').fill('KENZIE');
  await page.getByLabel('Font', { exact: true }).selectOption('Bebas Neue');
  await page.getByLabel('Font size (8 to 400)').fill('150');
  await page.waitForFunction(() => document.fonts.check('400 64px "Bebas Neue"'));
  await page.getByRole('button', { name: 'Add star' }).click();
  await page.getByRole('button', { name: 'Fill colour: Gold' }).click();
  await page.getByRole('button', { name: 'Add star' }).focus(); // arrow keys move the selected element: lay the design out by keyboard
  for (let i = 0; i < 15; i++) await page.keyboard.press('Shift+ArrowRight');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Add picture' }).click()]);
  await fc.setFiles(logo);
  await page.getByRole('heading', { name: 'Picture settings' }).waitFor();
  for (let i = 0; i < 12; i++) await page.keyboard.press('Shift+ArrowLeft');
  for (let i = 0; i < 9; i++) await page.keyboard.press('Shift+ArrowDown');
  // a hidden layer and a locked one, so the screenshot (and the contrast check) cover the dimmed rows too
  await page.getByRole('button', { name: 'Add circle' }).click();
  await page.getByRole('button', { name: 'Hide Circle' }).click();
  await page.getByRole('button', { name: 'Add line' }).click();
  await page.getByRole('button', { name: 'Lock Line' }).click();
  await page.getByRole('button', { name: /^logo, picture/ }).click(); // select the picture: its numeric fields show
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `design-showcase-${width}.png`), fullPage: true });
  await page.getByTestId('editor-host').screenshot({ path: path.join(out, `stage-showcase-${width}.png`) });
  // text panel for the screenshot
  await page.getByRole('button', { name: 'Add text' }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(out, `design-text-panel-${width}.png`), fullPage: true });

  report.overflow[width] = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: innerWidth, offenders: [...document.querySelectorAll('main *, section *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.sr-only')).slice(0, 5).map((e) => e.tagName + '.' + String(e.className).slice(0, 40)) }));
  check(`C1 nothing overflows horizontally at ${width}px`, report.overflow[width].scrollWidth <= report.overflow[width].innerWidth, JSON.stringify(report.overflow[width]));

  if (width === 1440) {
    report.motion = await page.evaluate(() => {
      const els = [...document.querySelectorAll('[data-testid="properties-panel"], [data-testid="properties-panel"] *, [data-testid="layers-panel"] *, [role="toolbar"] *, nav[aria-label="Design tools"], nav[aria-label="Design tools"] *')];
      const moving = els.filter((e) => { const s = getComputedStyle(e); return (parseFloat(s.transitionDuration) > 0.001) || (s.animationName !== 'none' && parseFloat(s.animationDuration) > 0.001); });
      return { checked: els.length, moving: moving.map((e) => e.tagName).slice(0, 5), reducedMotionMatches: matchMedia('(prefers-reduced-motion: reduce)').matches };
    });
    check('C2 reduced motion: the editor panels animate nothing', report.motion.moving.length === 0 && report.motion.reducedMotionMatches, JSON.stringify(report.motion));

    // contrast of every visible text in the rail and panel, from the rendered styles
    await page.getByRole('button', { name: 'Add text' }).click();
    report.contrast = await page.evaluate(() => {
      const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); const p = m[1].split(/[ ,\/]+/).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
      const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.a > 0.99) return c; } return { r: 245, g: 240, b: 232, a: 1 }; };
      const rows = [];
      for (const el of document.querySelectorAll('[data-testid="properties-panel"] *, [data-testid="layers-panel"] *, [role="toolbar"] *, nav[aria-label="Design tools"] *, [data-testid="editor-host"] ~ p')) {
        if (el.closest('.sr-only') || el.matches('svg, svg *, canvas, option, input[type=color], input[type=range]')) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const isField = el.matches('input, select, textarea');
        if (!own && !isField) continue;
        if (el.disabled) continue;
        const s = getComputedStyle(el);
        const fg = parse(s.color), bg = bgOf(el);
        const [hi, lo] = [L(fg), L(bg)].sort((a, b) => b - a);
        rows.push({ el: el.tagName.toLowerCase() + ':' + (el.textContent || el.value || '').trim().slice(0, 24), ratio: +(((hi + 0.05) / (lo + 0.05)).toFixed(2)), size: parseFloat(s.fontSize) });
      }
      rows.sort((a, b) => a.ratio - b.ratio);
      return { count: rows.length, lowest: rows.slice(0, 4), below45: rows.filter((r) => r.ratio < 4.5) };
    });
    check('C3 every text in the rail and panel is at least 4.5:1', report.contrast.below45.length === 0, JSON.stringify(report.contrast.below45));
  }
  await ctx.close();
}

// ============================================================================================== D. product page colours
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base + '/products/m-tee', { waitUntil: 'networkidle' });
  const imgSrcs = [];
  for (const colour of ['Black', 'White', 'Navy', 'Gray']) {
    await page.locator('label.option', { hasText: colour }).first().click();
    await page.waitForTimeout(120);
    const info = await page.evaluate(() => { const i = document.querySelector('.stitched img'); return { src: new URL(i.src).pathname, alt: i.alt, w: i.naturalWidth }; });
    imgSrcs.push(info);
  }
  report.product.images = imgSrcs;
  check('D1 the product picture follows the chosen colour', imgSrcs.map((i) => i.src).join() === '/garments/m-tee/black.webp,/garments/m-tee/white.webp,/garments/m-tee/navy.webp,/garments/m-tee/gray.webp' && imgSrcs.every((i) => i.w > 0));
  const text = (await page.textContent('body')) ?? '';
  check('D2 the old "stays one colour" copy is gone', !/one colour only|stays the same whichever|does not change when you pick/.test(text));
  await page.screenshot({ path: path.join(out, 'product-navy-1440.png'), fullPage: false });
  await ctx.close();
}

await browser.close();
check('E1 no console errors or warnings in any run', report.console.length === 0, report.console.join(' || '));
writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.checks.filter((c) => c.ok).length, failed: report.failures, fonts: report.fonts, contrast: { count: report.contrast.count, lowest: report.contrast.lowest }, motion: report.motion, overflow: report.overflow, product: report.product, console: report.console }, null, 2));
process.exit(report.failures.length ? 1 : 0);
