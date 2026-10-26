import { useRef, useState, type FormEvent } from 'react';
import { editStock, type StockVariant } from '../../api/inventory';
import { FormDialog } from '../FormDialog';
import { control, Field, FormAlert, NO_PROBLEM, problemOf, useFocusFirstError, useSubmit, type Problem } from '../suppliers/supplierUi';

const FIELDS = ['quantity', 'reason'] as const;

/**
 * Set a variant's on-hand count to a new whole number, with a reason. The server decides everything else (the same number, below what orders
 * hold, a reason that is too short): its sentence is shown beside the field or in the alert, and nothing is changed until it says yes.
 */
export function EditStockDialog({ variant, onSaved, onClose }: { variant: StockVariant; onSaved: (variant: StockVariant, message: string) => void; onClose: () => void }) {
  const [quantity, setQuantity] = useState(String(variant.onHand));
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<Problem>(NO_PROBLEM);
  const [stamp, setStamp] = useState(0);
  const { busy, run } = useSubmit();
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, stamp);
  const err = (name: string) => problem.fields[name];
  const fail = (next: Problem) => {
    setProblem(next);
    setStamp((s) => s + 1);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (!/^\d+$/.test(quantity.trim())) return fail({ fields: { quantity: 'Enter a whole number, 0 or more.' }, message: null });
      setProblem(NO_PROBLEM);
      try {
        const response = await editStock(variant.id, { quantity: Number(quantity.trim()), reason: reason.trim() });
        const { oldQty, newQty } = response.data.edit;
        onSaved(response.data.variant, `${variant.sku ?? variant.name}: on hand ${oldQty} → ${newQty}.`);
      } catch (error) {
        fail(problemOf(error, FIELDS));
      }
    });
  };

  return (
    <FormDialog title="Edit stock" busy={busy} onClose={onClose} testId="stock-dialog">
      <p className="break-words font-medium text-ink">{variant.name}</p>
      <p className="text-sm text-muted">
        On hand now {variant.onHand}, reserved by orders {variant.reserved}.
      </p>
      <form ref={form} onSubmit={submit} noValidate aria-busy={busy} className="mt-4 space-y-4">
        <Field label="New number on hand" hint="A whole number. This replaces the count." error={err('quantity')}>
          {(p) => <input {...p} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={control} />}
        </Field>
        <Field label="Reason" hint="5 to 500 characters. It is kept in the stock edit history." error={err('reason')}>
          {(p) => <textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} className={control} />}
        </Field>
        <FormAlert message={problem.message} />
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} className="btn btn-primary disabled:cursor-wait disabled:opacity-70" data-testid="stock-save">
            {busy ? 'Saving…' : 'Save stock'}
          </button>
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-secondary disabled:opacity-60">
            Cancel
          </button>
        </div>
      </form>
    </FormDialog>
  );
}
