import type { RestockState } from '../../api/inventory';

export const RESTOCK_STATE_LABEL: Record<RestockState, string> = {
  requested: 'Requested',
  approved: 'Approved',
  rejected: 'Rejected',
  received: 'Received',
  not_received: 'Not received',
};
export const RESTOCK_STATE_FILTER: { id: '' | RestockState; label: string }[] = [
  { id: '', label: 'Any' },
  ...(Object.keys(RESTOCK_STATE_LABEL) as RestockState[]).map((id) => ({ id, label: RESTOCK_STATE_LABEL[id] })),
];

/** The badge's look. The words always say the state; the colour is only a second hint. */
export const restockClass = (state: RestockState): string =>
  state === 'received'
    ? 'border-sage-dark bg-sage-dark text-cream'
    : state === 'rejected' || state === 'not_received'
      ? 'border-muted bg-paper-warm text-muted'
      : state === 'requested'
        ? 'border-brown-dark bg-cream text-brown-dark'
        : 'border-ink bg-ink text-cream';

export const EVENT_LABEL: Record<string, string> = {
  created: 'Requested',
  edited: 'Edited',
  approved: 'Approved',
  rejected: 'Rejected',
  received: 'Received',
  not_received: 'Marked not received',
};

/** Today's date in Manila as YYYY-MM-DD, the lowest day the date fields offer (the server still decides). */
export function todayManila(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export const PAGE_SIZE = 25;
