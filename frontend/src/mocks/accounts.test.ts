import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkRegistration, forget, hit, key, lockedFor, waitWords } from './accounts';
import { COMMON_PASSWORDS } from './commonPasswords';
import type { MockDb } from './shopDb';

const emptyDb = (): MockDb => ({ nextNumber: 1, orders: [], users: [], nextUserId: 1, sessions: {}, staffSessions: {}, throttle: {}, idempotency: {}, priceDelta: {} });

describe('the mock refuses the same passwords as Odoo', () => {
  it('its list equals addons/clothcraft/data/common_passwords.txt', () => {
    const file = readFileSync(resolve(process.cwd(), '..', 'addons', 'clothcraft', 'data', 'common_passwords.txt'), 'utf8');
    const odoo = file.split('\n').map((line) => line.trim().toLowerCase()).filter(Boolean);
    expect([...COMMON_PASSWORDS]).toEqual(odoo);
  });
});

describe('checkRegistration', () => {
  const ok = { name: 'Ana Cruz', email: 'ana@example.com', password: 'a long contract password' };
  const check = (change: Partial<typeof ok>) => checkRegistration(change.name ?? ok.name, change.email ?? ok.email, change.password ?? ok.password);

  it('accepts a good registration and asks for nothing more than length (no composition rules)', () => {
    expect(check({})).toEqual({});
    expect(check({ password: 'all lowercase and spaces' })).toEqual({});
  });
  it.each([
    [{ name: 'A' }, { name: 'Enter your name.' }],
    [{ name: 'x'.repeat(81) }, { name: 'Use 80 characters or fewer for the name.' }],
    [{ email: 'ana@example' }, { email: 'Enter an email address like name@example.com.' }],
    [{ email: 'a b@example.com' }, { email: 'Enter an email address like name@example.com.' }],
    [{ password: 'short' }, { password: 'Use at least 10 characters.' }],
    [{ password: 'x'.repeat(129) }, { password: 'Use 128 characters or fewer.' }],
    [{ password: 'Password123' }, { password: 'That password is too common. Choose another one.' }],
    [{ password: 'kkkkkkkkkkkk' }, { password: 'That password is too common. Choose another one.' }],
    [{ password: 'my-ana@example.com-pw' }, { password: 'Your password cannot contain your email address.' }],
  ])('refuses %j with %j', (change, fields) => {
    expect(check(change)).toEqual(fields);
  });
});

describe('attempt counters', () => {
  const t0 = 1_000_000;
  it('lock at the limit for 60 s, then 120 s, doubling, capped at 15 minutes', () => {
    const db = emptyDb();
    const k = key('login-email', 'a@b.cc');
    for (let i = 0; i < 4; i++) hit(db, k, 5, t0);
    expect(lockedFor(db, [k], t0)).toBe(0);
    hit(db, k, 5, t0);
    expect(lockedFor(db, [k], t0)).toBe(60);
    expect(lockedFor(db, [k], t0 + 59_000)).toBe(1);
    expect(lockedFor(db, [k], t0 + 61_000)).toBe(0);
    hit(db, k, 5, t0 + 61_000);
    expect(lockedFor(db, [k], t0 + 61_000)).toBe(120);
    for (let i = 0; i < 10; i++) hit(db, k, 5, t0 + 61_000);
    expect(lockedFor(db, [k], t0 + 61_000)).toBe(900);
  });
  it('forget failures older than 15 minutes, and a success clears the counter', () => {
    const db = emptyDb();
    const k = key('login-email', 'a@b.cc');
    for (let i = 0; i < 4; i++) hit(db, k, 5, t0);
    hit(db, k, 5, t0 + 16 * 60_000);
    expect(db.throttle[k].failures).toBe(1);
    forget(db, k);
    expect(db.throttle[k]).toBeUndefined();
  });
  it('take the longest of several locks', () => {
    const db = emptyDb();
    for (let i = 0; i < 5; i++) hit(db, 'x', 5, t0);
    for (let i = 0; i < 7; i++) hit(db, 'y', 5, t0);
    expect(lockedFor(db, ['x', 'y'], t0)).toBe(240);
  });
  it('are worded like the real service', () => {
    expect([waitWords(1), waitWords(60), waitWords(61), waitWords(900)]).toEqual(['a minute', 'a minute', '2 minutes', '15 minutes']);
  });
});
