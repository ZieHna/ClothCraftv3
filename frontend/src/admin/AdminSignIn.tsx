import { useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/client';
import { useAdminAuth } from './AdminAuth';

const input = 'mt-1 block w-full border border-brown-dark bg-paper px-3 py-2 text-base';

/** Admin sign-in: the email and password of an Administrator. An employee's account is turned away with a clear message (after a right password). */
export function AdminSignIn() {
  const { signIn } = useAdminAuth();
  const ids = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const summary = useRef<HTMLDivElement>(null);

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
      <form onSubmit={submit} noValidate className="stitched taped relative border border-tan bg-cream p-6 sm:p-8" data-testid="admin-signin">
        <p className="eyebrow">Administrators only</p>
        <h1 className="mt-1 text-4xl sm:text-5xl">Admin sign in</h1>
        <p className="mt-2 text-sm text-muted">
          For the shop&apos;s Administrators. Employees sign in with{' '}
          <Link to="/staff" className="underline underline-offset-4">
            Employee login
          </Link>
          .
        </p>

        <div
          ref={summary}
          tabIndex={-1}
          role={problem ? 'alert' : undefined}
          data-testid="admin-signin-error"
          className={problem ? 'mt-4 border-2 border-brown-dark bg-paper-warm p-3 font-medium text-brown-dark outline-none' : 'sr-only'}
        >
          {problem}
        </div>

        <div className="mt-4">
          <label htmlFor={`${ids}-email`} className="block text-sm font-medium">
            Email
          </label>
          <input id={`${ids}-email`} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" className={input} />
        </div>
        <div className="mt-4">
          <label htmlFor={`${ids}-password`} className="block text-sm font-medium">
            Password
          </label>
          <span className="mt-1 flex gap-2">
            <input id={`${ids}-password`} type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} maxLength={200} autoComplete="current-password" className={`${input} !mt-0`} />
            <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show} className="btn btn-secondary btn-small shrink-0">
              {show ? 'Hide ' : 'Show '}
              <span className="sr-only">password</span>
            </button>
          </span>
        </div>

        <div className="mt-6">
          <button type="submit" disabled={pending} aria-disabled={pending} className="btn btn-primary disabled:cursor-not-allowed disabled:opacity-60">
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </section>
  );
}
