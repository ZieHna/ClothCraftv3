// FROZEN in step 8 (not run): it drives the MOCK build through the old header (separate Sign in and Register buttons), the guest
// cart and mock-only wording, all of which step 8 removes. Its journeys are covered against the real service by check-shop-real.mjs and
// check-staff-real.mjs. Kept for reference; see frontend/README.md "Frozen checks".
// Step 6d: the register and sign-in screens, in real Edge, against the MOCK API (VITE_API=mock):
//   npm run build && npx vite preview --port 4173
//   node scripts/check-shop-auth.mjs http://localhost:4173 <outDir>
// Screenshots are taken only of the new screens (register, register with errors, sign in) at 1366 and 390 px.
import path from 'node:path';
import { createReport, launch } from './lib/e2e-common.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: node scripts/check-shop-auth.mjs <baseUrl> <outDir>');
const rep = createReport(out, 'shop-auth');
const { check, report } = rep;
const browser = await launch();
const shot = (page, name) => page.screenshot({ path: path.join(out, 'shots', name) });
const PASSWORD = 'a long and careful password';

async function open(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: width < 600, isMobile: width < 600 });
  const page = await ctx.newPage();
  const tag = `${width}px`;
  // Chrome logs every 4xx answer as a console error. This script PROVOKES a 422 (a refused password) and 401s (wrong password, ended session) on purpose.
  const expected = /Failed to load resource: the server responded with a status of (401|422)/;
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !expected.test(m.text()) && report.console.push(`${tag} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => report.console.push(`${tag} pageerror: ${e.message}`));
  await page.goto(base + '/account', { waitUntil: 'networkidle' });
  return { ctx, page };
}
const dialog = (page) => page.getByRole('dialog');
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const box = async (locator) => (await locator.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };

for (const [width, height] of [[1366, 800], [390, 844]]) {
  const L = `${width}px`;
  const { ctx, page } = await open(width, height);

  // ---- a signed-out visitor to the account page is asked, and can open either form
  check(`${L} the account page asks a signed-out visitor to sign in or register`, await page.getByRole('heading', { name: /sign in to see your account/i }).isVisible());
  await page.getByRole('button', { name: 'Register' }).first().click();
  const d = dialog(page);
  await d.getByRole('heading', { name: 'Register' }).waitFor();
  check(`${L} register: the dialog opens with the name field focused`, (await page.evaluate(() => document.activeElement?.getAttribute('autocomplete'))) === 'name');
  check(`${L} register: name, email and password each have a label`, (await d.getByLabel('Your name').count()) === 1 && (await d.getByLabel('Email').count()) === 1 && (await d.getByLabel('Password').count()) === 1);
  check(`${L} register: the password is hidden, new-password, and the rule is stated in words`, (await d.getByLabel('Password').getAttribute('type')) === 'password' && (await d.getByLabel('Password').getAttribute('autocomplete')) === 'new-password' && /At least 10 characters\. Spaces are fine, and there are no other rules\./.test(await d.textContent()));
  check(`${L} register: the email is typed email with the username autocomplete`, (await d.getByLabel('Email').getAttribute('type')) === 'email' && (await d.getByLabel('Email').getAttribute('autocomplete')) === 'username');
  check(`${L} register: the form fits the screen and the page does not scroll sideways`, (await box(d)).width <= width && (await noSideways(page)));
  const big = [d.getByRole('button', { name: 'Create account' }), d.getByRole('button', { name: /show password/i }), d.getByRole('button', { name: 'Cancel' })];
  const heights = await Promise.all(big.map(async (b) => (await box(b)).height));
  check(`${L} register: every button is at least 40 px tall`, heights.every((h) => h >= 40), heights.join(','));
  await shot(page, `auth-register-${width}.png`);

  // ---- empty submit: told at once, in words, summary focused, nothing sent
  await d.getByRole('button', { name: 'Create account' }).click();
  const summary = d.getByTestId('auth-error-summary');
  await summary.waitFor();
  const text = await summary.textContent();
  check(`${L} errors: the summary names every empty field in words`, /Your name: Enter your name\./.test(text) && /Email: Enter an email address like name@example\.com\./.test(text) && /Password: Choose a password\./.test(text), text);
  check(`${L} errors: the summary takes focus and is an alert`, (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'auth-error-summary' && (await summary.getAttribute('role')) === 'alert');
  check(`${L} errors: the email field is marked invalid and tied to its message`, (await d.getByLabel('Email').getAttribute('aria-invalid')) === 'true' && ((await d.getByLabel('Email').getAttribute('aria-describedby')) ?? '').length > 0);
  await summary.getByRole('link', { name: /Email:/ }).click();
  check(`${L} errors: a summary link moves focus to its field`, (await page.evaluate(() => document.activeElement?.getAttribute('type'))) === 'email');
  await shot(page, `auth-register-errors-${width}.png`);

  // ---- the server's sentences (the mock follows the real rules): a common password
  await d.getByLabel('Your name').fill('Ana Cruz');
  await d.getByLabel('Email').fill('ana@example.com');
  await d.getByLabel('Password').fill('password123');
  await d.getByRole('button', { name: 'Create account' }).click();
  await d.getByText('Password: That password is too common. Choose another one.').waitFor();
  check(`${L} server errors: a common password is refused with a sentence, and the password box is emptied`, (await d.getByLabel('Password').inputValue()) === '');
  await d.getByLabel('Password').fill(PASSWORD);
  await d.getByRole('button', { name: /show password/i }).click();
  check(`${L} show password: the toggle reveals it and says it is pressed`, (await d.getByLabel('Password').getAttribute('type')) === 'text' && (await d.getByRole('button', { name: /hide password/i }).getAttribute('aria-pressed')) === 'true');
  await d.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Account', exact: true }).waitFor();
  check(`${L} register: the customer is signed in, the dialog is closed, the account page says who`, !(await dialog(page).isVisible()) && /Signed in as Ana Cruz/.test(await page.getByTestId('account-signed-in').textContent()) && /ana@example\.com/.test(await page.getByTestId('account-signed-in').textContent()));
  check(`${L} register: the header shows the name and a Sign out button`, (await page.getByRole('button', { name: 'Sign out' }).isVisible()));

  // ---- a reload keeps the session; sign out ends it
  await page.reload({ waitUntil: 'networkidle' });
  check(`${L} reload: still signed in`, await page.getByTestId('account-signed-in').isVisible());
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: /sign in to see your account/i }).waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  check(`${L} sign out: after a reload still signed out`, await page.getByRole('heading', { name: /sign in to see your account/i }).isVisible());

  // ---- the sign-in screen
  await page.getByRole('button', { name: 'Sign in' }).first().click();
  const s = dialog(page);
  await s.getByRole('heading', { name: 'Sign in' }).waitFor();
  check(`${L} sign in: the email is focused, the password is current-password and hidden`, (await page.evaluate(() => document.activeElement?.getAttribute('autocomplete'))) === 'username' && (await s.getByLabel('Password').getAttribute('autocomplete')) === 'current-password' && (await s.getByLabel('Password').getAttribute('type')) === 'password');
  check(`${L} sign in: there is no name field`, (await s.getByLabel('Your name').count()) === 0);
  check(`${L} sign in: fits the screen`, (await box(s)).width <= width && (await noSideways(page)));
  await shot(page, `auth-signin-${width}.png`);
  await s.getByLabel('Email').fill('ana@example.com');
  await s.getByLabel('Password').fill('not the right password');
  await s.getByRole('button', { name: 'Sign in' }).click();
  await s.getByText('The email or password is not right.').waitFor();
  const wrong = await s.getByTestId('auth-error-summary').textContent();
  await s.getByLabel('Email').fill('nobody@example.com');
  await s.getByLabel('Password').fill('not the right password');
  await s.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="auth-error-summary"]')?.textContent.includes('not right'));
  check(`${L} sign in: a wrong password and an unknown email read exactly the same`, (await s.getByTestId('auth-error-summary').textContent()) === wrong, wrong);
  await s.getByLabel('Email').fill('ana@example.com');
  await s.getByLabel('Password').fill(PASSWORD);
  await s.getByRole('button', { name: 'Sign in' }).click();
  await page.getByTestId('account-signed-in').waitFor();
  check(`${L} sign in: the right password signs the same customer in again`, /Signed in as Ana Cruz/.test(await page.getByTestId('account-signed-in').textContent()));

  // ---- the session ends behind the page's back: signed out here too, cart kept, a notice says why
  await page.goto(base + '/browse', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.setItem('cc.cart.v1', JSON.stringify([{ sku: 'SIM-M-TEE-BLK-M', productId: 'm-tee', quantity: 1 }])));
  await page.evaluate(async () => {
    // another tab (or the server) ends the session: revoke it at the mock server without telling this page
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Mock-Session': sessionStorage.getItem('cc.mock.session') } });
    sessionStorage.setItem('cc.mock.session', sessionStorage.getItem('cc.mock.session')); // the page still believes it has a session
  });
  // client-side navigation to the account page (as clicking its link does): the page keeps its state and asks the server for the orders
  await page.evaluate(() => { history.pushState({}, '', '/account'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await page.getByTestId('session-ended').waitFor({ timeout: 8000 });
  check(`${L} expiry: a notice says "Your session ended. Please sign in again."`, /Your session ended\. Please sign in again\./.test(await page.getByTestId('session-ended').textContent()));
  check(`${L} expiry: the customer is signed out here too, and the cart is kept`, (await page.getByRole('button', { name: 'Sign out' }).count()) === 0 && (await page.evaluate(() => JSON.parse(localStorage.getItem('cc.cart.v1')).length)) === 1);

  // ---- keyboard: Escape closes, focus goes back to the opener
  await page.getByRole('button', { name: 'Sign in' }).first().focus();
  await page.keyboard.press('Enter');
  await dialog(page).getByRole('heading', { name: 'Sign in' }).waitFor();
  await page.keyboard.press('Escape');
  check(`${L} keyboard: Escape closes the dialog`, !(await dialog(page).isVisible()));
  await ctx.close();
}

await browser.close();
rep.finish();
