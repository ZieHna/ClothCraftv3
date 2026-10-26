import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useWorkspace } from '../workspace';
import { ApiError } from '../../api/client';
import { createSupplier, getSupplier, updateSupplier, type SupplierBody, type SupplierDetail } from '../../api/suppliers';
import { StaffDetailSkeleton } from '../../components/skeleton/routeSkeletons';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { COUNTRIES } from './supplierText';
import { control, Field, FormAlert, NO_PROBLEM, problemOf, useFocusFirstError, useSubmit, type Problem } from './supplierUi';

const FIELDS = ['name', 'contactName', 'street', 'street2', 'city', 'zip', 'phone', 'countryCode', 'ships', 'shippingFee'] as const;

interface Values {
  name: string;
  contactName: string;
  street: string;
  street2: string;
  city: string;
  zip: string;
  phone: string;
  countryCode: string;
  ships: boolean;
  /** typed text; the server decides what is a valid amount */
  shippingFee: string;
}
const EMPTY: Values = { name: '', contactName: '', street: '', street2: '', city: '', zip: '', phone: '', countryCode: 'PH', ships: false, shippingFee: '' };
const fromSupplier = (s: SupplierDetail): Values => ({
  name: s.name, contactName: s.contactName, street: s.street, street2: s.street2 ?? '', city: s.city, zip: s.zip ?? '', phone: s.phone ?? '',
  countryCode: s.countryCode ?? 'PH', ships: s.ships, shippingFee: s.ships ? String(s.shippingFee) : '',
});

type Load = { phase: 'loading' } | { phase: 'ready'; supplier: SupplierDetail } | { phase: 'error'; status: number; message: string };

/** Add a supplier (/staff/suppliers/new) or edit one (/staff/suppliers/:id/edit): the same form. */
export function SupplierFormPage() {
  const w = useWorkspace();
  const { id } = useParams();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const editing = id !== undefined;
  const gate = useSkeletonGate(editing && load.phase === 'loading', { immediate: load.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    getSupplier(id, controller.signal)
      .then((response) => setLoad({ phase: 'ready', supplier: response.data.supplier }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', status: error instanceof ApiError ? error.status : 0, message: error instanceof ApiError ? error.message : 'Could not load the supplier.' });
      });
    return () => controller.abort();
  }, [id, attempt]);

  if (!editing) return <SupplierForm initial={EMPTY} />;
  if (load.phase === 'loading' || gate !== 'content') return <StaffDetailSkeleton gate={gate === 'content' ? 'skeleton' : gate} label="Loading the supplier…" />;
  if (load.phase === 'error') {
    return (
      <section className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-4xl sm:text-5xl">{load.status === 404 ? 'No such supplier' : 'Could not load the supplier'}</h1>
        <p role="alert" className="mt-3 font-medium text-brown-dark">
          {load.message}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {load.status !== 404 && (
            <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
          <Link to={w.suppliers} className="btn btn-secondary">
            All suppliers
          </Link>
        </div>
      </section>
    );
  }
  return <SupplierForm supplier={load.supplier} initial={fromSupplier(load.supplier)} />;
}

function SupplierForm({ supplier, initial }: { supplier?: SupplierDetail; initial: Values }) {
  const w = useWorkspace();
  const navigate = useNavigate();
  const [v, setV] = useState<Values>(initial);
  const [problem, setProblem] = useState<Problem>(NO_PROBLEM);
  const [stamp, setStamp] = useState(0);
  const { busy, run } = useSubmit();
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, stamp);
  const set = <K extends keyof Values>(key: K, value: Values[K]) => setV((current) => ({ ...current, [key]: value }));
  const err = (name: string) => problem.fields[name];
  const back = supplier ? w.supplier(supplier.id) : w.suppliers;
  const countries = COUNTRIES.some((c) => c.code === v.countryCode) ? COUNTRIES : [...COUNTRIES, { code: v.countryCode, name: supplier?.country ?? v.countryCode }];

  const fail = (next: Problem) => {
    setProblem(next);
    setStamp((n) => n + 1);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const body: SupplierBody = { name: v.name.trim(), contactName: v.contactName.trim(), street: v.street.trim(), city: v.city.trim(), countryCode: v.countryCode, ships: v.ships };
      // an optional field left empty is not sent when adding; when editing it is sent empty, so that clearing it works
      for (const key of ['street2', 'zip', 'phone'] as const) if (supplier || v[key].trim()) body[key] = v[key].trim();
      if (v.ships) {
        const fee = v.shippingFee.trim() === '' ? Number.NaN : Number(v.shippingFee);
        if (!Number.isFinite(fee) || fee < 0) return fail({ fields: { shippingFee: 'Enter the shipping fee as an amount, for example 112.00.' }, message: null });
        body.shippingFee = fee;
      }
      setProblem(NO_PROBLEM);
      try {
        const response = supplier ? await updateSupplier(supplier.id, body) : await createSupplier(body);
        navigate(w.supplier(response.data.supplier.id), { state: { notice: supplier ? 'Supplier saved.' : 'Supplier added.' } });
      } catch (error) {
        fail(problemOf(error, FIELDS));
      }
    });
  };

  return (
    <section className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <h1 className="text-4xl sm:text-5xl">{supplier ? `Edit ${supplier.name}` : 'Add supplier'}</h1>
      <form ref={form} onSubmit={submit} noValidate className="mt-6 space-y-4" aria-busy={busy} data-testid="supplier-form">
        <Field label="Company name" error={err('name')}>
          {(p) => <input {...p} value={v.name} onChange={(e) => set('name', e.target.value)} maxLength={120} autoComplete="organization" className={control} />}
        </Field>
        <Field label="Contact name" error={err('contactName')}>
          {(p) => <input {...p} value={v.contactName} onChange={(e) => set('contactName', e.target.value)} maxLength={120} autoComplete="name" className={control} />}
        </Field>
        <Field label="Street" error={err('street')}>
          {(p) => <input {...p} value={v.street} onChange={(e) => set('street', e.target.value)} maxLength={200} autoComplete="address-line1" className={control} />}
        </Field>
        <Field label="Street 2" optional error={err('street2')}>
          {(p) => <input {...p} value={v.street2} onChange={(e) => set('street2', e.target.value)} maxLength={200} autoComplete="address-line2" className={control} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="City" error={err('city')}>
            {(p) => <input {...p} value={v.city} onChange={(e) => set('city', e.target.value)} maxLength={100} autoComplete="address-level2" className={control} />}
          </Field>
          <Field label="Postal code" optional error={err('zip')}>
            {(p) => <input {...p} value={v.zip} onChange={(e) => set('zip', e.target.value)} maxLength={20} autoComplete="postal-code" className={control} />}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Country" error={err('countryCode')}>
            {(p) => (
              <select {...p} value={v.countryCode} onChange={(e) => set('countryCode', e.target.value)} className={control}>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Phone" optional error={err('phone')}>
            {(p) => <input {...p} type="tel" value={v.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} autoComplete="tel" className={control} />}
          </Field>
        </div>

        <fieldset className="border border-tan p-4">
          <legend className="px-1 text-sm font-medium">Shipping</legend>
          <Field label="This supplier charges for shipping" error={err('ships')}>
            {(p) => (
              <input {...p} type="checkbox" checked={v.ships} onChange={(e) => set('ships', e.target.checked)} className="mt-2 block size-6 accent-sage-dark" />
            )}
          </Field>
          {v.ships && (
            <div className="mt-4">
              <Field label="Shipping fee (₱, VAT included)" error={err('shippingFee')}>
                {(p) => <input {...p} inputMode="decimal" value={v.shippingFee} onChange={(e) => set('shippingFee', e.target.value)} className={control} />}
              </Field>
            </div>
          )}
        </fieldset>

        <FormAlert message={problem.message} />
        <div className="flex flex-wrap gap-3 pt-2">
          <button type="submit" disabled={busy} className="btn btn-primary disabled:cursor-wait disabled:opacity-70" data-testid="supplier-save">
            {busy ? 'Saving…' : supplier ? 'Save changes' : 'Add supplier'}
          </button>
          <Link to={back} className="btn btn-secondary" aria-disabled={busy || undefined}>
            Cancel
          </Link>
        </div>
        <p role="status" className="sr-only">
          {busy ? 'Saving…' : ''}
        </p>
      </form>
    </section>
  );
}
