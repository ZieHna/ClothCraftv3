import { API_MODE, MOCK_SESSION_KEY } from '../api/client';

/**
 * Does this browser MAY have a session? The real session is an httpOnly cookie that the page cannot see, so this remembers that a
 * sign-in happened (localStorage) and the page asks the server "who am I" only then. A first-time visitor makes no such call.
 * The hint can be wrong in both directions and that is fine: stale (the session expired) the server says 401 and the hint is cleared;
 * missing (storage cleared, another profile) the visitor simply signs in again. In the mock the session token itself is the hint.
 */
const KEY = 'cc.session.hint';

export function hasSessionHint(): boolean {
  try {
    if (API_MODE === 'mock') return sessionStorage.getItem(MOCK_SESSION_KEY) !== null;
    return localStorage.getItem(KEY) === '1';
  } catch {
    return API_MODE !== 'mock'; // storage blocked: ask the server
  }
}

export function markSignedIn(): void {
  if (API_MODE === 'mock') return;
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* storage blocked: the page then asks the server every time */
  }
}

export function clearSessionHint(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
