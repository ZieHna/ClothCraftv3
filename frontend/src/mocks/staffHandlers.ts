import { delay, http } from 'msw';
import type { StaffUser } from '../api/types';
import { EMAIL_LIMIT, forget, hit, key, LOGIN_IP_LIMIT, lockedFor, normaliseEmail } from './accounts';
import { clientAddress, fail, readJson, respond, tooMany } from './http';
import { loadDb, saveDb, type MockDb } from './shopDb';
import { DEMO_STAFF, findStaff, list, PAGE_MAX, transition, detail, type MoveResult } from './staff';

/**
 * The MOCK SERVER's staff routes (the real ones are backend/app/staff.py in front of clothcraft.api). The rules are in ./staff.ts.
 * A staff session is the token in the X-Mock-Staff-Session header, kept apart from the customer's X-Mock-Session: a customer token never
 * opens a staff route and a staff token never opens a customer route. contract/cases/07-staff.json runs against this and the real service.
 */
const STAFF_HEADER = 'X-Mock-Staff-Session';
const UNAUTHORISED = 'Sign in to the staff dashboard to continue.';
const STATES = ['awaiting_payment', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'];

const unauthorised = () => fail(401, 'unauthorised', UNAUTHORISED, {}, { [STAFF_HEADER]: '' });
const staffJson = (s: { id: number; name: string; email: string; role: StaffUser['role'] }): StaffUser => ({ id: String(s.id), displayName: s.name, email: s.email, role: s.role });

/** The staff member this request's session names, or null. */
function currentStaff(request: Request, db: MockDb = loadDb()) {
  const token = request.headers.get(STAFF_HEADER);
  const id = token ? db.staffSessions[token] : undefined;
  return id === undefined ? null : (DEMO_STAFF.find((s) => s.id === id) ?? null);
}

/** A new session for this person; the one the browser held (if any) is ended. */
function startSession(db: MockDb, staffId: number, request: Request): string {
  const old = request.headers.get(STAFF_HEADER);
  if (old) delete db.staffSessions[old];
  const token = crypto.randomUUID();
  db.staffSessions[token] = staffId;
  return token;
}

const whole = (raw: string | null, fallback: number): number | null => {
  if (raw === null || raw === '') return fallback;
  return /^\s*[+-]?\d+\s*$/.test(raw) ? Number(raw) : null;
};
const isId = (id: unknown): id is string => typeof id === 'string' && /^\d+$/.test(id);
const notFound = (id: unknown) => fail(404, 'not_found', `No order "${String(id)}"`);

export const staffHandlers = [
  http.post('/api/staff/auth/login', async ({ request }) => {
    await delay(150);
    const body = await readJson(request);
    if (!body || ![body.email, body.password].every((v) => typeof v === 'string')) return fail(400, 'bad_request', 'The request is not complete.');
    const db = loadDb();
    const email = normaliseEmail(body.email as string);
    const emailKey = key('staff-login-email', email);
    const ipKey = key('staff-login-ip', clientAddress(request));
    const locked = lockedFor(db, [emailKey, ipKey]);
    if (locked) return tooMany(locked, 'sign-in attempts');
    const staff = findStaff(email);
    if (!staff || !body.password || staff.password !== body.password) {
      hit(db, emailKey, EMAIL_LIMIT);
      hit(db, ipKey, LOGIN_IP_LIMIT);
      saveDb(db);
      return fail(401, 'invalid_credentials', 'The email or password is not right.');
    }
    forget(db, emailKey);
    const token = startSession(db, staff.id, request);
    saveDb(db);
    return respond({ user: staffJson(staff) }, 200, { [STAFF_HEADER]: token });
  }),

  http.post('/api/staff/auth/logout', async ({ request }) => {
    await delay(50);
    const db = loadDb();
    const token = request.headers.get(STAFF_HEADER);
    if (token) delete db.staffSessions[token];
    saveDb(db);
    return respond({ signedOut: true }, 200, { [STAFF_HEADER]: '' });
  }),

  http.get('/api/staff/auth/me', async ({ request }) => {
    await delay(50);
    const staff = currentStaff(request);
    return staff ? respond({ user: staffJson(staff) }) : unauthorised();
  }),

  http.get('/api/staff/orders', async ({ request }) => {
    await delay(100);
    const db = loadDb();
    if (!currentStaff(request, db)) return unauthorised();
    const params = new URL(request.url).searchParams;
    const states = params.getAll('state').flatMap((raw) => raw.split(',')).filter(Boolean);
    const bad = states.find((s) => !STATES.includes(s));
    if (bad) return fail(400, 'bad_state', `Unknown status "${bad}"`);
    const method = params.get('method') || null;
    if (method !== null && method !== 'cod' && method !== 'bank_transfer') return fail(400, 'bad_method', `Unknown payment method "${method}"`);
    const page = whole(params.get('page'), 1);
    if (page === null) return fail(400, 'bad_request', '"page" must be a whole number.');
    const pageSize = whole(params.get('pageSize'), 25);
    if (pageSize === null) return fail(400, 'bad_request', '"pageSize" must be a whole number.');
    if (page < 1 || pageSize < 1 || pageSize > PAGE_MAX) return fail(400, 'bad_page', 'The page is 1 or more and the page size is from 1 to 100.');
    const result = list(db, { states, method, from: params.get('from') || null, to: params.get('to') || null, q: (params.get('q') ?? '').trim().slice(0, 100), page, pageSize });
    if (result.status === 'invalid') return fail(400, result.code, result.message);
    return respond({ orders: result.orders, total: result.total, page: result.page, pageSize: result.pageSize });
  }),

  http.get('/api/staff/orders/:id', async ({ request, params }) => {
    await delay(100);
    const db = loadDb();
    const staff = currentStaff(request, db);
    if (!staff) return unauthorised();
    const order = isId(params.id) ? db.orders.find((o) => o.id === params.id) : undefined;
    return order ? respond(detail(db, order, staff.role)) : notFound(params.id);
  }),

  http.post('/api/staff/orders/:id/transition', async ({ request, params }) => {
    await delay(150);
    const staff = currentStaff(request);
    if (!staff) return unauthorised();
    const body = await readJson(request);
    const note = body && 'note' in body ? body.note : '';
    if (!body || typeof body.to !== 'string' || typeof body.expectedState !== 'string' || typeof note !== 'string') return fail(400, 'bad_request', 'The request is not complete.');
    if (!isId(params.id)) return notFound(params.id);
    // The database is read HERE, after the last await, and saved before the answer is made: two requests at once cannot both pass the
    // "is it still in that state" check, because the second one reads what the first one saved.
    const result: MoveResult = transition(params.id, staff.role, staff.name, { to: body.to, expectedState: body.expectedState, note }, loadDb());
    switch (result.status) {
      case 'done':
        return respond(result.order);
      case 'not_found':
        return notFound(params.id);
      case 'invalid':
        return fail(422, 'validation', 'Some details need fixing.', { fields: result.fields });
      case 'state_changed':
        return fail(409, 'state_changed', result.message, { currentState: result.current, order: result.order });
      case 'forbidden':
        return fail(403, 'forbidden', result.message, { currentState: result.current });
      default:
        return fail(409, result.status, result.message, { currentState: result.current });
    }
  }),
];
