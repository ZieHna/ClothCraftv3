import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { handlers } from '../mocks/handlers';
import { validateDelivery } from '../lib/deliveryRules';
import { MOCK_PROVINCES } from '../mocks/provinces';
import { DEMO_STAFF } from '../mocks/staff';
import { caseFiles, deliveryFixture, discover, runCase, type Send, type Vars } from '../test/contractRunner';

/**
 * The shared API contract (/contract), run against the mock. backend/tests/test_contract.py runs the same cases against the
 * real service, so the two cannot drift apart.
 */
vi.setConfig({ testTimeout: 60000 });
const server = setupServer(...handlers);
const origin = window.location.origin;
let vars: Vars;

/**
 * One request as one browser. The jar is that browser's credentials: against the mock two tokens (X-Mock-Session for the customer and
 * X-Mock-Staff-Session for staff, each handed out on sign-in and emptied on sign-out), and its client address (X-Forwarded-For), which the mock's attempt counters are keyed by.
 */
const send: Send = async (method, path, query, body, headers, jar = { __ip: '10.9.9.9' }) => {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const hasBody = body !== undefined;
  const sent: Record<string, string> = { ...headers, 'X-Forwarded-For': jar.__ip, ...(hasBody ? { 'Content-Type': 'application/json' } : {}) };
  if (jar.session) sent['X-Mock-Session'] = jar.session;
  if (jar.staff) sent['X-Mock-Staff-Session'] = jar.staff;
  const response = await fetch(`${origin}${path}${qs}`, { method, headers: sent, body: hasBody ? JSON.stringify(body) : undefined });
  for (const [header, name] of [['X-Mock-Session', 'session'], ['X-Mock-Staff-Session', 'staff']] as const) {
    const token = response.headers.get(header);
    if (token === null) continue;
    if (token) jar[name] = token;
    else delete jar[name];
  }
  return { status: response.status, body: (await response.json()) as unknown, headers: Object.fromEntries([...response.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])) };
};

beforeAll(async () => {
  server.listen({ onUnhandledFrame: ({ defaults }) => defaults.error() });
  vars = await discover(async (path) => (await send('GET', path, undefined, undefined, {}, { __ip: '10.9.9.9' })).body);
  // the mock's two demo staff accounts (the real service's come from backend/.env)
  const inventory = DEMO_STAFF.find((s) => s.role === 'inventory')!;
  const admin = DEMO_STAFF.find((s) => s.role === 'admin')!;
  Object.assign(vars, { staffInventoryEmail: inventory.email, staffInventoryPassword: inventory.password, staffAdminEmail: admin.email, staffAdminPassword: admin.password });
});
afterAll(() => server.close());

for (const { file, cases } of caseFiles) {
  describe(`contract ${file}`, () => {
    for (const c of cases) it(c.name, () => runCase(c, vars, send));
  });
}

// The delivery rules the form and the mock use are the ones the real service must follow (backend/app/delivery.py).
describe('contract delivery-validation.json', () => {
  const codes = MOCK_PROVINCES.map((p) => p.code);
  for (const c of deliveryFixture.cases) {
    it(c.name, () => {
      const change = Object.fromEntries(Object.entries(c.change).map(([k, v]) => [k, /^\{\{x(\d+)\}\}$/.test(v) ? 'x'.repeat(Number(/\d+/.exec(v)![0])) : v]));
      const delivery = { ...deliveryFixture.valid, ...change } as unknown as Parameters<typeof validateDelivery>[0];
      expect(validateDelivery(delivery, codes)).toEqual(c.errors);
    });
  }
});
