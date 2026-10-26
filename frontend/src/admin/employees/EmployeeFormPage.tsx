import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ROLE_LABEL, createEmployee, getEmployee, updateEmployee, type Employee, type EmployeeRole } from '../../api/adminEmployees';
import { ApiError } from '../../api/client';
import { StaffDetailSkeleton } from '../../components/skeleton/routeSkeletons';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { control, Field, FormAlert, NO_PROBLEM, problemOf, useFocusFirstError, useSubmit, type Problem } from '../../staff/suppliers/supplierUi';

const FIELDS = ['name', 'email', 'role', 'password', 'jobTitle', 'phone'] as const;

interface Values {
  name: string;
  email: string;
  role: EmployeeRole;
  jobTitle: string;
  phone: string;
}
type Load = { phase: 'loading' } | { phase: 'ready'; employee: Employee } | { phase: 'error'; status: number; message: string };

/** Add an employee (/admin/employees/new) or edit one (/admin/employees/:id/edit): name, email, job title and phone; a new person also gets a role and a temporary password. */
export function EmployeeFormPage() {
  const { id } = useParams();
  const editing = id !== undefined;
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const gate = useSkeletonGate(editing && load.phase === 'loading', { immediate: load.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    getEmployee(id, controller.signal)
      .then((response) => setLoad({ phase: 'ready', employee: response.data.employee }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', status: error instanceof ApiError ? error.status : 0, message: error instanceof ApiError ? error.message : 'Could not load the employee.' });
      });
    return () => controller.abort();
  }, [id, attempt]);

  if (!editing) return <EmployeeForm initial={{ name: '', email: '', role: 'inventory', jobTitle: '', phone: '' }} />;
  if (load.phase === 'loading' || gate !== 'content') return <StaffDetailSkeleton gate={gate === 'content' ? 'skeleton' : gate} label="Loading the employee…" />;
  if (load.phase === 'error') {
    return (
      <section className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-4xl sm:text-5xl">{load.status === 404 ? 'No such employee' : 'Could not load the employee'}</h1>
        <p role="alert" className="mt-3 font-medium text-brown-dark">
          {load.message}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {load.status !== 404 && (
            <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
          <Link to="/admin/employees" className="btn btn-secondary">
            All employees
          </Link>
        </div>
      </section>
    );
  }
  const e = load.employee;
  return <EmployeeForm employee={e} initial={{ name: e.name, email: e.email, role: e.role, jobTitle: e.jobTitle ?? '', phone: e.phone ?? '' }} />;
}

function EmployeeForm({ initial, employee }: { initial: Values; employee?: Employee }) {
  const navigate = useNavigate();
  const [values, setValues] = useState<Values>(initial);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<Problem>(NO_PROBLEM);
  const [stamp, setStamp] = useState(0);
  const { busy, run } = useSubmit();
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, stamp);
  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues((v) => ({ ...v, [key]: value }));
  const err = (name: string) => problem.fields[name];
  const adding = employee === undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setProblem(NO_PROBLEM);
      try {
        if (adding) {
          const response = await createEmployee({
            name: values.name.trim(), email: values.email.trim(), role: values.role, password,
            ...(values.jobTitle.trim() ? { jobTitle: values.jobTitle.trim() } : {}), ...(values.phone.trim() ? { phone: values.phone.trim() } : {}),
          });
          navigate(`/admin/employees/${response.data.employee.id}`, { state: { notice: `${response.data.employee.name} was added as ${ROLE_LABEL[response.data.employee.role]}.` } });
        } else {
          const response = await updateEmployee(employee.id, {
            name: values.name.trim(), jobTitle: values.jobTitle.trim(), phone: values.phone.trim(), ...(employee.isSelf ? {} : { email: values.email.trim() }),
          });
          navigate(`/admin/employees/${response.data.employee.id}`, { state: { notice: 'The details were saved.' } });
        }
      } catch (error) {
        setProblem(problemOf(error, FIELDS));
        setStamp((n) => n + 1);
      } finally {
        setPassword(''); // the typed password never stays in the page, whatever happened
      }
    });
  };

  return (
    <section className="mx-auto max-w-3xl px-4 py-8 sm:py-10" data-testid="employee-form">
      <p>
        <Link to={adding ? '/admin/employees' : `/admin/employees/${employee.id}`} className="text-sm underline underline-offset-4">
          ← {adding ? 'All employees' : employee.name}
        </Link>
      </p>
      <h1 className="mt-2 text-4xl sm:text-5xl">{adding ? 'Add an employee' : 'Edit employee'}</h1>
      <form ref={form} onSubmit={submit} noValidate className="mt-6 space-y-4">
        <Field label="Name" error={err('name')}>
          {(p) => <input {...p} value={values.name} onChange={(e) => set('name', e.target.value)} maxLength={80} autoComplete="off" className={control} />}
        </Field>
        <Field
          label="Email (the sign-in name)"
          hint={employee?.isSelf ? 'You cannot change your own email here.' : undefined}
          error={err('email')}
        >
          {(p) => <input {...p} type="email" value={values.email} onChange={(e) => set('email', e.target.value)} maxLength={254} autoComplete="off" disabled={employee?.isSelf} className={control} />}
        </Field>
        {adding && (
          <>
            <Field label="Role" hint="An Administrator can also do everything Inventory Staff can." error={err('role')}>
              {(p) => (
                <select {...p} value={values.role} onChange={(e) => set('role', e.target.value as EmployeeRole)} className={control}>
                  <option value="inventory">{ROLE_LABEL.inventory}</option>
                  <option value="admin">{ROLE_LABEL.admin}</option>
                </select>
              )}
            </Field>
            <Field label="Temporary password" hint="At least 12 characters. Not a common password, and it cannot contain their name or email. Give it to them privately; it is not shown again." error={err('password')}>
              {(p) => <input {...p} type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={128} autoComplete="new-password" className={control} data-testid="employee-password" />}
            </Field>
          </>
        )}
        <Field label="Job title" optional error={err('jobTitle')}>
          {(p) => <input {...p} value={values.jobTitle} onChange={(e) => set('jobTitle', e.target.value)} maxLength={80} className={control} />}
        </Field>
        <Field label="Phone" optional error={err('phone')}>
          {(p) => <input {...p} type="tel" value={values.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} className={control} />}
        </Field>
        <FormAlert message={problem.message} />
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} className="btn btn-primary disabled:cursor-wait disabled:opacity-70" data-testid="employee-save">
            {busy ? 'Saving…' : adding ? 'Add employee' : 'Save'}
          </button>
          <Link to={adding ? '/admin/employees' : `/admin/employees/${employee.id}`} className="btn btn-secondary" aria-disabled={busy || undefined}>
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}
