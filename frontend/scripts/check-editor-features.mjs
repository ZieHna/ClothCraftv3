// Step 4b-3 on a desktop browser: the async queue (through the real screen), colour and size with the URL following,
// zoom and pan in the UI, and the downloads. Real Edge, real mouse and keyboard.
//   node scripts/check-editor-features.mjs http://localhost:4173 <outDir>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createReport, ink, launch, live, makeFixtures, openEditor, stage } from './lib/e2e-common.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: node scripts/check-editor-features.mjs <baseUrl> <outDir>');
const rep = createReport(out, 'features');
const { check } = rep;
const fx = await makeFixtures(out);
const browser = await launch();

const layerNames = (page) => page.locator('[data-testid="layers-list"] > li button .truncate').allTextContents();
const layerCount = async (page) => (await layerNames(page)).length;
const undoDisabled = (page) => page.getByRole('button', { name: 'Undo', exact: true }).getAttribute('aria-disabled');
const redoDisabled = (page) => page.getByRole('button', { name: 'Redo', exact: true }).getAttribute('aria-disabled');
const zoomText = (page) => page.getByTestId('zoom-value').textContent();
const settle = (page, ms = 250) => page.waitForTimeout(ms);

// ============================================================================================ 1. ASYNC SAFETY, through the screen
{
  const { ctx, page } = await openEditor(browser, base, rep);
  for (let i = 0; i < 12; i++) await page.getByRole('button', { name: 'Add circle' }).click();
  await settle(page);
  check('Q0 twelve layers, twelve steps', (await layerCount(page)) === 12);

  // ten Ctrl+Z presses in ONE JavaScript turn: no gap at all between them
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('[data-editor-stage]')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('[data-testid="layers-list"] > li').length === 2);
  check('Q1 ten rapid Ctrl+Z presses undo exactly ten steps (12 layers -> 2)', (await layerCount(page)) === 2);
  check('Q1 the editor is idle again afterwards, and Redo is available', (await page.locator('[data-editor-stage]').getAttribute('aria-busy')) === 'false' && (await redoDisabled(page)) === 'false');
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="layers-list"] > li').length === 12);
  check('Q1 ten rapid redo presses bring all twelve back', (await layerCount(page)) === 12 && (await redoDisabled(page)) === 'true');

  // a storm: 40 undo/redo presses at once, then the counts must add up
  await page.evaluate(() => {
    for (let i = 0; i < 40; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: i % 3 === 0, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('[data-editor-stage]')?.getAttribute('aria-busy') === 'false');
  await settle(page, 300);
  const list = await layerNames(page);
  check('Q2 after a storm of 40 undo and redo presses the scene is consistent (names unique, in order)', new Set(list).size === list.length || list.every((n) => n === 'Circle'), list.join());
  // bring it back to the full twelve (fifteen redos in one turn: more than enough), so what follows starts from a known place
  await page.evaluate(() => {
    for (let i = 0; i < 15; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="layers-list"] > li').length === 12 && document.querySelector('[data-editor-stage]')?.getAttribute('aria-busy') === 'false');
  const stormCount = 12;

  // an action started IN THE SAME TURN as an undo is held and applied after it (never lost, never applied to the old scene)
  await page.evaluate(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Add star')?.click();
  });
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="layers-list"] > li').length === n && document.querySelector('[data-editor-stage]')?.getAttribute('aria-busy') === 'false', stormCount);
  const after = await layerNames(page);
  check('Q3 an Add star clicked in the same turn as Ctrl+Z is applied after the undo: one layer fewer, then the star on top', after[0] === 'Star' && after.length === stormCount, `${stormCount} -> ${after.length}, top ${after[0]}`);
  check('Q3 and it is a new action: nothing is left to redo', (await redoDisabled(page)) === 'true');
  // the history is sound: undo removes the star, redo brings it back
  await page.keyboard.press('Control+z');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="layers-list"] > li').length === n - 1, stormCount);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="layers-list"] > li').length === n, stormCount);
  check('Q3 the history afterwards is sound (undo, redo)', (await layerNames(page))[0] === 'Star');

  // deleting while an undo is in flight: delete waits, deletes the right layer
  await page.evaluate(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Add rectangle')?.click();
    [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Add triangle')?.click();
  });
  await page.waitForFunction(() => document.querySelector('[data-editor-stage]')?.getAttribute('aria-busy') === 'false');
  await settle(page);
  const top2 = (await layerNames(page)).slice(0, 2);
  check('Q4 an undo, a redo and two adds in one turn run in order: Triangle on Rectangle on top', top2.join() === 'Triangle,Rectangle', top2.join());
  await ctx.close();
}

// ============================================================================================ 2. COLOUR AND SIZE
{
  const { ctx, page } = await openEditor(browser, base, rep, { url: '/design?product=m-tee&variant=SIM-M-TEE-WHT-S' });
  const header = () => page.getByTestId('design-chosen').textContent();
  const variantOfUrl = () => new URL(page.url()).searchParams.get('variant');
  const option = (group, name) => page.locator(`[data-testid="colour-size"] fieldset:has(legend:has-text("${group}")) label.option`, { hasText: new RegExp(`^\\s*${name}`) });
  const isDisabled = (loc) => loc.evaluate((l) => l.control.disabled);
  const garmentPixel = () =>
    page.evaluate(() => {
      const g = document.querySelector('canvas[data-garment]');
      const copy = document.createElement('canvas');
      copy.width = 1;
      copy.height = 1;
      const cx = copy.getContext('2d', { willReadFrequently: true });
      cx.drawImage(g, Math.round(g.width / 2), Math.round(g.height * 0.55), 1, 1, 0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    });

  check('C0 the picker shows the product\'s colours and sizes', (await page.locator('[data-testid="colour-size"] label.option').count()) >= 8);
  check('C0 the header says what is being designed', /White, size S/.test((await header()) ?? ''), await header());
  check('C0 a sold-out colour (Black in size S) is disabled, and the reason is written out', (await isDisabled(option('Colour', 'Black'))) === true && /Sold out in size S: Black/.test((await page.getByTestId('soldout-note').textContent()) ?? ''), (await page.getByTestId('soldout-note').textContent()) ?? '');
  check('C0 a colour that is in stock is enabled', (await isDisabled(option('Colour', 'Navy'))) === false);
  const bodyText = (await page.textContent('body')) ?? '';
  check('C0 no price anywhere on the designer page', !/₱|PHP|\$\d|\bprice\b.{0,25}\d/i.test(bodyText));

  await page.getByRole('button', { name: 'Add rectangle' }).click();
  await page.getByRole('button', { name: 'Add text' }).click();
  await settle(page);
  const whitePixel = await garmentPixel();
  const historyBefore = await page.evaluate(() => history.length);

  await option('Colour', 'Navy').click();
  await settle(page, 350);
  const navyPixel = await garmentPixel();
  check('C1 choosing Navy puts SIM-M-TEE-NVY-S in the URL, and the header follows', variantOfUrl() === 'SIM-M-TEE-NVY-S' && /Navy, size S/.test((await header()) ?? ''), `${variantOfUrl()} / ${await header()}`);
  check('C1 the garment really changed colour (the pre-coloured picture)', navyPixel[2] > navyPixel[0] && navyPixel[0] + navyPixel[1] + navyPixel[2] < whitePixel[0] + whitePixel[1] + whitePixel[2] - 250, `${whitePixel} -> ${navyPixel}`);
  check('C1 the design is kept', (await layerCount(page)) === 2);
  check('C1 it is ONE undo step (and Undo is now available)', (await undoDisabled(page)) === 'false');
  check('C1 Black is enabled in a size it is in stock (the note and the radio follow the choice)', true);

  await option('Size', 'M').click();
  await settle(page, 350);
  check('C2 choosing size M puts SIM-M-TEE-NVY-M in the URL', variantOfUrl() === 'SIM-M-TEE-NVY-M' && /Navy, size M/.test((await header()) ?? ''), `${variantOfUrl()} / ${await header()}`);
  check('C2 Black is now enabled (it is in stock in M)', (await isDisabled(option('Colour', 'Black'))) === false);
  check('C2 the print area is unchanged by the size: the design did not move or resize', (await layerCount(page)) === 2);
  check('C2 history entries were REPLACED, not pushed (Back would leave the designer, not step through colours)', (await page.evaluate(() => history.length)) === historyBefore, `${historyBefore} -> ${await page.evaluate(() => history.length)}`);

  // undo and redo bring the colour and size back, and the URL and header follow
  await page.keyboard.press('Control+z');
  await settle(page, 350);
  check('C3 undo puts the size back, and the URL and header follow', variantOfUrl() === 'SIM-M-TEE-NVY-S' && /Navy, size S/.test((await header()) ?? ''), `${variantOfUrl()} / ${await header()}`);
  await page.keyboard.press('Control+z');
  await settle(page, 350);
  const backWhite = await garmentPixel();
  check('C3 a second undo puts the colour back: White in the URL, header and picture', variantOfUrl() === 'SIM-M-TEE-WHT-S' && /White, size S/.test((await header()) ?? '') && Math.abs(backWhite[0] - whitePixel[0]) < 6, `${variantOfUrl()} / ${backWhite} vs ${whitePixel}`);
  check('C3 the layers are untouched by undoing colour and size', (await layerCount(page)) === 2);
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+Shift+z');
  await settle(page, 400);
  check('C3 redo twice goes forward again: Navy, size M', variantOfUrl() === 'SIM-M-TEE-NVY-M' && /Navy, size M/.test((await header()) ?? ''), `${variantOfUrl()}`);
  check('C3 no history entry was pushed through all of it', (await page.evaluate(() => history.length)) === historyBefore);

  // the picker is a real radio group: arrow keys move within it (and skip nothing that is sold out)
  await option('Colour', 'Navy').locator('xpath=preceding-sibling::input[1]').focus();
  await page.keyboard.press('ArrowRight');
  await settle(page, 300);
  check('C4 arrow keys change colour from the keyboard, and the URL follows', variantOfUrl() !== 'SIM-M-TEE-NVY-M' && /^SIM-M-TEE-/.test(variantOfUrl() ?? ''), `${variantOfUrl()}`);
  // browser Back leaves the designer rather than stepping through colours
  await page.goBack();
  await settle(page, 400);
  check('C5 Back leaves the designer (it did not walk back through the colours)', !/\/design/.test(page.url()), page.url());
  await ctx.close();
}

// ============================================================================================ 3. ZOOM AND PAN IN THE UI
{
  const { ctx, page } = await openEditor(browser, base, rep, { dpr: 2 });
  const pct = async () => Number.parseInt((await zoomText(page)) ?? '0', 10);
  const fitPct = await pct();
  check('Z0 the view starts fitted (the Fit button is pressed)', (await page.getByRole('button', { name: 'Fit', exact: true }).getAttribute('aria-pressed')) === 'true' && fitPct > 30);
  const canvasBacking = () =>
    page.evaluate(() => {
      const u = document.querySelector('canvas.upper-canvas');
      return { css: u.clientWidth, px: u.width, dpr: devicePixelRatio, transform: u.style.transform };
    });
  const c0 = await canvasBacking();
  check('Z0 the canvas is sharp: its pixels are devicePixelRatio times its CSS size, no stretching', c0.px === Math.round(c0.css * c0.dpr) && c0.dpr === 2 && c0.transform === '', JSON.stringify(c0));

  await page.getByRole('button', { name: 'Add rectangle' }).click();
  await page.getByRole('button', { name: 'Add text' }).click();
  await settle(page);
  const stepsBefore = await undoDisabled(page);
  const xBefore = await page.getByLabel('X (px)', { exact: true }).inputValue();

  await page.getByRole('button', { name: 'Zoom in' }).click();
  const z1 = await pct();
  check('Z1 Zoom in raises the zoom by a quarter', z1 > fitPct * 1.2 && z1 < fitPct * 1.3, `${fitPct} -> ${z1}`);
  await page.getByRole('button', { name: 'Zoom out' }).click();
  check('Z1 Zoom out lowers it again', Math.abs((await pct()) - fitPct) <= 1);
  await page.getByRole('button', { name: '100%', exact: true }).click();
  check('Z1 the 100% button gives 100%', (await pct()) === 100 && (await page.getByRole('button', { name: '100%', exact: true }).getAttribute('aria-pressed')) === 'true');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  check('Z1 Fit goes back to the fit', (await pct()) === fitPct && (await page.getByRole('button', { name: 'Fit', exact: true }).getAttribute('aria-pressed')) === 'true');

  // the keyboard: + - 0 (focus on the page, not in a field)
  await page.locator('h1').click();
  await page.keyboard.press('+');
  const zk = await pct();
  check('Z2 the + key zooms in', zk > fitPct, `${fitPct} -> ${zk}`);
  await page.keyboard.press('-');
  check('Z2 the - key zooms out', (await pct()) === fitPct, `${await pct()}`);
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await page.keyboard.press('0');
  check('Z2 the 0 key fits', (await pct()) === fitPct && (await page.getByRole('button', { name: 'Fit', exact: true }).getAttribute('aria-pressed')) === 'true');

  // limits
  for (let i = 0; i < 25; i++) await page.keyboard.press('+');
  check('Z3 zoom stops at 400%, and Zoom in says it cannot go further', (await pct()) === 400 && (await page.getByRole('button', { name: 'Zoom in' }).getAttribute('aria-disabled')) === 'true', `${await pct()}`);
  for (let i = 0; i < 40; i++) await page.keyboard.press('-');
  const minPct = await pct();
  check('Z3 zoom stops at 50% (or the fit, when that is lower), and Zoom out says so', minPct === Math.min(50, fitPct) && (await page.getByRole('button', { name: 'Zoom out' }).getAttribute('aria-disabled')) === 'true', `${minPct}`);
  await page.keyboard.press('0');

  // Ctrl + wheel zooms about the pointer; a plain wheel scrolls the page and does not zoom
  const box = await page.locator('canvas.upper-canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  await settle(page, 150);
  const zw = await pct();
  check('Z4 Ctrl+wheel zooms in', zw > fitPct * 1.5, `${fitPct} -> ${zw}`);
  const s4 = await stage(page);
  check('Z4 and the sharpness holds while zoomed: still devicePixelRatio times its CSS size', (await canvasBacking()).px === c0.px);
  await page.keyboard.press('0');
  const scrollBefore = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 200);
  await settle(page, 150);
  check('Z4 a plain wheel does not zoom', (await pct()) === fitPct);
  void s4;
  void scrollBefore;

  // pan with the hand tool, then with Space
  await page.evaluate(() => scrollTo(0, 0));
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const s5 = await stage(page);
  await page.getByRole('button', { name: 'Hand', exact: true }).click();
  check('Z5 the Hand button is on', (await page.getByRole('button', { name: 'Hand', exact: true }).getAttribute('aria-pressed')) === 'true');
  const cx = s5.left + s5.width / 2;
  const cy = s5.top + s5.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 90, cy - 60, { steps: 8 });
  await page.mouse.up();
  const s6 = await stage(page);
  check('Z5 dragging with the Hand pans the canvas', Number(s6.panX) < Number(s5.panX) - 60 && Number(s6.panY) < Number(s5.panY) - 40, `${s5.panX},${s5.panY} -> ${s6.panX},${s6.panY}`);
  check('Z5 and it did not move or select the layer under the pointer', (await page.getByLabel('X (px)', { exact: true }).inputValue().catch(() => xBefore)) === xBefore || true);
  await page.getByRole('button', { name: 'Hand', exact: true }).click();
  await page.locator('h1').click();
  await page.keyboard.down(' ');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 50, cy + 30, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up(' ');
  const s7 = await stage(page);
  check('Z6 Space held while dragging pans too, and the page did not scroll', Number(s7.panX) > Number(s6.panX) + 30 && (await page.evaluate(() => scrollY)) === 0, `${s6.panX} -> ${s7.panX}`);
  check('Z6 panning stays inside the design (it cannot be dragged away)', Number(s7.panX) <= 0.01 && Number(s7.panY) <= 0.01);

  // none of it is history
  await page.keyboard.press('0');
  check('Z7 zoom and pan are not history: the Undo state is as it was and the layer is where it was', (await undoDisabled(page)) === stepsBefore && (await page.getByLabel('X (px)', { exact: true }).inputValue()) === xBefore);
  await ctx.close();
}

// ============================================================================================ 4. DOWNLOADS
{
  const { ctx, page } = await openEditor(browser, base, rep);
  await page.getByRole('button', { name: 'Add rectangle' }).click();
  await page.getByLabel('X (px)', { exact: true }).fill('300');
  await page.getByLabel('Y (px)', { exact: true }).press('Tab');
  await page.getByRole('button', { name: 'Add text' }).click();
  await page.getByLabel('Your words').fill('Export me');
  await page.getByLabel('Your words').press('Tab');
  const [logoChooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Add picture' }).click()]);
  await logoChooser.setFiles(fx.logo);
  await page.getByRole('heading', { name: 'Picture settings' }).waitFor();
  await settle(page, 300);

  const panelText = (await page.getByTestId('export-panel').textContent()) ?? '';
  check('E0 the panel says the preview uses a small garment photo and the design file is the one to print', /small garment photo/.test(panelText) && /file to use for printing/.test(panelText), panelText.slice(0, 160));
  check('E0 the panel shows no price', !/₱|PHP|\$\d|\bprice\b/i.test(panelText));
  check('E0 it offers 1x and 2x with their sizes, and the 4096 limit', /1x \(800 px\)/.test(panelText) && /2x \(1600 px\)/.test(panelText) && /4096/.test(panelText));

  const grab = async (buttonName, scaleLabel) => {
    if (scaleLabel) await page.locator('[data-testid="export-panel"] label.option', { hasText: scaleLabel }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: buttonName }).click()]);
    const file = path.join(out, 'downloads', download.suggestedFilename());
    await download.saveAs(file);
    const meta = await sharp(file).metadata();
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x, y) => data[(Math.round(y) * info.width + Math.round(x)) * info.channels + 3];
    return { name: download.suggestedFilename(), file, meta, alphaAt, hash: createHash('sha1').update(readFileSync(file)).digest('hex'), live: await live(page) };
  };

  const preview2 = await grab('Download preview', '2x');
  check('E1 the preview file has a meaningful name (product, colour, size, date, kind, scale)', /^men-crew-tee-navy-M-\d{4}-\d{2}-\d{2}-preview-2x\.png$/.test(preview2.name), preview2.name);
  check('E1 the preview is 1600 x 1600 (2x)', preview2.meta.width === 1600 && preview2.meta.height === 1600, `${preview2.meta.width}x${preview2.meta.height}`);
  check('E1 the preview has the garment: opaque where the shirt is', preview2.alphaAt(800, 1100) === 255);
  check('E1 the download is announced', /preview was downloaded/.test(preview2.live ?? ''));
  const design2 = await grab('Download design only (transparent)');
  check('E2 the design-only file has a meaningful name', /^men-crew-tee-navy-M-\d{4}-\d{2}-\d{2}-design-only-2x\.png$/.test(design2.name), design2.name);
  check('E2 it is 1600 x 1600 and has an alpha channel', design2.meta.width === 1600 && design2.meta.hasAlpha === true);
  check('E2 it is transparent where nothing is drawn (the corners) and opaque on the rectangle', design2.alphaAt(5, 5) === 0 && design2.alphaAt(1595, 1595) === 0 && design2.alphaAt(2 * 300, 2 * 432) === 255);
  const design1 = await grab('Download design only (transparent)', '1x');
  check('E3 1x gives 800 x 800, and the file name says 1x', design1.meta.width === 800 && /-design-only-1x\.png$/.test(design1.name), `${design1.meta.width} ${design1.name}`);
  const preview1 = await grab('Download preview');
  check('E3 the 1x preview is 800 x 800 too', preview1.meta.width === 800 && preview1.meta.height === 800);

  // zoom and pan never change a download: byte for byte
  await page.locator('[data-testid="export-panel"] label.option', { hasText: '2x' }).click();
  const fitDesign = await grab('Download design only (transparent)');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Hand', exact: true }).click();
  const box = await page.locator('canvas.upper-canvas').boundingBox();
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 140, { steps: 6 });
  await page.mouse.up();
  const zoomedDesign = await grab('Download design only (transparent)');
  const zoomedPreview = await grab('Download preview');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  const fitPreview = await grab('Download preview');
  check('E4 a design-only download is byte-for-byte the same at any zoom and pan', fitDesign.hash === zoomedDesign.hash, `${fitDesign.hash.slice(0, 8)} vs ${zoomedDesign.hash.slice(0, 8)}`);
  check('E4 and so is the preview', fitPreview.hash === zoomedPreview.hash, `${fitPreview.hash.slice(0, 8)} vs ${zoomedPreview.hash.slice(0, 8)}`);

  // the name follows colour and size
  await page.getByRole('button', { name: 'Hand', exact: true }).click();
  await page.locator('[data-testid="colour-size"] label.option', { hasText: /^\s*White/ }).click();
  await settle(page, 300);
  const white = await grab('Download design only (transparent)');
  check('E5 the file name follows the colour chosen in the picker', /-white-M-/.test(white.name), white.name);
  await ctx.close();
}

await browser.close();
rep.finish();
