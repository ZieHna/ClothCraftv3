/**
 * Reads the shared API contract cases in /contract (see contract/README.md) and checks responses against them.
 * The same cases are read by backend/tests/contract_runner.py, so the mock and the real service answer to the same rules.
 * Keep the two interpreters in step: every `op`, every step kind and every {{expression}} exists there too.
 * Staff sign in with a step (POST /api/staff/auth/login with {{staffInventoryEmail}} and so on, see contract/README.md): the runner itself
 * knows nothing about staff. The credentials are given to it as variables by whoever runs it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Step {
  /** which client's browser sends this (a named client with its own customer and staff sessions); none: the case's default */
  as?: string;
  /** send the same request this many times, each answer expected to be the same */
  repeat?: number;
  /** remember this client's session under a label (no request) */
  snapshot?: string;
  /** give this client back the session remembered under a label (no request): a copy of an old cookie */
  restore?: string;
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Json;
  status?: number;
  shape?: Json;
  asserts?: Record<string, Json>[];
  /** variable name -> path in the response body, kept for later steps */
  save?: Record<string, string>;
}
export interface ParallelStep {
  parallel: Step[];
  as?: never;
  /** the statuses of the parallel requests, as a sorted list (which request wins a race is not fixed) */
  statuses: number[];
  save?: Record<string, string>;
  asserts?: Record<string, Json>[];
}
export interface ContractCase extends Step {
  name: string;
  /** customers registered fresh for this case, each a named client (alice, bob...); vars <name>Email, <name>Password, <name>Id */
  customers?: string[];
  /** names of fresh unique values (for Idempotency-Key, emails) */
  keys?: string[];
  steps?: (Step | ParallelStep)[];
}
export type Vars = Record<string, unknown>;
/** One client's credentials, kept by the transport (a cookie against the service, a token against the mock). `__ip` is its client address. */
export type Jar = Record<string, string>;
export interface Answer {
  status: number;
  body: unknown;
  /** response headers, names in lower case */
  headers: Record<string, string>;
}
export type Send = (method: string, path: string, query: Record<string, string> | undefined, body: unknown, headers: Record<string, string>, jar: Jar) => Promise<Answer>;
export const CONTRACT_PASSWORD = 'a long contract password';

const root = resolve(process.cwd(), '..', 'contract');
export const shapes = JSON.parse(readFileSync(join(root, 'shapes.json'), 'utf8')) as Record<string, Json>;
export const deliveryFixture = JSON.parse(readFileSync(join(root, 'delivery-validation.json'), 'utf8')) as {
  valid: Record<string, string>;
  cases: { name: string; change: Record<string, string>; errors: Record<string, string> }[];
};
// cases/ is shared with the real service; mock-only/ holds what the frozen mock still does and the real service no longer does (step 11:
// the step 7 order flow with "packed"). The real service has real-only/ instead.
export const caseFiles: { file: string; cases: ContractCase[] }[] = ['cases', 'mock-only'].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file: dir === 'cases' ? file : `${dir}/${file}`, cases: JSON.parse(readFileSync(join(root, dir, file), 'utf8')) as ContractCase[] })),
);

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- {{variables}}
function evaluate(expr: string, vars: Vars): unknown {
  const x = /^x(\d+)$/.exec(expr.trim());
  if (x) return 'x'.repeat(Number(x[1]));
  const m = /^(\w+)(?:([+*-])(\d+))?$/.exec(expr.trim());
  if (!m || !(m[1] in vars)) throw new Error(`contract: unknown variable in {{${expr}}}`);
  const value = vars[m[1]];
  if (!m[2]) return value;
  const n = Number(value);
  return m[2] === '+' ? n + Number(m[3]) : m[2] === '-' ? n - Number(m[3]) : round2(n * Number(m[3]));
}
export function fill<T>(value: T, vars: Vars): T {
  if (typeof value === 'string') {
    const whole = /^\{\{(.+)\}\}$/.exec(value);
    if (whole) return evaluate(whole[1], vars) as T;
    return value.replace(/\{\{(.+?)\}\}/g, (_, expr: string) => String(evaluate(expr, vars))) as T;
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)])) as T;
  return value;
}

// ---------------------------------------------------------------- paths: a.b[0].c, a[*].b, len:/sum:/min:/max: prefixes
function walk(value: unknown, steps: string[]): unknown {
  if (steps.length === 0) return value;
  const [head, ...rest] = steps;
  if (head === '*') {
    if (!Array.isArray(value)) throw new Error('contract: [*] on a non-array');
    return value.map((item) => walk(item, rest));
  }
  if (value === null || value === undefined) return undefined;
  return walk((value as Record<string, unknown>)[head], rest);
}
export function read(root: unknown, path: string): unknown {
  const fn = /^(len|sum|min|max):(.*)$/.exec(path);
  if (fn) {
    const inner = read(root, fn[2]) as number[] | string;
    if (fn[1] === 'len') return inner.length;
    const nums = inner as number[];
    return fn[1] === 'sum' ? round2(nums.reduce((a, b) => a + b, 0)) : fn[1] === 'min' ? Math.min(...nums) : Math.max(...nums);
  }
  const steps = path.replace(/\[(\*|\d+)\]/g, '.$1').split('.').filter(Boolean);
  return walk(root, steps);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- shapes
export function checkShape(template: Json, value: unknown, at = '$'): string[] {
  if (typeof template === 'string') return checkLeaf(template, value, at);
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) return [`${at}: expected an array`];
    return value.flatMap((item, i) => checkShape(template[0], item, `${at}[${i}]`));
  }
  const spec = template as { [key: string]: Json };
  if ('$ref' in spec) return checkShape(shapes[spec.$ref as string], value, at);
  if ('$oneOf' in spec) {
    const options = spec.$oneOf as Json[];
    return options.some((option) => checkShape(option, value, at).length === 0) ? [] : [`${at}: matches none of the allowed shapes`];
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${at}: expected an object`];
  const actual = value as Record<string, unknown>;
  if ('$map' in spec) return Object.entries(actual).flatMap(([k, v]) => checkShape(spec.$map, v, `${at}.${k}`));
  const errors: string[] = [];
  for (const key of Object.keys(spec)) {
    if (!(key in actual)) errors.push(`${at}.${key}: missing`);
    else errors.push(...checkShape(spec[key], actual[key], `${at}.${key}`));
  }
  for (const key of Object.keys(actual)) if (!(key in spec)) errors.push(`${at}.${key}: not in the contract`);
  return errors;
}
function checkLeaf(spec: string, value: unknown, at: string): string[] {
  if (spec.startsWith('enum:')) return spec.slice(5).split('|').includes(String(value)) ? [] : [`${at}: ${JSON.stringify(value)} is not one of ${spec.slice(5)}`];
  const types = spec.split('|');
  const kind = value === null ? 'null' : typeof value;
  return types.includes(kind) || types.includes('any') ? [] : [`${at}: expected ${spec}, got ${kind}`];
}

// ---------------------------------------------------------------- asserts
const each = (values: unknown, is: string, expected: unknown): boolean => {
  const items = values as unknown[];
  return items.every((v) => {
    switch (is) {
      case 'eq': return same(v, expected);
      case 'ne': return !same(v, expected);
      case 'gte': return (v as number) >= (expected as number);
      case 'lte': return (v as number) <= (expected as number);
      case 'containsI': return String(v).toLowerCase().includes(String(expected).toLowerCase());
      default: throw new Error(`contract: unknown 'is' ${is}`);
    }
  });
};

export function checkAssert(a: Record<string, Json>, body: unknown, headers: Record<string, string> = {}): string | null {
  const path = a.path as string;
  const fail = (what: string) => `${what} (${path ?? a.op})`;
  switch (a.op) {
    case 'eq': { const got = read(body, path); return same(got, a.value) ? null : fail(`expected ${JSON.stringify(a.value)}, got ${JSON.stringify(got)}`); }
    case 'eqPath': { const got = read(body, path), other = read(body, a.other as string); return same(got, other) ? null : fail(`${JSON.stringify(got)} differs from ${a.other} = ${JSON.stringify(other)}`); }
    case 'gt': return (read(body, path) as number) > (a.value as number) ? null : fail(`expected more than ${a.value}, got ${JSON.stringify(read(body, path))}`);
    case 'lte': return (read(body, path) as number) <= (a.value as number) ? null : fail(`expected at most ${a.value}, got ${JSON.stringify(read(body, path))}`);
    case 'each': return each(read(body, path), a.is as string, a.value) ? null : fail(`not every value is ${a.is} ${JSON.stringify(a.value)}: ${JSON.stringify(read(body, path))}`);
    case 'unique': { const v = read(body, path) as unknown[]; return new Set(v).size === v.length ? null : fail('values repeat'); }
    case 'countEq': { const n = (read(body, path) as unknown[]).filter((v) => same(v, a.value)).length; return n === a.count ? null : fail(`${n} value(s) equal ${JSON.stringify(a.value)}, expected ${a.count}`); }
    case 'absent': return JSON.stringify(body).includes(a.value as string) ? fail(`${JSON.stringify(a.value)} appears in the response`) : null;
    case 'header': { const got = headers[(a.name as string).toLowerCase()]; return got !== undefined && new RegExp(a.matches as string).test(got) ? null : fail(`header ${a.name} is ${JSON.stringify(got)}, expected to match ${a.matches}`); }
    case 'matches': return new RegExp(a.value as string).test(String(read(body, path))) ? null : fail(`${JSON.stringify(read(body, path))} does not match ${a.value}`);
    case 'startsWith': return String(read(body, path)).startsWith(a.value as string) ? null : fail(`${JSON.stringify(read(body, path))} does not start with ${JSON.stringify(a.value)}`);
    case 'endsWith': return String(read(body, path)).endsWith(a.value as string) ? null : fail(`${JSON.stringify(read(body, path))} does not end with ${JSON.stringify(a.value)}`);
    case 'eachSum': {
      const items = read(body, a.items as string) as Record<string, number>[];
      const bad = items.filter((item) => {
        const parts = (a.parts as string[]).map((p) => (p.startsWith('$.') ? (read(item, p.slice(2)) as number) : (read(body, p) as number)));
        return round2(parts.reduce((x, y) => x + y, 0)) !== item[a.field as string];
      });
      return bad.length === 0 ? null : fail(`${bad.length} item(s) where ${a.field} is not the sum of ${JSON.stringify(a.parts)}`);
    }
    case 'vatOf': {
      const total = read(body, a.total as string) as number, rate = read(body, a.rate as string) as number, vat = read(body, a.vat as string) as number;
      const expected = round2((total * rate) / (100 + rate));
      return Math.abs(vat - expected) < 0.005 ? null : `vat ${vat} is not ${expected} (${rate}% of ${total}, included, rounded once)`;
    }
    case 'statusFollowsStock': {
      const items = read(body, a.items as string) as { stock: number; status: string }[];
      const bad = items.filter((i) => i.status !== (i.stock <= 0 ? 'out_of_stock' : i.stock <= 2 ? 'low_stock' : 'in_stock'));
      return bad.length === 0 ? null : `${bad.length} item(s) whose status does not follow the stock (low stock is 2 or fewer)`;
    }
    default: throw new Error(`contract: unknown op ${String(a.op)}`);
  }
}

// ---------------------------------------------------------------- running a case
function expectResponse(step: { status?: number; shape?: Json; asserts?: Record<string, Json>[] }, result: Answer, vars: Vars) {
  const text = JSON.stringify(result.body).slice(0, 400);
  if (step.status !== undefined && result.status !== step.status) throw new Error(`status ${result.status}, expected ${step.status}: ${text}`);
  if (step.shape) {
    const errors = checkShape(step.shape, result.body);
    if (errors.length) throw new Error(`shape: ${errors.slice(0, 5).join('; ')} | ${text}`);
  }
  for (const a of step.asserts ?? []) {
    const failure = checkAssert(fill(a, vars), result.body, result.headers);
    if (failure) throw new Error(`${failure} | ${JSON.stringify(a)} | ${text}`);
  }
}
function remember(save: Record<string, string> | undefined, body: unknown, vars: Vars) {
  for (const [name, path] of Object.entries(save ?? {})) vars[name] = read(body, path);
}
const randomAddress = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

/** Run one case against any server. Throws on the first thing that does not hold. */
export async function runCase(c: ContractCase, baseVars: Vars, send: Send): Promise<void> {
  const vars: Vars = { ...baseVars, contractPassword: CONTRACT_PASSWORD };
  for (const key of c.keys ?? []) vars[key] = `${key}-${crypto.randomUUID()}`;
  // every named client is a separate browser: its own session, its own client address
  const jars: Record<string, Jar> = {};
  const jarOf = (name: string | undefined) => (jars[name ?? ''] ??= { __ip: randomAddress() });
  const snapshots: Record<string, Jar> = {};
  const request = (step: Step) =>
    send(step.method, fill(step.path, vars), step.query ? fill(step.query, vars) : undefined, step.body === undefined ? undefined : fill(step.body, vars), fill(step.headers ?? {}, vars), jarOf(step.as ?? c.as));

  for (const name of c.customers ?? []) {
    const email = `${name}-${crypto.randomUUID()}@example.test`.toLowerCase();
    const made = await send('POST', '/api/auth/register', undefined, { name: `Contract ${name}`, email, password: CONTRACT_PASSWORD }, {}, jarOf(name));
    if (made.status !== 201) throw new Error(`could not register the customer "${name}": ${made.status} ${JSON.stringify(made.body).slice(0, 200)}`);
    Object.assign(vars, { [`${name}Email`]: email, [`${name}Password`]: CONTRACT_PASSWORD, [`${name}Id`]: read(made.body, 'data.user.id') });
  }
  for (const step of c.steps ?? [c as Step]) {
    if ('parallel' in step) {
      const results = await Promise.all(step.parallel.map((s) => request({ ...s, as: s.as ?? c.as })));
      const statuses = results.map((r) => r.status).sort((x, y) => x - y);
      if (!same(statuses, [...step.statuses].sort((x, y) => x - y))) throw new Error(`parallel statuses ${JSON.stringify(statuses)}, expected ${JSON.stringify(step.statuses)}: ${JSON.stringify(results.map((r) => r.body)).slice(0, 500)}`);
      const combined = { results };
      for (const a of step.asserts ?? []) {
        const failure = checkAssert(fill(a, vars), combined);
        if (failure) throw new Error(`${failure} | ${JSON.stringify(a)}`);
      }
      remember(step.save, combined, vars);
    } else if (step.snapshot !== undefined) {
      snapshots[step.snapshot] = { ...jarOf(step.as ?? c.as) };
    } else if (step.restore !== undefined) {
      const jar = jarOf(step.as ?? c.as);
      for (const k of Object.keys(jar)) if (k !== '__ip') delete jar[k];
      Object.assign(jar, snapshots[step.restore]);
    } else {
      for (let i = 0; i < (step.repeat ?? 1); i++) {
        const result = await request(step);
        expectResponse(step, result, vars);
        remember(step.save, result.body, vars);
      }
    }
  }
}

/** Everything the cases need from the live data, found the same way against any server (see contract/README.md). */
export async function discover(get: (path: string) => Promise<unknown>): Promise<Vars> {
  const list = (await get('/api/catalogue/products')) as { data: { products: { id: string }[] } };
  const vars: Vars = { firstProductId: list.data.products[0].id, validDelivery: deliveryFixture.valid, badDelivery: { ...deliveryFixture.valid, email: 'nope', postalCode: '11' } };
  const inStock: { sku: string; id: string; price: number; stock: number }[] = [];
  for (const { id } of list.data.products) {
    const detail = (await get(`/api/catalogue/products/${id}`)) as { data: { variants: { sku: string; price: number; stock: number }[] } };
    for (const v of detail.data.variants) {
      if (v.stock === 0 && !vars.soldOutSku) vars.soldOutSku = v.sku;
      if (v.stock >= 2 && v.stock <= 90) inStock.push({ sku: v.sku, id, price: v.price, stock: v.stock });
    }
  }
  if (!vars.soldOutSku || inStock.length < 12) throw new Error('contract: the data needs a sold-out variant and at least 12 variants with 2 to 90 in stock');
  // the first one serves the quote cases; each order case then gets a variant of its own, so no case depends on another's stock
  Object.assign(vars, { inStockSku: inStock[0].sku, inStockProductId: inStock[0].id, inStockPrice: inStock[0].price, inStockAvailable: inStock[0].stock, otherInStockSku: inStock[1].sku });
  inStock.slice(2, 9).forEach((v, i) => {
    const n = i + 1;
    Object.assign(vars, { [`orderSku${n}`]: v.sku, [`orderSku${n}Price`]: v.price, [`orderSku${n}Avail`]: v.stock, [`orderSku${n}PriceMore`]: round2(v.price * (v.stock + 1)) });
  });
  const race = inStock[9];
  Object.assign(vars, { raceSku: race.sku, raceAvail: race.stock, racePriceAll: round2(race.price * race.stock) });
  const iso = [inStock[10], inStock[11]];
  iso.forEach((v, i) => Object.assign(vars, { [`isoSku${i + 1}`]: v.sku, [`isoSku${i + 1}Price`]: v.price }));
  // the staff cases: one variant each, so none depends on another's stock
  inStock.slice(12, 20).forEach((v, i) => {
    const n = i + 1;
    Object.assign(vars, { [`staffSku${n}`]: v.sku, [`staffSku${n}Price`]: v.price, [`staffSku${n}Avail`]: v.stock });
  });
  return vars;
}
