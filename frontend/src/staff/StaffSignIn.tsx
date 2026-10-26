import { lazy, Suspense, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { useStaffAuth } from './StaffAuth';

/**
 * The mock's two demo accounts and their passwords are written in ONE small file that only a mock build can reach: in an Odoo build this
 * condition is a constant false, so the file is never part of the build and its text is nowhere in the page, the scripts or the files.
 */
const MOCK_BUILD = import.meta.env.VITE_API !== 'odoo';
const DemoStaffHint = MOCK_BUILD ? lazy(() => import('./DemoStaffHint')) : null;

const input = 'mt-1 block w-full border border-brown-dark bg-paper px-3 py-2 text-base';

/** Staff sign-in: the email and password of an Odoo user who belongs to Inventory Staff or Administrator. */
export function StaffSignIn() {
  const { signIn } = useStaffAuth();
  const ids = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  const emailField = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (!email.trim() || !password) {
      setProblem(!email.trim() ? 'Enter your email.' : 'Enter your password.');
      setTimeout(() => summary.current?.focus(), 0);
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      await signIn(email.trim(), password);
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : 'Could not reach the shop. Please try again.');
      setPassword('');
      setTimeout(() => summary.current?.focus(), 0);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="mx-auto max-w-md px-4 py-10 sm:py-16">
      <form onSubmit={submit} noValidate className="stitched taped relative border border-tan bg-cream p-6 sm:p-8" data-testid="staff-signin">
        <p className="eyebrow">Staff only</p>
        <h1 className="mt-1 text-4xl sm:text-5xl">Staff sign in</h1>
        <p className="mt-2 text-sm text-muted">For the people who pack and send orders. Customers sign in on the shop.</p>

        <div
          ref={summary}
          tabIndex={-1}
          role={problem ? 'alert' : undefined}
          data-testid="staff-signin-error"
          className={problem ? 'mt-4 border-2 border-brown-dark bg-paper-warm p-3 font-medium text-brown-dark outline-none' : 'sr-only'}
        >
          {problem}
        </div>

        <div className="mt-4">
          <label htmlFor={`${ids}-email`} className="block text-sm font-medium">Email</label>
          <input id={`${ids}-email`} ref={emailField} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" className={input} />
        </div>
        <div className="mt-4">
          <label htmlFor={`${ids}-password`} className="block text-sm font-medium">Password</label>
          <span className="mt-1 flex gap-2">
            <input id={`${ids}-password`} type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} maxLength={200} autoComplete="current-password" className={`${input} !mt-0`} />
            <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show} className="btn btn-secondary btn-small shrink-0">
              {show ? 'Hide ' : 'Show '}<span className="sr-only">password</span>
            </button>
          </span>
        </div>

        <div className="mt-6">
          <button type="submit" disabled={pending} aria-disabled={pending} className="btn btn-primary disabled:cursor-not-allowed disabled:opacity-60">
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </div>

        {DemoStaffHint && (
          <Suspense fallback={null}>
            <DemoStaffHint
              onPick={(e, p) => {
                setEmail(e);
                setPassword(p);
                setProblem(null);
                emailField.current?.focus();
              }}
            />
          </Suspense>
        )}
      </form>
    </section>
  );
}
