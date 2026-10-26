import { API_MODE } from '../api/client';
import type { PaymentMethodId, StaffRole, TrackedState } from '../api/types';

/** How the staff screens name each status. A bank-transfer order that is confirmed has been paid, so it reads "Paid". */
const LABEL: Record<TrackedState, string> = {
  awaiting_payment: 'Awaiting payment', confirmed: 'Confirmed', packed: 'Packed', shipped: 'Shipped', out_for_delivery: 'On delivery',
  delivered: 'Delivered', closed: 'Closed', cancelled: 'Cancelled',
};
export const staffStateLabel = (state: TrackedState, method: PaymentMethodId): string => (state === 'confirmed' && method === 'bank_transfer' ? 'Paid' : LABEL[state]);
/** The filter tabs: "Confirmed" covers cash-on-delivery orders accepted and bank-transfer orders paid. The frozen mock keeps the step 7
 *  states; the real shop (step 11) has no packed step, and its list view is also where closed orders are found (the archive). */
export const STATE_TABS: { id: TrackedState | ''; label: string }[] =
  API_MODE === 'mock'
    ? [
        { id: '', label: 'All' }, { id: 'awaiting_payment', label: 'Awaiting payment' }, { id: 'confirmed', label: 'Confirmed or paid' }, { id: 'packed', label: 'Packed' },
        { id: 'shipped', label: 'Shipped' }, { id: 'delivered', label: 'Delivered' }, { id: 'cancelled', label: 'Cancelled' },
      ]
    : [
        { id: '', label: 'All' }, { id: 'awaiting_payment', label: 'Awaiting payment' }, { id: 'confirmed', label: 'Received or paid' },
        { id: 'shipped', label: 'Shipped' }, { id: 'out_for_delivery', label: 'On delivery' }, { id: 'delivered', label: 'Delivered' },
        { id: 'closed', label: 'Closed' }, { id: 'cancelled', label: 'Cancelled' },
      ];
export const ROLE_LABEL: Record<StaffRole, string> = { inventory: 'Inventory Staff', admin: 'Administrator' };
export const PAGE_SIZE = 25;

/** The badge's look. The words always say the status; the colour is only a second hint. */
export const stateClass = (state: TrackedState): string =>
  state === 'cancelled'
    ? 'border-muted bg-paper-warm text-muted'
    : state === 'delivered' || state === 'closed'
      ? 'border-sage-dark bg-sage-dark text-cream'
      : state === 'awaiting_payment'
        ? 'border-brown-dark bg-cream text-brown-dark'
        : 'border-ink bg-ink text-cream';
