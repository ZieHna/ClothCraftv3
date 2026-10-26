// Step 4b-3b: the desktop layout. The editor fits the window (no page scroll) on large desktop windows; columns that are
// taller than the window scroll INSIDE themselves; tablet and phone are untouched.
//   record the geometry of the tablet and phone layouts BEFORE a change:
//     node scripts/check-editor-desktop-layout.mjs http://localhost:4173 <outDir> --baseline <file.json>
//   check everything (compares tablet and phone with the recorded file):
//     node scripts/check-editor-desktop-layout.mjs http://localhost:4173 <outDir> --compare <file.json>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createReport, launch, makeFixtures, openEditor } from './lib/e2e-common.mjs';

const [base, out, mode, file] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: node scripts/check-editor-desktop-layout.mjs <baseUrl> <outDir> [--baseline|--compare <file>]');
const rep = createReport(out, 'desktop-layout');
const { check, report } = rep;
const fx = await makeFixtures(out);
const browser = await launch();
const shot = (page, name) => page.screenshot({ path: path.join(out, 'shots', name) });
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** where things are, in document coordinates: the same list for every layout, whatever exists in it */
const geometry = (page) =>
  page.evaluate(() => {
    const r = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.left * 10) / 10, y: Math.round((b.top + scrollY) * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 };
    };
    return {
      viewport: [innerWidth, innerHeight],
      scrollWidth: document.documentElement.scrollWidth,
      docHeight: document.documentElement.scrollHeight,
      scrollY: Math.round(scrollY),
      header: r('header'),
      h1: r('h1'),
      chosenBar: r('[data-testid="design-chosen"]'),
      toolbar: r('[role="toolbar"][aria-label="History and view"]'),
      canvas: r('canvas.upper-canvas'),
      tools: r('nav[aria-label="Design tools"]'),
      garment: r('[data-testid="garment-panel"]'),
      layers: r('[data-testid="layers-panel"]'),
      settings: r('[data-testid="properties-panel"]'),
      exportPanel: r('[data-testid="export-panel"]'),
      phoneToolbar: r('[data-testid="phone-toolbar"]'),
      contextBar: r('[data-testid="context-bar"]'),
      footer: r('footer'),
    };
  });

async function addContent(page, phone) {
  if (phone) {
    await page.getByRole('button', { name: 'Text', exact: true }).tap();
    await page.locator('[data-testid="picture-input"]').setInputFiles(fx.logo);
  } else {
    await page.getByRole('button', { name: 'Add text' }).click();
    await page.getByRole('button', { name: 'Add star' }).click();
    await page.locator('[data-testid="picture-input"]').setInputFiles(fx.logo);
  }
  await settle(page, 700);
}

// ================================================================================================ baseline: tablet and phone
if (mode === '--baseline') {
  const out2 = {};
  for (const [name, o, phone] of [
    ['768x1024', { width: 768, height: 1024, dpr: 1 }, false],
    ['390x844', { width: 390, height: 844, dpr: 3, touch: true }, true],
  ]) {
    const { ctx, page } = await openEditor(browser, base, rep, o);
    await addContent(page, phone);
    out2[name] = await geometry(page);
    await ctx.close();
  }
  writeFileSync(file, JSON.stringify(out2, null, 1));
  console.log('baseline written to ' + file);
  await browser.close();
  process.exit(0);
}

// ================================================================================================ the desktop sizes
const SIZES = [
  { w: 1920, h: 1080, name: '1920x1080', fit: true, xwide: true },
  { w: 1536, h: 864, name: '1536x864', fit: true, xwide: true },
  { w: 1366, h: 768, name: '1366x768', fit: true, xwide: false },
  { w: 1024, h: 768, name: '1024x768', fit: false, xwide: false },
];
// step 8c: the shop carries no mock-only wording, so the strip holds the copyright and nothing about a mock or a demo
const MOCK_WORDS = /mock|demo|simulated/i;
report.data.canvas = {};
report.data.header = {};

for (const s of SIZES) {
  const { ctx, page } = await openEditor(browser, base, rep, { width: s.w, height: s.h });
  await addContent(page, false);
  const g = await geometry(page);
  const L = `${s.name}:`;
  await shot(page, `desktop-${s.name}.png`);
  report.data.canvas[s.name] = `${Math.round(g.canvas.w)} x ${Math.round(g.canvas.h)}`;
  check(`${L} no horizontal scroll`, g.scrollWidth <= s.w, `${g.scrollWidth} > ${s.w}`);
  check(`${L} the canvas is square`, near(g.canvas.w, g.canvas.h, 1.5), `${g.canvas.w}x${g.canvas.h}`);
  check(`${L} the canvas is never under the 320 px floor`, g.canvas.w >= 319.5, `${g.canvas.w}`);

  if (s.fit) {
    check(`${L} NO vertical page scroll: the page is no taller than the window`, g.docHeight <= s.h, `page ${g.docHeight} vs window ${s.h}`);
    await page.evaluate(() => scrollTo(0, 800));
    check(`${L} and the page cannot be scrolled`, (await page.evaluate(() => scrollY)) === 0);
    check(`${L} the whole canvas is on screen, with the toolbar above it`, g.canvas.y >= g.toolbar.y + g.toolbar.h - 1 && g.canvas.y + g.canvas.h <= s.h, `${g.canvas.y}..${g.canvas.y + g.canvas.h}`);
    // the canvas follows the window height: bigger in a taller window, and never the old fixed 582
    if (s.h === 1080) check(`${L} the canvas uses the tall window (over 700 px)`, g.canvas.w > 700, `${g.canvas.w}`);
    if (s.h === 768) check(`${L} the canvas shrinks to fit the short window (under the old 582 px, not under 320)`, g.canvas.w < 560 && g.canvas.w >= 320, `${g.canvas.w}`);
  } else {
    report.data.canvas[`${s.name} page height`] = `${g.docHeight} (window ${s.h})`;
  }

  // the slim footer: the copyright, and (step 8c) no mock or demo wording
  const footer = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('footer')].filter((f) => f.getClientRects().length > 0);
    return visible.map((f) => ({ h: Math.round(f.getBoundingClientRect().height), text: f.innerText, links: f.querySelectorAll('a').length }));
  });
  check(`${L} exactly one footer shows, and it is the slim one-line strip`, footer.length === 1 && footer[0].h <= 48 && footer[0].links === 0, JSON.stringify(footer));
  check(`${L} the strip carries the copyright and no mock or demo wording`, /© \d{4} ClothCraft/.test(footer[0]?.text ?? '') && !MOCK_WORDS.test(footer[0]?.text ?? ''), footer[0]?.text);

  // the Download panel is in the rail, narrowed to the rail's width
  const rail = await page.getByRole('region', { name: /^Tools and download, scrollable$/ }).boundingBox();
  const ex = g.exportPanel;
  check(`${L} the Download panel is inside the left rail, no wider than it`, ex.x >= rail.x - 1 && ex.x + ex.w <= rail.x + rail.width + 1 && ex.w <= rail.width, `panel ${ex.w} rail ${rail.width}`);
  check(`${L} ...and under the tools (below Add text, Add picture and the shapes)`, ex.y >= g.tools.y + g.tools.h - 1, `${ex.y} vs ${g.tools.y + g.tools.h}`);
  const parts = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="export-panel"]');
    const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
    const labels = [...p.querySelectorAll('label.option')].map(box);
    const buttons = [...p.querySelectorAll('button')].map(box);
    return { labels, buttons, text: p.textContent };
  });
  check(`${L} 1x and 2x sit side by side`, parts.labels.length === 2 && near(parts.labels[0].y, parts.labels[1].y, 2) && parts.labels[1].x > parts.labels[0].x + parts.labels[0].w - 2, JSON.stringify(parts.labels));
  check(`${L} the two download buttons are stacked, one under the other`, parts.buttons.length === 2 && parts.buttons[1].y >= parts.buttons[0].y + parts.buttons[0].h - 1 && near(parts.buttons[0].x, parts.buttons[1].x, 2), JSON.stringify(parts.buttons));
  check(`${L} the explanatory text is kept`, /small garment photo/.test(parts.text) && /file to use for printing/.test(parts.text) && /nothing is uploaded/.test(parts.text) && /1x \(800 px\)/.test(parts.text) && /2x \(1600 px\)/.test(parts.text));

  // columns
  if (s.xwide) {
    check(`${L} Settings is in its own column, to the right of Layers, starting level with Garment`, g.settings.x >= g.layers.x + g.layers.w - 1 && near(g.settings.y, g.garment.y, 6), `settings x ${g.settings.x} layers right ${g.layers.x + g.layers.w}; y ${g.settings.y} vs ${g.garment.y}`);
    const section = await page.evaluate(() => document.querySelector('main > section')?.getBoundingClientRect().width);
    check(`${L} the Design container is widened: 1680 px, or the whole window when that is narrower`, near(section, Math.min(1680, s.w), 1), `${section}`);
  } else {
    check(`${L} Settings stays under Layers`, g.settings.y >= g.layers.y + g.layers.h - 1 && near(g.settings.x, g.layers.x, 2), `settings y ${g.settings.y} layers bottom ${g.layers.y + g.layers.h}`);
    const section = await page.evaluate(() => document.querySelector('main > section')?.getBoundingClientRect().width);
    check(`${L} the Design container keeps its 1152 px (or the window, if smaller)`, section <= 1152.5, `${section}`);
  }

  // the internal scroll regions
  const names = s.xwide ? ['Tools and download, scrollable', 'Garment and layers, scrollable', 'Settings, scrollable'] : ['Tools and download, scrollable', 'Garment, layers and settings, scrollable'];
  const regions = await page.evaluate((expected) =>
    [...document.querySelectorAll('[role="region"][aria-label*="scrollable"]')].map((el) => {
      const cs = getComputedStyle(el);
      return { name: el.getAttribute('aria-label'), tabindex: el.getAttribute('tabindex'), overflowY: cs.overflowY, overscroll: cs.overscrollBehaviorY, scrollbarWidth: cs.scrollbarWidth, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, windowH: innerHeight, top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom };
    }), names);
  check(`${L} the scroll regions are exactly: ${names.join(' | ')}`, JSON.stringify(regions.map((x) => x.name)) === JSON.stringify(names), JSON.stringify(regions.map((x) => x.name)));
  check(`${L} each is keyboard-focusable (tabindex 0), scrolls (overflow auto), contains overscroll, and has a thin scrollbar`, regions.every((x) => x.tabindex === '0' && x.overflowY === 'auto' && x.overscroll === 'contain' && x.scrollbarWidth === 'thin'), JSON.stringify(regions.map((x) => [x.tabindex, x.overflowY, x.overscroll, x.scrollbarWidth])));
  if (s.fit) check(`${L} every region ends inside the window (bottom at or above the footer strip)`, regions.every((x) => x.bottom <= s.h + 0.5), JSON.stringify(regions.map((x) => x.bottom)));
  report.data[`regions ${s.name}`] = regions.map((x) => `${x.name}: ${x.clientHeight} visible of ${x.scrollHeight}`);

  // each scrolls inside itself, not the page; the last control in Settings can be reached
  const scrolled = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[role="region"][aria-label*="scrollable"]')) {
      const could = el.scrollHeight > el.clientHeight + 1;
      el.scrollTop = 99999;
      out.push({ name: el.getAttribute('aria-label'), could, moved: el.scrollTop > 0, pageScrolled: scrollY });
    }
    return out;
  });
  check(`${L} a region that is taller than the window scrolls inside itself and the page does not move`, scrolled.every((x) => (!x.could || x.moved) && x.pageScrolled === 0), JSON.stringify(scrolled));
  await page.evaluate(() => document.querySelectorAll('[role="region"][aria-label*="scrollable"]').forEach((el) => (el.scrollTop = 0)));

  // keyboard: Tab reaches each region, with a visible focus ring; and then the last control in Settings
  await page.evaluate(() => document.activeElement?.blur());
  const seen = [];
  for (let i = 0; i < 140 && seen.length < names.length; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => ({ label: document.activeElement?.getAttribute('aria-label') ?? '', role: document.activeElement?.getAttribute('role'), outline: parseFloat(getComputedStyle(document.activeElement).outlineWidth), style: getComputedStyle(document.activeElement).outlineStyle }));
    if (f.role === 'region' && /scrollable/.test(f.label)) seen.push(f);
  }
  check(`${L} Tab reaches every scroll region, each with a visible focus ring`, seen.length === names.length && seen.every((x) => x.outline >= 2 && x.style !== 'none'), JSON.stringify(seen));
  const del = page.getByRole('button', { name: /^Delete (picture|shape|text)$/ });
  await del.focus();
  const vis = await page.evaluate(() => {
    const a = document.activeElement.getBoundingClientRect();
    return { top: a.top, bottom: a.bottom, innerHeight, scrollY };
  });
  check(`${L} the last control in Settings (Delete) can be focused and is on screen, with no page scroll`, vis.top >= 0 && vis.bottom <= vis.innerHeight && vis.scrollY === 0, JSON.stringify(vis));

  report.data.header[s.name] = { headerContainerLeft: await page.evaluate(() => Math.round(document.querySelector('header > div').firstElementChild.getBoundingClientRect().left)), designContentLeft: await page.evaluate(() => Math.round(document.querySelector('main > section').getBoundingClientRect().left)), designContentRight: await page.evaluate(() => Math.round(document.querySelector('main > section').getBoundingClientRect().right)), headerContentRight: await page.evaluate(() => Math.round(document.querySelector('header > div').lastElementChild.getBoundingClientRect().right)) };
  await ctx.close();
}

// other routes keep the full footer and their container
{
  const { ctx, page } = await openEditor(browser, base, rep, { width: 1920, height: 1080, url: '/category' }).catch(() => ({}));
  if (page) {
    const m = await page.evaluate(() => {
      const f = document.querySelector('footer');
      const c = document.querySelector('main .max-w-6xl, main section');
      return { footerLinks: f.querySelectorAll('a').length, footerH: Math.round(f.getBoundingClientRect().height), container: Math.round(c?.getBoundingClientRect().width ?? 0), docHeightOverWindow: document.documentElement.scrollHeight > innerHeight };
    });
    check('Category at 1920: the full footer (with its links) and the 1152 px container are unchanged', m.footerLinks >= 7 && m.footerH > 250 && m.container <= 1152, JSON.stringify(m));
    await ctx.close();
  }
}

// ================================================================================================ tablet and phone must not have moved
if (mode === '--compare') {
  const before = JSON.parse(readFileSync(file, 'utf8'));
  for (const [name, o, phone] of [
    ['768x1024', { width: 768, height: 1024, dpr: 1 }, false],
    ['390x844', { width: 390, height: 844, dpr: 3, touch: true }, true],
  ]) {
    const { ctx, page } = await openEditor(browser, base, rep, o);
    await addContent(page, phone);
    const now = await geometry(page);
    const diffs = [];
    for (const [key, was] of Object.entries(before[name])) {
      const is = now[key];
      if (JSON.stringify(was) === JSON.stringify(is)) continue;
      if (was && is && typeof was === 'object' && !Array.isArray(was)) {
        const d = Object.keys(was).filter((k) => Math.abs(was[k] - is[k]) > 0.5);
        if (!d.length) continue;
        diffs.push(`${key}: ${d.map((k) => `${k} ${was[k]} -> ${is[k]}`).join(', ')}`);
      } else diffs.push(`${key}: ${JSON.stringify(was)} -> ${JSON.stringify(is)}`);
    }
    check(`${name}: the layout is exactly as before (every recorded rectangle within 0.5 px)`, diffs.length === 0, diffs.join(' | '));
    if (name === '768x1024') {
      const regions = await page.locator('[role="region"][aria-label*="scrollable"]').count();
      check('768x1024: no scroll regions at tablet width', regions === 0, `${regions}`);
      const footer = await page.evaluate(() => [...document.querySelectorAll('footer')].filter((f) => f.getClientRects().length > 0).map((f) => f.querySelectorAll('a').length));
      check('768x1024: the full footer shows on the Design page below 1024 px', footer.length === 1 && footer[0] >= 7, JSON.stringify(footer));
    }
    await ctx.close();
  }
}

await browser.close();
rep.finish();
