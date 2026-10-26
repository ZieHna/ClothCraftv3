import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { API_MODE, forgetMockSession, MOCK_STAFF_SESSION_KEY, onStaffSessionEnded } from '../api/client';
import { signInStaff, signOutStaff, staffMe } from '../api/staff';
import type { StaffUser } from '../api/types';

/**
 * Who is signed in to the staff dashboard. The same idea as the customer's AuthProvider and as separate as the sessions are: the service
 * keeps the staff session in its own cookie, and a customer's session never opens a staff route. The page asks "who am I" only when this
 * browser may hold a staff session (a first-time visitor makes no such call, so no 401 is logged), and Odoo re-reads the person's groups
 * on every call, so a removed group takes effect at once.
 */
const HINT = 'cc.staff.hint';

function hasHint(): boolean {
  try {
    if (API_MODE === 'mock') return sessionStorage.getItem(MOCK_STAFF_SESSION_KEY) !== null;
    return localStorage.getItem(HINT) === '1';
  } catch {
    return API_MODE !== 'mock';
  }
}
function setHint(on: boolean): void {
  if (API_MODE === 'mock') return;
  try {
    if (on) localStorage.setItem(HINT, '1');
    else localStorage.removeItem(HINT);
  } catch {
    /* storage blocked: the page then asks the server every time */
  }
}

interface StaffAuthApi {
  /** the signed-in staff member, or null */
  user: StaffUser | null;
  /** "loading" only while a returning visitor's session is being checked with the server */
  status: 'loading' | 'ready';
  /** shown when the server ended the session */
  notice: string | null;
  /** throws ApiError: invalid_credentials, too_many_attempts, mfa_unsupported */
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}
const StaffAuthContext = createContext<StaffAuthApi | null>(null);

export function useStaffAuth(): StaffAuthApi {
  const api = useContext(StaffAuthContext);
  if (!api) throw new Error('useStaffAuth must be used inside <StaffAuthProvider>');
  return api;
}

/** The employee sign-in if there is one (no error when there is none): for pages that are also shown under /admin. */
export function useOptionalStaffAuth(): StaffAuthApi | null {
  return useContext(StaffAuthContext);
}

export function StaffAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<StaffUser | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready'>(() => (hasHint() ? 'loading' : 'ready'));
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!hasHint()) return;
    let alive = true;
    staffMe()
      .then((response) => alive && setUser(response.data.user))
      .catch(() => setHint(false))
      .finally(() => alive && setStatus('ready'));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () =>
      onStaffSessionEnded(() => {
        setHint(false);
        setUser((current) => {
          if (current) setNotice('Your session ended. Please sign in again.');
          return null;
        });
      }),
    [],
  );

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await signInStaff({ email, password });
    setHint(true);
    setNotice(null);
    setUser(response.data.user);
  }, []);

  const signOut = useCallback(() => {
    setHint(false);
    setNotice(null);
    setUser(null);
    void signOutStaff().catch(() => undefined); // the server ends the session (sent with keepalive: a reload right now cannot cancel it)
    forgetMockSession('staff'); // after the request was built: it carries the token
  }, []);

  const value = useMemo<StaffAuthApi>(() => ({ user, status, notice, signIn, signOut }), [user, status, notice, signIn, signOut]);
  return <StaffAuthContext.Provider value={value}>{children}</StaffAuthContext.Provider>;
}
