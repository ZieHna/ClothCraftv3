import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { signOutCustomer, whoAmI } from '../api/auth';
import { forgetMockSession, onSessionEnded } from '../api/client';
import type { AuthUser } from '../api/types';
import { cartStore } from '../cart/cartStore';
import { AuthDialog, type DialogMode } from '../components/AuthDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { countDrafts, knownDraftCount } from '../drafts/deviceDrafts';
import { clearDraftsOnSignOut } from '../drafts/registry';
import { clearSessionHint, hasSessionHint, markSignedIn } from './sessionHint';
import { userKey } from './userKey';

export type AuthStatus = 'loading' | 'ready';

interface AuthApi {
  /** the signed-in customer, or null (also while `status` is "loading") */
  user: AuthUser | null;
  /** "loading" only while a returning visitor's session is being checked with the server */
  status: AuthStatus;
  /** Open the sign-in dialog. `onDone` runs once the customer is signed in; `reason` says in the dialog why it is asked for. */
  openSignIn: (onDone?: () => void, reason?: string) => void;
  openRegister: (onDone?: () => void, reason?: string) => void;
  signOut: () => void;
  /** Run `then` now if signed in, otherwise ask for sign-in first and run it afterwards (only if the customer does sign in). */
  requireAccount: (then: () => void, reason?: string) => void;
}

const AuthContext = createContext<AuthApi | null>(null);

export function useAuth(): AuthApi {
  const api = useContext(AuthContext);
  if (!api) throw new Error('useAuth must be used inside <AuthProvider>');
  return api;
}

/**
 * Who is signed in. The account and its session are the server's (src/api/auth.ts): this asks "who am I" when the browser may hold a
 * session (see sessionHint.ts), shows the register / sign-in dialog, and reacts when the server says the session is over (a 401 on any
 * request): the customer is signed out here too, the cart is kept, and a notice says so.
 *
 * Sign-out (step 12) first makes sure nothing is lost without the customer knowing: unfinished designs on this device are deleted at
 * sign-out, so it says how many there are and lets them stay signed in; and in the real shop the cart's unsaved edits are saved first
 * (a few seconds at most), and if they cannot be, it asks before signing out (they then stay on this device for the next sign-in here).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>(() => (hasSessionHint() ? 'loading' : 'ready'));
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<DialogMode | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const pending = useRef<(() => void) | undefined>(undefined);
  const userRef = useRef<AuthUser | null>(null);
  userRef.current = user;
  // sign-out's questions: each one is answered through `answer` (true: sign out anyway)
  const [asking, setAsking] = useState<{ kind: 'drafts'; count: number } | { kind: 'cart' } | null>(null);
  const answer = useRef<((yes: boolean) => void) | null>(null);
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);

  // the drafts on this device, counted once signed in, so a sign-out with none needs no wait
  useEffect(() => {
    if (user) void countDrafts(userKey(user));
  }, [user]);

  useEffect(() => {
    if (!hasSessionHint()) return;
    let alive = true;
    whoAmI()
      .then((response) => {
        if (!alive) return;
        // the cart is the signed-in customer's. Set together with the user (not in an effect after the render), so a page that reads the
        // cart on its first render (checkout) never sees an empty cart for a moment.
        cartStore.setOwner(response.data.user.id);
        setUser(response.data.user);
      })
      .catch(() => clearSessionHint())
      .finally(() => alive && setStatus('ready'));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () =>
      onSessionEnded(() => {
        clearSessionHint();
        cartStore.setOwner(null); // the cart stays stored for when this customer signs in again, but nobody is signed in now
        if (userRef.current) {
          setUser(null);
          setNotice('Your session ended. Please sign in again.');
        }
      }),
    [],
  );

  const open = useCallback((next: DialogMode, onDone?: () => void, why?: string) => {
    pending.current = onDone;
    setReason(why ?? null);
    setMode(next);
  }, []);
  const openSignIn = useCallback((onDone?: () => void, why?: string) => open('signin', onDone, why), [open]);
  const openRegister = useCallback((onDone?: () => void, why?: string) => open('register', onDone, why), [open]);

  const finishSignOut = useCallback((who: AuthUser) => {
    // drafts go with the session too: every saver is sealed first (synchronously), then this person's drafts are deleted
    void clearDraftsOnSignOut(userKey(who));
    cartStore.signOut(); // mock: the cart goes with the session. Real shop: the account keeps it
    clearSessionHint();
    setUser(null);
    setNotice(null);
    void signOutCustomer().catch(() => undefined); // the server ends the session (sent with keepalive: a reload right now cannot cancel it)
    forgetMockSession('customer'); // after the request was built: it carries the token
  }, []);

  const ask = useCallback((question: { kind: 'drafts'; count: number } | { kind: 'cart' }) => new Promise<boolean>((resolve) => {
    answer.current = resolve;
    setAsking(question);
  }), []);
  const reply = useCallback((yes: boolean) => {
    setAsking(null);
    const done = answer.current;
    answer.current = null;
    done?.(yes);
  }, []);

  const signOut = useCallback(() => {
    const who = userRef.current;
    if (!who || leavingRef.current) return;
    const sync = cartStore.getSync();
    const cartSaved = sync.phase === 'off' || (sync.phase === 'ready' && !sync.pending);
    // nothing to warn about, known at once: signed out now, as before step 12
    if (knownDraftCount(userKey(who)) === 0 && cartSaved) {
      finishSignOut(who);
      return;
    }
    leavingRef.current = true;
    setLeaving(true);
    void (async () => {
      try {
        const drafts = await countDrafts(userKey(who));
        if (drafts > 0 && !(await ask({ kind: 'drafts', count: drafts }))) return;
        if (!(await cartStore.flush(3000)) && !(await ask({ kind: 'cart' }))) return;
        if (userRef.current?.id === who.id) finishSignOut(who);
      } finally {
        leavingRef.current = false;
        setLeaving(false);
      }
    })();
  }, [ask, finishSignOut]);

  const requireAccount = useCallback((then: () => void, why?: string) => (user ? then() : open('signin', then, why)), [user, open]);

  const complete = useCallback((signedIn: AuthUser) => {
    markSignedIn();
    cartStore.setOwner(signedIn.id); // now, not after the render: what was waiting for sign-in (an "Add to cart") runs below
    setUser(signedIn);
    setNotice(null);
    setMode(null);
    const done = pending.current;
    pending.current = undefined;
    done?.();
  }, []);

  const close = useCallback(() => {
    pending.current = undefined; // closed without signing in: what was waiting is dropped (nothing is added to a cart)
    setMode(null);
  }, []);

  const value = useMemo<AuthApi>(() => ({ user, status, openSignIn, openRegister, signOut, requireAccount }), [user, status, openSignIn, openRegister, signOut, requireAccount]);

  return (
    <AuthContext.Provider value={value}>
      {notice && (
        <p role="alert" className="border-b border-brown-dark bg-cream px-4 py-3 text-center font-medium text-brown-dark" data-testid="session-ended">
          {notice}{' '}
          <button type="button" className="underline underline-offset-4" onClick={() => openSignIn()}>
            Sign in
          </button>
        </p>
      )}
      {leaving && !asking && (
        <p role="status" className="border-b border-tan bg-cream px-4 py-2 text-center text-sm text-muted" data-testid="signing-out">
          Signing out…
        </p>
      )}
      {children}
      {asking?.kind === 'drafts' && (
        <ConfirmDialog title="Unfinished designs" yes="Sign out anyway" no="Stay signed in" onYes={() => reply(true)} onNo={() => reply(false)} testId="signout-drafts">
          <p>
            {asking.count === 1
              ? 'You have 1 unfinished design on this device. Add it to your cart to keep it, or sign out anyway.'
              : `You have ${asking.count} unfinished designs on this device. Add them to your cart to keep them, or sign out anyway.`}
          </p>
          <p className="mt-2 text-sm text-muted">Signing out deletes {asking.count === 1 ? 'it' : 'them'} from this device.</p>
        </ConfirmDialog>
      )}
      {asking?.kind === 'cart' && (
        <ConfirmDialog title="Cart not saved" yes="Sign out anyway" no="Stay signed in" onYes={() => reply(true)} onNo={() => reply(false)} testId="signout-cart">
          <p>Some cart changes couldn't be saved. Sign out anyway?</p>
          <p className="mt-2 text-sm text-muted">They stay on this device and are saved the next time you sign in here.</p>
        </ConfirmDialog>
      )}
      <AuthDialog mode={mode} reason={reason} onSwitch={setMode} onClose={close} onComplete={complete} />
    </AuthContext.Provider>
  );
}
