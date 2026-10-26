// Step 4b-4 in real Edge: design drafts in IndexedDB, through the real screen with the real mouse and keyboard.
//   node scripts/check-editor-drafts.mjs http://localhost:4173 <outDir>
// Covers: autosave and restore (garment and design), the restore prompt (focus, Escape, Tab), Start fresh keeping the old
// draft, the limits and their alert with a working download, two tabs, sign-out, the Account list, and unavailable storage.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createReport, DESIGN, launch, makeFixtures, openEditor, seedAccount, userKeyOf } from './lib/e2e-common.mjs';

/** Sign out through the header's account menu (step 8a: one menu instead of a Sign out button). Step 12: with drafts on this device,
 *  sign-out first warns "You have N unfinished designs…"; these checks are about what sign-out deletes, so they answer "Sign out anyway". */
const signOut = async (page) => {
  await page.getByTestId('account-menu-button').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  const ask = page.getByTestId('signout-drafts');
  if (await ask.waitFor({ timeout: 2000 }).then(() => true, () => false)) await ask.getByRole('button', { name: 'Sign out anyway' }).click();
};
const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: node scripts/check-editor-drafts.mjs <baseUrl> <outDir>');
const rep = createReport(out, 'drafts');
const { check } = rep;
const fx = await makeFixtures(out);
const browser = await launch();

const DB = 'clothcraft-drafts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** every draft row (without its state) and every picture key, read straight from IndexedDB. Never creates the database. */
const idb = (page) =>
  page.evaluate(async (name) => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === name)) return { rows: [], assets: [], exists: false };
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const db = r.result;
        const tx = db.transaction(['drafts', 'assets'], 'readonly');
        const rows = tx.objectStore('drafts').getAll();
        const keys = tx.objectStore('assets').getAllKeys();
        tx.oncomplete = () => {
          db.close();
          resolve({ exists: true, rows: rows.result.map(({ state: _s, ...row }) => row), assets: keys.result.map((k) => k.join('|')) });
        };
      };
    });
  }, DB);

/** writes straight into the drafts store (for damaged and newer drafts) */
const patchRow = (page, patch) =>
  page.evaluate(
    async ([name, p]) =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open(name);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction('drafts', 'readwrite');
          const store = tx.objectStore('drafts');
          const all = store.getAll();
          all.onsuccess = () => {
            for (const row of all.result) store.put({ ...row, ...p });
          };
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
        };
      }),
    [DB, patch],
  );

const layerNames = (page) => page.locator('[data-testid="layers-list"] > li button .truncate').allTextContents();
const layerCount = async (page) => (await layerNames(page)).length;
const prompt = (page) => page.locator('dialog[data-testid="draft-prompt"][open]');
const promptButtons = (page) => prompt(page).getByRole('button').allTextContents();
const focusInPrompt = (page) => page.evaluate(() => !!document.activeElement?.closest('dialog[data-testid="draft-prompt"]'));
const variantOf = (page) => new URL(page.url()).searchParams.get('variant');
const addPicture = async (page, file) => {
  const before = await layerCount(page);
  await page.locator('input[type="file"]').first().setInputFiles(file);
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="layers-list"] > li').length > n, before, { timeout: 8000 });
};
/** waits until the stored draft has at least this revision */
const savedAtLeast = async (page, revision, timeout = 9000, user = DEMO) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await idb(page);
    if (s.rows.some((r) => r.user === user && r.revision >= revision)) return s;
    await sleep(150);
  }
  return idb(page);
};
const watch = (page, tag) => {
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && rep.report.console.push(`${tag} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => rep.report.console.push(`${tag} pageerror: ${e.message}`));
};
// two registered customers (mock accounts 1 and 2); drafts are filed under the account id, never the name
const DEMO = userKeyOf(1);
const ANOTHER = userKeyOf(2);

// =========================================================================================== 1. SAVE, RESTORE, THE PROMPT
{
  const { ctx, page } = await openEditor(browser, base, rep);
  const state0 = await idb(page);
  check('D0 a fresh visit with no edits has written no draft', state0.rows.length === 0);

  await page.locator('label.option', { hasText: /^White$/ }).click();
  await page.locator('[data-testid="colour-size"] label.option', { hasText: /^L$/ }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Add text' }).click();
  await addPicture(page, fx.logo);
  const t0 = Date.now();
  const s1 = await savedAtLeast(page, 1);
  const delay = Date.now() - t0;
  check('D1 edits are saved by themselves (one draft, 2 layers, 1 picture)', s1.rows.length === 1 && s1.rows[0].layerCount === 2 && s1.assets.length === 1, JSON.stringify(s1.rows.map((r) => ({ n: r.layerCount, rev: r.revision }))));
  check('D1 the key is user + product + engine and the garment is inside the row (white, L), the sku is not in the key', s1.rows[0].key === JSON.stringify([DEMO, 'm-tee', 'simple']) && s1.rows[0].garment.color === 'white' && s1.rows[0].garment.size === 'L' && s1.rows[0].sku.includes('WHT-L'), JSON.stringify(s1.rows[0]));
  rep.report.data.firstSaveDelayMs = delay;
  check('D1 the first save arrives within about 1 to 5 s of the last edit', delay < 5500, `${delay} ms`);
  const rev1 = s1.rows[0].revision;

  // reload the page on the ORIGINAL garment (navy, M): the draft must bring back white, L
  await page.goto(base + DESIGN, { waitUntil: 'networkidle' });
  await prompt(page).waitFor({ state: 'visible', timeout: 8000 });
  check('D2 a returning visit asks first: "Continue your draft" / "Start fresh"', JSON.stringify(await promptButtons(page)) === JSON.stringify(['Continue your draft', 'Start fresh']), JSON.stringify(await promptButtons(page)));
  check('D2 the first button has the focus', (await page.evaluate(() => document.activeElement?.textContent)) === 'Continue your draft');
  check('D2 nothing is written, and nothing can be edited, while the prompt is up', (await layerCount(page)) === 0 && (await idb(page)).rows[0].revision === rev1);

  // Escape twice with no click between (Chromium closes a dialog on the second one unless it is handled)
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('D3 Escape (three times) does not close the prompt', await prompt(page).isVisible());
  // Tab and Shift+Tab never leave the dialog
  let stayed = true;
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    stayed = stayed && (await focusInPrompt(page));
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Shift+Tab');
    stayed = stayed && (await focusInPrompt(page));
  }
  check('D3 Tab and Shift+Tab (six each way) never leave the prompt', stayed);
  // a click on the page behind is inert
  await page.mouse.click(5, 5);
  check('D3 the prompt is still there after a click outside it', await prompt(page).isVisible());

  await page.getByRole('button', { name: 'Continue your draft' }).click();
  await page.waitForFunction(() => !document.querySelector('dialog[data-testid="draft-prompt"][open]'));
  await page.waitForTimeout(400);
  check('D4 Continue brings back both layers', (await layerCount(page)) === 2, JSON.stringify(await layerNames(page)));
  check('D4 and the garment (white, L), with the address following', variantOf(page).includes('WHT-L'), String(variantOf(page)));
  const chosen = (await page.getByTestId('design-chosen').textContent()) ?? '';
  check('D4 the page header agrees (White, size L)', /White, size L/.test(chosen), chosen);
  await page.waitForTimeout(2500);
  check('D4 restoring is not an edit: the draft was not rewritten', (await idb(page)).rows[0].revision === rev1);

  // an edit after restoring is saved over the same draft
  await page.getByRole('button', { name: 'Add circle' }).click();
  const s5 = await savedAtLeast(page, rev1 + 1);
  check('D5 an edit after Continue updates the same draft (3 layers, still 1 picture)', s5.rows.length === 1 && s5.rows[0].layerCount === 3 && s5.assets.length === 1, JSON.stringify(s5.rows.map((r) => r.layerCount)));

  // ---- Start fresh keeps the old draft until the first edit; leaving without editing deletes nothing
  const revBeforeFresh = s5.rows[0].revision;
  await page.goto(base + DESIGN, { waitUntil: 'networkidle' });
  await prompt(page).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Start fresh' }).click();
  await page.waitForTimeout(300);
  check('D6 Start fresh opens an empty design', (await layerCount(page)) === 0);
  await page.waitForTimeout(3000);
  const afterFresh = await idb(page);
  check('D6 Start fresh did not touch the saved draft (same revision, 3 layers, picture kept)', afterFresh.rows[0].revision === revBeforeFresh && afterFresh.rows[0].layerCount === 3 && afterFresh.assets.length === 1);
  await page.getByRole('link', { name: 'Category' }).first().click();
  await page.waitForURL(/\/category/);
  await page.waitForTimeout(2500);
  const afterLeave = await idb(page);
  check('D6 leaving without editing does NOT delete it', afterLeave.rows.length === 1 && afterLeave.rows[0].revision === revBeforeFresh && afterLeave.assets.length === 1);
  await page.goBack();
  await prompt(page).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Start fresh' }).click();
  await page.getByRole('button', { name: 'Add rectangle' }).click();
  const s7 = await savedAtLeast(page, revBeforeFresh + 1);
  check('D7 the first edit after Start fresh replaces the old draft (1 layer, the old picture is gone, no conflict)', s7.rows.length === 1 && s7.rows[0].layerCount === 1 && s7.assets.length === 0 && (await page.getByTestId('draft-conflict').count()) === 0, JSON.stringify(s7));

  // ---- the "Download design" is not needed here, but the page must be quiet when all is well
  check('D8 no alert or note while saving works', (await page.locator('[data-testid="draft-alert"], [data-testid="drafts-unavailable"], [data-testid="draft-conflict"]').count()) === 0);
  await ctx.close();
}

// =========================================================================================== 2. LIMITS: NEVER LOSE WORK SILENTLY
{
  const { ctx, page } = await openEditor(browser, base, rep);
  await page.getByRole('button', { name: 'Add text' }).click();
  const first = await savedAtLeast(page, 1);
  for (let i = 0; i < 8; i++) await addPicture(page, fx.logo);
  const s8 = await savedAtLeast(page, first.rows[0].revision + 1);
  check('L1 exactly 8 pictures is accepted and saved', s8.assets.length === 8 && (await page.getByTestId('draft-alert').count()) === 0, `${s8.assets.length} pictures`);
  const goodRevision = s8.rows[0].revision;
  await addPicture(page, fx.logo); // the ninth
  await page.getByTestId('draft-alert').waitFor({ state: 'visible', timeout: 8000 });
  const alert = page.getByTestId('draft-alert');
  check('L2 a ninth picture shows a persistent alert (role=alert)', (await alert.getAttribute('role')) === 'alert');
  const text = (await alert.textContent()) ?? '';
  check('L2 it says what happened in plain words, and that the latest changes are not saved', /9 pictures/.test(text) && /at most 8/.test(text) && /not being saved/.test(text), text);
  check('L2 it says the download cannot be reopened for editing', /cannot be opened again for editing/.test(text), text);
  const after = await idb(page);
  check('L2 the last good draft is untouched (8 pictures, same revision)', after.rows[0].revision === goodRevision && after.assets.length === 8);
  await page.waitForTimeout(6500);
  check('L3 the alert is still there 6 s later (nothing dismisses it)', await alert.isVisible());
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), alert.getByRole('button', { name: 'Download design' }).click()]);
  const file = path.join(out, 'drafts-download.png');
  await download.saveAs(file);
  check('L4 "Download design" gives the print PNG', download.suggestedFilename().endsWith('-design-only-2x.png') && existsSync(file), download.suggestedFilename());
  // back to 8 pictures: the alert goes and saving resumes
  await page.locator('[data-testid="layers-list"] > li button').first().click();
  await page.getByRole('button', { name: /^Delete/ }).first().click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="draft-alert"]'), null, { timeout: 8000 });
  const resumed = await savedAtLeast(page, goodRevision + 1);
  check('L5 deleting the ninth picture clears the alert and saving resumes', resumed.rows[0].revision > goodRevision && resumed.assets.length === 8);
  // orphan cleanup per save: delete a picture, the stored copy goes at the next save
  await page.locator('[data-testid="layers-list"] > li button').first().click();
  await page.getByRole('button', { name: /^Delete/ }).first().click();
  const s9 = await savedAtLeast(page, resumed.rows[0].revision + 1);
  check('L6 a picture removed from the design is removed from storage at the next save (7 left)', s9.assets.length === 7, `${s9.assets.length}`);
  await ctx.close();
}

// =========================================================================================== 3. TWO TABS
{
  const { ctx, page: a } = await openEditor(browser, base, rep);
  await a.getByRole('button', { name: 'Add text' }).click();
  const s1 = await savedAtLeast(a, 1);
  const b = await ctx.newPage();
  watch(b, 'tab B');
  await b.goto(base + DESIGN, { waitUntil: 'networkidle' });
  await prompt(b).waitFor({ state: 'visible' });
  await b.getByRole('button', { name: 'Continue your draft' }).click();
  await b.waitForTimeout(400);
  await a.bringToFront();
  await a.getByRole('button', { name: 'Add circle' }).click();
  const s2 = await savedAtLeast(a, s1.rows[0].revision + 1);
  await b.bringToFront();
  await b.getByRole('button', { name: 'Add rectangle' }).click();
  await b.getByTestId('draft-conflict').waitFor({ state: 'visible', timeout: 9000 });
  const c = b.getByTestId('draft-conflict');
  check('T1 the tab that has not seen the other version pauses and asks (role=alert)', (await c.getAttribute('role')) === 'alert' && /Saving is paused so nothing is overwritten/.test((await c.textContent()) ?? ''));
  await b.waitForTimeout(2500);
  const kept = await idb(b);
  check('T2 nothing was overwritten while it asks', kept.rows[0].revision === s2.rows[0].revision && kept.rows[0].layerCount === 2, JSON.stringify(kept.rows.map((r) => [r.revision, r.layerCount])));
  await c.getByRole('button', { name: /Replace it with this tab/ }).click();
  const s3 = await savedAtLeast(b, s2.rows[0].revision + 1);
  check('T3 after the person says Replace, this tab\'s design (the draft\'s text + its rectangle = 2 layers, not the other tab\'s circle) is written as the next revision', s3.rows[0].layerCount === 2 && s3.rows[0].revision === s2.rows[0].revision + 1 && (await b.getByTestId('draft-conflict').count()) === 0, JSON.stringify(s3.rows.map((r) => [r.revision, r.layerCount])));
  // and the other answer
  await a.bringToFront();
  await a.getByRole('button', { name: 'Add text' }).click();
  await a.getByTestId('draft-conflict').waitFor({ state: 'visible', timeout: 9000 });
  await a.getByRole('button', { name: 'Do not save in this tab' }).click();
  await a.getByTestId('drafts-declined').waitFor({ state: 'visible' });
  const s4 = await idb(a);
  await a.getByRole('button', { name: 'Add circle' }).click();
  await a.waitForTimeout(2500);
  check('T4 "Do not save in this tab" stops saving there and leaves the other version alone', (await idb(a)).rows[0].revision === s4.rows[0].revision);
  await ctx.close();
}

// =========================================================================================== 4. SIGN-OUT
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedAccount(ctx, 'Demo customer', 1);
  // another person's draft, written first in the same browser profile
  const other = await ctx.newPage();
  watch(other, 'other');
  await seedAccount(other, 'Another person', 2, { force: true });
  await other.goto(base + DESIGN, { waitUntil: 'networkidle' });
  await other.locator('[data-testid="editor-host"] canvas.upper-canvas').waitFor({ state: 'attached' });
  await other.waitForFunction(() => !document.querySelector('nav[aria-label="Design tools"] button')?.disabled);
  await other.getByRole('button', { name: 'Add text' }).click();
  await savedAtLeast(other, 1, 9000, ANOTHER);
  await other.close();

  const page = await ctx.newPage();
  watch(page, 'signout');
  await page.goto(base + DESIGN, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('nav[aria-label="Design tools"] button')?.disabled);
  await page.getByRole('button', { name: 'Add text' }).click();
  await addPicture(page, fx.logo);
  const mine = await savedAtLeast(page, 1);
  check('O0 both people have a draft before signing out', mine.rows.length === 2 && mine.rows.some((r) => r.user === ANOTHER) && mine.rows.some((r) => r.user === DEMO), JSON.stringify(mine.rows.map((r) => r.user)));
  // an edit that is still waiting to be saved, then sign out at once
  await page.getByRole('button', { name: 'Add circle' }).click();
  await signOut(page);
  await page.waitForTimeout(3500); // long enough for the debounced save to have fired if it had not been sealed
  const gone = await idb(page);
  check('O1 sign-out deleted this person\'s drafts and pictures, and the pending save did not bring one back', !gone.rows.some((r) => r.user === DEMO) && gone.assets.every((k) => k.includes('Another person')), JSON.stringify(gone.rows.map((r) => r.user)) + ' ' + JSON.stringify(gone.assets));
  check('O2 another person\'s draft is untouched', gone.rows.length === 1 && gone.rows[0].user === ANOTHER);
  await ctx.close();
}
{
  // a design that was never saved: no stored revision can refuse a late write, only the seal stops it
  const { ctx, page } = await openEditor(browser, base, rep);
  await page.getByRole('button', { name: 'Add text' }).click();
  await signOut(page); // two clicks (menu, Sign out), still well inside the 1 s debounce
  await page.waitForTimeout(3500);
  const st = await idb(page);
  check('O3 sign-out right after a first edit leaves no draft behind (the pending first save was sealed)', st.rows.length === 0 && st.assets.length === 0, JSON.stringify(st.rows.map((r) => r.user)));
  await ctx.close();
}

{
  // step B: <main> is keyed by the path (a new page fades in). An edit made just before the page is left through the header must still be
  // written, and coming back must offer it.
  const { ctx, page } = await openEditor(browser, base, rep);
  await page.getByRole('button', { name: 'Add text' }).click();
  await page.getByRole('link', { name: 'Category' }).first().click(); // well inside the one-second autosave delay
  await page.waitForURL(/\/category/);
  await page.waitForTimeout(1500);
  const left = await idb(page);
  check('D7 an edit made just before leaving through the header is saved (keyed page: nothing lost)', left.rows.length === 1 && left.rows[0].layerCount === 1, JSON.stringify(left.rows.map((r) => [r.user, r.layerCount])));
  await page.goBack();
  await prompt(page).waitFor({ state: 'visible', timeout: 15000 });
  check('D7 coming back offers "Continue your draft"', (await promptButtons(page)).some((t) => /Continue your draft/.test(t)), JSON.stringify(await promptButtons(page)));
  await ctx.close();
}

// =========================================================================================== 5. ACCOUNT: YOUR DRAFTS
{
  const { ctx, page } = await openEditor(browser, base, rep);
  await page.getByRole('button', { name: 'Add text' }).click();
  await addPicture(page, fx.logo);
  await savedAtLeast(page, 1);
  await page.goto(base + '/account', { waitUntil: 'networkidle' });
  await page.getByTestId('drafts').waitFor();
  await page.getByTestId('draft-row').first().waitFor({ state: 'visible', timeout: 8000 });
  const row = (await page.getByTestId('draft-row').first().textContent()) ?? '';
  check('A1 Account lists the draft with its garment, layers and size', /Navy, size M/.test(row) && /2 layers/.test(row), row);
  const total = (await page.getByTestId('drafts-total').textContent()) ?? '';
  check('A1 and says how much room the drafts use', /Using .* of 30\.0 MB/.test(total), total);
  const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check('A1 no sideways scroll on the account page', !hasHScroll);
  await page.getByRole('link', { name: /^Open the .* draft$/ }).click();
  await page.waitForURL(/\/design/);
  await prompt(page).waitFor({ state: 'visible', timeout: 8000 });
  check('A2 Open goes to the designer, which offers to continue the draft', true);
  await page.goto(base + '/account', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /^Delete the .* draft$/ }).click();
  check('A3 Delete asks first', await page.getByText('Delete this draft for good?').isVisible());
  await page.getByRole('button', { name: 'Yes, delete' }).click();
  await page.getByTestId('drafts-empty').waitFor({ state: 'visible', timeout: 5000 });
  const emptied = await idb(page);
  check('A3 confirming removes the draft and its picture from storage', emptied.rows.length === 0 && emptied.assets.length === 0);
  await ctx.close();
}

// =========================================================================================== 6. DAMAGED AND NEWER DRAFTS
{
  const { ctx, page } = await openEditor(browser, base, rep);
  await page.getByRole('button', { name: 'Add text' }).click();
  await savedAtLeast(page, 1);
  await patchRow(page, { state: null });
  await page.goto(base + DESIGN, { waitUntil: 'networkidle' });
  await prompt(page).waitFor({ state: 'visible' });
  check('X1 a damaged draft offers only Start fresh', JSON.stringify(await promptButtons(page)) === JSON.stringify(['Start fresh']), JSON.stringify(await promptButtons(page)));
  await page.getByRole('button', { name: 'Start fresh' }).click();
  await page.getByRole('button', { name: 'Add circle' }).click();
  const s = await savedAtLeast(page, 2);
  check('X1 Start fresh then an edit replaces it with a good draft (1 layer, next revision)', s.rows[0].layerCount === 1 && s.rows[0].revision === 2, JSON.stringify(s.rows.map((r) => [r.revision, r.layerCount])));
  await patchRow(page, { format: 99 });
  const before = (await idb(page)).rows[0].revision;
  await page.goto(base + DESIGN, { waitUntil: 'networkidle' });
  await prompt(page).waitFor({ state: 'visible' });
  check('X2 a newer-version draft offers Keep it (work without saving) / Discard', JSON.stringify(await promptButtons(page)) === JSON.stringify(['Keep it (work without saving)', 'Discard']), JSON.stringify(await promptButtons(page)));
  await page.getByRole('button', { name: /Keep it/ }).click();
  await page.getByRole('button', { name: 'Add rectangle' }).click();
  await page.waitForTimeout(3000);
  const kept = await idb(page);
  check('X2 Keep it leaves the draft exactly as it was and saves nothing', kept.rows[0].revision === before && kept.rows[0].format === 99 && (await page.getByTestId('drafts-kept').isVisible()));
  await page.goto(base + DESIGN, { waitUntil: 'networkidle' });
  await prompt(page).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.waitForTimeout(500);
  check('X3 Discard deletes it', (await idb(page)).rows.length === 0);
  await page.getByRole('button', { name: 'Add text' }).click();
  const fresh = await savedAtLeast(page, 1);
  check('X3 and saving starts over from revision 1', fresh.rows.length === 1 && fresh.rows[0].revision === 1);
  await ctx.close();
}

// =========================================================================================== 7. STORAGE UNAVAILABLE
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedAccount(ctx, 'Demo customer', 1);
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }); // as in a browser that blocks it
  });
  const page = await ctx.newPage();
  watch(page, 'no-idb');
  await page.goto(base + DESIGN, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="editor-host"] canvas.upper-canvas').waitFor({ state: 'attached' });
  await page.getByTestId('drafts-unavailable').waitFor({ state: 'visible', timeout: 8000 });
  check('U1 with no IndexedDB the designer still works and says drafts are unavailable', (await page.getByTestId('drafts-unavailable').textContent())?.includes('not available in this browser') === true);
  await page.getByRole('button', { name: 'Add text' }).click();
  check('U1 designing is not blocked', (await layerCount(page)) === 1);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByTestId('drafts-unavailable').getByRole('button', { name: 'Download design' }).click()]);
  check('U2 and Download design works', dl.suggestedFilename().endsWith('.png'));
  await page.goto(base + '/account', { waitUntil: 'networkidle' });
  check('U3 the Account list says drafts are unavailable', await page.getByTestId('drafts-list-unavailable').isVisible());
  await ctx.close();
}

// =========================================================================================== 8. THE PAGE BEING CLOSED (measured, not promised)
{
  const { ctx, page } = await openEditor(browser, base, rep);
  await page.getByRole('button', { name: 'Add text' }).click();
  await savedAtLeast(page, 1);
  const probe = await ctx.newPage();
  await page.getByRole('button', { name: 'Add circle' }).click(); // not yet saved
  await page.close({ runBeforeUnload: true });
  await sleep(1200);
  await probe.goto(base + '/account', { waitUntil: 'networkidle' });
  await probe.getByTestId('draft-row').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined);
  const st = await idb(probe);
  rep.report.data.closeTabKeptLastEdit = st.rows[0]?.layerCount === 2;
  check('P0 (measured) closing the tab right after an edit: the draft exists', st.rows.length === 1);
  await ctx.close();
}

await browser.close();
rep.finish();
