import { useState, type FormEvent } from 'react';
import { setOpeningBalance, type SupplierDetail } from '../../api/suppliers';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { FormDialog } from '../FormDialog';
import { pesos } from './supplierText';
import { control, Field, FormAlert, NO_PROBLEM, problemOf, useSubmit, type Problem } from './supplierUi';

type Step = 'closed' | 'amount' | 'confirm';

/**
 * Administrator only (the page draws it only for one; the server and the model check the role again). Two steps: type the amount, then
 * confirm it. The opening balance is a starting investment for stock the shop already held: it replaces the old figure and is not spending in
 * any month. Nothing is worked out here: the server's answer carries every figure.
 */
export function OpeningBalanceAction({ supplier, onDone }: { supplier: SupplierDetail; onDone: (supplier: SupplierDetail, message: string) => void }) {
  const [step, setStep] = useState<Step>('closed');
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<Problem>(NO_PROBLEM);
  const { busy, run } = useSubmit();

  const open = () => {
    setTyped(String(supplier.openingBalance));
    setProblem(NO_PROBLEM);
    setStep('amount');
  };
  const amount = typed.trim() === '' ? Number.NaN : Number(typed);

  const next = (event: FormEvent) => {
    event.preventDefault();
    if (!Number.isFinite(amount) || amount < 0) {
      setProblem({ fields: { openingBalance: 'Enter the opening balance as an amount, 0 or more, for example 317068.00.' }, message: null });
      return;
    }
    setProblem(NO_PROBLEM);
    setStep('confirm');
  };

  const confirm = () =>
    void run(async () => {
      try {
        const response = await setOpeningBalance(supplier.id, amount);
        setStep('closed');
        onDone(response.data.supplier, 'Opening balance set.');
      } catch (error) {
        setProblem(problemOf(error, ['openingBalance']));
        setStep('amount'); // back to the field, where the server's sentence is shown
      }
    });

  return (
    <>
      <button type="button" className="btn btn-secondary btn-small" onClick={open} data-testid="opening-set">
        Set opening balance
      </button>
      {step === 'amount' && (
        <FormDialog title="Set opening balance" onClose={() => setStep('closed')} testId="opening-dialog">
          <p className="break-words font-medium text-ink">{supplier.name}</p>
          <p className="mt-1 text-sm text-muted">The existing stock, treated as if it was bought from this supplier. A starting investment, not a monthly cost.</p>
          <form onSubmit={next} noValidate className="mt-4 space-y-4">
            <Field label="Opening balance (₱, VAT included)" hint={`Now ${pesos(supplier.openingBalance)}. The new figure replaces it.`} error={problem.fields.openingBalance}>
              {(p) => <input {...p} inputMode="decimal" value={typed} onChange={(e) => setTyped(e.target.value)} className={control} />}
            </Field>
            <FormAlert message={problem.message} />
            <div className="flex flex-wrap gap-3">
              <button type="submit" className="btn btn-primary" data-testid="opening-next">
                Continue
              </button>
              <button type="button" onClick={() => setStep('closed')} className="btn btn-secondary">
                Cancel
              </button>
            </div>
          </form>
        </FormDialog>
      )}
      {step === 'confirm' && (
        <ConfirmDialog title="Set opening balance" yes="Set opening balance" no="Back" busy={busy} onYes={confirm} onNo={() => setStep('amount')} testId="opening-confirm">
          <p>
            Set the opening balance of {supplier.name} to <span className="font-semibold text-ink">{pesos(amount)}</span> (VAT included)? It replaces the current{' '}
            {pesos(supplier.openingBalance)}. It is a starting investment for stock already held, not spending in any month.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
