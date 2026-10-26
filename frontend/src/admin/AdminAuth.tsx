import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { onAdminSessionEnded } from '../api/client';
import { adminMe, signInAdmin, signOutAdmin } from '../api/admin';
import type { StaffUser } from '../api/types';

/**
 * Who is signed in to the admin dashboard. The same idea as StaffAuth and as separate: the service keeps this session in its own cookie
 * (cc_admin), so an employee session never opens /admin and signing out of one does not sign out of the other. The page asks "who am I"
 * only when this browser may hold an admin session, and Odoo re-reads the person's groups on every call: the page decides nothing.
 */
const HINT = 'cc.admin.hint';

function hasHint(): boolean {
  try {
    return localStorage.getItem(HINT) === '1';
  } catch {
    return true;
  }
}
function setHint(on: boolean): void {
  try {
    if (on) localStorage.setItem(HINT, '1');
    else localStorage.removeItem(HINT);
  } catch {
    /* storage blocked: the page then asks the server every time */
  }
}

interface AdminAuthApi {
  /** the signed-in Administrator, or null */
  user: StaffUser | null;
  /** "loading" only while a returning visitor's session is being checked with the server */
  status: 'loading' | 'ready';
  /** shown when the server ended the session */
  notice: string | null;
  /** throws ApiError: invalid_credentials, too_many_attempts, not_admin, mfa_unsupported */
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}
const AdminAuthContext = createContext<AdminAuthApi | null>(null);

export function useAdminAuth(): AdminAuthApi {
  const api = useContext(AdminAuthContext);
  if (!api) throw new Error('useAdminAuth must be used inside <AdminAuthProvider>');
  return api;
}

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<StaffUser | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready'>(() => (hasHint() ? 'loading' : 'ready'));
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!hasHint()) return;
    let alive = true;
    adminMe()
      .then((response) => alive && setUser(response.data.user))
      .catch(() => setHint(false))
      .finally(() => alive && setStatus('ready'));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () =>
      onAdminSessionEnded(() => {
        setHint(false);
        setUser((current) => {
          if (current) setNotice('Your session ended. Please sign in again.');
          return null;
        });
      }),
    [],
  );

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await signInAdmin({ email, password });
    setHint(true);
    setNotice(null);
    setUser(response.data.user);
  }, []);

  const signOut = useCallback(() => {
    setHint(false);
    setNotice(null);
    setUser(null);
    void signOutAdmin().catch(() => undefined); // the server ends the session (sent with keepalive: a reload right now cannot cancel it)
  }, []);

  const value = useMemo<AdminAuthApi>(() => ({ user, status, notice, signIn, signOut }), [user, status, notice, signIn, signOut]);
  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}
