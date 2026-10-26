import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { registerCustomer, signInCustomer } from '../api/auth';
import { ApiError } from '../api/client';
import type { AuthUser } from '../api/types';

export type DialogMode = 'signin' | 'register';
type Field = 'name' | 'email' | 'password';

interface Props {
  mode: DialogMode | null;
  /** why the dialog opened, when something is waiting for the sign-in ("Sign in or register to add this to your cart.") */
  reason?: string | null;
  onSwitch: (mode: DialogMode) => void;
  onClose: () => void;
  onComplete: (user: AuthUser) => void;
}

const FIELD_LABEL: Record<Field, string> = { name: 'Your name', email: 'Email', password: 'Password' };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * "Sign in" and "Register". Built on the native <dialog> element, which gives a focus trap, Escape to close, an inert page behind it
 * and focus back on the opener for free. The server decides what a good name, email and password are and says so in sentences;
 * this only catches what is empty or not an email, so a mistake is told at once and a request is not wasted. Every message is text,
 * tied to its field (aria-describedby), and gathered in a summary that takes focus when a submit fails.
 */
export function AuthDialog({ mode, reason = null, onSwitch, onClose, onComplete }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const emailField = useRef<HTMLInputElement>(null);
  const ids = useId();
  const [values, setValues] = useState({ name: '', email: '', password: '' });
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const isRegister = mode === 'register';

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (mode && !dialog.open) dialog.showModal();
    if (!mode && dialog.open) dialog.close();
    // the first field takes focus (the form is made as the dialog opens, so the autofocus attribute is too early to count on)
    if (mode) setTimeout(() => (mode === 'register' ? nameField : emailField).current?.focus(), 0);
    // a fresh start every time the dialog opens or switches: what was typed in the other form is not carried over
    setErrors({});
    setProblem(null);
    setShow(false);
    setValues((v) => ({ ...v, password: '' }));
  }, [mode]);

  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [retryAt]);
  const waiting = Math.max(0, Math.ceil((retryAt - now) / 1000));

  const fail = (fields: Partial<Record<Field, string>>, general: string | null = null) => {
    setErrors(fields);
    setProblem(general);
    setTimeout(() => summary.current?.focus(), 0); // the summary takes focus, so a keyboard or screen reader user lands on it
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || waiting > 0) return;
    const name = values.name.trim();
    const email = values.email.trim();
    const mine: Partial<Record<Field, string>> = {};
    if (isRegister && !name) mine.name = 'Enter your name.';
    if (!EMAIL.test(email)) mine.email = 'Enter an email address like name@example.com.';
    if (!values.password) mine.password = isRegister ? 'Choose a password.' : 'Enter your password.';
    if (Object.keys(mine).length > 0) return fail(mine);
    setErrors({});
    setProblem(null);
    setPending(true);
    try {
      const response = isRegister ? await registerCustomer({ name, email, password: values.password }) : await signInCustomer({ email, password: values.password });
      setValues({ name: '', email: '', password: '' });
      onComplete(response.data.user);
    } catch (error) {
      setValues((v) => ({ ...v, password: '' })); // a refused password is not kept in the page
      if (!(error instanceof ApiError)) return fail({}, 'Could not reach the shop. Nothing was changed. Check your connection and try again.');
      if (error.status === 422 && error.details.fields) return fail(error.details.fields as Partial<Record<Field, string>>);
      if (error.status === 429) {
        const seconds = error.details.retryAfter ?? 60;
        setRetryAt(Date.now() + seconds * 1000);
        setNow(Date.now());
      }
      fail({}, error.message);
    } finally {
      setPending(false);
    }
  };

  const messages = (['name', 'email', 'password'] as Field[]).filter((f) => errors[f] && (f !== 'name' || isRegister));
  const showSummary = messages.length > 0 || problem !== null;
  const title = isRegister ? 'Register' : 'Sign in';
  const described = (f: Field) => (errors[f] ? `${ids}-${f}-error` : undefined);
  const input = 'mt-1 block w-full border border-brown-dark bg-paper px-3 py-2 text-base';

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${ids}-title`}
      aria-describedby={reason ? `${ids}-reason` : undefined}
      onClose={onClose}
      onClick={(event) => event.target === ref.current && ref.current.close()}
      className="m-auto w-[min(92vw,28rem)] border border-brown bg-cream p-0 text-text backdrop:bg-ink/55"
    >
      {mode && (
        <form onSubmit={submit} noValidate className="m-2 border border-dashed border-brown/70 p-6" data-testid="auth-form" data-mode={mode}>
          <h2 id={`${ids}-title`} className="text-4xl">{title}</h2>
          {reason && (
            <p id={`${ids}-reason`} className="mt-2 font-medium text-ink" data-testid="auth-reason">
              {reason}
            </p>
          )}

          <div ref={summary} tabIndex={-1} role={showSummary ? 'alert' : undefined} data-testid="auth-error-summary" className={showSummary ? 'mt-4 border-2 border-brown-dark bg-paper-warm p-3 outline-none' : 'sr-only'}>
            {problem && <p className="font-medium text-brown-dark">{problem}</p>}
            {messages.length > 0 && (
              <ul className="list-disc pl-5">
                {messages.map((f) => (
                  <li key={f}>
                    <a href={`#${ids}-${f}`} onClick={(e) => { e.preventDefault(); document.getElementById(`${ids}-${f}`)?.focus(); }} className="underline">
                      {FIELD_LABEL[f]}: {errors[f]}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {waiting > 0 && <p aria-live="off">You can try again in {waiting} second{waiting === 1 ? '' : 's'}.</p>}
          </div>

          {isRegister && (
            <div className="mt-4">
              <label htmlFor={`${ids}-name`} className="block text-sm font-medium">Your name</label>
              <input id={`${ids}-name`} type="text" value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} maxLength={80} autoComplete="name" ref={nameField}
                aria-invalid={errors.name ? true : undefined} aria-describedby={described('name')} className={input} />
              {errors.name && <span id={`${ids}-name-error`} className="mt-1 block text-sm font-medium text-brown-dark">{errors.name}</span>}
            </div>
          )}

          <div className="mt-4">
            <label htmlFor={`${ids}-email`} className="block text-sm font-medium">Email</label>
            <input id={`${ids}-email`} type="email" inputMode="email" value={values.email} onChange={(e) => setValues({ ...values, email: e.target.value })} autoComplete="username" ref={emailField}
              aria-invalid={errors.email ? true : undefined} aria-describedby={described('email')} className={input} />
            {errors.email && <span id={`${ids}-email-error`} className="mt-1 block text-sm font-medium text-brown-dark">{errors.email}</span>}
          </div>

          <div className="mt-4">
            <label htmlFor={`${ids}-password`} className="block text-sm font-medium">Password</label>
            <span className="mt-1 flex gap-2">
              <input id={`${ids}-password`} type={show ? 'text' : 'password'} value={values.password} onChange={(e) => setValues({ ...values, password: e.target.value })} maxLength={200}
                autoComplete={isRegister ? 'new-password' : 'current-password'} aria-invalid={errors.password ? true : undefined}
                aria-describedby={[described('password'), isRegister ? `${ids}-password-hint` : undefined].filter(Boolean).join(' ') || undefined} className={`${input} !mt-0`} />
              <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show} className="btn btn-secondary btn-small shrink-0">
                {show ? 'Hide ' : 'Show '}<span className="sr-only">password</span>
              </button>
            </span>
            {isRegister && <span id={`${ids}-password-hint`} className="mt-1 block text-sm text-muted">At least 10 characters. Spaces are fine, and there are no other rules.</span>}
            {errors.password && <span id={`${ids}-password-error`} className="mt-1 block text-sm font-medium text-brown-dark">{errors.password}</span>}
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button type="submit" disabled={pending || waiting > 0} aria-disabled={pending || waiting > 0} className="btn btn-primary disabled:cursor-not-allowed disabled:opacity-60">
              {pending ? (isRegister ? 'Creating account…' : 'Signing in…') : isRegister ? 'Create account' : 'Sign in'}
            </button>
            <button type="button" onClick={() => ref.current?.close()} className="btn btn-secondary">
              Cancel
            </button>
          </div>

          <p className="mt-5 text-sm text-muted">
            {isRegister ? 'Already have an account? ' : 'New here? '}
            <button type="button" onClick={() => onSwitch(isRegister ? 'signin' : 'register')} className="font-medium text-sage-dark underline">
              {isRegister ? 'Sign in' : 'Register'}
            </button>
          </p>
        </form>
      )}
    </dialog>
  );
}
