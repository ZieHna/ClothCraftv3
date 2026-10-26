import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { ROLE_LABEL, getEmployee, type Employee, type EmployeeAuditEntry } from '../../api/adminEmployees';
import { ApiError } from '../../api/client';
import { StaffDetailSkeleton } from '../../components/skeleton/routeSkeletons';
import { formatWhen } from '../../lib/orderText';
import { STAFF_MIN_SKELETON_MS } from '../../lib/skeletonTiming';
import { useSkeletonGate } from '../../lib/useSkeletonGate';
import { EmployeeActions } from './EmployeeActions';
import { ACTION_LABEL, ActiveBadge, describeChange } from './employeeUi';

type Load = { phase: 'loading' } | { phase: 'ready'; employee: Employee; audit: EmployeeAuditEntry[] } | { phase: 'error'; status: number; message: string };

/** One employee: their details, the Administrator's actions, and the latest recorded changes (read-only). */
export function EmployeeDetailPage() {
  const { id = '' } = useParams();
  const arrived = (useLocation().state as { notice?: string } | null)?.notice ?? null;
  const [said, setSaid] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const gate = useSkeletonGate(load.phase === 'loading', { immediate: load.phase === 'error', minMs: STAFF_MIN_SKELETON_MS });

  useEffect(() => {
    const controller = new AbortController();
    setLoad((current) => (current.phase === 'ready' && attempt > 0 ? current : { phase: 'loading' }));
    getEmployee(id, controller.signal)
      .then((response) => setLoad({ phase: 'ready', employee: response.data.employee, audit: response.data.audit }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', status: error instanceof ApiError ? error.status : 0, message: error instanceof ApiError ? error.message : 'Could not load the employee.' });
      });
    return () => controller.abort();
  }, [id, attempt]);

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
  const notice = said ?? arrived;
  return (
    <section className="mx-auto max-w-5xl px-4 py-8 sm:py-10" data-testid="employee-detail">
      <p>
        <Link to="/admin/employees" className="text-sm underline underline-offset-4">
          ← All employees
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-4xl sm:text-5xl" data-testid="employee-name">
          {e.name}
        </h1>
        <ActiveBadge active={e.active} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link to={`/admin/employees/${e.id}/edit`} className="btn btn-primary" data-testid="employee-edit">
          Edit details
        </Link>
      </div>
      <div className="mt-4">
        <EmployeeActions
          employee={e}
          onDone={(next, message) => {
            setFailed(null);
            setSaid(message);
            setLoad({ phase: 'ready', employee: next, audit: load.audit });
            setAttempt((n) => n + 1); // read the person and the recorded changes again
          }}
          onFail={(message) => {
            setSaid(null);
            setFailed(message);
          }}
        />
      </div>
      {failed && (
        <p role="alert" className="mt-3 font-medium text-brown-dark" data-testid="employee-failed">
          {failed}
        </p>
      )}
      {notice && !failed && (
        <p role="status" className="mt-3 font-medium text-sage-dark" data-testid="employee-done">
          {notice}
        </p>
      )}

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <Card title="Details">
          <dl className="space-y-2">
            <Row label="Email (the sign-in name)">
              <span className="break-all">{e.email}</span>
            </Row>
            <Row label="Role">{ROLE_LABEL[e.role]}</Row>
            <Row label="Job title">{e.jobTitle ?? 'None'}</Row>
            <Row label="Phone">{e.phone ?? 'None'}</Row>
            <Row label="Last sign-in">{e.lastSignInAt ? formatWhen(e.lastSignInAt) : 'Never'}</Row>
          </dl>
          {e.twoStep && (
            <p className="mt-3 border border-brown-dark bg-paper px-3 py-2 text-sm font-medium text-brown-dark" data-testid="employee-two-step">
              Two-step verification is on for this account, so it cannot sign in to the dashboards.
            </p>
          )}
        </Card>

        <Card title="Recent changes">
          {load.audit.length === 0 ? (
            <p className="text-muted" data-testid="audit-empty">
              Nothing has been recorded for this account yet.
            </p>
          ) : (
            <ol className="divide-y divide-tan border-y border-tan" data-testid="employee-audit">
              {load.audit.map((a) => (
                <li key={a.id} className="py-3" data-testid="audit-entry">
                  <p className="font-semibold text-ink">{ACTION_LABEL[a.action]}</p>
                  <p className="text-sm text-muted">
                    {a.actorName}, {formatWhen(a.at)}
                  </p>
                  {describeChange(a).map((line) => (
                    <p key={line} className="break-words text-sm">
                      {line}
                    </p>
                  ))}
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border border-tan bg-cream p-4 sm:p-5">
      <h2 className="text-2xl">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
      <dt className="text-sm font-medium text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right">{children}</dd>
    </div>
  );
}
