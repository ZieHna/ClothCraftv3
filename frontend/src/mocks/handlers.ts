import { delay, http } from 'msw';
import type {
  AuthUser, CartLineInput, CatalogueList, ColorInfo, ColorOption, FeaturedList, GarmentTypeFacet, Group, PlaceOrderRequest, Product, ProductDetail, Variant,
} from '../api/types';
import { checkRegistration, findUser, forget, hit, key, lockedFor, normaliseEmail, EMAIL_LIMIT, LOGIN_IP_LIMIT, REGISTER_IP_LIMIT } from './accounts';
import { cancelOrder, checkoutOptions, MAX_LINE_QUANTITY, placeOrder, priceCart } from './shop';
import { clientAddress, fail, readJson, respond, tooMany } from './http';
import { catalogue, liveProducts, loadDb, money, saveDb, type MockDb, type MockOrder, type MockUser } from './shopDb';
import { staffHandlers } from './staffHandlers';

/** The mock server's choice of featured items: the best-seller tier (A) in addons/clothcraft/sim/data.py, if not sold out. */
const FEATURED_IDS = ['m-tee', 'w-crop', 'w-hood', 'w-tee', 'b-ones'];

function summarise(product: Product) {
  const { variants, ...summary } = product;
  void variants;
  return summary;
}

// ---- everything below is the MOCK SERVER's work: filtering, counting, facets and the size surcharge are decided here, in
// ---- the same deterministic way every time, so the UI only ever displays what it is given.
const GARMENT_TYPE_CODES = new Set(catalogue.products.map((p) => p.garmentType.code));

function parseAmount(value: string | null): number | undefined | 'bad' {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 'bad';
}

function facetsFor(products: Product[]) {
  const byCode = new Map<string, GarmentTypeFacet>();
  for (const p of products) {
    const f = byCode.get(p.garmentType.code) ?? { ...p.garmentType, count: 0 };
    f.count += 1;
    byCode.set(p.garmentType.code, f);
  }
  const garmentTypes = [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
  const prices = products.map((p) => p.price);
  return { garmentTypes, priceBounds: { min: prices.length ? Math.min(...prices) : 0, max: prices.length ? Math.max(...prices) : 0 } };
}

/** The variant as the product page needs it: with the surcharge the server says it has. */
function withExtra(product: Product, variant: Variant): Variant {
  return { ...variant, priceExtra: money(variant.price - product.price) };
}

export const handlers = [
  http.get('/api/catalogue/products', async ({ request }) => {
    await delay(150);
    const params = new URL(request.url).searchParams;
    const group = params.get('group') || undefined;
    const type = params.get('type') || undefined;
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const min = parseAmount(params.get('min'));
    const max = parseAmount(params.get('max'));
    if (group && !catalogue.groups.includes(group as Group)) return fail(400, 'bad_group', `Unknown group "${group}"`);
    if (type && !GARMENT_TYPE_CODES.has(type)) return fail(400, 'bad_type', `Unknown garment type "${type}"`);
    if (min === 'bad' || max === 'bad') return fail(400, 'bad_price', 'Prices must be numbers of 0 or more');
    if (min !== undefined && max !== undefined && min > max) return fail(400, 'bad_price', 'The minimum price is above the maximum price');
    const inStockOnly = params.get('stock') === '1';

    const inGroup = liveProducts().filter((p) => !group || p.group === group);
    const matches = inGroup.filter(
      (p) =>
        (!type || p.garmentType.code === type) &&
        (!q || p.name.toLowerCase().includes(q)) &&
        (min === undefined || p.price >= min) &&
        (max === undefined || p.price <= max) &&
        (!inStockOnly || p.status !== 'out_of_stock'),
    );
    const list: CatalogueList = {
      currency: catalogue.meta.currency,
      vatIncluded: catalogue.meta.vatIncluded,
      groups: catalogue.groups,
      colors: catalogue.colors,
      sizes: catalogue.sizes,
      count: matches.length,
      ...facetsFor(inGroup),
      products: matches.map(summarise),
    };
    return respond(list);
  }),

  http.get('/api/catalogue/featured', async () => {
    await delay(150);
    const featured: FeaturedList = {
      currency: catalogue.meta.currency,
      vatIncluded: catalogue.meta.vatIncluded,
      products: liveProducts().filter((p) => FEATURED_IDS.includes(p.id) && p.status !== 'out_of_stock').map(summarise),
    };
    return respond(featured);
  }),

  http.get('/api/catalogue/products/:id', async ({ params }) => {
    await delay(100);
    const product = liveProducts().find((p) => p.id === params.id);
    if (!product) return fail(404, 'not_found', `No product "${String(params.id)}"`);
    const detail: ProductDetail = {
      ...product,
      variants: product.variants.map((v) => withExtra(product, v)),
      currency: catalogue.meta.currency,
      vatIncluded: catalogue.meta.vatIncluded,
      colorOptions: product.colors
        .map((id) => catalogue.colors.find((c) => c.id === id))
        .filter((c): c is ColorInfo => c !== undefined)
        // deterministic: public/garments/<product>/<colour>.webp, made by scripts/make-garment-colours.mjs for exactly these colours
        .map((c): ColorOption => ({ ...c, image: `/garments/${product.id}/${c.id}.webp` })),
    };
    return respond(detail);
  }),

  // ---- cart, checkout and orders (STEP 5a). The rules are in ./shop.ts; this is only the HTTP side.
  http.post('/api/cart/quote', async ({ request }) => {
    await delay(100);
    const lines = await readLines(request);
    if (!lines) return fail(400, 'bad_request', 'Send {"lines": [{"sku": "...", "quantity": 1}]} with whole-number quantities from 1 to ' + MAX_LINE_QUANTITY + '.');
    return respond(priceCart(lines));
  }),

  http.get('/api/checkout/options', async () => {
    await delay(100);
    return respond(checkoutOptions);
  }),

  http.post('/api/orders', async ({ request }) => {
    const user = currentUser(request);
    if (!user) return unauthorised();
    await delay(400);
    const body = await readJson(request);
    const lines = body ? parseLines(body.lines) : null;
    if (!body || !lines || typeof body.delivery !== 'object' || body.delivery === null) return fail(400, 'bad_request', 'The order request is not complete.');
    const result = placeOrder({ ...(body as unknown as PlaceOrderRequest), lines }, request.headers.get('Idempotency-Key'), loadDb(), user.id);
    switch (result.status) {
      case 201:
        return respond(publicOrder(result.order), 201);
      case 409:
        return result.code === 'stock_conflict'
          ? fail(409, result.code, result.message, { lines: result.lines })
          : fail(409, result.code, result.message, { quote: result.quote });
      case 422:
        return fail(422, result.code, result.message, { fields: result.fields });
      default:
        return fail(400, result.code, result.message);
    }
  }),

  http.get('/api/orders', async ({ request }) => {
    const user = currentUser(request);
    if (!user) return unauthorised();
    await delay(100);
    return respond(loadDb().orders.filter((o) => o.ownerId === user.id).reverse().map(publicOrder));
  }),

  http.get('/api/orders/:id', async ({ request, params }) => {
    const user = currentUser(request);
    if (!user) return unauthorised();
    await delay(100);
    // another customer's order is simply not found
    const order = loadDb().orders.find((o) => o.id === params.id && o.ownerId === user.id);
    return order ? respond(publicOrder(order)) : fail(404, 'not_found', `No order "${String(params.id)}"`);
  }),

  // MOCK ONLY: stands in for staff cancelling an unpaid order (decision A). The real API has no such customer endpoint.
  http.post('/api/orders/:id/cancel', async ({ request, params }) => {
    const user = currentUser(request);
    if (!user) return unauthorised();
    await delay(150);
    const own = loadDb().orders.some((o) => o.id === String(params.id) && o.ownerId === user.id);
    const order = own ? cancelOrder(String(params.id)) : undefined;
    return order ? respond(publicOrder(order as MockOrder)) : fail(404, 'not_found', `No order "${String(params.id)}"`);
  }),

  // ---- customer accounts (step 6d). The rules are in ./accounts.ts; the session is the token in the X-Mock-Session header.
  http.post('/api/auth/register', async ({ request }) => {
    await delay(150);
    const body = await readJson(request);
    if (!body || ![body.name, body.email, body.password].every((v) => typeof v === 'string')) return fail(400, 'bad_request', 'The request is not complete.');
    const db = loadDb();
    const ipKey = key('register-ip', clientAddress(request));
    const locked = lockedFor(db, [ipKey]);
    if (locked) return tooMany(locked, 'attempts');
    hit(db, ipKey, REGISTER_IP_LIMIT);
    const name = (body.name as string).trim();
    const email = normaliseEmail(body.email as string);
    const fields = checkRegistration(name, email, body.password as string);
    if (Object.keys(fields).length > 0) {
      saveDb(db);
      return fail(422, 'validation', 'Some details need fixing.', { fields: fields as Record<string, string> });
    }
    if (findUser(db, email)) {
      saveDb(db);
      return fail(409, 'email_unavailable', "We couldn't create an account with that email. If it is yours, sign in instead.");
    }
    const user: MockUser = { id: db.nextUserId, name, email, password: body.password as string };
    db.nextUserId += 1;
    db.users.push(user);
    const token = startSession(db, user, request);
    saveDb(db);
    return respond({ user: authUser(user) }, 201, { 'X-Mock-Session': token });
  }),

  http.post('/api/auth/login', async ({ request }) => {
    await delay(150);
    const body = await readJson(request);
    if (!body || ![body.email, body.password].every((v) => typeof v === 'string')) return fail(400, 'bad_request', 'The request is not complete.');
    const db = loadDb();
    const email = normaliseEmail(body.email as string);
    const emailKey = key('login-email', email);
    const ipKey = key('login-ip', clientAddress(request));
    const locked = lockedFor(db, [emailKey, ipKey]);
    if (locked) return tooMany(locked, 'sign-in attempts');
    const user = findUser(db, email);
    if (!user || !body.password || user.password !== body.password) {
      hit(db, emailKey, EMAIL_LIMIT);
      hit(db, ipKey, LOGIN_IP_LIMIT);
      saveDb(db);
      return fail(401, 'invalid_credentials', 'The email or password is not right.');
    }
    forget(db, emailKey);
    const token = startSession(db, user, request);
    saveDb(db);
    return respond({ user: authUser(user) }, 200, { 'X-Mock-Session': token });
  }),

  http.post('/api/auth/logout', async ({ request }) => {
    await delay(50);
    const db = loadDb();
    const token = request.headers.get('X-Mock-Session');
    if (token) delete db.sessions[token];
    saveDb(db);
    return respond({ signedOut: true }, 200, { 'X-Mock-Session': '' });
  }),

  http.get('/api/auth/me', async ({ request }) => {
    await delay(50);
    const user = currentUser(request);
    return user ? respond({ user: authUser(user) }) : unauthorised();
  }),

  // ---- the staff dashboard (step 7). Own session, own routes: ./staffHandlers.ts
  ...staffHandlers,
];

// ---- request helpers for the routes above
/** The customer this request's session names, or null. The session token travels in X-Mock-Session (the real service uses a cookie). */
function currentUser(request: Request, db: MockDb = loadDb()): MockUser | null {
  const token = request.headers.get('X-Mock-Session');
  const id = token ? db.sessions[token] : undefined;
  return id === undefined ? null : (db.users.find((u) => u.id === id) ?? null);
}
const unauthorised = () => fail(401, 'unauthorised', 'Sign in to place or see orders.', {}, { 'X-Mock-Session': '' });
const authUser = (user: MockUser): AuthUser => ({ id: String(user.id), displayName: user.name, email: user.email });
/** The order as the customer sees it: not who owns it, and not what only the staff screens know (the payment received, the history of moves). */
const publicOrder = ({ ownerId, paid, history, ...order }: MockOrder) => (void ownerId, void paid, void history, order);
/** A new session for this customer; the one the browser held (if any) is ended: a new id at every sign-in and registration. */
function startSession(db: MockDb, user: MockUser, request: Request): string {
  const old = request.headers.get('X-Mock-Session');
  if (old) delete db.sessions[old];
  const token = crypto.randomUUID();
  db.sessions[token] = user.id;
  return token;
}

function parseLines(value: unknown): CartLineInput[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const lines: CartLineInput[] = [];
  for (const item of value) {
    const line = item as Partial<CartLineInput> | null;
    if (!line || typeof line.sku !== 'string' || !Number.isInteger(line.quantity) || line.quantity! < 1 || line.quantity! > MAX_LINE_QUANTITY) return null;
    lines.push({ sku: line.sku, quantity: line.quantity! });
  }
  return lines;
}

async function readLines(request: Request): Promise<CartLineInput[] | null> {
  const body = await readJson(request);
  return body ? parseLines(body.lines) : null;
}
