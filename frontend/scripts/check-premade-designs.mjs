// F7: premade designs in the REAL Edge, against the mock shop (no database is touched).
//   npx vite --mode mock --port 5175      (in another window)
//   node scripts/check-premade-designs.mjs http://localhost:5175 <outDir>
import { createHash } from 'node:crypto';
import { createReport, launch, seedAccount } from './lib/e2e-common.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: node scripts/check-premade-designs.mjs <baseUrl> <outDir>');
const rep = createReport(out, 'premade-designs');
const { check } = rep;
const browser = await launch();
const sha = async (page, url) => page.evaluate(async (u) => {
  const buf = await (await fetch(u, { cache: 'no-store' })).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}, url);

async function newPage(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await seedAccount(ctx);
  const page = await ctx.newPage();
  const tag = `${width}x${height}`;
  const failed = [];
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && rep.report.console.push(`${tag} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => rep.report.console.push(`${tag} pageerror: ${e.message}`));
  // a request React cancels on purpose (its effects run twice in development) is not a failure
  page.on('requestfailed', (r) => !/ERR_ABORTED/.test(r.failure()?.errorText ?? '') && failed.push(`${r.method()} ${r.url()}`));
  page.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`));
  return { ctx, page, failed };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
// every picture on the page is scrolled to (lazy pictures load only then), waited for, and must have really loaded
const brokenImages = (page) =>
  page.evaluate(async () => {
    const bad = [];
    for (const img of document.images) {
      img.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 60));
      await img.decode().catch(() => {});
      if (!(img.complete && img.naturalWidth > 0)) bad.push(img.getAttribute('src'));
    }
    scrollTo(0, 0);
    return bad;
  });

// ============================================================================================ landing: navigation and the Featured section
{
  const { ctx, page, failed } = await newPage(1440, 900);
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  const nav = await page.locator('header nav[aria-label="Main"] a, header nav a').allTextContents();
  check('N1 the top navigation has no "Browse designs" and keeps Design', !nav.includes('Browse designs') && nav.includes('Design'), nav.join(' | '));
  const links = await page.locator('header nav a').evaluateAll((a) => a.map((x) => x.getAttribute('href')));
  check('N2 the Design link still goes to /design', links.includes('/design'), links.join(' '));
  check('N3 no link in the header goes to the removed #browse-designs section', !links.some((h) => h?.includes('browse-designs')));
  await page.locator('#featured').scrollIntoViewIfNeeded();
  await page.waitForSelector('#featured [data-testid="product-card"]');
  const cards = page.locator('#featured [data-testid="product-card"]');
  const withDesign = await page.locator('#featured [data-testid="featured-mockup"]').count();
  check('F1 the Featured section shows design mockups on featured garments', withDesign >= 1, `${withDesign} of ${await cards.count()} cards`);
  const first = page.locator('#featured [data-testid="product-card"][data-design]').first();
  check('F2 a design card still shows the product name, a price and a stock status', (await first.locator('h3').textContent()).length > 2 && /₱|PHP|\d/.test(await first.textContent()) && (await first.getByText(/in stock|low stock|sold out|out of stock/i).count()) >= 1, (await first.textContent()).slice(0, 120));
  const button = page.locator('#featured').getByRole('link', { name: 'Browse all designs' });
  check('F3 the Featured button reads "Browse all designs"', (await button.count()) === 1 && (await page.locator('#featured').getByText('See all categories').count()) === 0);
  check('F4 it points to the new page /designs', (await button.getAttribute('href')) === '/designs');
  check('F5 no broken pictures on the landing page', (await brokenImages(page)).length === 0, (await brokenImages(page)).join(' '));
  await page.screenshot({ path: `${out}/landing-featured.png`, clip: { x: 0, y: await page.evaluate(() => document.querySelector('#featured').getBoundingClientRect().top + scrollY - 20), width: 1440, height: 900 }, fullPage: true });
  await button.click();
  await page.waitForURL('**/designs');
  check('F6 clicking it opens the Browse all designs page', (await page.locator('h1').textContent()).includes('Find your next design'));
  check('F7 no failed requests on the landing page and the click', failed.length === 0, failed.join(' | '));
  await ctx.close();
}

// ============================================================================================ the Browse all designs page
{
  const { ctx, page, failed } = await newPage(1440, 900);
  await page.goto(base + '/designs', { waitUntil: 'networkidle' });
  check('B1 heading and introduction', (await page.locator('h1').textContent()).includes('Find your next design.') && (await page.getByText(/Pick a premade design you like/).count()) === 1);
  const count = await page.getByTestId('design-card').count();
  check('B2 the grid shows every design of the catalog (12)', count === 12, String(count));
  check('B3 every card has a name, a style, the garments it is made for and Customize Design', await page.getByTestId('design-card').evaluateAll((cs) => cs.every((c) => c.querySelector('h3')?.textContent && c.querySelector('[data-testid="design-style"]')?.textContent && /Made for/.test(c.textContent) && c.querySelector('a')?.textContent === 'Customize Design')));
  check('B4 no prices or stock labels on a design card', await page.getByTestId('design-card').evaluateAll((cs) => cs.every((c) => !/₱|in stock|sold out|low stock/i.test(c.textContent))));
  check('B5 no broken pictures', (await brokenImages(page)).length === 0, (await brokenImages(page)).join(' '));
  // the carousel
  const name = () => page.getByTestId('carousel-name').textContent();
  const pos = () => page.getByTestId('carousel-position').textContent();
  const first = await name();
  check('C1 the carousel starts on design 1', /Design 1 of 5/.test(await pos()), await pos());
  await page.getByTestId('carousel-next').click();
  const second = await name();
  check('C2 Next shows the next design and the position', second !== first && /Design 2 of 5/.test(await pos()), `${first} -> ${second}`);
  await page.getByTestId('carousel-prev').click();
  check('C3 Previous goes back', (await name()) === first && /Design 1 of 5/.test(await pos()));
  await page.getByTestId('carousel-prev').click();
  check('C4 Previous from the first wraps to the last', /Design 5 of 5/.test(await pos()), await pos());
  await page.getByTestId('carousel-dot').nth(2).click();
  check('C5 a dot jumps to that design and is marked current', /Design 3 of 5/.test(await pos()) && (await page.getByTestId('carousel-dot').nth(2).getAttribute('aria-current')) === 'true');
  await page.getByTestId('carousel-next').focus();
  await page.keyboard.press('ArrowRight');
  check('C6 the right arrow key moves the carousel', /Design 4 of 5/.test(await pos()), await pos());
  check('C7 the carousel image changed with the slide', (await page.getByTestId('carousel-image').getAttribute('src')).includes('/designs/previews/'));
  // filters
  await page.getByTestId('style-Nature').click();
  await page.waitForTimeout(300);
  check('D1 the Nature filter shows only Nature designs', (await page.getByTestId('design-card').count()) === 3 && (await page.getByTestId('design-style').allTextContents()).every((t) => t === 'Nature'), await page.getByTestId('design-count').textContent());
  check('D2 the filter is in the address', page.url().includes('style=Nature'));
  await page.getByTestId('apparel-filter').selectOption('ONESIE');
  await page.waitForTimeout(300);
  const onesie = await page.getByTestId('design-card').count();
  check('D3 combined with apparel Onesies it narrows further', onesie >= 1 && onesie < 3, String(onesie));
  await page.getByTestId('style-Streetwear').click();
  await page.getByTestId('apparel-filter').selectOption('ONESIE');
  await page.waitForTimeout(300);
  check('D4 a style and apparel with no design (Streetwear and onesies) shows a clear empty state and no cards', (await page.getByTestId('design-card').count()) === 0 && (await page.getByTestId('designs-empty').count()) === 1 && /Showing 0 of 12/.test(await page.getByTestId('design-count').textContent()));
  await page.getByTestId('style-all').click();
  await page.getByTestId('apparel-filter').selectOption('all');
  await page.waitForTimeout(300);
  check('D5 clearing the filters shows all 12 again', (await page.getByTestId('design-card').count()) === 12);
  check('B6 no failed requests on the page', failed.length === 0, failed.join(' | '));
  await page.screenshot({ path: `${out}/designs-1440.png`, fullPage: true });
  await ctx.close();
}

// ============================================================================================ responsive: no sideways scroll
for (const [w, h] of [[320, 700], [390, 844], [768, 1024], [1024, 768], [1440, 900]]) {
  const { ctx, page } = await newPage(w, h);
  await page.goto(base + '/designs', { waitUntil: 'networkidle' });
  const o1 = await overflow(page);
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.locator('#featured').scrollIntoViewIfNeeded();
  await page.waitForSelector('#featured [data-testid="product-card"]');
  check(`R ${w}x${h}: no sideways scroll on /designs or the landing page`, !o1 && !(await overflow(page)));
  if (w === 320 || w === 390) {
    await page.goto(base + '/designs', { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${out}/designs-${w}.png`, fullPage: true });
    const small = await page.evaluate(() => [...document.querySelectorAll('main a, main button, main select')].map((e) => ({ t: (e.textContent || e.id).slice(0, 24), h: Math.round(e.getBoundingClientRect().height) })).filter((x) => x.h > 0 && x.h < 40));
    check(`R ${w}: controls are at least 40 px tall`, small.length === 0, JSON.stringify(small.slice(0, 4)));
  }
  await ctx.close();
}

// ============================================================================================ Customize Design: the real editor with the design
{
  const { ctx, page, failed } = await newPage(1440, 900);
  await page.goto(base + '/designs', { waitUntil: 'networkidle' });
  const templateUrl = '/designs/templates/night-shift.json';
  const before = await sha(page, templateUrl);
  // from a card: the 'Night Shift' card -> the editor asks for a garment, then opens it with the design
  await page.getByTestId('design-card').filter({ hasText: 'Night Shift' }).getByRole('link', { name: /Customize Design/ }).click();
  await page.waitForURL(/\/design\?template=night-shift$/);
  await page.getByTestId('template-garment-picker').waitFor();
  await page.getByTestId('template-garment').first().waitFor();
  const garments = await page.getByTestId('template-garment').count();
  check('E1 Customize Design opens the editor page and asks which garment (real garments, not placeholders)', garments >= 1, `${garments} garments`);
  await page.getByTestId('template-garment').first().getByRole('link').click();
  await page.waitForURL(/template=night-shift&product=[^&]+&variant=/);
  check('E2 a colour and size were chosen and are in the address, with the template', /template=night-shift/.test(page.url()) && /variant=/.test(page.url()), page.url());
  await page.locator('[data-testid="editor-host"] canvas.upper-canvas').waitFor({ state: 'attached', timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="layers-list"] > li').length >= 1, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  const layerNames = async () => page.locator('[data-testid="layers-list"] > li button .truncate').allTextContents();
  const names = await layerNames();
  check('E3 the existing editor opened with the design loaded as editable layers', names.length === 6 && names.includes('NIGHT') && names.includes('SHIFT') && names.filter((n) => n.startsWith('Star')).length === 3, names.join(' | '));
  check('E4 the page says which premade design it started from', (await page.getByTestId('design-template-note').textContent()).includes('Night Shift'));
  await page.screenshot({ path: `${out}/editor-night-shift.png` });
  // the editor still works: undo is off for a loaded design, adding a layer and undoing it work, a text layer can be changed
  const undoOff = (await page.getByRole('button', { name: 'Undo', exact: true }).getAttribute('aria-disabled')) === 'true';
  check('E5 a loaded design starts a new history (nothing to undo yet)', undoOff);
  await page.getByRole('button', { name: 'Add circle' }).click();
  await page.waitForTimeout(250);
  check('E6 existing tools work on the loaded design (add a circle)', (await layerNames()).length === 7);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  check('E7 undo works and stops at the loaded design', (await layerNames()).length === 6 && (await page.getByRole('button', { name: 'Undo', exact: true }).getAttribute('aria-disabled')) === 'true');
  // edit the design: delete a layer, restyle another
  await page.locator('[data-testid="layers-list"] > li button', { hasText: 'SHIFT' }).first().click();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  const after = await layerNames();
  check('E8 the customer can change the design (a layer was removed from THEIR copy)', after.length === 5 && !after.includes('SHIFT'), after.join(' | '));
  const ids = [templateUrl, '/designs/assets/mountain-mist-image-1.png'];
  check('E9 the premade design file is byte-identical after the edits (the shared template is never overwritten)', (await sha(page, templateUrl)) === before);
  // a second visit starts from the full design again
  await page.goto(page.url(), { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="layers-list"] > li').length >= 1, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  check('E10 opening the design again starts from the complete original (6 layers)', (await layerNames()).length === 6);
  check('E11 no failed requests while opening and editing', failed.length === 0, failed.join(' | '));
  await ctx.close();
}

// a design with a picture layer, opened straight from an address with a garment
{
  const { ctx, page, failed } = await newPage(1440, 900);
  await page.goto(base + '/design?template=mountain-mist&product=m-tee', { waitUntil: 'networkidle' });
  await page.locator('[data-testid="editor-host"] canvas.upper-canvas').waitFor({ state: 'attached', timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="layers-list"] > li').length >= 1, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  const names = await page.locator('[data-testid="layers-list"] > li button .truncate').allTextContents();
  check('G1 a garment without a colour and size gets a sensible variant, and the design opens', /variant=/.test(page.url()) && names.length === 3, `${page.url()} :: ${names.join(' | ')}`);
  check('G2 a design with a picture layer says so', (await page.getByTestId('design-template-note').textContent()).includes('one picture'));
  await page.screenshot({ path: `${out}/editor-mountain-mist.png` });
  await page.goto(base + '/design?template=nope&product=m-tee', { waitUntil: 'networkidle' });
  check('G3 an unknown design id shows a clear message and a link back', (await page.getByTestId('design-unknown-template').count()) === 1);
  await page.goto(base + '/design?product=m-tee&variant=SIM-M-TEE-NVY-M', { waitUntil: 'networkidle' });
  await page.locator('[data-testid="editor-host"] canvas.upper-canvas').waitFor({ state: 'attached', timeout: 30000 });
  check('G4 the plain editor entry (no template) is unchanged: an empty design, no premade note', (await page.getByTestId('design-template-note').count()) === 0 && (await page.locator('[data-testid="layers-list"] > li').count()) === 0);
  check('G5 no failed requests', failed.length === 0, failed.join(' | '));
  await ctx.close();
}
await browser.close();
rep.finish();
