import type { RestockSummary } from '../../api/inventory';
import { RESTOCK_STATE_LABEL, restockClass } from './restockText';

const FLAG = 'inline-block rounded-sm border border-brown-dark bg-cream px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-brown-dark';

/** The state, and the two flags the server sets: "Received late" (received after the expected range) and "Overdue" (past it, not received). */
export function RestockBadges({ restock }: { restock: Pick<RestockSummary, 'state' | 'receivedLate' | 'overdue'> }) {
  return (
    <span className="flex flex-wrap justify-end gap-1.5 md:justify-start">
      <span className={`inline-block rounded-sm border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${restockClass(restock.state)}`} data-testid="restock-state">
        {RESTOCK_STATE_LABEL[restock.state]}
      </span>
      {restock.receivedLate && (
        <span className={FLAG} data-testid="restock-late">
          Received, late
        </span>
      )}
      {restock.overdue && (
        <span className={FLAG} data-testid="restock-overdue">
          Overdue
        </span>
      )}
    </span>
  );
}
