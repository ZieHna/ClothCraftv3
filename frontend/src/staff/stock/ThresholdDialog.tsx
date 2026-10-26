import { useRef, useState, type FormEvent } from 'react';
import { setGlobalThreshold, setVariantThreshold, type StockVariant } from '../../api/inventory';
import { FormDialog } from '../FormDialog';
import { control, Field, FormAlert, NO_PROBLEM, problemOf, useFocusFirstError, useSubmit, type Problem } from '../suppliers/supplierUi';

export type ThresholdTarget = { kind: 'global'; value: number } | { kind: 'variant'; variant: StockVariant };

/**
 * The Administrator's low-stock levels: the shop-wide one, or one variant's own (which can be taken away again, so the variant follows the shop's).
 * Only the number typed is checked here (digits); the range and everything else is the server's, shown as it sent it. What the level means for a
 * variant (the level that applies, where it comes from, Low or not) is read back from the server's answer, never worked out here.
 */
export function ThresholdDialog({ target, onSaved, onClose }: { target: ThresholdTarget; onSaved: (message: string, variant?: StockVariant) => void; onClose: () => void }) {
  const variant = target.kind === 'variant' ? target.variant : null;
  const [value, setValue] = useState(target.kind === 'global' ? String(target.value) : variant?.threshold === null || !variant ? '' : String(variant.threshold));
  const [problem, setProblem] = useState<Problem>(NO_PROBLEM);
  const [stamp, setStamp] = useState(0);
  const { busy, run } = useSubmit();
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, stamp);
  const fail = (next: Problem) => {
    setProblem(next);
    setStamp((n) => n + 1);
  };
  const name = variant ? (variant.sku ?? variant.name) : 'the shop';

  const save = (level: number | null) =>
    run(async () => {
      setProblem(NO_PROBLEM);
      try {
        if (target.kind === 'global') {
          const response = await setGlobalThreshold(level ?? 0);
          onSaved(`The shop-wide low-stock level is now ${response.data.globalThreshold}.`);
        } else {
          const response = await setVariantThreshold(target.variant.id, level);
          onSaved(level === null ? `${name} follows the shop-wide level again.` : `${name}: its own low-stock level is now ${level}.`, response.data.variant);
        }
      } catch (error) {
        fail(problemOf(error, ['threshold']));
      }
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d+$/.test(value.trim())) return fail({ fields: { threshold: 'Enter a whole number, 0 or more.' }, message: null });
    void save(Number(value.trim()));
  };

  return (
    <FormDialog title={target.kind === 'global' ? 'Shop-wide low-stock level' : `Low-stock level of ${name}`} busy={busy} onClose={onClose} testId="threshold-dialog">
      <form ref={form} onSubmit={submit} noValidate className="space-y-4">
        <p>
          {target.kind === 'global'
            ? 'A variant is Low when its on-hand count is below its level. 0 means no variant is ever Low on the shop-wide level. Changing it updates every variant quietly: no notifications are sent.'
            : 'A level of its own replaces the shop-wide one for this variant. Changing it sends no notification.'}
        </p>
        <Field label="Level" optional={target.kind === 'variant'} hint={variant ? 'Leave empty and choose "Use the shop-wide level" to remove its own level.' : undefined} error={problem.fields.threshold}>
          {(p) => <input {...p} inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} className={control} data-testid="threshold-input" />}
        </Field>
        <FormAlert message={problem.message} />
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} className="btn btn-primary disabled:cursor-wait disabled:opacity-70" data-testid="threshold-save">
            {busy ? 'Saving…' : 'Save level'}
          </button>
          {variant && variant.threshold !== null && (
            <button type="button" disabled={busy} onClick={() => void save(null)} className="btn btn-secondary disabled:opacity-60" data-testid="threshold-clear">
              Use the shop-wide level
            </button>
          )}
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-secondary disabled:opacity-60">
            Cancel
          </button>
        </div>
      </form>
    </FormDialog>
  );
}
