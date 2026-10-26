import type { PaymentMethodId, TrackedState, TrackingStepId } from '../api/types';

/** The customer's short status label (orders list, status box). Step 11 adds "On delivery" and "Completed" (closed). */
export const STATE_LABEL: Record<TrackedState, string> = {
  awaiting_payment: 'Waiting for payment', confirmed: 'Confirmed', packed: 'Packed', shipped: 'Shipped', out_for_delivery: 'On delivery',
  delivered: 'Delivered', closed: 'Completed', cancelled: 'Cancelled',
};
/** The customer's four tracking steps (step 11). */
export const STEP_LABEL: Record<TrackingStepId, string> = {
  received: 'Order received and preparing', shipped: 'Shipped out', on_delivery: 'On delivery', delivered: 'Delivered',
};
export const METHOD_LABEL: Record<PaymentMethodId, string> = { cod: 'Cash on delivery', bank_transfer: 'Bank transfer' };

/** Display only: the server sends an ISO time, this is how it reads. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
