import { MOCK_SESSION_KEY } from '../api/client';
import { loadDb, saveDb } from '../mocks/shopDb';

/**
 * Test helper: an account and a live session already exist in the mock, as if the customer had registered and signed in (what the
 * browser checks do with an init script). Returns the account's id.
 */
export function signInTestCustomer(name = 'Demo', id = 1): number {
  const db = loadDb();
  if (!db.users.some((u) => u.id === id)) db.users.push({ id, name, email: `${name.toLowerCase().replace(/\W+/g, '-')}@example.test`, password: 'seeded password 123' });
  db.nextUserId = Math.max(db.nextUserId, id + 1);
  db.sessions[`test-session-${id}`] = id;
  saveDb(db);
  sessionStorage.setItem(MOCK_SESSION_KEY, `test-session-${id}`);
  return id;
}
