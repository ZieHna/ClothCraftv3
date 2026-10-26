import { DEMO_STAFF } from '../mocks/staff';
import { ROLE_LABEL } from './staffText';

/** MOCK BUILDS ONLY (see StaffSignIn.tsx): the demo staff accounts, with a button that fills the form. They open nothing real. */
export default function DemoStaffHint({ onPick }: { onPick: (email: string, password: string) => void }) {
  return (
    <div className="mt-6 border-t border-dashed border-brown/70 pt-4" data-testid="staff-demo-hint">
      <p className="text-sm text-muted">Demo only: in this mock shop there are two pretend staff accounts. Pick one to fill in the form.</p>
      <ul className="mt-2 space-y-2">
        {DEMO_STAFF.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              <span className="font-medium text-ink">{ROLE_LABEL[s.role]}</span>
              <span className="block text-muted">{s.email}</span>
            </span>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => onPick(s.email, s.password)}>
              Use <span className="sr-only">{ROLE_LABEL[s.role]} account</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
