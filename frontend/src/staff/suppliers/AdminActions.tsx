import { useState } from 'react';
import { supplierAction, type SupplierAction, type SupplierDetail } from '../../api/suppliers';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { problemOf, useSubmit } from './supplierUi';

interface Choice {
  action: SupplierAction;
  label: string;
  question: (name: string) => string;
  said: string;
}
const CHOICES: Record<SupplierAction, Choice> = {
  'switch-off': { action: 'switch-off', label: 'Switch off', question: (n) => `Switch off ${n}? It is marked as not available until you switch it on again.`, said: 'Supplier switched off.' },
  'switch-on': { action: 'switch-on', label: 'Switch on', question: (n) => `Switch ${n} back on?`, said: 'Supplier switched on.' },
  deactivate: { action: 'deactivate', label: 'Deactivate', question: (n) => `Deactivate ${n}? It becomes inactive. An Administrator can reactivate it.`, said: 'Supplier deactivated.' },
  reactivate: { action: 'reactivate', label: 'Reactivate', question: (n) => `Reactivate ${n}?`, said: 'Supplier reactivated.' },
};

/** Which of the four Administrator actions make sense for a supplier in this status. */
const OFFERED: Record<SupplierDetail['status'], SupplierAction[]> = {
  available: ['switch-off', 'deactivate'],
  unavailable_range: ['switch-off', 'deactivate'],
  off: ['switch-on', 'deactivate'],
  inactive: ['reactivate'],
};

/**
 * Deactivate, Reactivate, Switch off, Switch on. The page draws this only for an Administrator; the server checks the role again on every
 * call, and a refusal (403) is shown as it was sent. Each action asks first, in a dialog that returns focus to the button.
 */
export function AdminActions({ supplier, onDone, onFail }: {
  supplier: SupplierDetail;
  onDone: (supplier: SupplierDetail, message: string) => void;
  onFail: (message: string) => void;
}) {
  const [asking, setAsking] = useState<Choice | null>(null);
  const { busy, run } = useSubmit();

  const confirm = () => {
    if (!asking) return;
    const choice = asking;
    void run(async () => {
      try {
        const response = await supplierAction(supplier.id, choice.action);
        setAsking(null);
        onDone(response.data.supplier, choice.said);
      } catch (error) {
        setAsking(null);
        onFail(problemOf(error, []).message ?? 'The change was not made.');
      }
    });
  };

  return (
    <>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Administrator actions" data-testid="admin-actions">
        {OFFERED[supplier.status].map((a) => (
          <button key={a} type="button" disabled={busy} onClick={() => setAsking(CHOICES[a])} className="btn btn-secondary disabled:opacity-60" data-testid={`supplier-${a}`}>
            {CHOICES[a].label}
          </button>
        ))}
      </div>
      {asking && (
        <ConfirmDialog title={asking.label} yes={asking.label} no="Cancel" busy={busy} onYes={confirm} onNo={() => setAsking(null)} testId="admin-confirm">
          <p>{asking.question(supplier.name)}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
