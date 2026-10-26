import { useRef, useState, type FormEvent } from 'react';
import {
  ROLE_LABEL, deactivateEmployee, reactivateEmployee, resetEmployeePassword, setEmployeeRole, type Employee, type EmployeeRole,
} from '../../api/adminEmployees';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { FormDialog } from '../../staff/FormDialog';
import { control, Field, FormAlert, NO_PROBLEM, problemOf, useFocusFirstError, useSubmit, type Problem } from '../../staff/suppliers/supplierUi';

type Ask = 'role' | 'password' | 'deactivate' | 'reactivate';
export type Done = (employee: Employee, message: string) => void;

/**
 * Change role, Reset password, Deactivate / Reactivate. Each asks first, in a dialog. Odoo enforces every rule (not yourself, never the last
 * Administrator, the password rule), so a refusal is shown as the server sent it; this page also hides the actions that would only be refused on
 * your own account. Nothing is sent twice while a request is in flight.
 */
export function EmployeeActions({ employee, onDone, onFail }: { employee: Employee; onDone: Done; onFail: (message: string) => void }) {
  const [asking, setAsking] = useState<Ask | null>(null);
  const { busy, run } = useSubmit();
  if (employee.isSelf) {
    return (
      <p className="text-muted" data-testid="employee-self-note">
        This is your own account. You can edit your name, job title and phone; your role, activation, email and password cannot be changed here.
      </p>
    );
  }
  const finish = (next: Employee, message: string) => {
    setAsking(null);
    onDone(next, message);
  };
  const toggle = (kind: 'deactivate' | 'reactivate') =>
    void run(async () => {
      try {
        const response = await (kind === 'deactivate' ? deactivateEmployee(employee.id) : reactivateEmployee(employee.id));
        finish(response.data.employee, kind === 'deactivate' ? `${employee.name} was deactivated and signed out.` : `${employee.name} was reactivated.`);
      } catch (error) {
        setAsking(null);
        onFail(problemOf(error, []).message ?? 'The change was not made.');
      }
    });

  return (
    <>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Employee actions" data-testid="employee-actions">
        {employee.active && (
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setAsking('role')} data-testid="employee-role">
              Change role
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setAsking('password')} data-testid="employee-reset">
              Reset password
            </button>
          </>
        )}
        <button type="button" className="btn btn-secondary" onClick={() => setAsking(employee.active ? 'deactivate' : 'reactivate')} data-testid={employee.active ? 'employee-deactivate' : 'employee-reactivate'}>
          {employee.active ? 'Deactivate' : 'Reactivate'}
        </button>
      </div>
      {asking === 'role' && <RoleDialog employee={employee} onClose={() => setAsking(null)} onDone={finish} />}
      {asking === 'password' && <PasswordDialog employee={employee} onClose={() => setAsking(null)} onDone={finish} />}
      {asking === 'deactivate' && (
        <ConfirmDialog title="Deactivate this account" yes="Deactivate" no="Cancel" busy={busy} onYes={() => toggle('deactivate')} onNo={() => setAsking(null)} testId="employee-confirm">
          <p>
            Deactivate {employee.name}? They are signed out at once and cannot sign in until you reactivate the account. Nothing they did is removed.
          </p>
        </ConfirmDialog>
      )}
      {asking === 'reactivate' && (
        <ConfirmDialog title="Reactivate this account" yes="Reactivate" no="Cancel" busy={busy} onYes={() => toggle('reactivate')} onNo={() => setAsking(null)} testId="employee-confirm">
          <p>Reactivate {employee.name}? They can sign in again with their current password.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function RoleDialog({ employee, onClose, onDone }: { employee: Employee; onClose: () => void; onDone: Done }) {
  const other: EmployeeRole = employee.role === 'admin' ? 'inventory' : 'admin';
  const [role, setRole] = useState<EmployeeRole>(other);
  const [problem, setProblem] = useState<Problem>(NO_PROBLEM);
  const [stamp, setStamp] = useState(0);
  const { busy, run } = useSubmit();
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, stamp);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setProblem(NO_PROBLEM);
      try {
        const response = await setEmployeeRole(employee.id, role);
        onDone(response.data.employee, `${employee.name} is now ${ROLE_LABEL[response.data.employee.role]}. They were signed out.`);
      } catch (error) {
        setProblem(problemOf(error, ['role']));
        setStamp((n) => n + 1);
      }
    });
  };
  return (
    <FormDialog title="Change role" busy={busy} onClose={onClose} testId="employee-role-dialog">
      <form ref={form} onSubmit={submit} noValidate className="space-y-4">
        <p>
          {employee.name} is {ROLE_LABEL[employee.role]}. Changing the role signs them out of every dashboard at once; they sign in again with the same password.
        </p>
        <Field label="New role" error={problem.fields.role}>
          {(p) => (
            <select {...p} value={role} onChange={(e) => setRole(e.target.value as EmployeeRole)} className={control}>
              <option value="inventory">{ROLE_LABEL.inventory}</option>
              <option value="admin">{ROLE_LABEL.admin}</option>
            </select>
          )}
        </Field>
        <FormAlert message={problem.message} />
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} className="btn btn-primary disabled:cursor-wait disabled:opacity-70" data-testid="employee-role-yes">
            {busy ? 'Working…' : `Make ${ROLE_LABEL[role]}`}
          </button>
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-secondary disabled:opacity-60">
            Cancel
          </button>
        </div>
      </form>
    </FormDialog>
  );
}

function PasswordDialog({ employee, onClose, onDone }: { employee: Employee; onClose: () => void; onDone: Done }) {
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<Problem>(NO_PROBLEM);
  const [stamp, setStamp] = useState(0);
  const { busy, run } = useSubmit();
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, stamp);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setProblem(NO_PROBLEM);
      try {
        const response = await resetEmployeePassword(employee.id, password);
        onDone(response.data.employee, `A new temporary password was set for ${employee.name}. They were signed out.`);
      } catch (error) {
        setProblem(problemOf(error, ['password']));
        setStamp((n) => n + 1);
      } finally {
        setPassword(''); // the typed password never stays in the page
      }
    });
  };
  return (
    <FormDialog title="Reset password" busy={busy} onClose={onClose} testId="employee-password-dialog">
      <form ref={form} onSubmit={submit} noValidate className="space-y-4">
        <p>
          Set a new temporary password for {employee.name}. The old one stops working and they are signed out at once. The new one is not shown again, so give it to them privately.
        </p>
        <Field label="New temporary password" hint="At least 12 characters. Not a common password, and it cannot contain their name or email." error={problem.fields.password}>
          {(p) => <input {...p} type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={128} autoComplete="new-password" className={control} data-testid="employee-new-password" />}
        </Field>
        <FormAlert message={problem.message} />
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} className="btn btn-primary disabled:cursor-wait disabled:opacity-70" data-testid="employee-password-yes">
            {busy ? 'Working…' : 'Reset password'}
          </button>
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-secondary disabled:opacity-60">
            Cancel
          </button>
        </div>
      </form>
    </FormDialog>
  );
}
