// The static documentation page (frontend/public/docs/index.html) and the header's Documentation link, in real Edge.
//   node scripts/check-docs-page.mjs <docsBase> <outDir> [--shop <base>] [--mock <base>]
//     <docsBase>  any server that serves the build or the dev server, e.g. http://localhost:4180 (vite preview) or http://localhost:5173
//     --shop      the real-shop dev server (signed out menu, desktop and phone); nothing is written, nobody signs in
//     --mock      a `vite --mode mock` server: the SIGNED-IN menu (a seeded mock customer), desktop and phone
// Checks the page itself (loads at /docs/, every contents link, every in-page link, diagrams, no sideways scroll at five widths, light and dark
// contrast, print, no JavaScript, no outside requests, no secrets in the text) and the menu (a real link, new tab, noopener, both menus).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createReport, launch, seedAccount } from './lib/e2e-common.mjs';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const [docsBase, out] = args;
if (!docsBase || !out) throw new Error('usage: node scripts/check-docs-page.mjs <docsBase> <outDir> [--shop <base>] [--mock <base>]');
const shop = flag('--shop');
const mock = flag('--mock');
const rep = createReport(out, 'docs-page');
const { check, report } = rep;
const browser = await launch();
const WIDTHS = [320, 390, 768, 1024, 1440];
const origin = new URL(docsBase).origin;

const watch = (page, label) => {
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && report.console.push(`${label} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => report.console.push(`${label} pageerror: ${e.message}`));
};

// ------------------------------------------------------------------------------------------------------------ the page
{
  const requests = [];
  const failed = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  watch(page, 'docs');
  page.on('request', (r) => requests.push(r.url()));
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
  const res = await page.goto(`${docsBase}/docs/`, { waitUntil: 'load' });
  check('GET /docs/ answers 200 with HTML', res?.status() === 200 && /text\/html/.test(res.headers()['content-type'] ?? ''), String(res?.status()));
  check('the page is the documentation, not the app (title, one h1, no #root)', (await page.title()) === 'ClothCraft System Documentation' && (await page.locator('h1').count()) === 1 && (await page.locator('#root').count()) === 0);
  const res2 = await page.goto(`${docsBase}/docs`, { waitUntil: 'load' });
  check('/docs (no slash) also reaches the documentation', res2?.status() === 200 && (await page.title()) === 'ClothCraft System Documentation');
  await page.goto(`${docsBase}/docs/`, { waitUntil: 'load' });

  check('the last-verified date is on the page', /Last verified:\s*27 October 2026/.test(await page.locator('header.top').innerText()));
  const sections = await page.locator('main > section[id]').evaluateAll((els) => els.map((e) => e.id));
  check('17 top-level sections: A to N, the tutorial, status, counts', sections.length === 17 && 'abcdefghijklmn'.split('').every((l) => sections.some((s) => s.startsWith(`${l}-`))) && sections.includes('tutorial'), sections.join(','));
  const tut = await page.locator('#tutorial > section[id]').evaluateAll((els) => els.map((e) => e.id));
  check('the tutorial has its 12 lettered parts, A to L, each with a heading', tut.join() === 'tut-a,tut-b,tut-c,tut-d,tut-e,tut-f,tut-g,tut-h,tut-i,tut-j,tut-k,tut-l' && (await page.locator('#tutorial > section > h3').count()) === 12, tut.join());
  const cmds = await page.locator('#tutorial pre code').allInnerTexts();
  check('the tutorial has copyable command blocks, including the clone URL and the first-run steps', cmds.length >= 20 && cmds.some((c) => c.includes('git clone https://github.com/ZieHna/ClothCraftv3.git')) && cmds.some((c) => c.includes('createdb')) && cmds.some((c) => c.includes('-i clothcraft --stop-after-init')) && cmds.some((c) => c.includes('npm ci')), String(cmds.length));

  // contents links: each one exists, points at a real section, and goes there
  const toc = await page.locator('#toc a').evaluateAll((els) => els.map((e) => ({ href: e.getAttribute('href'), text: e.textContent.trim() })));
  check('the contents list has 29 links (17 sections and the 12 tutorial parts), all with text', toc.length === 29 && toc.every((l) => l.href?.startsWith('#') && l.text.length > 1), String(toc.length));
  const dead = [];
  for (const l of toc) {
    const id = l.href.slice(1);
    if (!(await page.locator(`main section#${id}`).count())) dead.push(l.href);
  }
  check('every contents link has a matching section', dead.length === 0, dead.join(','));
  const wrong = [];
  for (const l of toc) {
    await page.locator(`#toc a[href="${l.href}"]`).click();
    const at = await page.evaluate((id) => ({ hash: location.hash, top: document.getElementById(id).getBoundingClientRect().top, h2: document.querySelector(`#${id} h2`)?.getBoundingClientRect().top }), l.href.slice(1));
    if (at.hash !== l.href || at.top < -2 || at.top > 260) wrong.push(`${l.href} hash=${at.hash} top=${Math.round(at.top)}`);
  }
  check('clicking each contents link scrolls to its section (hash set, section near the top)', wrong.length === 0, wrong.join('; '));
  const anchors = await page.locator('a[href^="#"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  const broken = [];
  for (const href of new Set(anchors)) if (href.length > 1 && !(await page.locator(`[id="${href.slice(1)}"]`).count())) broken.push(href);
  check(`every in-page link (${new Set(anchors).size}) points at an existing id`, broken.length === 0, broken.join(','));
  const ids = await page.locator('[id]').evaluateAll((els) => els.map((e) => e.id));
  check('no duplicate ids', new Set(ids).size === ids.length, ids.filter((x, i) => ids.indexOf(x) !== i).join(','));

  // the current section is marked while reading
  await page.evaluate(() => document.getElementById('h-forecast').scrollIntoView());
  await page.waitForTimeout(400);
  check('the contents list marks the section being read (aria-current)', (await page.locator('#toc a[aria-current="true"]').getAttribute('href')) === '#h-forecast');

  // headings, labels, landmarks
  const headings = await page.locator('h1,h2,h3,h4').evaluateAll((els) => els.map((e) => +e.tagName[1]));
  let jump = 0;
  headings.forEach((h, i) => { if (i && h - headings[i - 1] > 1) jump++; });
  check('headings never skip a level', jump === 0, String(jump));
  check('landmarks: header, nav with a label, main, skip link', (await page.locator('header.top').count()) === 1 && (await page.locator('nav[aria-label]').count()) === 1 && (await page.locator('main#content').count()) === 1 && (await page.locator('a.skip[href="#content"]').count()) === 1);
  check('html has a lang and the page a viewport meta', (await page.locator('html').getAttribute('lang')) === 'en' && /width=device-width/.test((await page.locator('meta[name=viewport]').getAttribute('content')) ?? ''));
  const unlabelled = await page.locator('.tablebox').evaluateAll((els) => els.filter((e) => !e.getAttribute('aria-label') || e.getAttribute('role') !== 'region' || e.tabIndex !== 0).length);
  check('every scrollable table box is a labelled, focusable region', unlabelled === 0, String(unlabelled));
  const noName = await page.locator('a').evaluateAll((els) => els.filter((e) => !(e.textContent ?? '').trim() && !e.getAttribute('aria-label')).length);
  check('every link has a name', noName === 0, String(noName));

  // diagrams
  const svgs = await page.locator('figure.diagram svg').evaluateAll((els) => els.map((e) => ({ role: e.getAttribute('role'), labelled: !!e.getAttribute('aria-labelledby') && !!document.getElementById(e.getAttribute('aria-labelledby').split(' ')[0]), texts: e.querySelectorAll('text').length, w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) })));
  check('4 diagrams, each an img with a title and description, with searchable text and a size', svgs.length === 4 && svgs.every((s) => s.role === 'img' && s.labelled && s.texts >= 6 && s.w > 400 && s.h > 150), JSON.stringify(svgs));
  const bad = await page.locator('figure.diagram svg').evaluateAll((els) => els.flatMap((svg, i) => [...svg.querySelectorAll('text')].filter((t) => { const r = t.getBoundingClientRect(); const s = svg.getBoundingClientRect(); return r.width === 0 || r.right > s.right + 1 || r.left < s.left - 1; }).map((t) => `${i}:${t.textContent.slice(0, 30)}`)));
  check('no diagram text is clipped by the edge of its drawing', bad.length === 0, bad.join(' | '));
  // text inside a box: no <text> may stick out of the rectangle drawn behind it (a wide label in a narrow box)
  const spill = await page.locator('figure.diagram svg').evaluateAll((els) => els.flatMap((svg, n) => {
    const boxes = [...svg.querySelectorAll('rect.d-box,rect.d-alt,rect.d-warn')].map((r) => r.getBoundingClientRect());
    const out = [];
    for (const t of svg.querySelectorAll('text')) {
      const tr = t.getBoundingClientRect();
      const host = boxes.filter((b) => tr.left >= b.left - 1 && tr.top >= b.top - 1 && tr.top < b.bottom && tr.left < b.right).sort((a, b) => (a.width * a.height) - (b.width * b.height))[0];
      if (host && tr.right > host.right + 1) out.push(`d${n}: "${t.textContent.slice(0, 40)}" over by ${Math.round(tr.right - host.right)}px`);
    }
    return out;
  }));
  check('no diagram label runs out of its box', spill.length === 0, spill.join(' | '));
  await page.locator('#fig-arch').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'diagram-architecture-1440.png'), clip: await page.locator('#fig-arch').boundingBox() });
  await page.locator('#fig-dss-flow').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'diagram-dss-1440.png'), clip: await page.locator('#fig-dss-flow').boundingBox() });
  await page.locator('#fig-flow').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'diagram-flow-1440.png'), clip: await page.locator('#fig-flow').boundingBox() });
  await page.locator('#fig-backtest').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'diagram-backtest-1440.png'), clip: await page.locator('#fig-backtest').boundingBox() });

  // layout at five widths
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`${docsBase}/docs/`, { waitUntil: 'load' });
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, tocOpen: document.getElementById('toc').open, tocLeft: document.querySelector('.toc-wrap').getBoundingClientRect().left, tocW: document.querySelector('.toc-wrap').getBoundingClientRect().width, mainLeft: document.querySelector('main').getBoundingClientRect().left, sticky: getComputedStyle(document.querySelector('.toc-wrap')).position, mainW: document.querySelector('main').getBoundingClientRect().width }));
    check(`${w}px: no sideways page scroll`, m.sw <= m.iw, JSON.stringify(m));
    if (w >= 1024) check(`${w}px: the contents list is a sticky column on the left, open, beside the text`, m.tocOpen && m.sticky === 'sticky' && m.tocLeft < m.mainLeft && m.mainLeft >= m.tocW, JSON.stringify(m));
    else check(`${w}px: the contents list is a collapsed block above the text`, !m.tocOpen && m.sticky !== 'sticky', JSON.stringify(m));
    const wide = await page.locator('main').evaluate((el) => [...el.querySelectorAll('p,li,h2,h3,dd,dt,.callout')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === 'visible').map((e) => e.tagName + ':' + e.textContent.slice(0, 30)));
    check(`${w}px: no text spills out of its container`, wide.length === 0, wide.slice(0, 5).join(' | '));
    if (w <= 768) {
      await page.locator('#toc summary').click();
      const open = await page.evaluate(() => document.getElementById('toc').open);
      await page.locator('#toc a[href="#k-evidence"]').click();
      check(`${w}px: opening the contents and choosing a link goes there and closes the list`, open && (await page.evaluate(() => location.hash === '#k-evidence' && !document.getElementById('toc').open)));
    }
    if (w === 320 || w === 1440 || w === 390) await page.screenshot({ path: path.join(out, `page-${w}.png`), fullPage: false });
  }
  const tableFit = await (async () => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${docsBase}/docs/`, { waitUntil: 'load' });
    return page.locator('.tablebox').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right <= innerWidth + 1).every(Boolean));
  })();
  check('390px: wide tables scroll inside their own box (the box itself fits the screen)', tableFit);

  // print
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.goto(`${docsBase}/docs/`, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });
  const pr = await page.evaluate(() => ({ toc: getComputedStyle(document.querySelector('.toc-wrap')).display, bg: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color, sw: document.documentElement.scrollWidth, boxes: [...document.querySelectorAll('.tablebox')].filter((e) => e.scrollWidth > e.clientWidth + 1).length, svg: [...document.querySelectorAll('figure.diagram svg')].filter((s) => s.getBoundingClientRect().right > innerWidth + 1).length }));
  check('print: the contents list is hidden, the page is black on white, nothing is wider than the page', pr.toc === 'none' && pr.bg === 'rgb(255, 255, 255)' && pr.color === 'rgb(0, 0, 0)' && pr.sw <= 794 && pr.boxes === 0 && pr.svg === 0, JSON.stringify(pr));
  const pdf = await page.pdf({ format: 'A4', printBackground: false, margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' } });
  writeFileSync(path.join(out, 'docs.pdf'), pdf);
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  report.data.pdfPages = pages;
  check('print: a PDF is produced with a sensible number of pages', pages >= 8 && pages <= 60, String(pages));
  await page.emulateMedia({ media: 'screen' });

  // dark and light colours: WCAG contrast of the text people read
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${docsBase}/docs/`, { waitUntil: 'load' });
    const rows = await page.evaluate(() => {
      const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
      const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.9) return c; } return parse(getComputedStyle(document.body).backgroundColor); };
      const ratio = (fg, bg) => { const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
      const probe = (label, sel, prop = 'color') => { const el = document.querySelector(sel); if (!el) return { label, missing: true }; const cs = getComputedStyle(el); return { label, ratio: +ratio(parse(cs[prop]), bgOf(el)).toFixed(2) }; };
      return [
        probe('body text', 'main p'), probe('muted text', 'main .muted'), probe('link', 'main a'), probe('table header', 'th'), probe('table cell', 'td'), probe('contents link', '.toc a'),
        probe('pill implemented', '.pill.ok'), probe('pill planned', '.pill.warn'), probe('pill not implemented', '.pill.off'), probe('code', 'main code'),
        probe('diagram text', '.d-text', 'fill'), probe('diagram small text', '.d-small', 'fill'), probe('diagram title', '.d-title', 'fill'), probe('callout title', '.callout .title'),
      ];
    });
    const low = rows.filter((r) => !r.missing && r.ratio < 4.5);
    check(`${scheme} scheme: all probed text has contrast of at least 4.5:1`, low.length === 0 && rows.filter((r) => r.missing).length <= 2, JSON.stringify(rows));
    report.data[`contrast_${scheme}`] = Object.fromEntries(rows.map((r) => [r.label, r.ratio ?? 'missing']));
    await page.screenshot({ path: path.join(out, `page-${scheme}-1440.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // keyboard: the skip link and the contents links take focus and show a visible ring
  await page.goto(`${docsBase}/docs/`, { waitUntil: 'load' });
  await page.keyboard.press('Tab');
  const skip = await page.evaluate(() => ({ is: document.activeElement.classList.contains('skip'), left: document.activeElement.getBoundingClientRect().left }));
  check('Tab first reaches the skip link, and it is on screen when focused', skip.is && skip.left >= 0);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); return { tag: e.tagName, outline: cs.outlineStyle, w: cs.outlineWidth }; });
  check('a focused control shows a focus outline', ring.outline !== 'none' && parseFloat(ring.w) >= 2, JSON.stringify(ring));

  // nothing from outside the server, and nothing sensitive in the text
  const outside = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:'));
  check('the page makes no request to any other site', outside.length === 0, outside.join(','));
  const apiCalls = requests.filter((u) => /\/api\//.test(u));
  check('the page makes no API call', apiCalls.length === 0, apiCalls.join(','));
  check('no failed requests', failed.length === 0, failed.join(','));
  const ext = await page.locator('a[href^="http"]').evaluateAll((els) => els.map((e) => new URL(e.href).hostname));
  check('every outside link goes to an official site (Docker, Git, Node.js, Microsoft)', ext.every((h) => /^(docs.docker.com|git-scm.com|nodejs.org|www.microsoft.com)$/.test(h)), [...new Set(ext)].join(','));
  const source = readFileSync(new URL('../public/docs/index.html', import.meta.url), 'utf8');
  const secrets = [/(password|api[_ -]?key|secret)[ \t]*[:=][ \t]*(?![ \t<])[^\s<]{6,}/i, /bearer\s+[a-z0-9._-]{12,}/i, /BEGIN [A-Z ]*PRIVATE KEY/, /[a-z0-9._%+-]+@(?!example\.test|clothcraft\.test)[a-z0-9.-]+\.[a-z]{2,}/i, /(?<![\d.])(?!127\.0\.0\.1)\d{1,3}(\.\d{1,3}){3}(?![\d.])/, /host\.docker\.internal/i, /[A-Za-z]:\\(Users|Schoolworks|ccv3t)/, /\bccv3t\b/i, /\/Users\/[a-z]/i]
    .filter((re) => re.test(source.replace(/<style[\s\S]*?<\/style>/, '')));
  check('the source holds no credentials, real e-mail addresses, outside IP addresses, personal paths or machine names', secrets.length === 0, secrets.map(String).join(' '));
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------------------ no JavaScript
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto(`${docsBase}/docs/`, { waitUntil: 'load' });
  check('without JavaScript: the contents list is open and a link still goes to its section', (await page.evaluate(() => document.getElementById('toc').hasAttribute('open'))) && (await (async () => { await page.locator('#toc a[href="#m-tests"]').click(); await page.waitForTimeout(1500); return page.evaluate(() => location.hash === '#m-tests' && document.getElementById('m-tests').getBoundingClientRect().top < 300); })()));
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------------------ the menu link
async function menuCase(label, base, { signedIn, width }) {
  const phone = width < 640;
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  const page = await ctx.newPage();
  watch(page, label);
  if (signedIn) await seedAccount(page, 'Docs Check Customer', 91);
  await page.goto(`${base}/`, { waitUntil: 'load' });
  if (signedIn) await page.getByTestId('signed-in-name').or(page.getByTestId('account-menu-button')).first().waitFor();
  await page.waitForTimeout(700);
  const button = page.getByTestId('account-menu-button');
  await button.click();
  const menu = page.getByRole('menu');
  await menu.waitFor();
  const items = (await menu.getByRole('menuitem').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
  const docs = menu.getByRole('menuitem', { name: /^Documentation/ });
  check(`${label}: the menu lists Need help? (Coming soon) and Documentation (a link), ${signedIn ? 'signed in' : 'signed out'}`, items.includes('Need help? Coming soon') && items.some((t) => t === 'Documentation (opens in a new tab)') && items.filter((t) => /^Documentation/.test(t)).length === 1, JSON.stringify(items));
  const attrs = await docs.evaluate((e) => ({ tag: e.tagName, href: e.getAttribute('href'), target: e.getAttribute('target'), rel: e.getAttribute('rel'), disabled: e.hasAttribute('aria-disabled'), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) }));
  check(`${label}: Documentation is a link to /docs/ with target _blank and rel noopener, and is at least 44 px tall`, attrs.tag === 'A' && attrs.href === '/docs/' && attrs.target === '_blank' && /noopener/.test(attrs.rel ?? '') && !attrs.disabled && attrs.h >= 44, JSON.stringify(attrs));
  const help = menu.getByRole('menuitem', { name: /^Need help\?/ });
  check(`${label}: Need help? is still disabled and not a link`, (await help.getAttribute('aria-disabled')) === 'true' && (await help.evaluate((e) => e.tagName !== 'A' && !e.hasAttribute('href'))));
  const before = page.url();
  const [popup] = await Promise.all([ctx.waitForEvent('page'), docs.click()]);
  await popup.waitForLoadState('load');
  check(`${label}: clicking it opens the documentation in a NEW tab, and this tab stays where it was`, new URL(popup.url()).pathname === '/docs/' && (await popup.title()) === 'ClothCraft System Documentation' && page.url() === before && ctx.pages().length === 2, popup.url());
  check(`${label}: the new tab has no opener (noopener)`, (await popup.evaluate(() => window.opener === null)) === true);
  check(`${label}: the menu closes and focus returns to the menu button`, (await menu.count()) === 0 && (await button.evaluate((e) => e === document.activeElement)));
  check(`${label}: no sideways scroll in the new tab`, await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await popup.screenshot({ path: path.join(out, `menu-link-${label.replace(/\W+/g, '-')}.png`) });
  await popup.close();
  // keyboard: the item can be reached with the arrow keys and opened with Enter
  await button.focus();
  await page.keyboard.press('Enter');
  await menu.waitFor();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  check(`${label}: with the keyboard, End then Enter on Documentation opens it in a new tab too`, ctx.pages().length === 2 && new URL(ctx.pages()[1].url()).pathname === '/docs/', ctx.pages().map((p) => p.url()).join(' '));
  await ctx.close();
}
if (shop) for (const width of [1440, 390]) await menuCase(`shop signed out ${width}px`, shop, { signedIn: false, width });
if (mock) for (const width of [1440, 390]) {
  await menuCase(`mock signed out ${width}px`, mock, { signedIn: false, width });
  await menuCase(`mock signed in ${width}px`, mock, { signedIn: true, width });
}
if (!shop && !mock) report.data.menu = 'not checked: pass --shop and/or --mock';

await browser.close();
rep.finish();
