import { COMMON_PASSWORDS } from './commonPasswords';
import type { MockDb, MockUser } from './shopDb';

/**
 * The MOCK SERVER's account rules. They are the real service's (addons/clothcraft/models/api_auth.py): the same sentences, the same
 * limits, the same counters. contract/cases/06-auth.json runs against both, so they cannot drift.
 */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// attempt counters: 5 failures lock an email for 60 s, doubling to 15 minutes; 20 lock an address; 10 registrations per address
export const EMAIL_LIMIT = 5;
export const LOGIN_IP_LIMIT = 20;
export const REGISTER_IP_LIMIT = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCK_BASE_S = 60;
const LOCK_CAP_S = 900;
const common = new Set(COMMON_PASSWORDS);

export type RegistrationFields = Partial<Record<'name' | 'email' | 'password', string>>;

export function checkRegistration(name: string, email: string, password: string): RegistrationFields {
  const fields: RegistrationFields = {};
  if (name.length < 2) fields.name = 'Enter your name.';
  else if (name.length > 80) fields.name = 'Use 80 characters or fewer for the name.';
  if (email.length > 254 || !EMAIL.test(email)) fields.email = 'Enter an email address like name@example.com.';
  const lower = password.toLowerCase();
  if (password.length < PASSWORD_MIN) fields.password = `Use at least ${PASSWORD_MIN} characters.`;
  else if (password.length > PASSWORD_MAX) fields.password = `Use ${PASSWORD_MAX} characters or fewer.`;
  else if (common.has(lower) || new Set(password).size === 1) fields.password = 'That password is too common. Choose another one.';
  else if (email && (lower.includes(email) || lower === email.split('@')[0])) fields.password = 'Your password cannot contain your email address.';
  return fields;
}

export const normaliseEmail = (email: string) => email.trim().toLowerCase();
export const findUser = (db: MockDb, email: string): MockUser | undefined => db.users.find((u) => u.email === email);

// ---------------------------------------------------------------- counters
export const key = (kind: string, value: string) => `${kind}:${value}`;

/** Seconds until the longest lock among these counters ends (0: none is locked). */
export function lockedFor(db: MockDb, keys: string[], now = Date.now()): number {
  const until = Math.max(0, ...keys.map((k) => db.throttle[k]?.until ?? 0));
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

/** Count one attempt; from `limit` attempts on, lock the counter for 60 s, doubling each time, at most 15 minutes. */
export function hit(db: MockDb, k: string, limit: number, now = Date.now()): void {
  const old = db.throttle[k];
  const failures = old && old.last >= now - FAILURE_WINDOW_MS ? old.failures + 1 : 1;
  const until = failures >= limit ? now + Math.min(LOCK_BASE_S * 2 ** (failures - limit), LOCK_CAP_S) * 1000 : (old?.until ?? 0);
  db.throttle[k] = { failures, last: now, until };
}

export const forget = (db: MockDb, k: string) => {
  delete db.throttle[k];
};

/** "a minute" up to 60 s, else whole minutes: the same words as the real service. */
export const waitWords = (seconds: number) => (seconds <= 60 ? 'a minute' : `${Math.ceil(seconds / 60)} minutes`);
