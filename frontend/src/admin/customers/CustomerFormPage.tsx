import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { getCustomer, updateCustomer, type CustomerDetail } from '../../api/adminCustomers';
import { ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { StaffDetailSkeleton } from '../../components/skeleton/routeSkeletons';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { control, Field, FormAlert, NO_PROBLEM, problemOf, useFocusFirstError, useSubmit, type Problem } from '../../staff/suppliers/supplierUi';

const FIELDS = ['name', 'email', 'phone'] as const;
type Load = { phase: 'loading' } | { phase: 'ready'; customer: CustomerDetail } | { phase: 'error'; status: number; message: string };

/** Edit a customer (/admin/customers/:id/edit): name, email (the sign-in name) and phone. Nothing else, and never a password. */
export function CustomerFormPage() {
  const { id = '' } = useParams();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const gate = useSkeletonGate(load.phase === 'loading', { immediate: load.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    getCustomer(id, controller.signal)
      .then((response) => setLoad({ phase: 'ready', customer: response.data.customer }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', status: error instanceof ApiError ? error.status : 0, message: error instanceof ApiError ? error.message : 'Could not load the customer.' });
      });
    return () => controller.abort();
  }, [id, attempt]);

  if (load.phase === 'loading' || gate !== 'content') return <StaffDetailSkeleton gate={gate === 'content' ? 'skeleton' : gate} label="Loading the customer…" />;
  if (load.phase === 'error') {
    return (
      <section className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-4xl sm:text-5xl">{load.status === 404 ? 'No such customer' : 'Could not load the customer'}</h1>
        <p role="alert" className="mt-3 font-medium text-brown-dark">
          {load.message}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {load.status !== 404 && (
            <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
          <Link to="/admin/customers" className="btn btn-secondary">
            All customers
          </Link>
        </div>
      </section>
    );
  }
  return <CustomerForm customer={load.customer} />;
}

function CustomerForm({ customer }: { customer: CustomerDetail }) {
  const navigate = useNavigate();
  const [name, setName] = useState(customer.name);
  const [email, setEmail] = useState(customer.email);
  const [phone, setPhone] = useState(customer.phone ?? '');
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<Problem>(NO_PROBLEM);
  const [stamp, setStamp] = useState(0);
  const { busy, run } = useSubmit();
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, stamp);
  const back = `/admin/customers/${customer.id}`;
  const newEmail = email.trim().toLowerCase();
  const emailChanges = newEmail !== customer.email;

  const save = () =>
    void run(async () => {
      setProblem(NO_PROBLEM);
      try {
        await updateCustomer(customer.id, { name: name.trim(), email: email.trim(), phone: phone.trim() });
        setConfirming(false);
        navigate(back, { state: { notice: emailChanges ? 'The details were saved. They were signed out and now sign in with the new email.' : 'The details were saved.' } });
      } catch (error) {
        setConfirming(false);
        setProblem(problemOf(error, FIELDS));
        setStamp((n) => n + 1);
      }
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (emailChanges) setConfirming(true); // an email change is the sign-in name: it is asked about first, with both addresses in full
    else save();
  };

  return (
    <section className="mx-auto max-w-3xl px-4 py-8 sm:py-10" data-testid="customer-form">
      <p>
        <Link to={back} className="text-sm underline underline-offset-4">
          ← {customer.name}
        </Link>
      </p>
      <h1 className="mt-2 text-4xl sm:text-5xl">Edit customer</h1>
      <form ref={form} onSubmit={submit} noValidate className="mt-6 space-y-4">
        <Field label="Name" error={problem.fields.name}>
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" className={control} />}
        </Field>
        <Field label="Email (the sign-in name)" hint="Changing it signs them out; they then sign in with the new email and the same password." error={problem.fields.email}>
          {(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="off" className={control} />}
        </Field>
        <Field label="Phone" optional error={problem.fields.phone}>
          {(p) => <input {...p} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} className={control} />}
        </Field>
        <FormAlert message={problem.message} />
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} className="btn btn-primary disabled:cursor-wait disabled:opacity-70" data-testid="customer-save">
            {busy ? 'Saving…' : 'Save'}
          </button>
          <Link to={back} className="btn btn-secondary" aria-disabled={busy || undefined}>
            Cancel
          </Link>
        </div>
      </form>
      {confirming && (
        <ConfirmDialog title="Change the sign-in email" yes="Change the email" no="Cancel" busy={busy} onYes={save} onNo={() => setConfirming(false)} testId="customer-email-confirm">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="customer-email-compare">
            <div className="min-w-0 border border-tan bg-paper p-3">
              <dt className="text-sm font-medium text-muted">Old email</dt>
              <dd className="break-all font-semibold text-ink">{customer.email}</dd>
            </div>
            <div className="min-w-0 border border-ink bg-paper p-3">
              <dt className="text-sm font-medium text-muted">New email</dt>
              <dd className="break-all font-semibold text-ink">{newEmail}</dd>
            </div>
          </dl>
          <p className="mt-3">
            They are signed out at once and must sign in with the new email. Check it letter by letter: the shop has no "forgot password", so a mistyped email locks them out until it is put back.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
