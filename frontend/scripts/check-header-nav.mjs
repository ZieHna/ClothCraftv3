// Step A: the sticky header, the hamburger menu, the section links, the Category rename and the tab icons, in real Edge (mouse and
// keyboard), on a PRODUCTION build, at 320, 390, 768, 1024 and 1440 px. It REGISTERS ONE REAL CUSTOMER (for the signed-in menu), so point it
// at a THROWAWAY COPY only:
//   node scripts/check-header-nav.mjs http://localhost:4175 <outDir> --db-container <db container> --db clothcraft_e2e
// (--db-container and --db are only used to refuse a database that is not a throwaway; nothing is read from it.)
// Screenshots go to <outDir>/shots: desktop closed and open menu (signed out and in), phone menu, scrolled header, a hash jump, the favicon.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createReport, launch } from './lib/e2e-common.mjs';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const [base, out] = args;
const db = flag('--db');
if (!base || !out || !db) throw new Error('usage: node scripts/check-header-nav.mjs <baseUrl> <outDir> --db-container <name> --db <throwaway database>');
if (!/^clothcraft_(e2e|ctest|throwaway)/.test(db)) throw new Error(`refusing to run against "${db}": only a throwaway copy (clothcraft_e2e...) may be used`);

const rep = createReport(out, 'header-nav');
const { check, report } = rep;
const browser = await launch();
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(out, 'shots', name), ...opts });
const PASSWORD = 'a long and careful e2e password';
const ipOf = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const WIDTHS = [320, 390, 768, 1024, 1440];
const HEADER = 68; // --header-height 4.25rem
const watch = (page, label) => {
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource: the server responded with a status of (401|404)/.test(m.text()) && report.console.push(`${label} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => report.console.push(`${label} pageerror: ${e.message}`));
};
async function section(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(`${name}: ran to the end`, false, error.message.split('\n')[0]);
  }
}
async function newPage(width, { height = 800, reducedMotion = 'no-preference', label = 'page' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion, extraHTTPHeaders: { 'X-Forwarded-For': ipOf() } });
  const page = await ctx.newPage();
  watch(page, `${label}@${width}`);
  return { ctx, page };
}
const go = async (page, url) => {
  await page.goto(base + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(200);
};
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const headerBox = (page) => page.locator('header').first().boundingBox();
/** scrollY has stopped changing (a smooth scroll has finished) */
async function settled(page) {
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const y = await page.evaluate(() => Math.round(window.scrollY));
    if (y === last) return y;
    last = y;
    await page.waitForTimeout(120);
  }
  return last;
}
const button = (page) => page.getByTestId('account-menu-button');
const panel = (page) => page.getByRole('menu');
async function register(page) {
  const email = `e2e-${randomUUID().slice(0, 12)}@example.test`;
  await button(page).click();
  await page.getByRole('menuitem', { name: 'Register' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your name').fill('Header Check Customer');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await page.getByTestId('signed-in-name').waitFor({ state: 'attached' });
  return email;
}
/** contrast ratio (WCAG) between a text colour and the background it sits on, resolved through a canvas so any CSS colour syntax works */
const CONTRAST = `(a, b) => {
  const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgb = (css) => { c.clearRect(0, 0, 1, 1); c.fillStyle = '#000'; c.fillStyle = css; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3); };
  const lum = ([r, g, bl]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl); };
  const [x, y] = [lum(rgb(a)), lum(rgb(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}`;

// ================================================================================================ what the API has (featured items may be none)
const probe = await newPage(1440, { label: 'probe' });
await go(probe.page, '/');
const featured = (await (await probe.page.request.get(base + '/api/catalogue/featured')).json()).data.products.length;
report.data.featuredItems = featured;
await probe.ctx.close();

// ================================================================================================ per width
for (const width of WIDTHS) {
  const wide = width >= 1024;
  await section(`w${width}`, async () => {
    const { ctx, page } = await newPage(width, { label: 'out' });
    await go(page, '/');
    const tag = `${width}px`;

    // ---- the header: one fixed row, no sideways scroll, sticky, shadow only once scrolled
    const box0 = await headerBox(page);
    check(`${tag} header: one row of the fixed height (${HEADER}px), at the top`, box0.height === HEADER && box0.y === 0, JSON.stringify(box0));
    check(`${tag} header: no sideways page scroll`, await noSideways(page));
    check(`${tag} header: its own content does not overflow`, await page.evaluate(() => { const h = document.querySelector('header > div'); return h.scrollWidth <= h.clientWidth; }));
    check(`${tag} header: no shadow at the top`, (await page.locator('header').first().evaluate((h) => getComputedStyle(h).boxShadow)) === 'none');
    if (width === 1440 || width === 390) await shot(page, `header-closed-signed-out-${width}.png`, { clip: { x: 0, y: 0, width, height: 120 } });
    check(`${tag} header: sticky, with a solid background`, await page.locator('header').first().evaluate((h) => { const s = getComputedStyle(h); return s.position === 'sticky' && /^rgb\(/.test(s.backgroundColor); }));
    const mainNav = page.getByRole('navigation', { name: 'Main' });
    if (wide) {
      const links = await mainNav.getByRole('link').allTextContents();
      check(`${tag} nav: How it works, Category, Browse designs, Featured designs, Design, Contact (in the header row)`, JSON.stringify(links) === JSON.stringify(['How it works', 'Category', 'Featured designs', 'Design', 'Contact']), JSON.stringify(links));
      const gaps = await page.evaluate(() => {
        const nav = document.querySelector('[data-testid="main-nav"]').getBoundingClientRect();
        const logo = document.querySelector('header a[aria-label="ClothCraft, home"]').getBoundingClientRect();
        const menu = document.querySelector('[data-testid="account-menu-button"]').getBoundingClientRect();
        return { logoToNav: Math.round(nav.left - logo.right), navToMenu: Math.round(menu.left - nav.right) };
      });
      check(`${tag} nav: the links do not touch the logo or the menu button (at least 12 px apart)`, gaps.logoToNav >= 12 && gaps.navToMenu >= 12, JSON.stringify(gaps));
    } else {
      check(`${tag} nav: no link row in the header (the links are in the menu)`, (await mainNav.count()) === 0);
    }

    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(500);
    const box1 = await headerBox(page);
    check(`${tag} sticky: after scrolling 1600 px the header is still at the top, the same height`, box1.y === 0 && box1.height === HEADER, JSON.stringify(box1));
    check(`${tag} sticky: it now has a shadow`, (await page.locator('header').first().evaluate((h) => getComputedStyle(h).boxShadow)) !== 'none');
    if (width === 1440 || width === 390) await shot(page, `scrolled-header-${width}.png`);
    await page.mouse.wheel(0, -4000);
    await page.waitForTimeout(400);
    check(`${tag} sticky: back at the top the shadow goes`, (await page.locator('header').first().evaluate((h) => getComputedStyle(h).boxShadow)) === 'none');

    // ---- the menu, with the mouse
    const btn = button(page);
    const size = await btn.boundingBox();
    check(`${tag} menu button: at least 44 x 44 px, at the right end of the header`, size.width >= 44 && size.height >= 44 && Math.abs(size.x + size.width - (width - (await page.evaluate(() => (document.documentElement.clientWidth - document.querySelector('header > div').getBoundingClientRect().right)))) ) < 2 || size.x + size.width > width * 0.6, JSON.stringify(size));
    check(`${tag} menu button: closed it says "Open menu", aria-expanded false, and the panel is not there`, (await btn.getAttribute('aria-label')) === 'Open menu' && (await btn.getAttribute('aria-expanded')) === 'false' && (await panel(page).count()) === 0);
    const barsClosed = await btn.locator('span[aria-hidden] > span').evaluateAll((els) => els.map((e) => getComputedStyle(e).rotate + '|' + getComputedStyle(e).opacity));
    await btn.click();
    await panel(page).waitFor();
    await page.waitForTimeout(350);
    const barsOpen = await btn.locator('span[aria-hidden] > span').evaluateAll((els) => els.map((e) => getComputedStyle(e).rotate + '|' + getComputedStyle(e).opacity));
    check(`${tag} menu: open it says "Close menu", aria-expanded true and aria-controls names the panel`, (await btn.getAttribute('aria-label')) === 'Close menu' && (await btn.getAttribute('aria-expanded')) === 'true' && (await btn.getAttribute('aria-controls')) === (await panel(page).getAttribute('id')));
    check(`${tag} menu: the three bars become an X (outer bars rotate +-45 degrees, the middle one disappears)`, barsClosed[0].startsWith('none') && barsOpen[0].startsWith('45deg') && barsOpen[2].startsWith('-45deg') && barsOpen[1].endsWith('|0') && barsClosed[1].endsWith('|1'), JSON.stringify({ barsClosed, barsOpen }));
    check(`${tag} menu: focus moved into the panel (the first item)`, await page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem' && document.activeElement === document.querySelector('[role="menu"] [role="menuitem"]')));
    const labels = (await panel(page).getByRole('menuitem').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
    const tail = ['Register', 'Login', 'CC user', 'Need help? Coming soon', 'Documentation (opens in a new tab)'];
    const head = wide ? [] : ['How it works', 'Category', 'Featured designs', 'Design', 'Contact'];
    check(`${tag} menu (signed out): ${wide ? '' : 'the five links, a divider, then '}Register, Login, CC user, Need help?, Documentation`, JSON.stringify(labels) === JSON.stringify([...head, ...tail]), JSON.stringify(labels));
    const fits = await panel(page).evaluate((p) => { const r = p.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; });
    check(`${tag} menu: the panel is inside the screen`, fits);
    // (before anything inside is clicked, so the first item is the focused one, as a visitor first sees it)
    if (width === 1440) await shot(page, 'menu-open-signed-out-1440.png');
    if (width === 390) await shot(page, 'menu-open-signed-out-390.png');
    if (width === 320) await shot(page, 'menu-open-signed-out-320.png');
    check(`${tag} menu: no sideways page scroll with it open`, await noSideways(page));
    const heights = await panel(page).getByRole('menuitem').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    check(`${tag} menu: every item is at least 44 px tall`, heights.every((h) => h >= 44), JSON.stringify(heights));
    const help = panel(page).getByRole('menuitem', { name: /^Need help\?/ });
    const helpState = await help.evaluate((e) => [e.getAttribute('aria-disabled'), e.tagName, e.hasAttribute('href')]);
    check(`${tag} menu: Need help? is aria-disabled, not a link`, JSON.stringify(helpState) === JSON.stringify(['true', 'SPAN', false]), JSON.stringify(helpState));
    const docs = panel(page).getByRole('menuitem', { name: /^Documentation/ });
    const docsState = await docs.evaluate((e) => [e.tagName, e.getAttribute('href'), e.getAttribute('target'), e.getAttribute('rel'), e.hasAttribute('aria-disabled')]);
    check(`${tag} menu: Documentation is a link to /docs/ that opens in a new tab (target _blank, rel noopener), not disabled`, docsState[0] === 'A' && docsState[1] === '/docs/' && docsState[2] === '_blank' && /noopener/.test(docsState[3] ?? '') && docsState[4] === false, JSON.stringify(docsState));
    const urlBefore = page.url();
    // Playwright itself refuses to click an aria-disabled item (not "enabled"): force it, as a visitor's click would land
    await help.click({ force: true });
    check(`${tag} menu: clicking Need help? does nothing (still open, same address)`, (await panel(page).count()) === 1 && page.url() === urlBefore);
    // text contrast of what is shown in the panel (normal and "Coming soon" text, and the focused item)
    const contrast = await page.evaluate(`(() => { const ratio = ${CONTRAST}; const p = document.querySelector('[role="menu"]'); const panelBg = getComputedStyle(p).backgroundColor;
      // the background an element is really on: its own if it has one (a focused item is ink), else the panel's
      const bgOf = (e) => { const own = getComputedStyle(e).backgroundColor; return /rgba\\(0, 0, 0, 0\\)|transparent/.test(own) ? panelBg : own; }; // (inside a template string: the backslashes are doubled)
      const rows = [...p.querySelectorAll('[role="menuitem"]')].map((e) => [e.textContent.trim().slice(0, 14) + (e === document.activeElement ? ' (focused)' : ''), ratio(getComputedStyle(e).color, bgOf(e))]);
      const chip = p.querySelector('[aria-disabled] span'); rows.push(['chip', ratio(getComputedStyle(chip).color, bgOf(chip.parentElement))]);
      return rows; })()`);
    check(`${tag} menu: text contrast is at least 4.5:1 everywhere (items, "Coming soon", the focused item)`, contrast.every(([, r]) => r >= 4.5), JSON.stringify(contrast.map(([n, r]) => [n, Math.round(r * 10) / 10])));

    // Esc closes and gives focus back; a press outside closes
    await page.keyboard.press('Escape');
    check(`${tag} menu: Esc closes it and puts focus back on the button`, (await panel(page).count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'account-menu-button');
    await btn.click();
    await panel(page).waitFor();
    await page.mouse.click(Math.round(width / 2), 700);
    check(`${tag} menu: a click outside closes it`, (await panel(page).count()) === 0);

    // keyboard only: Tab to the button, Enter opens, arrows move, Space toggles
    await page.keyboard.press('Escape');
    await btn.focus();
    await page.keyboard.press('Enter');
    await panel(page).waitFor();
    const first = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 14));
    await page.keyboard.press('ArrowDown');
    const second = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 14));
    check(`${tag} menu (keyboard): Enter opens it with focus on the first item, ArrowDown moves on`, !!first && !!second && first !== second, `${first} -> ${second}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');
    check(`${tag} menu (keyboard): Space opens it too`, (await panel(page).count()) === 1);
    await page.keyboard.press('Escape');

    // CC user goes to the staff sign-in
    await btn.click();
    await panel(page).getByRole('menuitem', { name: 'CC user' }).click();
    await page.waitForURL('**/staff');
    await page.getByLabel('Email').waitFor();
    check(`${tag} CC user: opens the staff sign-in at /staff`, new URL(page.url()).pathname === '/staff' && (await page.getByRole('button', { name: 'Sign in' }).count()) > 0);
    await ctx.close();
  });
}

// ================================================================================================ the section links (every width)
for (const width of WIDTHS) {
  const wide = width >= 1024;
  await section(`anchors@${width}`, async () => {
    const { ctx, page } = await newPage(width, { height: 800, label: 'anchors' });
    await go(page, '/');
    const targets = [
      ['How it works', 'how-it-works'],
      ['Browse designs', 'browse-designs'],
      ...(featured > 0 ? [['Featured designs', 'featured']] : []),
      ['Contact', 'contact'],
    ];
    for (const [name, id] of targets) {
      // from the top of the page each time, so each jump is a real scroll
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(150);
      if (wide) await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();
      else {
        await button(page).click();
        await panel(page).getByRole('menuitem', { name }).click();
      }
      const y = await settled(page);
      const heading = page.locator(`#${id} h2`).first();
      const top = await heading.evaluate((h) => Math.round(h.getBoundingClientRect().top));
      const focused = await page.evaluate(() => document.activeElement?.closest('section')?.id ?? document.activeElement?.tagName);
      check(`${width}px "${name}": lands with the heading below the header (top ${top}px, header ${HEADER}px) and visible`, top >= HEADER && top < 400, String(top));
      check(`${width}px "${name}": the address now ends in #${id}`, new URL(page.url()).hash === `#${id}`, page.url());
      check(`${width}px "${name}": focus is on the section's heading`, focused === id && (await page.evaluate(() => document.activeElement?.tagName)) === 'H2', String(focused));
      check(`${width}px "${name}": the header is still at the top and nothing scrolls sideways`, (await headerBox(page)).y === 0 && (await noSideways(page)), `y=${y}`);
      if (width === 1440 && id === 'contact') await shot(page, 'hash-jump-contact-1440.png');
      if (width === 390 && id === 'browse-designs') await shot(page, 'hash-jump-browse-designs-390.png');
    }
    if (wide) {
      const current = await page.getByRole('navigation', { name: 'Main' }).locator('[aria-current="location"]').allTextContents();
      check(`${width}px nav: after the jump to Contact, "Contact" is the current section (aria-current="location")`, JSON.stringify(current) === JSON.stringify(['Contact']), JSON.stringify(current));
    }
    // the same link twice, and from another page
    await go(page, '/category');
    if (wide) await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Contact' }).click();
    else {
      await button(page).click();
      await panel(page).getByRole('menuitem', { name: 'Contact' }).click();
    }
    await page.waitForURL('**/#contact');
    await settled(page);
    check(`${width}px from /category: "Contact" goes to the landing page's Contact section`, await page.evaluate(() => document.querySelector('#contact h2').getBoundingClientRect().top >= 68));
    await ctx.close();
  });
}

// ================================================================================================ reduced motion: nothing animates, scrolling is instant
await section('reduced', async () => {
  const { ctx, page } = await newPage(1440, { reducedMotion: 'reduce', label: 'reduced' });
  await go(page, '/');
  await button(page).click();
  const dur = await button(page).locator('span[aria-hidden] > span').evaluateAll((els) => els.map((e) => getComputedStyle(e).transitionDuration));
  check('reduced motion: the X has no transition (the bars swap at once)', dur.every((d) => parseFloat(d) <= 0.001), JSON.stringify(dur));
  await page.keyboard.press('Escape');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Contact' }).click();
  await page.waitForTimeout(120);
  const y1 = await page.evaluate(() => Math.round(window.scrollY));
  await page.waitForTimeout(600);
  const y2 = await page.evaluate(() => Math.round(window.scrollY));
  check('reduced motion: the jump to a section is instant (the scroll position after 120 ms is the final one)', y1 > 500 && Math.abs(y1 - y2) <= 2, `${y1} -> ${y2}`);
  await ctx.close();
});
await section('smooth', async () => {
  const { ctx, page } = await newPage(1440, { label: 'smooth' });
  await go(page, '/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Contact' }).click();
  await page.waitForTimeout(60);
  const early = await page.evaluate(() => Math.round(window.scrollY));
  const end = await settled(page);
  check('smooth motion: the jump is animated (60 ms after the click it is not there yet)', early < end - 100, `${early} -> ${end}`);
  await ctx.close();
});

// ================================================================================================ signed in
await section('signed-in', async () => {
  for (const width of [320, 1440]) {
    const { ctx, page } = await newPage(width, { label: 'in' });
    await go(page, '/category');
    await register(page);
    const tag = `${width}px signed in`;
    check(`${tag}: the header still fits (no sideways scroll, own content not overflowing) with the cart link and the menu button`, (await noSideways(page)) && (await page.evaluate(() => { const h = document.querySelector('header > div'); return h.scrollWidth <= h.clientWidth; })));
    check(`${tag}: the cart link is there`, (await page.getByRole('link', { name: /^Cart/ }).count()) === 1);
    if (width === 1440) {
      // what "Design" in the nav does: with no garment chosen it says so and points to Category
      await go(page, '/design');
      check('Design (nav link, signed in, no garment chosen): says "No garment chosen yet" and links to Category', (await page.getByText('No garment chosen yet.').count()) === 1 && (await page.getByRole('link', { name: 'Choose a category' }).getAttribute('href')) === '/category');
      await go(page, '/category');
    }
    await button(page).click();
    await panel(page).waitFor();
    const labels = (await panel(page).getByRole('menuitem').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
    const head = width >= 1024 ? [] : ['How it works', 'Category', 'Featured designs', 'Design', 'Contact'];
    check(`${tag}: ${width >= 1024 ? '' : 'the links, then '}Account, Orders, Sign out, Need help?, Documentation (no Register, Login or CC user)`, JSON.stringify(labels) === JSON.stringify([...head, 'Account', 'Orders', 'Sign out', 'Need help? Coming soon', 'Documentation (opens in a new tab)']), JSON.stringify(labels));
    check(`${tag}: the panel shows the name and email`, (await page.getByTestId('menu-who').textContent()).includes('Header Check Customer'));
    if (width === 1440) {
      check('1440px signed in: the name is also shown beside the menu button', (await page.getByTestId('signed-in-name').isVisible()));
      await shot(page, 'menu-open-signed-in-1440.png');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(450); // the X has turned back into the three bars
      await shot(page, 'header-closed-signed-in-1440.png', { clip: { x: 0, y: 0, width: 1440, height: 120 } });
      await button(page).click();
      await panel(page).waitFor();
    } else {
      await shot(page, 'menu-open-signed-in-320.png');
    }
    await panel(page).getByRole('menuitem', { name: 'Orders' }).click();
    await page.waitForURL('**/account#orders');
    check(`${tag}: Orders goes to the account page's orders`, new URL(page.url()).pathname === '/account');
    await button(page).click();
    await panel(page).getByRole('menuitem', { name: 'Sign out' }).click();
    await page.getByTestId('signed-in-name').waitFor({ state: 'detached' });
    check(`${tag}: Sign out signs out (no name, no cart link)`, (await page.getByRole('link', { name: /^Cart/ }).count()) === 0);
    await ctx.close();
  }
});

// ================================================================================================ Category (was Browse)
await section('category', async () => {
  const { ctx, page } = await newPage(1440, { label: 'category' });
  await go(page, '/category');
  check('category: the page heading is "Category" and the tab title says so', (await page.getByRole('heading', { level: 1 }).textContent()) === 'Category' && (await page.title()) === 'Category · ClothCraft', await page.title());
  check('category: the nav link is the current page (aria-current="page")', (await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Category' }).getAttribute('aria-current')) === 'page');
  check('category: there is no "Browse" link in the nav', (await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Browse', exact: true }).count()) === 0);
  await go(page, '/browse?group=Men&stock=1#top');
  check('/browse redirects to /category with its query string and hash', new URL(page.url()).pathname === '/category' && new URL(page.url()).search === '?group=Men&stock=1' && new URL(page.url()).hash === '#top', page.url());
  await go(page, '/browse');
  check('/browse (no query) redirects to /category', new URL(page.url()).pathname === '/category' && new URL(page.url()).search === '');
  await page.goBack();
  check('Back from the redirected page does not return to /browse', !new URL(page.url()).pathname.startsWith('/browse'), page.url());
  // the product page's breadcrumb and the tiles
  await go(page, '/');
  await page.locator('[data-testid="category"] a').first().waitFor();
  const href = await page.locator('[data-testid="category"] a').first().getAttribute('href');
  const text = await page.locator('[data-testid="category"] a').first().textContent();
  check('landing: the "Shop by category" tiles link to /category?group=... and say "Shop <group>"', /^\/category\?group=/.test(href) && /Shop (Men|Women|Kids|Babies)/.test(text), `${href} ${text}`);
  const cat = await page.evaluate(() => [...document.querySelectorAll('a')].filter((a) => (a.getAttribute('href') ?? '').startsWith('/browse')).length);
  check('landing: no link on the page still points at /browse', cat === 0, String(cat));
  await page.locator('[data-testid="category"] a').first().click();
  await page.waitForURL('**/category?group=*');
  await page.locator('[data-testid="product-card"] a').first().click();
  await page.waitForURL('**/products/*');
  await page.getByRole('navigation', { name: 'Breadcrumb' }).waitFor();
  const crumbs = await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link').allTextContents();
  check('product page: the breadcrumb says Category > <group>', crumbs.length === 2 && crumbs[0] === 'Category', JSON.stringify(crumbs));
  await ctx.close();
});

// ================================================================================================ the landing's hero buttons and the new section
await section('hero', async () => {
  const { ctx, page } = await newPage(1440, { label: 'hero' });
  await go(page, '/');
  check('landing: the Browse designs section has its heading and one honest line, and nothing to click', (await page.locator('#browse-designs h2').textContent()).startsWith('Browse') && (await page.getByTestId('browse-designs-note').textContent()) === 'Predesigned shirts are coming soon.' && (await page.locator('#browse-designs a, #browse-designs button').count()) === 0);
  check('landing: How it works is followed by Browse designs', await page.evaluate(() => { const ids = [...document.querySelectorAll('main section[id]')].map((s) => s.id); return ids.indexOf('browse-designs') === ids.indexOf('how-it-works') + 1; }));
  check('landing: the featured section heading says "Featured designs"', featured === 0 || (await page.locator('#featured h2').textContent()).replace(/\s+/g, ' ').startsWith('Featured designs'), String(await page.locator('#featured h2').textContent().catch(() => '(no featured items)')));
  await page.getByRole('link', { name: 'Browse designs' }).filter({ hasText: /^Browse designs$/ }).last().waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('section[aria-label="Welcome"]').getByRole('link', { name: 'Browse designs' }).click();
  await settled(page);
  check('hero: "Browse designs" scrolls to #browse-designs (it stays on the landing page)', new URL(page.url()).pathname === '/' && new URL(page.url()).hash === '#browse-designs');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('section[aria-label="Welcome"]').getByRole('button', { name: 'Design your own' }).click();
  await page.getByRole('dialog').waitFor();
  check('hero: "Design your own" signed out asks to sign in first (and stays on the landing page)', new URL(page.url()).pathname === '/' && (await page.getByRole('dialog').getByRole('heading').first().textContent()) !== '');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await ctx.close();
});

// ================================================================================================ tab icons
await section('icons', async () => {
  const { ctx, page } = await newPage(1440, { label: 'icons' });
  const requests = [];
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  await go(page, '/');
  const tags = await page.evaluate(() => ({
    links: [...document.head.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')].map((l) => ({ rel: l.rel, href: l.getAttribute('href'), sizes: l.getAttribute('sizes'), type: l.getAttribute('type') })),
    theme: document.head.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
  }));
  report.data.iconTags = tags;
  const has = (rel, href) => tags.links.some((l) => l.rel.split(' ').includes(rel) && l.href === href);
  check('icons: <link rel="icon"> to /favicon.ico (16, 32, 48), the 32 and 192 px PNGs, the apple-touch-icon and the manifest are in the page', has('icon', '/favicon.ico') && has('icon', '/favicon-32.png') && has('icon', '/icon-192.png') && has('apple-touch-icon', '/apple-touch-icon.png') && has('manifest', '/site.webmanifest'), JSON.stringify(tags.links));
  check('icons: a theme-color meta is there', /^#[0-9a-f]{6}$/i.test(tags.theme ?? ''), String(tags.theme));
  const sizes = {};
  for (const [href, want] of [['/favicon-32.png', 32], ['/icon-192.png', 192], ['/icon-512.png', 512], ['/apple-touch-icon.png', 180]]) {
    const r = await page.request.get(base + href);
    const dims = await page.evaluate(async (u) => { const img = new Image(); img.src = u; await img.decode(); return [img.naturalWidth, img.naturalHeight]; }, href);
    sizes[href] = { status: r.status(), type: r.headers()['content-type'], dims };
    check(`icons: ${href} is a ${want} x ${want} PNG`, r.status() === 200 && /image\/png/.test(r.headers()['content-type']) && dims[0] === want && dims[1] === want, JSON.stringify(sizes[href]));
  }
  const ico = await page.request.get(base + '/favicon.ico');
  const body = await ico.body();
  const count = body.readUInt16LE(4);
  const entries = [0, 1, 2].map((i) => body[6 + 16 * i]);
  check('icons: /favicon.ico is a real .ico with 16, 32 and 48 px images', ico.status() === 200 && body.readUInt16LE(2) === 1 && count === 3 && JSON.stringify(entries) === JSON.stringify([16, 32, 48]), JSON.stringify({ status: ico.status(), count, entries }));
  const manifest = await (await page.request.get(base + '/site.webmanifest')).json();
  check('icons: the manifest names the site and the 192 and 512 icons', manifest.name === 'ClothCraft' && manifest.icons.length === 2);
  check('icons: the page asked for no missing favicon (no 404s)', !requests.some((p) => p === '/favicon.png'));
  // what the tab shows, rendered at 16 and 32 px (device pixels) next to the page title colour
  await page.setContent(`<body style="margin:0;background:#dee1e6;font:14px sans-serif"><div style="display:flex;gap:24px;padding:16px;align-items:center">
    <img src="${base}/favicon.ico" width="16" height="16" style="image-rendering:pixelated"><span>16 px</span>
    <img src="${base}/favicon-32.png" width="32" height="32" style="image-rendering:pixelated"><span>32 px</span>
    <img src="${base}/favicon.ico" width="16" height="16" style="width:128px;height:128px;image-rendering:pixelated"><span>16 px, enlarged 8x</span>
    <img src="${base}/favicon-32.png" style="width:256px;height:256px;image-rendering:pixelated"><span>32 px, enlarged 8x</span></div></body>`);
  await page.waitForTimeout(400);
  await shot(page, 'favicon-16-32.png', { clip: { x: 0, y: 0, width: 760, height: 300 } });
  await ctx.close();
});

// ================================================================================================ the landing page loads no editor code
await section('bundle', async () => {
  const { ctx, page } = await newPage(1440, { label: 'bundle' });
  const files = [];
  page.on('request', (r) => /\.js(\?|$)/.test(r.url()) && files.push(new URL(r.url()).pathname));
  await go(page, '/');
  report.data.landingScripts = files;
  const bodies = [];
  for (const f of files) bodies.push(await (await page.request.get(base + f)).text());
  check('bundle: the landing page downloads no editor or Fabric chunk', !files.some((f) => /fabric|Design-|EditorStage|SimpleEditor/i.test(f)) && !bodies.some((b) => /fabric\.Canvas|new fabric\./.test(b)), JSON.stringify(files));
  await ctx.close();
});

await browser.close();
rep.finish();
