import { useEffect, useRef, useState, type FormEvent } from 'react';
import { addRange, updateRange, type SupplierDetail, type UnavailableRange } from '../../api/suppliers';
import { control, Field, FormAlert, NO_PROBLEM, problemOf, useFocusFirstError, useSubmit, type Problem } from './supplierUi';

const FIELDS = ['dateFrom', 'dateTo', 'reason'] as const;

/** Add or change one range of days the supplier cannot deliver. A supplier may have several; the server says whether a range is acceptable. */
export function RangeForm({ supplierId, range, onSaved, onCancel }: {
  supplierId: string;
  range?: UnavailableRange;
  onSaved: (supplier: SupplierDetail, message: string) => void;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState(range?.dateFrom ?? '');
  const [to, setTo] = useState(range?.dateTo ?? '');
  const [reason, setReason] = useState(range?.reason ?? '');
  const [problem, setProblem] = useState<Problem>(NO_PROBLEM);
  const [stamp, setStamp] = useState(0);
  const { busy, run } = useSubmit();
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, stamp);
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('input, select, textarea')?.focus({ preventScroll: true });
  }, []);
  const err = (name: string) => problem.fields[name];

  const fail = (next: Problem) => {
    setProblem(next);
    setStamp((n) => n + 1);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const fields: Record<string, string> = {};
      if (!from) fields.dateFrom = 'Choose the first day.';
      if (!to) fields.dateTo = 'Choose the last day.';
      if (Object.keys(fields).length > 0) return fail({ fields, message: null });
      setProblem(NO_PROBLEM);
      // when changing a range an emptied reason is sent empty, so that clearing it works
      const body = { dateFrom: from, dateTo: to, ...(range || reason.trim() ? { reason: reason.trim() } : {}) };
      try {
        const response = range ? await updateRange(range.id, body) : await addRange(supplierId, body);
        onSaved(response.data.supplier, range ? 'Unavailable dates saved.' : 'Unavailable dates added.');
      } catch (error) {
        fail(problemOf(error, FIELDS));
      }
    });
  };

  return (
    <form ref={form} onSubmit={submit} noValidate aria-label={range ? 'Change unavailable dates' : 'Add unavailable dates'} aria-busy={busy} className="mt-4 space-y-4 border-2 border-dashed border-brown-dark p-4" data-testid="range-form">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="From" error={err('dateFrom')}>
          {(p) => <input {...p} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={control} />}
        </Field>
        <Field label="To" error={err('dateTo')}>
          {(p) => <input {...p} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={control} />}
        </Field>
      </div>
      <Field label="Reason" optional error={err('reason')}>
        {(p) => <input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className={control} />}
      </Field>
      <FormAlert message={problem.message} />
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className="btn btn-primary disabled:cursor-wait disabled:opacity-70" data-testid="range-save">
          {busy ? 'Saving…' : range ? 'Save dates' : 'Add dates'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="btn btn-secondary disabled:opacity-60">
          Cancel
        </button>
      </div>
    </form>
  );
}
