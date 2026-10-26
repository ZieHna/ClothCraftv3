// Shared helpers for the end-to-end scripts that drive the built editor in the REAL installed Microsoft Edge
// (playwright-core, channel "msedge"; no browser is downloaded). Run against a running build:
//   npm run build:mock && npx vite preview --port 4173
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

export const DESIGN = '/design?product=m-tee&variant=SIM-M-TEE-NVY-M';
/**
 * A customer who is already registered and signed in, in the MOCK (VITE_API=mock): the account, its session token and the
 * mock server's bookkeeping are written into this tab's sessionStorage before the page loads, exactly what registering and signing
 * in leave behind (src/api/client.ts MOCK_SESSION_KEY, src/mocks/shopDb.ts). The account id decides the drafts key ("u<id>").
 * It is written only when no session is there yet, so signing out is not undone by the next page load; `force` replaces
 * whatever session there is (a second person in the same browser).
 * Real sign-in is tested against the real service by check-shop-real.mjs and check-shop-auth.mjs.
 */
export const SEED_PASSWORD = 'seeded password 123';
export const userKeyOf = (id) => `u${id}`;
export function seedAccount(target, name = 'Demo customer', id = 1, { force = false } = {}) {
  if (process.env.E2E_LEGACY_SEED === '1') {
    // only to record a baseline from a build made BEFORE step 6d, which still reads the old demo session
    return target.addInitScript((n) => { try { sessionStorage.setItem('cc.demo.session', JSON.stringify({ displayName: n, demo: true })); } catch { /* about:blank */ } }, name);
  }
  return target.addInitScript(
    ({ name, id, force, password }) => {
      try {
        if (!force && sessionStorage.getItem('cc.mock.session')) return;
        const db = JSON.parse(sessionStorage.getItem('cc.mock.db.v1') || 'null') || { nextNumber: 1, orders: [], idempotency: {}, priceDelta: {} };
        db.users = db.users || [];
        db.sessions = db.sessions || {};
        db.throttle = db.throttle || {};
        if (!db.users.some((u) => u.id === id)) db.users.push({ id, name, email: `${name.toLowerCase().replace(/\W+/g, '-')}@example.test`, password });
        db.nextUserId = Math.max(db.nextUserId || 1, id + 1);
        db.sessions[`seed-${id}`] = id;
        sessionStorage.setItem('cc.mock.db.v1', JSON.stringify(db));
        sessionStorage.setItem('cc.mock.session', `seed-${id}`);
      } catch {
        /* about:blank has no storage: that is fine */
      }
    },
    { name, id, force, password: SEED_PASSWORD },
  );
}

export function createReport(out, name) {
  mkdirSync(out, { recursive: true });
  const report = { name, checks: [], failures: [], console: [], data: {} };
  return {
    report,
    check(label, ok, detail = '') {
      report.checks.push({ name: label, ok: !!ok, detail });
      if (!ok) report.failures.push(`${label} ${detail}`);
    },
    finish() {
      this.check('no console errors or warnings in any run', report.console.length === 0, report.console.join(' || '));
      writeFileSync(path.join(out, `${name}.json`), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ script: name, passed: report.checks.filter((c) => c.ok).length, failed: report.failures, data: report.data, console: report.console }, null, 2));
      process.exit(report.failures.length ? 1 : 0);
    },
  };
}

/** A real logo-like PNG, a photo-like JPEG (large), and a few heavy noise pictures, made once with sharp. */
export async function makeFixtures(out) {
  const dir = path.join(out, 'fixtures');
  mkdirSync(dir, { recursive: true });
  const logo = path.join(dir, 'logo.png');
  await sharp({ create: { width: 420, height: 300, channels: 4, background: { r: 201, g: 162, b: 39, alpha: 1 } } })
    .composite([{ input: Buffer.from('<svg width="420" height="300"><circle cx="210" cy="150" r="110" fill="#fffdf8"/><circle cx="210" cy="150" r="70" fill="#a8353a"/><rect x="40" y="130" width="340" height="40" fill="#243049" opacity="0.85"/></svg>') }])
    .png()
    .toFile(logo);
  // a photo-like picture: smooth gradients with texture, so a JPEG of it is a realistic few MB and decoding it is real work
  const w = 4000;
  const h = 3000;
  const raw = Buffer.alloc(w * h * 3);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const n = rnd() * 40;
      raw[i] = Math.min(255, 40 + (x / w) * 180 + n + Math.sin(y / 90) * 20);
      raw[i + 1] = Math.min(255, 60 + (y / h) * 150 + n + Math.cos(x / 120) * 25);
      raw[i + 2] = Math.min(255, 120 + ((x + y) / (w + h)) * 100 + n);
    }
  }
  const photo = path.join(dir, 'photo-4000x3000.jpg');
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 88 }).toFile(photo);
  const noise = [];
  for (let k = 0; k < 8; k++) {
    const nw = 1000;
    const nh = 700;
    const buf = Buffer.alloc(nw * nh * 3);
    for (let i = 0; i < buf.length; i++) buf[i] = (rnd() * 256) | 0;
    const file = path.join(dir, `noise-${k}.png`);
    await sharp(buf, { raw: { width: nw, height: nh, channels: 3 } }).png({ compressionLevel: 1 }).toFile(file);
    noise.push(file);
  }
  return { dir, logo, photo, noise };
}

export function launch() {
  // precise memory and gc() so heap numbers mean something
  return chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
}

/**
 * Opens /design in a fresh context. `touch: true` makes it a phone-like context (touch input, mobile emulation, coarse pointer).
 * Console errors and warnings are collected into the report.
 */
export async function openEditor(browser, base, rep, o = {}) {
  const { width = 1440, height = 900, dpr = 1, touch = false, mobile = touch, reducedMotion = 'no-preference', url = DESIGN, colorScheme } = o;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, hasTouch: touch, isMobile: mobile, reducedMotion, colorScheme });
  await seedAccount(ctx);
  const page = await ctx.newPage();
  const tag = `${width}x${height}${touch ? ' touch' : ''}`;
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && rep.report.console.push(`${tag} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => rep.report.console.push(`${tag} pageerror: ${e.message}`));
  await page.goto(base + url, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="editor-host"] canvas.upper-canvas').waitFor({ state: 'attached' });
  await page.waitForFunction(() => !document.querySelector('nav[aria-label="Design tools"] button')?.disabled);
  await page.waitForTimeout(300);
  const cdp = await ctx.newCDPSession(page);
  return { ctx, page, cdp };
}

/** Real multi-touch through the DevTools protocol: every touchStart/touchMove lists ALL fingers down; touchEnd lifts them. */
export function touchDriver(cdp) {
  const send = (type, pts) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i + 1, radiusX: 4, radiusY: 4, force: 1 })) });
  return {
    start: (pts) => send('touchStart', pts),
    move: (pts) => send('touchMove', pts),
    end: () => send('touchEnd', []),
    /** a whole gesture: fingers go from `from` to `to` in `steps` moves, `ms` apart, then lift */
    async gesture(from, to, steps = 12, ms = 16) {
      await send('touchStart', from);
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        await send(
          'touchMove',
          from.map((f, j) => ({ id: f.id, x: f.x + (to[j].x - f.x) * k, y: f.y + (to[j].y - f.y) * k })),
        );
        if (ms) await new Promise((r) => setTimeout(r, ms));
      }
      await send('touchEnd', []);
    },
  };
}

/** two finger points about a centre, `half` px each side, twisted by `deg` */
export function twoFingers(c, half, deg) {
  const a = (deg * Math.PI) / 180;
  return [
    { id: 1, x: c.x - Math.cos(a) * half, y: c.y - Math.sin(a) * half },
    { id: 2, x: c.x + Math.cos(a) * half, y: c.y + Math.sin(a) * half },
  ];
}

export const stage = (page) =>
  page.evaluate(() => {
    const s = document.querySelector('[data-editor-stage]');
    const r = document.querySelector('canvas.upper-canvas').getBoundingClientRect();
    return { ...s.dataset, left: r.left, top: r.top, width: r.width, height: r.height };
  });

/** where a design point (800-unit square) is on screen, given the stage's current view */
export async function screenOf(page, x, y) {
  const s = await stage(page);
  return { x: s.left + Number(s.panX) + x * Number(s.zoom), y: s.top + Number(s.panY) + y * Number(s.zoom) };
}

/** drawn-pixel statistics of the design canvas, in CSS px */
export const ink = (page) =>
  page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = document.querySelector('[data-testid="editor-host"] canvas.lower-canvas');
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    const cx = copy.getContext('2d', { willReadFrequently: true });
    cx.drawImage(c, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    const back = c.width / c.clientWidth;
    let n = 0, sx = 0, sy = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 20) { n++; sx += x; sy += y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { n: n / (back * back), cx: n ? sx / n / back : 0, cy: n ? sy / n / back : 0, w: (x1 - x0) / back, h: (y1 - y0) / back };
  });

export const live = (page) => page.getByTestId('live-region').textContent();

/** WCAG contrast of every visible piece of text (and every field) under the given selectors, from rendered styles */
export function contrastOf(page, selectors) {
  return page.evaluate((sel) => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      const p = m[1].split(/[ ,\/]+/).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
    };
    const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const bgOf = (el) => {
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c.a > 0.99) return c;
      }
      return { r: 245, g: 240, b: 232, a: 1 };
    };
    const rows = [];
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('.sr-only') || el.matches('svg, svg *, canvas, option, input[type=color], input[type=range], input[type=file]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own && !el.matches('input, select, textarea')) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue; // disabled controls are exempt from contrast rules
      const s = getComputedStyle(el);
      const fg = parse(s.color), bg = bgOf(el);
      const [hi, lo] = [L(fg), L(bg)].sort((a, b) => b - a);
      rows.push({ el: el.tagName.toLowerCase() + ':' + (el.textContent || el.value || '').trim().slice(0, 24), ratio: +(((hi + 0.05) / (lo + 0.05)).toFixed(2)) });
    }
    rows.sort((a, b) => a.ratio - b.ratio);
    return { count: rows.length, lowest: rows.slice(0, 4), below45: rows.filter((x) => x.ratio < 4.5) };
  }, selectors);
}

/** every control a finger could touch inside `root`, with its on-screen size; visually hidden radios are measured by their label */
export function targetsOf(page, rootSelector) {
  return page.evaluate((rootSel) => {
    const root = document.querySelector(rootSel) ?? document;
    const out = [];
    for (const el of root.querySelectorAll('button, a[href], input, select, textarea, summary, [role="button"], label.option')) {
      let box = el;
      if (el.matches('input')) {
        if (el.type === 'hidden' || el.type === 'file') continue;
        if (el.classList.contains('sr-only')) box = el.labels?.[0] ?? el;
        else if (el.type === 'checkbox' || el.type === 'radio') box = el.closest('label') ?? el;
      }
      if (el.matches('label.option') && el.control) continue; // counted through its radio
      const r = box.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (getComputedStyle(box).visibility === 'hidden') continue;
      if (box.closest('[hidden], [inert]') || box.closest('.sr-only')) continue;
      out.push({ what: el.tagName.toLowerCase() + ':' + ((el.getAttribute('aria-label') || el.textContent || el.id || el.type || '').trim().slice(0, 28)), w: Math.round(r.width), h: Math.round(r.height) });
    }
    return out;
  }, rootSelector);
}

// ---- step 12: the real shop keeps the cart on the account (GET/PUT /api/cart); this device keeps a copy under cc.cart.v2:<id>
/** this device's copy of the signed-in customer's cart (src/cart/cartStore.ts cartV2KeyFor) */
export const cartCopyKey = (page) => page.evaluate(async () => `cc.cart.v2:${(await (await fetch('/api/auth/me')).json()).data.user.id}`);

/**
 * Seed the signed-in customer's cart through the API, as a whole-cart PUT with the version the account has now (what the page itself
 * does). A line is stored ticked unless it says selected: false. The page shows it on its next load.
 */
export async function seedCart(page, lines) {
  const sent = lines.map(({ selected = true, sku, quantity, designId }) => ({ sku, quantity, selected, ...(designId ? { designId } : {}) }));
  const answer = await page.evaluate(async (l) => {
    const now = await (await fetch('/api/cart', { headers: { Accept: 'application/json' } })).json();
    const res = await fetch('/api/cart', { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ baseVersion: now.data.version, lines: l }) });
    return { status: res.status, body: await res.text() };
  }, sent);
  if (answer.status !== 200) throw new Error(`seeding the cart through PUT /api/cart failed: ${answer.status} ${answer.body.slice(0, 200)}`);
}

/**
 * The cart as the page keeps it (this device's copy: {sku, productId, quantity, designId?, estimate?, selected?}), once the page has
 * saved everything and the account's cart says the same (keys, quantities, ticks, order). Throws if they do not agree within `ms`.
 */
export async function savedCart(page, ms = 8000) {
  const key = await cartCopyKey(page);
  const until = Date.now() + ms;
  let last = '';
  for (;;) {
    const { copy, server } = await page.evaluate(async (k) => ({
      copy: JSON.parse(localStorage.getItem(k) ?? 'null'),
      server: (await (await fetch('/api/cart', { headers: { Accept: 'application/json' } })).json()).data,
    }), key);
    const lines = copy?.lines ?? [];
    const a = JSON.stringify(lines.map((l) => [l.sku, l.designId ?? null, l.quantity, !!l.selected]));
    const b = JSON.stringify(server.lines.map((l) => [l.sku, l.designId ?? null, l.quantity, !!l.selected]));
    if (copy && copy.pending === false && a === b) return lines;
    last = `copy ${a} pending ${copy?.pending} / account ${b}`;
    if (Date.now() > until) throw new Error(`the page's cart and the account's cart did not agree: ${last}`);
    await page.waitForTimeout(150);
  }
}
