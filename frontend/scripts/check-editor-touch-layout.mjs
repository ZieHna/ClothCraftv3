// Step 4b-3: touch gestures with REAL touch input, the layout at every width, bottom sheets, the on-screen keyboard
// (emulated) and the screenshots. Real Edge. Touch is sent through the DevTools protocol (Input.dispatchTouchEvent), so the
// page gets real Pointer Events with pointerType "touch", multi-touch included.
//   node scripts/check-editor-touch-layout.mjs http://localhost:4173 <outDir>
import path from 'node:path';
import { contrastOf, createReport, ink, launch, live, makeFixtures, openEditor, screenOf, stage, targetsOf, touchDriver, twoFingers } from './lib/e2e-common.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: node scripts/check-editor-touch-layout.mjs <baseUrl> <outDir>');
const rep = createReport(out, 'touch-layout');
const { check } = rep;
const fx = await makeFixtures(out);
const browser = await launch();
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(out, 'shots', name), ...opts });
const settle = (page, ms = 250) => page.waitForTimeout(ms);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const field = (page, label) => page.getByLabel(label, { exact: true });
const num = async (page, label) => Number(await field(page, label).inputValue());
const bar = (page, name) => page.getByRole('button', { name, exact: true });

async function openSheet(page, name, title) {
  await bar(page, name).tap().catch(() => bar(page, name).click());
  await page.locator('dialog[open]').waitFor();
  await settle(page, 220);
  return page.locator('dialog[open] h2').first().textContent().then((t) => t === title || (title instanceof RegExp && title.test(t ?? '')));
}
async function closeSheet(page) {
  await page.locator('dialog[open]').getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
}

// ================================================================================================= 1. TOUCH (phone, real fingers)
{
  const { ctx, page, cdp } = await openEditor(browser, base, rep, { width: 390, height: 844, dpr: 3, touch: true });
  const finger = touchDriver(cdp);
  const layout = await page.locator('[data-layout]').getAttribute('data-layout');
  // step 9: the bar also holds the Add to cart / Checkout row above its six tool buttons
  check('P0 a 390 px touch screen gets the phone layout, with a bottom tool bar of six buttons (and the cart row above them)', layout === 'phone' && (await page.getByTestId('phone-tools').locator('button').count()) === 6 && (await page.getByTestId('design-action-row').locator('button').count()) === 2);
  const s0 = await stage(page);
  check('P0 the canvas fills the width as a square', near(s0.width, 390, 1) && near(s0.height, s0.width, 1), `${s0.width}x${s0.height}`);
  check('P0 the pointer is recognised as coarse (a finger)', s0.pointer === 'coarse', s0.pointer);
  check('P0 the canvas is sharp at the screen\'s 3x: pixels are 3 times its CSS size', await page.evaluate(() => { const u = document.querySelector('canvas.upper-canvas'); return u.width === Math.round(u.clientWidth * devicePixelRatio) && devicePixelRatio === 3; }));

  await bar(page, 'Text').tap();
  await page.getByTestId('context-bar').waitFor();
  await settle(page);
  const sSel = await stage(page);
  check('P1 handles for a finger: the smallest touch target is at least 44 CSS px, measured on the selected layer', Number(sSel.handleTouchPx) >= 44, `${sSel.handleTouchPx} px`);
  check('P1 the layer\'s settings, rotate and delete are in a bar above the tool bar', (await page.getByTestId('context-bar').getByRole('button').count()) === 4);

  // one finger: drag the layer
  const start = await ink(page);
  const c = await screenOf(page, 320, 280);
  await finger.gesture([{ id: 1, x: c.x, y: c.y }], [{ id: 1, x: c.x + 70, y: c.y + 50 }], 14, 14);
  await settle(page, 200);
  const dragged = await ink(page);
  check('P2 one finger picks the layer and drags it', near(dragged.cx - start.cx, 70, 8) && near(dragged.cy - start.cy, 50, 8), `moved ${(dragged.cx - start.cx).toFixed(1)},${(dragged.cy - start.cy).toFixed(1)}`);
  await bar(page, 'Undo').tap();
  await settle(page, 250);
  const undone = await ink(page);
  check('P2 ONE undo puts the whole drag back', near(undone.cx, start.cx, 3) && near(undone.cy, start.cy, 3), `${undone.cx.toFixed(1)} vs ${start.cx.toFixed(1)}`);

  // two fingers on the selected layer: pinch resizes, twist rotates
  await openSheet(page, 'Settings', /settings/i).catch(() => null);
  const before = { w: await num(page, 'Width (px)'), r: await num(page, 'Rotation (°)') };
  await closeSheet(page);
  const centre = await screenOf(page, 320, 280);
  const steps0 = await page.getByRole('button', { name: 'Undo', exact: true }).getAttribute('aria-disabled');
  await finger.gesture(twoFingers(centre, 40, 0), twoFingers(centre, 90, 35), 16, 14);
  await settle(page, 250);
  await page.getByRole('button', { name: 'Settings' }).tap();
  await page.locator('dialog[open]').waitFor();
  await settle(page, 200);
  const after = { w: await num(page, 'Width (px)'), r: await num(page, 'Rotation (°)') };
  check('P3 two fingers on a selected layer: pinch scales it', near(after.w / before.w, 90 / 40, 0.25), `${before.w} -> ${after.w} (x${(after.w / before.w).toFixed(2)})`);
  check('P3 ...and a twist rotates it', near(after.r, 35, 4), `${after.r} deg`);
  await closeSheet(page);
  await bar(page, 'Undo').tap();
  await settle(page, 250);
  await page.getByRole('button', { name: 'Settings' }).tap();
  await page.locator('dialog[open]').waitFor();
  await settle(page, 200);
  check('P3 the whole pinch and twist is ONE history step', near(await num(page, 'Rotation (°)'), 0, 0.6) && near(await num(page, 'Width (px)'), before.w, 1.5), `${await num(page, 'Width (px)')} / ${await num(page, 'Rotation (°)')}`);
  void steps0;
  await closeSheet(page);

  // two fingers with nothing selected: zoom and pan the canvas
  const corner = await screenOf(page, 40, 40);
  await page.touchscreen.tap(corner.x, corner.y); // an empty spot: deselect
  await settle(page, 200);
  check('P4 tapping empty canvas deselects (the layer bar goes away)', (await page.getByTestId('context-bar').count()) === 0);
  const undoStateBefore = await page.getByRole('button', { name: 'Undo', exact: true }).getAttribute('aria-disabled');
  const v0 = await stage(page);
  const mid = { x: v0.left + v0.width / 2, y: v0.top + v0.height / 2 };
  await finger.gesture(twoFingers(mid, 30, 0), twoFingers(mid, 75, 0), 14, 14);
  await settle(page, 200);
  const v1 = await stage(page);
  check('P4 two fingers with nothing selected: pinch zooms the canvas', Number(v1.zoom) > Number(v0.zoom) * 2, `${v0.zoom} -> ${v1.zoom}`);
  const a = twoFingers(mid, 40, 0);
  await finger.gesture(a, a.map((p) => ({ ...p, x: p.x - 60, y: p.y - 40 })), 12, 14);
  await settle(page, 200);
  const v2 = await stage(page);
  check('P4 moving both fingers pans it', Number(v2.panX) < Number(v1.panX) - 30 && Number(v2.panY) < Number(v1.panY) - 15, `${v1.panX},${v1.panY} -> ${v2.panX},${v2.panY}`);
  check('P4 zoom and pan are not history: Undo is as it was', (await page.getByRole('button', { name: 'Undo', exact: true }).getAttribute('aria-disabled')) === undoStateBefore);
  await bar(page, 'More').tap();
  await page.locator('dialog[open]').waitFor();
  await page.locator('dialog[open]').getByRole('button', { name: 'Fit', exact: true }).tap();
  await closeSheet(page);

  // the page scrolls outside the canvas, never from the canvas
  await page.evaluate(() => scrollTo(0, 0));
  const h1 = await page.locator('h1').boundingBox();
  await finger.gesture([{ id: 1, x: 200, y: h1.y + 10 }], [{ id: 1, x: 200, y: h1.y - 150 }], 10, 12);
  await settle(page, 200);
  const scrolledOutside = await page.evaluate(() => scrollY);
  check('P5 a swipe outside the canvas scrolls the page', scrolledOutside > 80, `scrollY ${scrolledOutside}`);
  await page.evaluate(() => scrollTo(0, 0));
  await settle(page, 100);
  const sc = await stage(page);
  const canvasMid = { x: sc.left + sc.width / 2, y: sc.top + sc.height / 2 };
  await finger.gesture([{ id: 1, x: canvasMid.x, y: canvasMid.y + 80 }], [{ id: 1, x: canvasMid.x, y: canvasMid.y - 120 }], 10, 12);
  await settle(page, 200);
  check('P5 a swipe on the canvas does NOT scroll the page', (await page.evaluate(() => scrollY)) === 0, `scrollY ${await page.evaluate(() => scrollY)}`);

  // rotate and delete buttons
  await page.evaluate(() => scrollTo(0, 0));
  await bar(page, 'Text').tap();
  await page.getByTestId('context-bar').waitFor();
  await page.getByRole('button', { name: 'Rotate right 15 degrees' }).tap();
  await page.getByRole('button', { name: 'Rotate right 15 degrees' }).tap();
  await page.getByRole('button', { name: 'Rotate left 15 degrees' }).tap();
  await settle(page, 200);
  await page.getByRole('button', { name: 'Settings' }).tap();
  await page.locator('dialog[open]').waitFor();
  await settle(page, 200);
  check('P6 the rotate buttons turn the layer 15 degrees a tap', (await num(page, 'Rotation (°)')) === 15, `${await num(page, 'Rotation (°)')}`);
  await closeSheet(page);
  const delBtn = page.getByTestId('context-bar').getByRole('button', { name: /^Delete/ });
  const delBox = await delBtn.boundingBox();
  check('P6 the delete button is easy to tap (at least 44 x 44)', delBox.width >= 44 && delBox.height >= 44, `${delBox.width}x${delBox.height}`);
  const layersBefore = await page.evaluate(() => 0);
  void layersBefore;
  await delBtn.tap();
  await settle(page, 200);
  check('P6 delete removes the layer (the bar goes away)', (await page.getByTestId('context-bar').count()) === 0);
  await ctx.close();
}

// ================================================================================================= 2. LAYOUT AT EVERY WIDTH
const widths = [
  { w: 320, h: 640, touch: true, expect: 'phone' },
  { w: 360, h: 740, touch: true, expect: 'phone' },
  { w: 390, h: 844, touch: true, expect: 'phone' },
  { w: 412, h: 915, touch: true, expect: 'phone' },
  { w: 844, h: 390, touch: true, expect: 'phone', name: 'phone landscape' },
  { w: 768, h: 1024, touch: false, expect: 'wide' },
  { w: 1024, h: 768, touch: false, expect: 'wide' },
  { w: 1440, h: 900, touch: false, expect: 'wide' },
];
rep.report.data.layouts = [];
for (const { w, h, touch, expect, name } of widths) {
  const { ctx, page } = await openEditor(browser, base, rep, { width: w, height: h, dpr: touch ? 2 : 1, touch });
  const label = name ?? `${w}px`;
  // a design with text, a shape and a picture: the widest and tallest things the screen holds
  const phone = expect === 'phone';
  if (phone) {
    await bar(page, 'Text').click();
    await bar(page, 'Shapes').click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Star' }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await page.locator('[data-testid="picture-input"]').setInputFiles(fx.logo);
  } else {
    await page.getByRole('button', { name: 'Add text' }).click();
    await page.getByRole('button', { name: 'Add star' }).click();
    await page.locator('[data-testid="picture-input"]').setInputFiles(fx.logo);
  }
  await settle(page, 500);
  const attr = await page.locator('[data-layout]').getAttribute('data-layout');
  const m = await page.evaluate(() => {
    const u = document.querySelector('canvas.upper-canvas').getBoundingClientRect();
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth, canvasLeft: u.left, canvasRight: u.right, canvasW: u.width, canvasH: u.height, offenders: [...document.querySelectorAll('main *')].filter((e) => !e.closest('.sr-only') && !e.closest('dialog:not([open])') && e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed').slice(0, 4).map((e) => e.tagName + '.' + String(e.className).slice(0, 36)) };
  });
  rep.report.data.layouts.push({ label, layout: attr, canvas: Math.round(m.canvasW), scrollWidth: m.scrollWidth });
  check(`L1 ${label}: layout is "${expect}"`, attr === expect, attr ?? '');
  check(`L1 ${label}: no horizontal scroll`, m.scrollWidth <= m.innerWidth, `scrollWidth ${m.scrollWidth} > ${m.innerWidth}; ${m.offenders.join(', ')}`);
  check(`L1 ${label}: the whole canvas is on screen sideways and is square`, m.canvasLeft >= -0.5 && m.canvasRight <= m.innerWidth + 0.5 && Math.abs(m.canvasW - m.canvasH) < 1.5, `${m.canvasLeft}..${m.canvasRight} ${m.canvasW}x${m.canvasH}`);
  if (phone) {
    const fit = await page.evaluate(() => {
      const u = document.querySelector('canvas.upper-canvas').getBoundingClientRect();
      const bars = [...document.querySelectorAll('[data-testid="context-bar"], [data-testid="phone-toolbar"]')].map((b) => b.getBoundingClientRect().top);
      return { top: Math.round(u.top), bottom: Math.round(u.bottom), barTop: Math.round(Math.min(...bars)), bars: bars.length };
    });
    check(`L4 ${label}: the whole canvas is visible, above the fixed bars (no scrolling to see it)`, fit.bars === 2 && fit.top >= -1 && fit.bottom <= fit.barTop + 1, JSON.stringify(fit));
  }
  if (phone && h > w) check(`L1 ${label}: in portrait the canvas fills the width`, Math.abs(m.canvasW - w) < 1.5, `${m.canvasW}`);
  if (phone) {
    const t = await targetsOf(page, '[data-layout="phone"]');
    const small = t.filter((x) => x.w < 44 || x.h < 44);
    check(`L2 ${label}: every target is at least 44 x 44 px (${t.length} measured)`, small.length === 0, small.slice(0, 6).map((x) => `${x.what} ${x.w}x${x.h}`).join('; '));
    const toolbar = await page.getByTestId('phone-toolbar').boundingBox();
    check(`L2 ${label}: the bottom bar sits on the screen's bottom edge, inside the width`, near(toolbar.y + toolbar.height, h, 1) && toolbar.width <= w + 0.5, JSON.stringify(toolbar));
  } else if (w === 768) {
    const side = await page.evaluate(() => {
      const u = document.querySelector('canvas.upper-canvas').getBoundingClientRect();
      const p = document.querySelector('[data-testid="layers-panel"]').getBoundingClientRect();
      const r = document.querySelector('nav[aria-label="Design tools"]').getBoundingClientRect();
      return { panelBesideCanvas: p.left >= u.right - 1, toolsAbove: r.bottom <= u.top + 1 };
    });
    check('L3 768px (tablet): the tools sit in a row above the canvas and the panels beside it', side.panelBesideCanvas && side.toolsAbove, JSON.stringify(side));
  }
  await shot(page, `layout-${label.replace(/\s+/g, '-')}.png`, { fullPage: !phone });
  await ctx.close();
}

// ================================================================================================= 3. BOTTOM SHEETS (touch, then keyboard only)
{
  const { ctx, page } = await openEditor(browser, base, rep, { width: 390, height: 844, dpr: 3, touch: true, reducedMotion: 'no-preference' });
  await bar(page, 'Text').tap();
  await page.locator('[data-testid="picture-input"]').setInputFiles(fx.logo);
  await settle(page, 500);
  const sheets = [
    ['Shapes', 'Shapes'],
    ['Layers', 'Layers'],
    ['Colour', 'Colour and size'],
    ['More', 'More'],
  ];
  for (const [button, title] of sheets) {
    await bar(page, button).tap();
    await page.locator('dialog[open]').waitFor();
    await settle(page, 250);
    const heading = await page.locator('dialog[open] h2').first().textContent();
    check(`S1 the ${button} sheet opens with its title`, heading === title, heading ?? '');
    const info = await page.evaluate(() => {
      const d = document.querySelector('dialog[open]');
      const r = d.getBoundingClientRect();
      return { inside: d.contains(document.activeElement), overflow: d.scrollWidth > d.clientWidth + 1, bottom: r.bottom, innerHeight, width: r.width, anim: getComputedStyle(d).animationName };
    });
    check(`S1 ${button}: focus is inside the sheet, nothing overflows sideways, it sits on the bottom edge and spans the width`, info.inside && !info.overflow && near(info.bottom, info.innerHeight, 1) && near(info.width, 390, 1), JSON.stringify(info));
    check(`S1 ${button}: with normal motion the sheet slides up (animation "${info.anim}")`, info.anim === 'sheet-up');
    const t = await targetsOf(page, 'dialog[open]');
    const small = t.filter((x) => x.w < 44 || x.h < 44);
    check(`S1 ${button}: every target in the sheet is at least 44 x 44 (${t.length})`, small.length === 0, small.slice(0, 6).map((x) => `${x.what} ${x.w}x${x.h}`).join('; '));
    const ratio = await contrastOf(page, 'dialog[open] *');
    check(`S1 ${button}: text contrast is at least 4.5:1 (${ratio.count} measured)`, ratio.below45.length === 0, JSON.stringify(ratio.below45));
    await shot(page, `sheet-${button.toLowerCase()}-390.png`);
    await closeSheet(page);
    check(`S1 ${button}: Close closes it, and focus goes back to the button that opened it`, (await page.evaluate(() => document.activeElement?.textContent?.trim())) === button);
  }
  // the sheets do real work
  await bar(page, 'Shapes').tap();
  await page.locator('dialog[open]').getByRole('button', { name: 'Star' }).tap();
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  await bar(page, 'Layers').tap();
  await page.locator('dialog[open]').waitFor();
  const names = await page.locator('dialog[open] [data-testid="layers-list"] > li button .truncate').allTextContents();
  check('S2 the Layers sheet lists the layers, top first, without the garment', names.join() === 'Star,logo,Your text', names.join());
  await page.locator('dialog[open]').getByRole('button', { name: 'Hide Star' }).tap();
  check('S2 Hide works from the sheet', (await page.locator('dialog[open]').textContent())?.includes('Hidden') === true);
  await closeSheet(page);
  await bar(page, 'Colour').tap();
  await page.locator('dialog[open]').waitFor();
  await page.locator('dialog[open] label.option', { hasText: /^\s*White/ }).tap();
  await settle(page, 400);
  check('S2 the Colour sheet changes the colour, and the URL follows', new URL(page.url()).searchParams.get('variant') === 'SIM-M-TEE-WHT-M', page.url());
  await closeSheet(page);
  await bar(page, 'More').tap();
  await page.locator('dialog[open]').waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('dialog[open]').getByRole('button', { name: 'Download preview' }).tap()]);
  check('S2 More holds undo, zoom, the downloads and the touch help; the preview downloads', /-preview-2x\.png$/.test(download.suggestedFilename()) && (await page.locator('dialog[open] [data-testid="touch-help"]').count()) === 1 && (await page.locator('dialog[open] [data-testid="zoom-controls"]').count()) === 1, download.suggestedFilename());
  const help = (await page.locator('dialog[open] [data-testid="touch-help"]').textContent()) ?? '';
  check('S2 the help states the two-finger rule', /Two fingers with a layer selected/.test(help) && /Two fingers with nothing selected/.test(help) && /tap an empty spot first to deselect/.test(help));
  await closeSheet(page);
  await ctx.close();
}
{
  // reduced motion: no slide
  const { ctx, page } = await openEditor(browser, base, rep, { width: 390, height: 844, dpr: 2, touch: true, reducedMotion: 'reduce' });
  await bar(page, 'Layers').tap();
  await page.locator('dialog[open]').waitFor();
  const anim = await page.evaluate(() => getComputedStyle(document.querySelector('dialog[open]')).animationName);
  check('S3 reduced motion: the sheet does not animate', anim === 'none', anim);
  await ctx.close();
}
{
  // keyboard only, on a phone-width window with no touch
  const { ctx, page } = await openEditor(browser, base, rep, { width: 390, height: 844, dpr: 1, touch: false });
  await bar(page, 'Text').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('context-bar').waitFor();
  const tabTo = async (matcher, cap = 40) => {
    for (let i = 0; i < cap; i++) {
      await page.keyboard.press('Tab');
      const f = await page.evaluate(() => ({ name: (document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '').trim().slice(0, 40), outline: parseFloat(getComputedStyle(document.activeElement).outlineWidth) }));
      if (matcher(f)) return f;
    }
    throw new Error('Tab never reached the target');
  };
  await page.evaluate(() => document.activeElement?.blur());
  const layersBtn = await tabTo((f) => f.name === 'Layers');
  check('K1 keyboard only: Tab reaches the Layers button with a visible focus ring', layersBtn.outline >= 2, JSON.stringify(layersBtn));
  await page.keyboard.press('Enter');
  await page.locator('dialog[open]').waitFor();
  let escaped = 0;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    // inside the sheet, or on nothing at all (a modal dialog lets Tab reach the browser's own toolbar, which leaves document.body focused): both are fine; focus on the PAGE behind the sheet is not
    if (!(await page.evaluate(() => { const a = document.activeElement; return !a || a === document.body || !!document.querySelector('dialog[open]')?.contains(a); }))) escaped++;
  }
  check('K1 the sheet traps focus: 40 Tab presses never leave it', escaped === 0, `${escaped} escapes`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  check('K1 Esc closes the sheet and focus returns to the Layers button', (await page.evaluate(() => document.activeElement?.textContent?.trim())) === 'Layers');
  for (const [name, title] of [['Colour', 'Colour and size'], ['More', 'More'], ['Shapes', 'Shapes']]) {
    await bar(page, name).focus();
    await page.keyboard.press('Enter');
    await page.locator('dialog[open]').waitFor();
    check(`K2 ${name}: Enter opens it, focus is inside, with its title`, (await page.locator('dialog[open] h2').first().textContent()) === title && (await page.evaluate(() => !!document.querySelector('dialog[open]')?.contains(document.activeElement))));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  }
  await page.getByTestId('context-bar').getByRole('button', { name: 'Settings' }).focus();
  await page.keyboard.press('Enter');
  await page.locator('dialog[open]').waitFor();
  await page.getByLabel('X (px)', { exact: true }).focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('333');
  await page.keyboard.press('Enter');
  check('K3 the numeric fields work from the keyboard inside the Settings sheet', (await num(page, 'X (px)')) === 333);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  await ctx.close();
}

// ================================================================================================= 4. THE ON-SCREEN KEYBOARD (emulated)
for (const width of [390, 360]) {
  const { ctx, page } = await openEditor(browser, base, rep, { width, height: 780, dpr: 3, touch: true });
  await bar(page, 'Text').tap();
  await page.getByTestId('context-bar').waitFor();
  await page.getByRole('button', { name: 'Settings' }).tap();
  await page.locator('dialog[open]').waitFor();
  await settle(page, 250);
  const canvasTopBefore = await page.evaluate(() => document.querySelector('canvas.upper-canvas').getBoundingClientRect().top + scrollY);
  await page.getByLabel('Your words').tap();
  // emulate the keyboard: the visual viewport shrinks (Android "resizes-visual" and iOS behave like this) while the layout viewport stays
  await page.evaluate((visible) => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => visible });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    vv.dispatchEvent(new Event('resize'));
  }, 420);
  await settle(page, 450);
  const kb = await page.evaluate(() => {
    const d = document.querySelector('dialog[open]');
    const t = document.querySelector('textarea#' + CSS.escape(document.activeElement.id)) ?? document.activeElement;
    const r = t.getBoundingClientRect();
    const dr = d.getBoundingClientRect();
    return {
      vvBottom: getComputedStyle(document.documentElement).getPropertyValue('--vv-bottom'),
      fieldTop: r.top,
      fieldBottom: r.bottom,
      sheetTop: dr.top,
      sheetBottom: dr.bottom,
      toolbars: document.querySelectorAll('[data-testid="phone-toolbar"], [data-testid="context-bar"]').length,
      canvasTop: document.querySelector('canvas.upper-canvas').getBoundingClientRect().top + scrollY,
      focused: document.activeElement?.tagName,
    };
  });
  check(`KB1 ${width}px: the sheet sits above the keyboard (its bottom is at the top of the keyboard)`, near(kb.sheetBottom, 420, 2) && kb.vvBottom === '360px', JSON.stringify(kb));
  check(`KB1 ${width}px: the focused text box is inside the visible part`, kb.focused === 'TEXTAREA' && kb.fieldTop >= 0 && kb.fieldBottom <= 420, `${kb.fieldTop}..${kb.fieldBottom}`);
  check(`KB1 ${width}px: the bottom bars get out of the way while typing`, kb.toolbars === 0);
  check(`KB1 ${width}px: the canvas was not shifted away`, near(kb.canvasTop, canvasTopBefore, 1), `${canvasTopBefore} -> ${kb.canvasTop}`);
  await page.keyboard.type(' typed');
  await shot(page, `keyboard-open-${width}.png`);
  // keyboard closes again
  await page.evaluate(() => {
    const vv = window.visualViewport;
    delete vv.height;
    delete vv.offsetTop;
    vv.dispatchEvent(new Event('resize'));
  });
  await page.getByLabel('Your words').blur();
  await settle(page, 300);
  await page.locator('dialog[open]').getByRole('button', { name: 'Close', exact: true }).click();
  await settle(page, 200);
  check(`KB2 ${width}px: when the keyboard closes the tool bars come back`, (await page.getByTestId('phone-toolbar').count()) === 1);
  await ctx.close();
}

// ================================================================================================= 5. CONTRAST of the phone bars, and screenshots
{
  const { ctx, page } = await openEditor(browser, base, rep, { width: 390, height: 844, dpr: 2, touch: true, reducedMotion: 'reduce' });
  await bar(page, 'Text').tap();
  await page.locator('[data-testid="picture-input"]').setInputFiles(fx.logo);
  await settle(page, 400);
  const r = await contrastOf(page, '[data-testid="phone-toolbar"] *, [data-testid="context-bar"] *, [role="toolbar"] *');
  check(`X1 the phone tool bar, layer bar and history bar are at least 4.5:1 (${r.count} measured)`, r.below45.length === 0, JSON.stringify(r.below45));
  rep.report.data.phoneContrastLowest = r.lowest;
  await ctx.close();
}
for (const [w, h, touch] of [
  [1440, 900, false],
  [768, 1024, false],
  [390, 844, true],
  [360, 740, true],
]) {
  const { ctx, page } = await openEditor(browser, base, rep, { width: w, height: h, dpr: touch ? 3 : 1, touch });
  const phone = w < 640;
  if (phone) {
    await bar(page, 'Text').tap();
    await page.locator('[data-testid="picture-input"]').setInputFiles(fx.logo);
    await settle(page, 400);
    await bar(page, 'Shapes').tap();
    await page.locator('dialog[open]').getByRole('button', { name: 'Star' }).tap();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  } else {
    await page.getByRole('button', { name: 'Add text' }).click();
    await page.locator('[data-testid="picture-input"]').setInputFiles(fx.logo);
    await settle(page, 400);
    await page.getByRole('button', { name: 'Add star' }).click();
  }
  await settle(page, 300);
  await shot(page, `selection-${w}.png`, { fullPage: !phone });
  if (phone) {
    await bar(page, 'Layers').tap();
    await page.locator('dialog[open]').waitFor();
    await settle(page, 300);
    await shot(page, `layers-sheet-${w}.png`);
    await closeSheet(page);
    await bar(page, 'Colour').tap();
    await page.locator('dialog[open]').waitFor();
    await settle(page, 300);
    await shot(page, `colour-sheet-${w}.png`);
    await closeSheet(page);
    await bar(page, 'More').tap();
    await page.locator('dialog[open]').waitFor();
    await settle(page, 300);
    await page.locator('dialog[open] [data-testid="export-panel"]').scrollIntoViewIfNeeded();
    await shot(page, `more-export-sheet-${w}.png`);
    await closeSheet(page);
    await page.getByRole('button', { name: 'Settings' }).tap();
    await page.locator('dialog[open]').waitFor();
    await settle(page, 300);
    await shot(page, `settings-sheet-${w}.png`);
    await closeSheet(page);
  } else {
    await page.getByTestId('layers-panel').screenshot({ path: path.join(out, 'shots', `layers-panel-${w}.png`) });
    await page.getByTestId('garment-panel').screenshot({ path: path.join(out, 'shots', `colour-size-panel-${w}.png`) });
    await page.getByTestId('export-panel').screenshot({ path: path.join(out, 'shots', `export-buttons-${w}.png`) });
  }
  await ctx.close();
}

await browser.close();
rep.finish();
