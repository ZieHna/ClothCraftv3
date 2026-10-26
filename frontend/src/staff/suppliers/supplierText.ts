import type { SupplierStatus } from '../../api/suppliers';

/** Words and display formats for the supplier screens. Nothing is calculated here: every amount shown is one the server sent. */
export const STATUS_LABEL: Record<SupplierStatus, string> = {
  available: 'Available',
  unavailable_range: 'Unavailable now',
  off: 'Switched off',
  inactive: 'Inactive',
};

/** The status filter: the value is what the service accepts. */
export const STATUS_FILTER: { id: '' | SupplierStatus; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'available', label: 'Available' },
  { id: 'unavailable_range', label: 'Unavailable (dates)' },
  { id: 'off', label: 'Switched off' },
  { id: 'inactive', label: 'Inactive' },
];

/** The badge's look. The words always say the status; the colour is only a second hint. */
export const statusClass = (status: SupplierStatus): string =>
  status === 'available'
    ? 'border-sage-dark bg-sage-dark text-cream'
    : status === 'unavailable_range'
      ? 'border-brown-dark bg-cream text-brown-dark'
      : status === 'off'
        ? 'border-ink bg-ink text-cream'
        : 'border-muted bg-paper-warm text-muted';

const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** An amount from the server, always with centavos (₱112.00). */
export const pesos = (amount: number): string => peso.format(amount);

const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
/** "2026-12-01" -> "1 Dec 2026". Read as a plain calendar day, so no time zone can move it. */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return y && m && d ? day.format(new Date(y, m - 1, d)) : iso;
}

/** The countries the form offers (a short fixed list: the service takes a two-letter code and has no country list of its own). */
export const COUNTRIES: { code: string; name: string }[] = [
  { code: 'PH', name: 'Philippines' }, { code: 'CN', name: 'China' }, { code: 'HK', name: 'Hong Kong' }, { code: 'ID', name: 'Indonesia' },
  { code: 'IN', name: 'India' }, { code: 'JP', name: 'Japan' }, { code: 'KR', name: 'South Korea' }, { code: 'MY', name: 'Malaysia' },
  { code: 'SG', name: 'Singapore' }, { code: 'TW', name: 'Taiwan' }, { code: 'TH', name: 'Thailand' }, { code: 'US', name: 'United States' },
  { code: 'VN', name: 'Vietnam' },
];
export const PAGE_SIZE = 25;
