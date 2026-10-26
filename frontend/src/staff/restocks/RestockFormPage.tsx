import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useWorkspace } from '../workspace';
import { ApiError } from '../../api/client';
import { createRestock, getRestock, restockOptions, updateRestock, type RestockBody, type RestockDetail, type RestockSupplier } from '../../api/inventory';
import { listSuppliers, type SupplierSummary } from '../../api/suppliers';
import { StaffDetailSkeleton } from '../../components/skeleton/routeSkeletons';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { pesos, STATUS_LABEL } from '../suppliers/supplierText';
import { control, Field, FormAlert, NO_PROBLEM, problemOf, useFocusFirstError, useSubmit, type Problem } from '../suppliers/supplierUi';
import { todayManila } from './restockText';

const FIELDS = ['supplierId', 'lines', 'shippingOn', 'expectedFrom', 'expectedTo', 'requestNote', 'note'] as const;

interface Row {
  productId: string;
  sku: string | null;
  name: string;
  /** typed text; the server decides what is valid */
  quantity: string;
  unitCost: string;
}
interface Data {
  options: RestockSupplier[];
  suppliers: SupplierSummary[];
  restock?: RestockDetail;
}
type Load = { phase: 'loading' } | { phase: 'ready'; data: Data } | { phase: 'error'; status: number; message: string };

/**
 * Request a restock (/staff/restocks/new) or change a request (/staff/restocks/:id/edit). The supplier comes first; then variants are added
 * from that supplier's supply lines (garment type, then size and colour, then the variant when a line can be filled by more than one).
 * Costs default from the supply line and can be changed. No total is worked out here: the server's estimate shows once the request is saved.
 */
export function RestockFormPage() {
  const w = useWorkspace();
  const { id } = useParams();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const gate = useSkeletonGate(load.phase === 'loading', { immediate: load.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    // the supplier picker merges two lists: restock-options has the suppliers that can be chosen, the suppliers list says why the others cannot
    Promise.all([restockOptions(controller.signal), listSuppliers({ pageSize: 100 }, controller.signal), id ? getRestock(id, controller.signal) : Promise.resolve(null)])
      .then(([options, suppliers, restock]) => setLoad({ phase: 'ready', data: { options: options.data.suppliers, suppliers: suppliers.data.suppliers, restock: restock?.data.restock } }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', status: error instanceof ApiError ? error.status : 0, message: error instanceof ApiError ? error.message : 'Could not load the form.' });
      });
    return () => controller.abort();
  }, [id, attempt]);

  if (load.phase === 'loading' || gate !== 'content') return <StaffDetailSkeleton gate={gate === 'content' ? 'skeleton' : gate} label="Loading the form…" />;
  if (load.phase === 'error') {
    return (
      <section className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-4xl sm:text-5xl">{load.status === 404 ? 'No such restock' : 'Could not load the form'}</h1>
        <p role="alert" className="mt-3 font-medium text-brown-dark">
          {load.message}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {load.status !== 404 && (
            <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
          <Link to={w.restocks} className="btn btn-secondary">
            All restocks
          </Link>
        </div>
      </section>
    );
  }
  return <RestockForm data={load.data} />;
}

/** Why a supplier cannot be chosen for a new request. */
function whyNot(s: SupplierSummary): string {
  if (s.status !== 'available') return STATUS_LABEL[s.status].toLowerCase();
  return s.lineCount === 0 ? 'no supply lines yet' : 'not available';
}

function RestockForm({ data }: { data: Data }) {
  const w = useWorkspace();
  const { options, suppliers, restock } = data;
  const navigate = useNavigate();
  const [supplierId, setSupplierId] = useState(restock?.supplier.id ?? '');
  const [rows, setRows] = useState<Row[]>(() => (restock?.lines ?? []).map((l) => ({ productId: l.productId, sku: l.sku, name: l.name, quantity: String(l.quantity), unitCost: String(l.unitCost) })));
  const [shippingOn, setShippingOn] = useState(restock?.shippingOn ?? true);
  const [from, setFrom] = useState(restock?.expectedFrom ?? '');
  const [to, setTo] = useState(restock?.expectedTo ?? '');
  const [requestNote, setRequestNote] = useState(restock?.requestNote ?? '');
  const [historyNote, setHistoryNote] = useState('');
  const [problem, setProblem] = useState<Problem>(NO_PROBLEM);
  const [rowErrors, setRowErrors] = useState<Record<string, { quantity?: string; unitCost?: string }>>({});
  const [stamp, setStamp] = useState(0);
  const { busy, run } = useSubmit();
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, stamp);
  const err = (name: string) => problem.fields[name];
  const fail = (next: Problem) => {
    setProblem(next);
    setStamp((n) => n + 1);
  };

  const supplier = options.find((s) => s.id === supplierId);
  const unavailable = suppliers.filter((s) => !options.some((o) => o.id === s.id));
  const ships = supplier?.ships ?? restock?.shippingApplied ?? false;
  const fee = supplier?.shippingFee ?? restock?.shippingFee ?? 0;
  const today = todayManila();

  const chooseSupplier = (next: string) => {
    setSupplierId(next);
    setRows([]); // the lines belong to the supplier they were chosen from
    setRowErrors({});
    setShippingOn(true);
  };
  const setRow = (productId: string, patch: Partial<Row>) => setRows((current) => current.map((r) => (r.productId === productId ? { ...r, ...patch } : r)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const local: Record<string, string> = {};
      const perRow: Record<string, { quantity?: string; unitCost?: string }> = {};
      if (!restock && !supplierId) local.supplierId = 'Choose a supplier.';
      if (rows.length === 0) local.lines = 'Add at least one variant.';
      for (const r of rows) {
        const e: { quantity?: string; unitCost?: string } = {};
        if (!/^[1-9]\d*$/.test(r.quantity.trim())) e.quantity = 'Enter a whole number, 1 or more.';
        const cost = r.unitCost.trim() === '' ? Number.NaN : Number(r.unitCost);
        if (!Number.isFinite(cost) || cost < 0) e.unitCost = 'Enter the cost as an amount, for example 494.00.';
        if (e.quantity || e.unitCost) perRow[r.productId] = e;
      }
      if (!from) local.expectedFrom = 'Choose the first expected day.';
      if (!to) local.expectedTo = 'Choose the last expected day.';
      setRowErrors(perRow);
      if (Object.keys(local).length > 0 || Object.keys(perRow).length > 0) return fail({ fields: local, message: null });
      setProblem(NO_PROBLEM);
      const body: RestockBody = {
        lines: rows.map((r) => ({ productId: r.productId, quantity: Number(r.quantity.trim()), unitCost: Number(r.unitCost) })),
        expectedFrom: from,
        expectedTo: to,
      };
      if (ships) body.shippingOn = shippingOn;
      try {
        if (restock) {
          body.requestNote = requestNote.trim(); // sent empty when cleared, so that clearing works
          if (historyNote.trim()) body.note = historyNote.trim();
          await updateRestock(restock.id, body);
          navigate(w.restock(restock.id), { state: { notice: 'Restock saved.' } });
        } else {
          body.supplierId = supplierId;
          if (requestNote.trim()) body.requestNote = requestNote.trim();
          const response = await createRestock(body);
          navigate(w.restock(response.data.restock.id), { state: { notice: 'Restock requested.' } });
        }
      } catch (error) {
        fail(problemOf(error, FIELDS));
      }
    });
  };

  return (
    <section className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <h1 className="text-4xl sm:text-5xl">{restock ? `Edit ${restock.name}` : 'Request a restock'}</h1>
      {restock && restock.state !== 'requested' && (
        <p className="mt-2 text-muted">Only a request that has not been approved yet can be edited. You can still try; the server will say if it cannot be changed.</p>
      )}
      <form ref={form} onSubmit={submit} noValidate className="mt-6 space-y-5" aria-busy={busy} data-testid="restock-form">
        {restock ? (
          <p>
            Supplier: <span className="font-semibold text-ink">{restock.supplier.name}</span>
          </p>
        ) : (
          <Field label="Supplier" error={err('supplierId')} hint={unavailable.length > 0 ? 'A supplier that is switched off, inactive or unavailable cannot be chosen; the list says why.' : undefined}>
            {(p) => (
              <select {...p} value={supplierId} onChange={(e) => chooseSupplier(e.target.value)} className={control}>
                <option value="">Choose a supplier…</option>
                {options.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                {unavailable.map((s) => (
                  <option key={s.id} value={s.id} disabled>
                    {s.name} (not available: {whyNot(s)})
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {restock && (
          <p className="border border-dashed border-brown-dark px-3 py-2" data-testid="replace-note">
            Saving replaces this request&apos;s lines with the lines below.
          </p>
        )}
        {!restock && rows.length > 0 && <p className="text-sm text-muted">Changing the supplier clears the lines below.</p>}

        <fieldset className="border border-tan p-4">
          <legend className="px-1 text-sm font-medium">Variants</legend>
          {supplier ? (
            <Picker supplier={supplier} taken={rows.map((r) => r.productId)} onAdd={(row) => setRows((current) => [...current, row])} />
          ) : (
            <p className="text-muted">{restock ? 'This supplier is not available for new lines now. You can still change or remove the lines below.' : 'Choose a supplier to add variants.'}</p>
          )}
          {rows.length > 0 && (
            <ul className="mt-4 space-y-4" data-testid="restock-rows">
              {rows.map((r) => (
                <li key={r.productId} className="border border-tan bg-cream p-3" data-testid="restock-row-edit">
                  <p className="break-words font-semibold text-ink">{r.sku ?? r.name}</p>
                  <p className="break-words text-sm text-muted">{r.name}</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Quantity" error={rowErrors[r.productId]?.quantity}>
                      {(p) => <input {...p} inputMode="numeric" value={r.quantity} onChange={(e) => setRow(r.productId, { quantity: e.target.value })} className={control} />}
                    </Field>
                    <Field label="Unit cost (₱, VAT included)" error={rowErrors[r.productId]?.unitCost}>
                      {(p) => <input {...p} inputMode="decimal" value={r.unitCost} onChange={(e) => setRow(r.productId, { unitCost: e.target.value })} className={control} />}
                    </Field>
                  </div>
                  <button type="button" className="btn btn-secondary btn-small mt-3" onClick={() => setRows((current) => current.filter((x) => x.productId !== r.productId))} aria-label={`Remove ${r.sku ?? r.name}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {err('lines') && (
            <p role="alert" tabIndex={-1} className="mt-3 font-medium text-brown-dark" data-testid="lines-error">
              <span className="sr-only">Error: </span>
              {err('lines')}
            </p>
          )}
        </fieldset>

        {ships && (
          <Field label={`Add the supplier's shipping (${pesos(fee)})`} error={err('shippingOn')}>
            {(p) => <input {...p} type="checkbox" checked={shippingOn} onChange={(e) => setShippingOn(e.target.checked)} className="mt-2 block size-6 accent-sage-dark" />}
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Expected from" error={err('expectedFrom')}>
            {(p) => <input {...p} type="date" value={from} min={today} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={control} />}
          </Field>
          <Field label="Expected to" error={err('expectedTo')}>
            {(p) => <input {...p} type="date" value={to} min={from || today} onChange={(e) => setTo(e.target.value)} className={control} />}
          </Field>
        </div>
        <Field label="Note on the request" optional error={err('requestNote')}>
          {(p) => <textarea {...p} value={requestNote} onChange={(e) => setRequestNote(e.target.value)} rows={3} maxLength={500} className={control} />}
        </Field>
        {restock && (
          <Field label="Note for the history" optional hint="What you changed and why; it appears in the history." error={err('note')}>
            {(p) => <input {...p} value={historyNote} onChange={(e) => setHistoryNote(e.target.value)} maxLength={500} className={control} />}
          </Field>
        )}

        <FormAlert message={problem.message} />
        <div className="flex flex-wrap gap-3 pt-2">
          <button type="submit" disabled={busy} className="btn btn-primary disabled:cursor-wait disabled:opacity-70" data-testid="restock-save">
            {busy ? 'Saving…' : restock ? 'Save changes' : 'Request restock'}
          </button>
          <Link to={restock ? w.restock(restock.id) : w.restocks} className="btn btn-secondary" aria-disabled={busy || undefined}>
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

/** Adds one variant: garment type, then the size and colour line (with its cost), then the variant if the line has several. */
function Picker({ supplier, taken, onAdd }: { supplier: RestockSupplier; taken: string[]; onAdd: (row: Row) => void }) {
  const [garmentId, setGarmentId] = useState('');
  const [lineId, setLineId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [message, setMessage] = useState('');
  const garments = useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of supplier.lines) seen.set(l.garmentType.id, l.garmentType.name);
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [supplier]);
  const lines = supplier.lines.filter((l) => l.garmentType.id === garmentId);
  const line = lines.find((l) => l.id === lineId);
  const variant = line?.variants.length === 1 ? line.variants[0] : line?.variants.find((v) => v.id === variantId);

  const add = () => {
    if (!line || !variant) return setMessage(line ? 'Choose the variant.' : 'Choose a garment type, then a size and colour.');
    if (taken.includes(variant.id)) return setMessage('That variant is already in the request.');
    setMessage('');
    onAdd({ productId: variant.id, sku: variant.sku, name: variant.name, quantity: '1', unitCost: String(line.unitCost) });
    setLineId('');
    setVariantId('');
  };

  return (
    <div className="space-y-3" data-testid="restock-picker">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Garment type">
          {(p) => (
            <select
              {...p}
              value={garmentId}
              onChange={(e) => {
                setGarmentId(e.target.value);
                setLineId('');
                setVariantId('');
                setMessage('');
              }}
              className={control}
            >
              <option value="">Choose…</option>
              {garments.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Size and colour">
          {(p) => (
            <select
              {...p}
              value={lineId}
              disabled={!garmentId}
              onChange={(e) => {
                setLineId(e.target.value);
                setVariantId('');
                setMessage('');
              }}
              className={`${control} disabled:opacity-60`}
            >
              <option value="">{garmentId ? 'Choose…' : 'Choose a garment type first'}</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.size.name}, {l.color.name} ({pesos(l.unitCost)} each)
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {line && line.variants.length > 1 && (
        <Field label="Variant">
          {(p) => (
            <select {...p} value={variantId} onChange={(e) => setVariantId(e.target.value)} className={control}>
              <option value="">Choose…</option>
              {line.variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.sku ?? v.name} — {v.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <button type="button" className="btn btn-secondary" onClick={add} data-testid="restock-add-variant">
        Add to the request
      </button>
      {message && (
        <p role="alert" className="font-medium text-brown-dark">
          {message}
        </p>
      )}
    </div>
  );
}
