// Step 4b-3 performance, measured in real Edge on the built app, with a busy design: 20 text and shape layers and 8
// pictures (each about 2 MB). Frame rate while dragging, pinching and zooming, at normal speed and with the CPU slowed 4x
// (DevTools protocol); a cold decode of a real large photo; the JS heap and blob URLs over 100 history steps.
//   node scripts/check-editor-perf.mjs http://localhost:4173 <outDir>
import { statSync } from 'node:fs';
import { createReport, ink, launch, makeFixtures, openEditor, stage, touchDriver, twoFingers } from './lib/e2e-common.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: node scripts/check-editor-perf.mjs <baseUrl> <outDir>');
const rep = createReport(out, 'perf');
const { check, report } = rep;
const fx = await makeFixtures(out);
const browser = await launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.error('[perf ' + new Date().toISOString().slice(11, 19) + '] ' + m);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const layerCount = (page) => page.locator('[data-testid="layers-list"] > li').count();

async function heap(page) {
  return page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      window.gc?.();
      await new Promise((r) => setTimeout(r, 40));
    }
    return performance.memory?.usedJSHeapSize ?? 0;
  });
}

/** frames drawn while `action` runs: average fps, the slowest frame, and how many frames took over 50 ms (visible jank) */
async function frames(page, action) {
  await page.evaluate(() => {
    window.__frames = [];
    window.__running = true;
    const loop = (t) => {
      if (!window.__running) return;
      window.__frames.push(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const t0 = Date.now();
  await action();
  const seconds = (Date.now() - t0) / 1000;
  const f = await page.evaluate(() => {
    window.__running = false;
    return window.__frames;
  });
  const gaps = f.slice(1).map((t, i) => t - f[i]);
  return { fps: +(f.length / seconds).toFixed(1), frames: f.length, seconds: +seconds.toFixed(2), worstMs: +Math.max(...gaps, 0).toFixed(1), p95Ms: +([...gaps].sort((a, b) => a - b)[Math.floor(gaps.length * 0.95)] ?? 0).toFixed(1), over50ms: gaps.filter((g) => g > 50).length };
}

// ================================================================================================= the busy design
const { ctx, page, cdp } = await openEditor(browser, base, rep, { width: 1280, height: 900, touch: true, mobile: false });
await ctx.addInitScript(() => {
  // count blob URLs, to prove history does not create new ones
  const make = URL.createObjectURL.bind(URL);
  const free = URL.revokeObjectURL.bind(URL);
  window.__urls = { created: 0, revoked: 0 };
  URL.createObjectURL = (b) => {
    window.__urls.created++;
    return make(b);
  };
  URL.revokeObjectURL = (u) => {
    window.__urls.revoked++;
    return free(u);
  };
});
await page.reload({ waitUntil: 'networkidle' });
await page.locator('[data-testid="editor-host"] canvas.upper-canvas').waitFor({ state: 'attached' });
await page.waitForFunction(() => !document.querySelector('nav[aria-label="Design tools"] button')?.disabled);
await sleep(400);
const finger = touchDriver(await ctx.newCDPSession(page));
const heapEmpty = await heap(page);

say('building the design');
const t0 = Date.now();
for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Add text' }).click();
const kinds = ['rectangle', 'circle', 'triangle', 'star', 'line'];
for (let i = 0; i < 14; i++) await page.getByRole('button', { name: `Add ${kinds[i % 5]}` }).click();
for (const [i, file] of fx.noise.entries()) {
  await page.locator('[data-testid="picture-input"]').setInputFiles(file);
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="layers-list"] > li').length === n, 20 + i + 1);
}
await sleep(500);
report.data.build = { layers: await layerCount(page), pictures: 8, pictureMBEach: +(statSync(fx.noise[0]).size / 1048576).toFixed(2), buildSeconds: +((Date.now() - t0) / 1000).toFixed(1) };
check('F0 the busy design is 28 layers: 20 text and shapes, 8 pictures', (await layerCount(page)) === 28);
const heapBuilt = await heap(page);

// the top layer is the last picture, and it is selected
const x = Number(await page.getByLabel('X (px)', { exact: true }).inputValue());
const y = Number(await page.getByLabel('Y (px)', { exact: true }).inputValue());
const s0 = await stage(page);
const centre = { x: s0.left + (x + 0) * Number(s0.zoom) + Number(s0.panX), y: s0.top + y * Number(s0.zoom) + Number(s0.panY) };
const cpuProbe = () =>
  page.evaluate(() => {
    const t = performance.now();
    let x = 0;
    for (let i = 0; i < 3e7; i++) x += Math.sqrt(i) % 3;
    return { ms: performance.now() - t, x: x > 0 };
  });
const slow = async (rate) => {
  const c = await ctx.newCDPSession(page);
  await c.send('Emulation.setCPUThrottlingRate', { rate });
  return c;
};

for (const rate of [1, 4]) {
  const label = rate === 1 ? 'normal' : 'cpu4x';
  say('measuring at ' + label);
  const throttle = await slow(rate);
  report.data[`cpuProbe_${label}`] = { ms: Math.round((await cpuProbe()).ms), note: 'the same 30 million sqrt operations, timed in the page' };
  // ---- one pointer drags the top layer in a figure of eight, at about 120 moves a second, for 2 seconds
  report.data[`drag_${label}`] = await frames(page, async () => {
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    const N = 240;
    for (let i = 1; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      await page.mouse.move(centre.x + Math.sin(a) * 90, centre.y + Math.sin(2 * a) * 50);
      await sleep(8);
    }
    await page.mouse.up();
  });
  // ---- two fingers pinch and twist the selected layer
  const layerBefore = await page.getByLabel('Width (px)', { exact: true }).inputValue();
  const c2 = { x: centre.x, y: centre.y };
  report.data[`pinch_${label}`] = await frames(page, async () => {
    await finger.gesture(twoFingers(c2, 40, 0), twoFingers(c2, 110, 70), 120, 14);
  });
  check(`F1 (${label}) the pinch of a layer changed it: width ${layerBefore} -> ${await page.getByLabel('Width (px)', { exact: true }).inputValue()}`, (await page.getByLabel('Width (px)', { exact: true }).inputValue()) !== layerBefore);
  // ---- two fingers zoom the whole canvas (every one of the 28 layers is redrawn each frame)
  await page.keyboard.press('Escape');
  await sleep(100);
  const sv = await stage(page);
  const mid = { x: sv.left + sv.width / 2, y: sv.top + sv.height / 2 };
  report.data[`zoom_${label}`] = await frames(page, async () => {
    await finger.gesture(twoFingers(mid, 30, 0), twoFingers(mid, 120, 0), 120, 14);
  });
  await page.keyboard.press('0');
  await sleep(150);
  // reselect the top layer for the next round
  await page.getByRole('button', { name: /^logo|^noise|^noise-7/ }).first().click().catch(() => {});
  await throttle.send('Emulation.setCPUThrottlingRate', { rate: 1 });
}
report.data.throttleSlowdown = +(report.data.cpuProbe_cpu4x.ms / Math.max(1, report.data.cpuProbe_normal.ms)).toFixed(2);
check(`F2 the CPU throttle (set to 4x) really slows the page: the probe takes ${report.data.throttleSlowdown}x as long`, report.data.throttleSlowdown > 1.8, // the emulator slows this probe by 2.3x to 3x in practice, not the nominal 4x: report the measured ratio, do not trust the label
   JSON.stringify([report.data.cpuProbe_normal, report.data.cpuProbe_cpu4x]));
for (const [name, v] of Object.entries(report.data).filter(([k]) => /^(drag|pinch|zoom)_/.test(k))) {
  check(`F2 ${name}: ${v.fps} fps, slowest frame ${v.worstMs} ms, ${v.over50ms} frames over 50 ms`, v.frames > 10);
}

say('history cost');
// ================================================================================================= history cost on this design
say('selecting a picture');
await page.getByRole('button', { name: /^noise-7|^noise/ }).first().click();
await page.waitForFunction(() => !!document.querySelector('[data-testid="properties-panel"] h2')?.textContent?.includes('Picture'));
const urlsBefore = await page.evaluate(() => ({ ...window.__urls }));
const xf = page.getByLabel('X (px)', { exact: true });
const tHist = Date.now();
for (let i = 1; i <= 100; i++) {
  const t = Date.now();
  await xf.fill(String(300 + (i % 40)));
  await xf.press('Enter');
  if (i === 1 || i % 20 === 0 || Date.now() - t > 1500) say('step ' + i + ' took ' + (Date.now() - t) + ' ms');
}
await sleep(300);
const heapAfter100 = await heap(page);
const hist100Seconds = (Date.now() - tHist) / 1000;
// undo times, one at a time: how long from the keypress until the editor is idle and Redo is available
await page.evaluate(() => document.activeElement?.blur()); // a text field keeps Ctrl+Z for itself, so leave it first
const undoMs = [];
for (let i = 0; i < 12; i++) {
  const ms = await page.evaluate(async () => {
    const redo = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Redo');
    const before = redo.getAttribute('aria-disabled');
    const t = performance.now();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    while (document.querySelector('[data-editor-stage]').getAttribute('aria-busy') === 'true' || (before === 'true' && redo.getAttribute('aria-disabled') === 'true')) {
      if (performance.now() - t > 4000) return -1; // never wait forever
      await new Promise((r) => requestAnimationFrame(r));
    }
    return performance.now() - t;
  });
  undoMs.push(ms);
  await sleep(60);
}
const tTen = await page.evaluate(async () => {
  const t = performance.now();
  for (let i = 0; i < 10; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  while (document.querySelector('[data-editor-stage]').getAttribute('aria-busy') === 'true') {
    if (performance.now() - t > 8000) return -1;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return performance.now() - t;
});
const urlsAfter = await page.evaluate(() => ({ ...window.__urls }));
report.data.history100 = {
  stepsMadeSeconds: +hist100Seconds.toFixed(1),
  heapEmptyKB: Math.round(heapEmpty / 1024),
  heapBuiltKB: Math.round(heapBuilt / 1024),
  heapAfter100StepsKB: Math.round(heapAfter100 / 1024),
  heapGrowthFor100StepsKB: Math.round((heapAfter100 - heapBuilt) / 1024),
  perStepKB: +((heapAfter100 - heapBuilt) / 100 / 1024).toFixed(1),
  ifEveryStepCopiedPicturesMB: Math.round((8 * statSync(fx.noise[0]).size * 100) / 1048576),
  blobUrlsCreatedByTheDesign: urlsBefore.created,
  blobUrlsCreatedBy100StepsAndUndoRedo: urlsAfter.created - urlsBefore.created,
};
report.data.undo = { undoMedianMs: +median(undoMs).toFixed(1), undoWorstMs: +Math.max(...undoMs).toFixed(1), tenRapidRedosTotalMs: +tTen.toFixed(1), layers: 28 };
check('H1 100 steps on 28 layers with 8 pictures cost under 25 MB of heap (a copy of the pictures per step would be over a gigabyte)', heapAfter100 - heapBuilt < 25 * 1048576, `${Math.round((heapAfter100 - heapBuilt) / 1024)} KB`);
check('H2 undo, redo and 100 steps created NO new blob URLs: each picture exists once', urlsAfter.created === urlsBefore.created, `${urlsBefore.created} -> ${urlsAfter.created}`);
check('H3 every undo finished (none timed out)', undoMs.every((m) => m > 0) && tTen > 0, JSON.stringify(undoMs));
check(`H3 undo on this design takes ${report.data.undo.undoMedianMs} ms (median), worst ${report.data.undo.undoWorstMs} ms`, median(undoMs) < 250);
await ctx.close();

// ================================================================================================= cold decode of a real large photo
{
  say('cold photo');
  const { ctx: c2, page: p2 } = await openEditor(browser, base, rep, { width: 1280, height: 900 });
  await p2.waitForTimeout(500);
  const size = statSync(fx.photo).size;
  const start = Date.now();
  await p2.locator('[data-testid="picture-input"]').setInputFiles(fx.photo);
  await p2.waitForFunction(() => document.querySelectorAll('[data-testid="layers-list"] > li').length === 1);
  await p2.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const addMs = Date.now() - start;
  const drawn = await ink(p2);
  report.data.coldPhoto = { fileMB: +(size / 1048576).toFixed(1), source: '4000 x 3000 JPEG', uploadToVisibleMs: addMs, drawnPixelsAfter: Math.round(drawn.n) };
  check(`C1 a ${report.data.coldPhoto.fileMB} MB 4000x3000 photo is shrunk, decoded and drawn in ${addMs} ms from the file being chosen (cold)`, drawn.n > 5000 && addMs < 8000);
  await c2.close();
}

await browser.close();
rep.finish();
