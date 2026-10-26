// Step 4b-3c investigation harness (NOT one of the regular checks). Opens the editor on a phone in real Edge and drives the
// bottom sheets from the keyboard many times, logging every native event involved, to measure how often a sheet fails to
// open and why.
//   node scripts/repro-sheet-race.mjs <baseUrl> <outFile.json> [--n 300] [--variants open,enterTwice,escEnter,aThenB,closeThenB,k2]
//                                     [--delays 0,10,50,150] [--profile phone|keyboard]
// profile phone:    390x844, touch, mobile, dpr 3 (a phone).  profile keyboard: 390x844, no touch, dpr 1 (what check K2 uses).
// Every run is appended to <outFile>.jsonl as it finishes ({kind:'run'}, then {kind:'cell'} per cell), so stopping the
// script never loses what was measured; the full JSON (with sample logs) is written only at the end.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createReport, launch, openEditor } from './lib/e2e-common.mjs';

const args = process.argv.slice(2);
const [base, outFile] = args;
const opt = (name, def) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : def);
if (!base || !outFile) throw new Error('usage: node scripts/repro-sheet-race.mjs <baseUrl> <outFile.json> [--n 300] [--variants ...] [--delays ...] [--profile phone|keyboard]');
const N = Number(opt('n', '300'));
const VARIANTS = opt('variants', 'open,enterTwice,escEnter,aThenB,closeThenB').split(',');
const DELAYS = opt('delays', '0,10,50,150').split(',').map(Number);
const PROFILE = opt('profile', 'phone');

const SHEETS = [['Shapes', 'Shapes'], ['Layers', 'Layers'], ['Colour', 'Colour and size'], ['More', 'More']];
const TITLE = Object.fromEntries(SHEETS);

// Instrumentation, installed before any page script: every event that can open, close or move focus, with a timestamp,
// what was open at that instant and what had the focus. showModal()/close() CALLS are logged too (a native Esc does not
// call close(); the Close button and React's effect do).
const INSTRUMENT = () => {
  const title = (d) => d?.querySelector?.('h2')?.textContent?.trim() ?? '?';
  const label = (el) => {
    if (!el) return 'null';
    if (el === document || el === window) return 'document';
    if (el === document.body) return 'body';
    if (el.tagName === 'DIALOG') return `dialog:${title(el)}`;
    const own = (el.getAttribute?.('aria-label') || el.textContent || el.tagName || '').trim().replace(/\s+/g, ' ').slice(0, 28);
    const inDialog = el.closest?.('dialog');
    return inDialog ? `${own} [in ${title(inDialog)}]` : own;
  };
  const openNow = () => [...document.querySelectorAll('dialog[open]')].map(title);
  window.__log = [];
  const push = (type, target, extra = {}) => window.__log.push({ t: Math.round(performance.now() * 100) / 100, type, target: label(target), open: openNow(), active: label(document.activeElement), ...extra });
  for (const type of ['keydown', 'keyup', 'click', 'focusin', 'cancel', 'close', 'toggle', 'beforetoggle']) {
    document.addEventListener(type, (e) => push(type, e.target, type.startsWith('key') ? { key: e.key } : type.endsWith('toggle') ? { state: e.newState } : {}), true);
  }
  const showModal = HTMLDialogElement.prototype.showModal;
  const close = HTMLDialogElement.prototype.close;
  HTMLDialogElement.prototype.showModal = function () {
    push('call:showModal', this);
    return showModal.call(this);
  };
  HTMLDialogElement.prototype.close = function (...a) {
    push('call:close', this, { wasOpen: this.open });
    return close.apply(this, a);
  };
  new MutationObserver((records) => {
    for (const r of records) if (r.attributeName === 'open') push(r.target.hasAttribute('open') ? 'attr:open' : 'attr:closed', r.target);
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['open'] });
};

const rep = createReport(outFile.replace(/[\\/][^\\/]+$/, ''), 'repro-sheet-race-console');
const browser = await launch();
const profile = PROFILE === 'keyboard' ? { width: 390, height: 844, dpr: 1, touch: false } : { width: 390, height: 844, dpr: 3, touch: true };
// openEditor adds its own init script; ours is added to the context before the first navigation by opening a blank page first
const { ctx, page } = await openEditor(browser, base, rep, { ...profile, url: '/design?product=m-tee&variant=SIM-M-TEE-NVY-M' });
await ctx.addInitScript(INSTRUMENT);
await page.reload({ waitUntil: 'networkidle' });
await page.locator('[data-testid="editor-host"] canvas.upper-canvas').waitFor({ state: 'attached' });
await page.waitForFunction(() => !document.querySelector('[data-testid="phone-toolbar"] button')?.disabled);
await page.waitForTimeout(400);
if (!(await page.evaluate(() => Array.isArray(window.__log)))) throw new Error('instrumentation did not load');

const bar = (name) => page.locator('[data-testid="phone-toolbar"]').getByRole('button', { name, exact: true });
const openTitles = () => page.evaluate(() => [...document.querySelectorAll('dialog[open]')].map((d) => d.querySelector('h2')?.textContent?.trim()));
const wait = (ms) => (ms ? page.waitForTimeout(ms) : Promise.resolve());

async function reset() {
  for (let k = 0; k < 4 && (await openTitles()).length; k++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(150); // let any queued close event run before the next run starts
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    window.__log.length = 0;
  });
}
async function openAndWait(name) {
  await bar(name).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction((t) => [...document.querySelectorAll('dialog[open]')].some((d) => d.querySelector('h2')?.textContent?.trim() === t), TITLE[name], { timeout: 2000 });
}

/** after the last key: which sheet is open 400 ms later, and was the expected one open at some point and then closed again */
async function outcome(expected) {
  await page.waitForTimeout(400);
  const final = await openTitles();
  const log = await page.evaluate(() => window.__log.slice());
  const lastEnter = [...log].reverse().find((e) => e.type === 'keydown' && e.key === 'Enter');
  const after = log.filter((e) => e.t >= (lastEnter?.t ?? 0));
  const openedAfterLastEnter = after.some((e) => e.type === 'attr:open' && e.target === `dialog:${expected}`);
  const closedAgain = openedAfterLastEnter && after.some((e) => e.type === 'attr:closed' && e.target === `dialog:${expected}` && e.t > after.find((x) => x.type === 'attr:open' && x.target === `dialog:${expected}`).t);
  return { final, log, lastEnter, openedAfterLastEnter, closedAgain, active: await page.evaluate(() => (document.activeElement?.closest('dialog') ? 'in-dialog' : (document.activeElement?.textContent || document.activeElement?.tagName || '').trim().slice(0, 20))) };
}

const gapBetween = (log, a, b) => {
  const first = log.find(a);
  const second = first ? log.find((e) => e.t >= first.t && e !== first && b(e)) : undefined;
  return first && second ? Math.round((second.t - first.t) * 100) / 100 : null;
};
const isKey = (k) => (e) => e.type === 'keydown' && e.key === k;

const jsonl = outFile.replace(/\.json$/, '') + '.jsonl';
writeFileSync(jsonl, JSON.stringify({ kind: 'start', base, profile: PROFILE, N, variants: VARIANTS, delays: DELAYS, at: new Date().toISOString() }) + '\n');
const record = (o) => appendFileSync(jsonl, JSON.stringify(o) + '\n');

const results = [];
const cells = [];
const samples = {}; // a few full logs per variant/delay: the first failures and one pass
const t0 = Date.now();
const plan = [];
for (const v of VARIANTS) for (const d of v === 'open' || v === 'k2' ? [0] : DELAYS) plan.push([v, d]);

for (const [variant, delay] of plan) {
  const cell = `${variant}@${delay}`;
  let fails = 0;
  const gaps = [];
  const latencies = [];
  let lateCloseRuns = 0;
  let lateCloseAndFail = 0;
  let strayClicks = 0;
  let focusWrongAtEnter = 0;
  const outcomes = {};
  for (let i = 0; i < N; i++) {
    const [A] = SHEETS[i % 4];
    const [B] = SHEETS[(i + 1) % 4];
    await reset();
    let expected;
    let pass;
    let r;
    try {
      if (variant === 'open') {
        await bar(A).focus();
        await page.keyboard.press('Enter');
        expected = TITLE[A];
        r = await outcome(expected);
        pass = r.final.length === 1 && r.final[0] === expected;
      } else if (variant === 'enterTwice') {
        // the second Enter goes to whatever has the focus at that instant: the opener (sheet not open yet) or the sheet's Close button
        await bar(A).focus();
        await page.keyboard.press('Enter');
        await wait(delay);
        await page.keyboard.press('Enter');
        expected = TITLE[A];
        r = await outcome(expected);
        const enters = r.log.filter(isKey('Enter'));
        const secondOn = enters[1]?.active ?? '?';
        gaps.push(gapBetween(r.log, isKey('Enter'), (e) => e.type === 'keydown' && e.key === 'Enter'));
        // what the second key SHOULD do, judged by where the focus was when it arrived
        const expectClosed = /Close \[in /.test(secondOn);
        pass = expectClosed ? r.final.length === 0 : r.final.length === 1 && r.final[0] === expected;
        r.secondOn = secondOn;
      } else if (variant === 'escEnter') {
        // the same sheet again: Esc closes it, focus returns to its button, Enter should open it again
        await openAndWait(A);
        await page.keyboard.press('Escape');
        await wait(delay);
        await page.keyboard.press('Enter');
        expected = TITLE[A];
        r = await outcome(expected);
        gaps.push(gapBetween(r.log, isKey('Escape'), isKey('Enter')));
        pass = r.final.length === 1 && r.final[0] === expected;
      } else if (variant === 'aThenB') {
        // what check K2 does: Esc closes A, then B's button is focused and Enter pressed
        await openAndWait(A);
        await page.keyboard.press('Escape');
        await wait(delay);
        await bar(B).focus();
        await page.keyboard.press('Enter');
        expected = TITLE[B];
        r = await outcome(expected);
        gaps.push(gapBetween(r.log, isKey('Escape'), isKey('Enter')));
        pass = r.final.length === 1 && r.final[0] === expected;
      } else if (variant === 'closeThenB') {
        // the Close button instead of Esc (it calls dialog.close()); the sheet opens with the focus on Close, so Enter presses it
        await openAndWait(A);
        await page.keyboard.press('Enter');
        await wait(delay);
        await bar(B).focus();
        await page.keyboard.press('Enter');
        expected = TITLE[B];
        r = await outcome(expected);
        const enters = r.log.filter(isKey('Enter'));
        gaps.push(enters.length >= 3 ? Math.round((enters[2].t - enters[1].t) * 100) / 100 : null);
        pass = r.final.length === 1 && r.final[0] === expected;
      } else if (variant === 'k2') {
        // exactly what check K2 in check-editor-touch-layout does: Esc, wait until no dialog is open, focus B, Enter, wait for a dialog
        await openAndWait(A);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('dialog[open]'));
        await bar(B).focus();
        await page.keyboard.press('Enter');
        await page.locator('dialog[open]').waitFor({ timeout: 2000 });
        expected = TITLE[B];
        r = await outcome(expected);
        gaps.push(gapBetween(r.log, isKey('Escape'), isKey('Enter')));
        pass = r.final.length === 1 && r.final[0] === expected;
      }
    } catch (error) {
      r = { final: await openTitles(), log: await page.evaluate(() => window.__log.slice()), error: String(error).slice(0, 200) };
      pass = false;
      // the gap of THIS run (without it, the cell's last entry would be the previous run's gap)
      gaps.push(variant === 'escEnter' || variant === 'aThenB' || variant === 'k2' ? gapBetween(r.log, isKey('Escape'), isKey('Enter')) : null);
    }
    // (a) how late each native close event is: from the moment the dialog starts closing (beforetoggle "closed") to its close event
    const lat = [];
    for (const e of r.log ?? []) {
      if (e.type !== 'beforetoggle' || e.state !== 'closed') continue;
      const c = r.log.find((x) => x.type === 'close' && x.target === e.target && x.t >= e.t);
      if (c) lat.push(Math.round((c.t - e.t) * 100) / 100);
    }
    latencies.push(...lat);
    // was a close event dispatched AFTER a different (or the same) sheet had been asked to open again? that is hypothesis (a) in action
    const lateClose = (r.log ?? []).some((c) => c.type === 'close' && (r.log ?? []).some((o) => o.type === 'click' && o.t < c.t && o.t > ((r.log ?? []).filter((b) => b.type === 'beforetoggle' && b.state === 'closed' && b.target === c.target && b.t < c.t).at(-1)?.t ?? Infinity)));
    if (lateClose) lateCloseRuns++;
    if (lateClose && !pass) lateCloseAndFail++;
    // (b) a click that no key caused, or focus somewhere unexpected when the last Enter arrived
    const log = r.log ?? [];
    for (const c of log.filter((e) => e.type === 'click')) {
      const k = [...log].reverse().find((e) => e.type === 'keydown' && e.t <= c.t);
      if (!k || k.key !== 'Enter' || c.t - k.t > 5 || k.target !== c.target) strayClicks++;
    }
    const want = variant === 'aThenB' || variant === 'closeThenB' || variant === 'k2' ? B : A;
    if (variant !== 'enterTwice' && r.lastEnter && r.lastEnter.active !== want) focusWrongAtEnter++;
    const kind = pass ? 'pass' : r.error ? 'error' : r.final.length === 0 ? (r.openedAfterLastEnter ? (r.closedAgain ? 'opened-then-closed' : 'closed') : 'never-opened') : `wrong:${r.final.join('+')}`;
    outcomes[kind] = (outcomes[kind] ?? 0) + 1;
    if (!pass) fails++;
    const key = `${cell}:${kind}`;
    samples[key] ??= [];
    if (samples[key].length < (pass ? 1 : 3)) samples[key].push({ run: i, A, B, expected, final: r.final, active: r.active, secondOn: r.secondOn, error: r.error, log: r.log });
    results.push({ cell, run: i, pass, kind, gap: gaps.at(-1) ?? null });
    record({ kind: 'run', cell, run: i, A, B, pass, outcome: kind, gap: gaps.at(-1) ?? null, closeLatencyMs: lat, lateClose, final: r.final, error: r.error, ...(pass ? {} : { log: r.log }) });
  }
  const g = gaps.filter((x) => x !== null).sort((a, b) => a - b);
  const pct = (p) => (g.length ? g[Math.min(g.length - 1, Math.floor(p * g.length))] : null);
  const L = latencies.sort((a, b) => a - b);
  const lp = (q) => (L.length ? L[Math.min(L.length - 1, Math.floor(q * L.length))] : null);
  const failGaps = results.filter((x) => x.cell === cell && !x.pass && x.gap !== null).map((x) => x.gap).sort((a, b) => a - b);
  const line = {
    cell, runs: N, fails, rate: `${((100 * fails) / N).toFixed(1)}%`, outcomes,
    measuredGapMs: g.length ? { min: g[0], median: pct(0.5), p90: pct(0.9), max: g.at(-1) } : null,
    largestGapThatFailedMs: failGaps.at(-1) ?? null,
    closeEventLatencyMs: L.length ? { n: L.length, min: L[0], median: lp(0.5), p90: lp(0.9), p99: lp(0.99), max: L.at(-1) } : null,
    runsWithLateClose: lateCloseRuns, lateCloseAndFailed: lateCloseAndFail, failsWithoutLateClose: fails - lateCloseAndFail,
    strayClicks, focusWrongAtLastEnter: focusWrongAtEnter,
  };
  cells.push(line);
  record({ kind: 'cell', ...line });
  console.log(JSON.stringify(line));
}

const summary = {};
for (const r of results) {
  summary[r.cell] ??= { runs: 0, fails: 0 };
  summary[r.cell].runs++;
  if (!r.pass) summary[r.cell].fails++;
}
// per failing run: how the Esc/close -> Enter gap compares with the gap of passing runs in the same cell
writeFileSync(outFile, JSON.stringify({ base, profile: PROFILE, N, minutes: Math.round((Date.now() - t0) / 600) / 100, cells, summary, results, samples }, null, 1));
console.log(JSON.stringify({ done: true, minutes: Math.round((Date.now() - t0) / 600) / 100, console: rep.report.console }));
await browser.close();
