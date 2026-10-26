import type { AuditValues, EmployeeAuditEntry } from '../../api/adminEmployees';
import { ROLE_LABEL } from '../../api/adminEmployees';

/** The state in words (the colour is only a second hint). */
export function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-block rounded-sm border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${active ? 'border-sage-dark bg-sage-dark text-cream' : 'border-muted bg-paper-warm text-muted'}`}
      data-testid="employee-status"
    >
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

export const ACTION_LABEL: Record<EmployeeAuditEntry['action'], string> = {
  created: 'Added',
  edited: 'Edited',
  role_changed: 'Role changed',
  password_reset: 'Password reset',
  deactivated: 'Deactivated',
  reactivated: 'Reactivated',
};

const FIELD_LABEL: Record<keyof AuditValues, string> = { name: 'Name', email: 'Email', jobTitle: 'Job title', phone: 'Phone', role: 'Role', active: 'Status' };

/** One recorded value as words. Only the non-secret fields the server records can be here; a password never is. */
function shown(key: keyof AuditValues, value: AuditValues[keyof AuditValues]): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (key === 'role') return ROLE_LABEL[value as keyof typeof ROLE_LABEL] ?? String(value);
  if (key === 'active') return value ? 'Active' : 'Inactive';
  return String(value);
}

/** "Role: Inventory Staff → Administrator", one phrase per changed field. A password reset has no values and says so in words. */
export function describeChange(entry: EmployeeAuditEntry): string[] {
  if (entry.action === 'password_reset') return ['A new temporary password was set.'];
  const before = entry.old ?? {};
  const after = entry.new ?? {};
  const keys = (Object.keys(after) as (keyof AuditValues)[]).filter((k) => k in FIELD_LABEL);
  if (entry.action === 'created') return keys.map((k) => `${FIELD_LABEL[k]}: ${shown(k, after[k])}`);
  return keys.map((k) => `${FIELD_LABEL[k]}: ${shown(k, before[k])} → ${shown(k, after[k])}`);
}
