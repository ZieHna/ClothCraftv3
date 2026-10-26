// Step 4b-3c investigation harness (NOT one of the regular checks), for check P5 "a swipe on the canvas does NOT scroll the
// page" failing with scrollY 1. Repeats P5's sequence in real Edge on a phone and logs every scroll with a timestamp, to tell
// whether the canvas swipe scrolls the page or something earlier is still scrolling.
//   node scripts/repro-swipe-scroll.mjs <baseUrl> <outFile.json> [--n 200]
// Variants:
//   asScript      outside swipe, scrollTo(0,0), wait 100 ms, canvas swipe       (exactly what P5 does)
//   noOutside     scrollTo(0,0), wait 100 ms, canvas swipe                     (no earlier fling at all)
//   longSettle    outside swipe, scrollTo(0,0), wait 1500 ms, canvas swipe     (the earlier fling has long ended)
//   outsideOnly   outside swipe, scrollTo(0,0), wait 100 ms, NO canvas swipe    (does the page move with nothing on the canvas?)
import { writeFileSync } from 'node:fs';
import { createReport, launch, openEditor, stage, touchDriver } from './lib/e2e-common.mjs';

const args = process.argv.slice(2);
const [base, outFile] = args;
if (!base || !outFile) throw new Error('usage: node scripts/repro-swipe-scroll.mjs <baseUrl> <outFile.json> [--n 200]');
const N = Number(args.includes('--n') ? args[args.indexOf('--n') + 1] : 200);
const rep = createReport(outFile.replace(/[\\/][^\\/]+$/, ''), 'repro-swipe-console');
const browser = await launch();
const { page, cdp } = await openEditor(browser, base, rep, { width: 390, height: 844, dpr: 3, touch: true });
const finger = touchDriver(cdp);

await page.evaluate(() => {
  window.__scroll = [];
  window.__marks = {};
  addEventListener('scroll', () => window.__scroll.push({ t: Math.round(performance.now() * 10) / 10, y: scrollY }), { passive: true });
  // when a finger first lands on the canvas
  document.addEventListener('touchstart', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-testid="editor-host"]')) window.__marks.canvasDown ??= performance.now();
  }, { capture: true, passive: true });
});

const results = [];
const samples = {};
for (const variant of ['asScript', 'noOutside', 'longSettle', 'outsideOnly']) {
  let fails = 0;
  const kinds = {};
  for (let i = 0; i < N; i++) {
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      window.__scroll.length = 0;
      window.__marks = {};
    });
    if (variant !== 'noOutside') {
      const h1 = await page.locator('h1').boundingBox();
      await finger.gesture([{ id: 1, x: 200, y: h1.y + 10 }], [{ id: 1, x: 200, y: h1.y - 150 }], 10, 12);
      await page.waitForTimeout(200);
    }
    const resetAt = await page.evaluate(() => {
      scrollTo(0, 0);
      window.__marks.reset = performance.now();
      return scrollY;
    });
    await page.waitForTimeout(variant === 'longSettle' ? 1500 : 100);
    if (variant !== 'outsideOnly') {
      const sc = await stage(page);
      const mid = { x: sc.left + sc.width / 2, y: sc.top + sc.height / 2 };
      await finger.gesture([{ id: 1, x: mid.x, y: mid.y + 80 }], [{ id: 1, x: mid.x, y: mid.y - 120 }], 10, 12);
    }
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => ({ y: scrollY, scroll: window.__scroll.slice(), marks: { ...window.__marks } }));
    const after = r.scroll.filter((s) => s.t > r.marks.reset);
    const firstMove = after.find((s) => s.y !== 0);
    const pass = r.y === 0;
    // where the first non-zero scroll after the reset happened, relative to the canvas finger
    let kind = 'pass';
    if (!pass) {
      if (!firstMove) kind = 'moved-without-scroll-event';
      else if (r.marks.canvasDown === undefined) kind = 'moved-no-canvas-touch';
      else kind = firstMove.t < r.marks.canvasDown ? 'moved-BEFORE-canvas-touch' : 'moved-DURING/AFTER-canvas-touch';
    }
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (!pass) fails++;
    const key = `${variant}:${kind}`;
    samples[key] ??= [];
    if (samples[key].length < (pass ? 1 : 3)) samples[key].push({ run: i, resetScrollY: resetAt, finalY: r.y, marks: r.marks, scroll: r.scroll });
    results.push({ variant, run: i, pass, kind, finalY: r.y });
  }
  console.log(JSON.stringify({ variant, runs: N, fails, rate: `${((100 * fails) / N).toFixed(1)}%`, kinds }));
}
writeFileSync(outFile, JSON.stringify({ base, N, results, samples, console: rep.report.console }, null, 1));
console.log(JSON.stringify({ done: true, console: rep.report.console }));
await browser.close();
