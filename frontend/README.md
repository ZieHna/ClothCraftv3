# ClothCraft storefront (frontend)

Vite + React + TypeScript + Tailwind CSS. Step 1 was the scaffold (router, API client with a mock/odoo switch, mock catalogue
served by MSW, Category, which was called Browse until step A). Step 2 is the landing page: header with demo sign-in/register, a photo slideshow hero, "How it works"
(the video plus the four steps as text), shop by category, featured items from the mock API, the design call to action, a
plain contact section and the footer. Design and Account need a (demo) account; browsing never does.

`video-src/` (the "How it works" video source, with its own `package.json`) and `public/video/` (its three outputs plus
captions) are separate committed work. The app never imports from `video-src/`; its tooling (playwright-core,
ffmpeg-static, sharp) is not a dependency of the app.

## Run it

```
npm install                 # exact versions are pinned in package.json and package-lock.json
npm run dev                 # http://localhost:5173, against the real API service (start the dev stack first: ../README.md)
npm run dev:mock            # the same, against the in-browser mock (the test double)
npm run typecheck           # tsc -b
npm run build               # type-check, then the real shop's production build into dist/ (VITE_API=odoo)
npm run build:mock          # a mock build, for the editor checks
npm run preview             # serve dist/ on http://localhost:4173
```

## The API switch

The browser always calls `/api` on its own origin. `VITE_API` decides who answers (see `.env.example`). **From step 8 the shop runs on the real
backend**: `.env.development` and `.env.production` say `odoo`; the mock is chosen with `--mode mock` (`.env.mock`). Vitest always uses the mock.

| `VITE_API` | What happens |
|---|---|
| `odoo` (default) | Nothing is intercepted. The Vite dev/preview proxy forwards `/api` to `VITE_PROXY_TARGET` (`http://127.0.0.1:8000`, the API service of `docker-compose.dev.yml`). |
| `mock` (`--mode mock`) | MSW starts in the browser and answers `/api` from `src/mocks/`. Every response says `simulation`, so the UI shows its "Simulated" label; the shop's own pages carry no other mock-only wording (step 8c). Frozen: no new features. |

## Mock catalogue

`src/mocks/catalogue.json` is generated, not hand-written. It comes from `addons/clothcraft/sim/data.py` (names, groups,
colours, sizes, VAT-inclusive PHP prices, the XXL extra). The host has no Python, so run the export in a throwaway
container (no network, repo mounted read-only, only the two output folders writable). From the repo root, in Git Bash:

```
R='D:\path\to\ClothCraft-v3'     # the repo root, Windows form
MSYS_NO_PATHCONV=1 docker run --rm --network none -e PYTHONDONTWRITEBYTECODE=1 \
  -v "$R:/repo:ro" -v "$R\frontend\src\mocks:/out/mocks" -v "$R\frontend\scripts:/out/scripts" \
  python:3.12-slim python -I /repo/frontend/scripts/export-catalogue.py /repo /out/mocks /out/scripts
node scripts/optimise-images.mjs   # from frontend/: v1 photos -> public/products/*.webp (borrows sharp from video-src, read-only)
```

The export is deterministic. `data.py` has no stock figures, so stock is a seeded mock (about 12% of variants sold out,
18% low) built on the simulator's opening-stock sizing. It is not the end state of a simulator run, and the API says so
in `meta.note`.

## Category and product pages (step 3; Browse was renamed Category in step A)

- `/category` (`/browse` redirects to it, keeping the query string and the #hash): group tabs and filters (search by name, garment type, price range, in stock only), all kept in the URL
  (`?group=&type=&q=&min=&max=&stock=1`) so links are shareable and Back works. The mock server filters and counts.
- `/products/:id`: colour and size options built from the variants the API returns; the price, the size extra and the stock
  shown are the API's numbers for the chosen variant (kept in the URL as `?color=&size=`). Sold-out sizes are disabled with a
  message. The v1 photos are one fixed colour, and the page says so.
- "Design this" asks for the (demo) sign-in, then opens `/design?product=<id>&variant=<sku>`, a placeholder that shows the
  chosen garment (unchanged).

## Cart, checkout and orders (step 5a, plain products only)

- **Cart** (`src/cart/`): lines are `{sku, productId, quantity}` in `localStorage` (`cc.cart.v1`), nothing else: no price, name or
  stock. It survives reloads and closed tabs, works signed out (a guest cart) and is **cleared on sign-out**. Prices, names,
  stock and every total come from the server: `POST /api/cart/quote` prices the cart, and the order request is checked again
  (all or nothing). The header badge is the sum of the quantities the shopper chose.
- **Pages:** `/cart`, `/checkout` (needs the demo sign-in), `/orders/:id` and the orders list under `/account`. Payment is Cash
  on delivery or Bank transfer only. Both confirm the order and hold its stock at once; a bank-transfer order then waits for
  payment and staff may cancel it, which releases the stock. **No page promises a payment deadline** (decision A).
- **Mock server** (`src/mocks/shop.ts`, `shopDb.ts`): orders and the stock they hold live in this tab's `sessionStorage`
  (`cc.mock.db.v1`), so **orders and stock reset when the tab closes** (the pages say so). It mirrors the Odoo addon's rules
  and sentences, answers 409 `stock_conflict` and 409 `price_changed` (nothing is created), and states VAT rounded globally,
  as `clothcraft_sim` does (`tax_calculation_rounding_method = round_globally`). The demo "pretend staff cancelled" button
  exists only when `VITE_API=mock`.
- **Gap (not built, on purpose):** real customer login. The Odoo side needs a real customer-login spike first (customer
  accounts, and the 1-day portal access keys Odoo issues for portal documents) before the API can know who an order belongs
  to. Until then the cart is a client-held cart plus a stateless quote, and the mock tells a demo session by an
  `X-Demo-Session` header. The real API must replace that with a real session, and decide how a client cart becomes an Odoo
  order.
- **Check:** `node scripts/check-shop-flow.mjs http://localhost:4173 <outDir> [--odoo http://localhost:4174]`. The optional second
  base is a preview of a `VITE_API=odoo` build (`VITE_API=odoo npx vite build --outDir <dir>`, then
  `VITE_API=odoo npx vite preview --outDir <dir> --port 4174`).

## Demo sign-in (a stub, not authentication)

"Sign in" and "Register" open dialogs that only create a made-up demo customer in this tab's sessionStorage (`src/auth/`).
There is no password, email, OTP or server call, and it only works with `VITE_API=mock`. Real login will come through the API
service and replace `src/auth/demoSession.ts`.

## Staff dashboard (step 7)

`/staff` is for the people who pack and send orders. It is a route tree of its own (`src/staff/`, lazy: a shopper never downloads it), outside
the shop's `Layout`: no cart, no customer sign-in dialog, no shop footer, `noindex`. A customer session never opens it and a staff session never
signs a customer in (separate sessions: the real service keeps a `cc_staff` cookie, the mock an `X-Mock-Staff-Session` token).

- `/staff` sign-in, then the **orders table**: status tabs, search (order number, name, email), payment method, placed-from / placed-to, 25 per
  page, newest first. The filters live in the address, so a view can be shared and Back works. On a phone each order is a card (the same table
  markup, drawn as labelled lines).
- `/staff/orders/:id` the **order**: customer contact, delivery address, items, totals, payment, the history of every move (who, when, note),
  and **what to do next**: the moves Odoo allows this person now, and the blocked ones with the reason (Inventory Staff on a paid bank-transfer
  order read "Only an Administrator can cancel an order that has been paid."). Cancelling asks first; cancelling a paid bank-transfer order (an
  Administrator only) needs a note, and the history then says REFUND DUE. Every move sends the state the screen showed (`expectedState`): if
  another person moved the order first, nothing is done, the screen catches up and says who did it.
- The screen decides nothing: Odoo does (`clothcraft.api`), the service passes it through. The mock (`src/mocks/staff.ts`) follows the same
  rules and sentences; `contract/cases/07-staff.json` runs against both.
- **Demo staff accounts exist only in a mock build** (`DEMO_STAFF` in `src/mocks/staff.ts`, shown by `DemoStaffHint.tsx`). In a build made with
  `VITE_API=odoo` the condition that loads them is a constant, so neither they nor the mock server are part of the build at all.
- Customers see the new statuses (packed, shipped, delivered) in words on the order page and in the orders list. No step carries a date, a time
  or a deadline, and nothing promises a refund (`pages/orderStatus.test.tsx` checks the wording of every status for both payment methods).
- **A trap found building it:** an effect that returns a value (`useEffect(() => setX(...), [])`) works in tests and in development, and in a
  production build React calls that value as a clean-up function when the page changes ("l is not a function"). Give every effect a block
  body. Only a check against the built app catches it.
- Checks: `node scripts/check-staff-ui.mjs http://localhost:4173 <outDir> --odoo http://localhost:4174` (the mock build, and a build made with
  `VITE_API=odoo`); `node scripts/check-staff-real.mjs ...` runs the same journeys against the real service and Odoo on a throwaway copy of
  `clothcraft_dev` (see the comment at the top of that file for the setup).

## Header, account menu and cart (step 8a)

- (Step A replaced this control with the hamburger menu described in the next section; the rest of this section still holds.) The header had ONE account control (the WAI-ARIA menu-button pattern): signed out it reads "Sign in"
  and offers Sign in and Register; signed in it shows the customer's name and offers Account, Orders (the list on the account page) and Sign
  out. `aria-expanded`/`aria-controls` on the button; opening moves focus into the menu (ArrowUp on the button: to the last item);
  ArrowUp/ArrowDown go round, Home/End jump; Esc closes and gives focus back to the button; Tab and a press outside close it.
- **There is no guest cart.** The cart link appears only when a customer is signed in (a staff session never has one: the staff dashboard
  has its own header and the shop knows only the customer session). A cart is stored under its customer's own key (`cc.cart.v1:<id>`), so
  a shared computer never shows the previous person's cart; it is cleared on sign-out and kept when a session merely expires. The old shared
  key `cc.cart.v1` is dropped.
- Signed out, **Add to cart** opens the sign-in dialog with "Sign in or register to add this to your cart."; the item is added once the
  customer has signed in or registered (closing the dialog adds nothing). `/cart` and `/checkout` ask for sign-in.

## Header, menu, section links and tab icons (step A)

- **Sticky header** (`components/Layout.tsx`): stays at the top while the page scrolls, one fixed height (`--header-height`, 4.25 rem) at every
  width, a solid `bg-paper`, and a soft shadow (`--shadow-header`) only once the page has scrolled. z-40: over the page, under the dialogs.
- **Menu** (`components/HeaderMenu.tsx`): a hamburger button that animates into an X (off under `prefers-reduced-motion`) at the right end of the
  header. Signed out: Register, Login, CC user (the staff sign-in, `/staff`; a staff session there goes on to the dashboard), then Need help?
  and Documentation, shown as "Coming soon" and not clickable (`aria-disabled`, no link). Signed in: the name and email, Account, Orders, Sign out,
  then the same two placeholders. A real button labelled "Open menu" / "Close menu" with `aria-expanded` and `aria-controls`; click, Enter and
  Space toggle it; focus moves into the panel; arrow keys, Home and End move round the items; Esc closes and returns focus; a press outside or Tab closes.
- **Links** (`components/siteNav.tsx`): How it works, Category, Browse designs, Featured designs, Design, Contact. From 1024 px (`NAV_QUERY`) they
  are a row in the header; below that they are the first group in the menu, above a divider, so the header never has a second row.
  The four section links (`SectionLink`) go to `/#<id>` (`how-it-works`, `browse-designs`, `featured`, `contact`), scroll smoothly (at once under reduced
  motion), update the hash, stay clear of the header (`scroll-padding-top` in `index.css`) and move focus to the section's heading
  (`lib/sections.ts`). The section in view gets `aria-current="location"` (an IntersectionObserver that changes state only when the answer changes).
- **Tab icons**: `node scripts/make-icons.mjs` makes `public/favicon.ico` (16, 32, 48), `favicon-32.png`, `icon-192.png`, `icon-512.png` and
  `apple-touch-icon.png` from `assets-v1/logo.png`, with a tighter, sharpened crop for the small ones (`--preview <png>` renders them);
  `public/site.webmanifest` and `public/CREDITS.md` (the logo's source and licence are unconfirmed).
- Proof: `src/components/HeaderMenu.test.tsx`, `Layout.test.tsx`, and in real Edge on a production build `node scripts/check-header-nav.mjs
  http://localhost:4175 <outDir> --db-container <db> --db clothcraft_e2e` (320, 390, 768, 1024 and 1440 px).

## Loading skeletons and page changes (step B)

- **Skeletons** (`components/skeleton/Skeleton.tsx` the pieces, `pageSkeletons.tsx` one per page or section): grey blocks of a token colour (`--color-skeleton`),
  a shimmer that exists only without `prefers-reduced-motion`, `aria-busy="true"` on the container and a "Loading…" status for screen readers once it is
  visible. Each wears the SAME outer classes as its page, with heights measured on the real page at each width (cart rows, order page, checkout
  form, product columns), so nothing moves when the data arrives. A skeleton that is inside its show delay is still rendered, but invisibly
  (`[data-skeleton='wait']`, `visibility: hidden`), to keep the page's size.
- **Timing rule** (`lib/skeletonTiming.ts` the numbers, `lib/useSkeletonGate.ts` the rule): a skeleton shows only after `SHOW_DELAY_MS` (150 ms); once shown it
  stays `MIN_SKELETON_MS` (600 ms; `STAFF_MIN_SKELETON_MS` 300 ms on the staff dashboard) from its first appearance; content that is ready is never delayed;
  an error or an empty answer skips the minimum. A new filter, page or re-pricing keeps what is on screen (dimmed) instead of a skeleton.
  **`VITE_SKELETON_INSTANT=1`** makes all three 0 (a skeleton shows and goes at once): Vitest sets it (`vite.config.ts`), and so does the build that the
  real-mode scripts run against (`VITE_API=odoo VITE_SKELETON_INSTANT=1 npx vite build`). `scripts/check-skeleton.mjs` runs against the NORMAL build.
- **Lazy pages** (`src/router.tsx`): cart, checkout, order, design and the staff pages are `React.lazy` inside `Suspense`, not router `lazy` routes, so the URL
  changes at once and the page's own skeleton (`RouteFallback`) stands in while its code arrives (never delayed). The page that takes over carries on from the
  fallback without a blank moment, and its minimum counts from the fallback's first appearance. `RequireAccount` shows the same skeleton while a returning
  visitor's sign-in is checked (`checking`).
- **Page fade**: `<main>` is keyed by the path and fades in over 180 ms (`.page-fade`; off under reduced motion); there is no exit fade, so nothing waits. A query string
  or #hash change keeps the page and what is typed in it. The editor page's light state is one still block under its heading.
- Proof: `lib/useSkeletonGate.test.tsx` (the rule), `components/skeleton/Skeleton.test.tsx`, `pages/loadingStates.test.tsx`, `cart/cartLoading.test.tsx`,
  `staff/staffLoading.test.tsx`, `components/pageTransition.test.tsx`, and in real Edge `node scripts/check-skeleton.mjs http://localhost:4175 <outDir>
  --db-container <db> --db clothcraft_e2e --env ../backend/.env` (timing, layout shift per page and width, throttled network, reduced motion).

## Frozen checks (step 8)

These browser scripts are **not run** from step 8 on, and are not updated. Each drives the MOCK build through things step 8 removes (the
two header buttons, the guest cart, mock-only wording); their journeys are covered against the real service by `check-shop-real.mjs` and
`check-staff-real.mjs`:

| Script | Last count | Why frozen |
|---|---|---|
| `check-shop-flow.mjs` | 101 | guest cart, header buttons, "Simulated" and "orders reset" wording, the mock's "pretend staff cancelled" button |
| `check-shop-auth.mjs` | 51 | the two header buttons and a guest cart kept across expiry |
| `check-staff-ui.mjs` | 61 | the mock's demo staff accounts (the real sign-in is covered by `check-staff-real.mjs`) |

The editor checks (`check-editor-*.mjs`) keep running on the mock build: they do not touch the header menu or the cart (`check-editor-drafts.mjs` uses the
header's Category link and answers the sign-out question about unfinished designs).

## Design drafts (step 4b-4)

The designer keeps the design you are working on as a **draft in this browser's IndexedDB** (`src/drafts/`). Nothing is sent
anywhere. Code is split: `types.ts` (limits, row shape), `idbDb.ts` and `memoryDb.ts` (one contract, `dbContract.ts`, run on both),
`saver.ts` (autosave), `DraftSession.tsx` (restore prompt and notices), `registry.ts` (sign-out), `components/DraftsList.tsx`.

- **Key = user + product + engine.** The garment (colour and size) is stored *inside* the row, and the sku is *not* part of the key
  (it is only kept so "Open" in the Account list can build the link). This changes the earlier plan, where the sku was in the key:
  changing colour or size now keeps working on the same draft instead of starting a new one.
- **People who type the same display name share drafts.** The owner is the demo display name (`src/auth/demoSession.ts` is a
  stub); two people who sign in with the same name in the same browser see each other's drafts. This goes away with real accounts.
- **Restore order:** `loadBase`, `whenIdle`, `setColor`, `setSize`, `loadState`. Restoring is not an edit: nothing is written until
  the person changes something.
- **Limits:** 8 pictures and 6 MB per draft (design data plus picture bytes), 30 MB for all of one person's drafts. Over a limit, or if
  the browser refuses a write (quota), nothing is written, the last good draft is kept, and a persistent `role="alert"` says so, with
  a **Download design** button (the print PNG) and a plain line that the download cannot be opened again for editing. Saving resumes
  by itself once the design fits.
- **Pictures are stored once**, keyed `[draftKey, assetId]`. Orphans are removed in the same transaction as every save, when a draft
  is deleted, when someone signs out, and by a sweep when the database is first opened in a page load.
- **Autosave:** about 1 s after the last change, never more than 5 s after the first unsaved change, and at once when the page is
  hidden or closed (`visibilitychange`, `pagehide`; the last one is best effort, a crash or a killed browser can still lose up to
  5 s). The saver uses only `exportState` and read methods, one save at a time, in one atomic transaction, and drops a snapshot if
  the editor started an undo, redo or load meanwhile. A design with **no layers is never written** (so Start fresh plus a colour
  change cannot replace a real draft with nothing); deleting every layer therefore does not clear the stored draft, use
  Account, Your drafts, Delete.
- **Restore prompt** (native modal dialog, Esc does not close it, Tab cannot leave it): **Continue your draft** / **Start fresh**.
  Start fresh keeps the old draft until the first edit; leaving without editing deletes nothing. A damaged draft offers only Start
  fresh (it is replaced at the first edit). A draft written by a newer version offers **Keep it (work without saving)** or
  **Discard**.
- **Sign-out** seals the saver first (nothing can be written after that), then deletes that person's drafts and pictures.
- **Two tabs:** every write names the revision it started from. If another tab wrote since, saving pauses and the person chooses
  *Replace it with this tab's design* or *Do not save in this tab*; nothing is overwritten silently.
- **Storage unavailable** (no IndexedDB, blocked, a newer database): the designer works, a visible note says nothing is saved, with
  the same Download design button; Account says drafts are unavailable.
- **Account, Your drafts:** the person's drafts with Open (the designer then offers Continue), Delete (asks first) and the total size.
- Checks: `src/drafts/*.test.*` (jsdom and real Edge) and `node scripts/check-editor-drafts.mjs http://localhost:4173 <outDir>`.

React Router's "No `HydrateFallback` element provided" warning on direct visits to a lazy page (cart, checkout, order, design) is
fixed by a root `HydrateFallback` in `src/router.tsx`. One load of `/design` in the earlier, unfixed build did not warn and could not
be reproduced in 100 more loads; that is unexplained, and was not chased.

## Landing page settings

- `VITE_CONTACT_EMAIL` (in `.env`) is the shop's contact address for the Contact section. It is unset on purpose, so the section
  says details are coming; nothing is invented.
- Logo and slideshow photos are made by `node scripts/optimise-images.mjs` into `public/site/` (WebP, hero at 800 and 1600 px).
- The video component only downloads the video when it is within 600 px of the screen, plays only while visible, and starts
  silent on every page load (sound is switched on only by a click on its button).

## Rules for data

Prices and stock come from API responses and are shown as received. The UI only formats them (`src/lib/format.ts`); it
never adds, multiplies or counts them. The draft response shapes are in `src/api/types.ts` (marked DRAFT).

## Design tokens

`src/index.css` (`@theme`) holds the palette and fonts of the video: warm paper, sage, brown, Cormorant Garamond for
display and Jost for text, both self-hosted through fontsource (no Google Fonts requests). `muted` is darker than the
video's (`#6a6058` instead of `#7a7068`) because the original is only 4.26:1 on the warm paper background. The sticky header adds
`--header-height`, `--shadow-header` and `--shadow-menu` (the shadows are made of the ink token, so a dark theme moves them with the palette);
the only literal colours outside the tokens are in `index.html` (`theme-color`) and `public/site.webmanifest`, which cannot read CSS variables.

## Garment colours and editor checks

- `npm run garments` regenerates `public/garments/<product>/<colour>.webp` (one pre-coloured picture per colour a product is sold in) from `public/products/` and `src/mocks/catalogue.json`. Run it again after the catalogue or the photos change. Licence note: `public/garments/CREDITS.md`.
- `npm test` runs the unit tests (jsdom) and the Fabric tests in the installed Microsoft Edge (no browser download).
- `node scripts/check-editor-browser.mjs http://localhost:4173 <outDir>` drives the built editor in Edge with a real mouse and keyboard (start `npm run build:mock` and `npx vite preview --port 4173` first: the editor checks run on the mock).

## Trying the editor on a real phone

The demo catalogue is answered by a service worker inside the browser, and browsers only allow service workers on **https or
localhost**. So `http://<your-computer's-LAN-address>:5173` shows a short explanation instead of the site. Two ways that work:

- **Android, by USB (simplest).** Turn on USB debugging, connect the phone, run `npm run dev` here, then
  `adb reverse tcp:5173 tcp:5173`, and open `http://localhost:5173/design?product=m-tee&variant=SIM-M-TEE-NVY-M` in Chrome on the
  phone. To look at the page with the real dev tools, open `chrome://inspect` in desktop Chrome or Edge.
- **Any phone, over https (an iPhone needs this).** Run `npm run build && npm run preview` (port 4173) and put a tunnel in
  front of it, for example `npx ngrok http 4173` or `cloudflared tunnel --url http://localhost:4173`. Open the https address it
  prints. Hostnames ending `.ngrok-free.app`, `.ngrok.app`, `.ngrok.io`, `.trycloudflare.com` and `.loca.lt` are already allowed in
  `vite.config.ts`; for another tunnel add its hostname to `allowedHosts` there.

The designer needs an account: tap **Sign in**, then **Continue as demo customer** (a demo: no password, nothing stored).

- `scripts/check-editor-browser.mjs`, `check-editor-features.mjs`, `check-editor-touch-layout.mjs` and `check-editor-perf.mjs` drive the built editor in Edge: desktop flows, the async queue, colour and size, zoom and downloads, real multi-touch, every layout width, bottom sheets, the emulated on-screen keyboard, and frame-rate and memory measurements. Each takes `<baseUrl> <outDir>` (build and preview first).
