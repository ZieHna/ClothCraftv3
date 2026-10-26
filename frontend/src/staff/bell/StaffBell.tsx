import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../api/client';
import { listNotifications, markAllNotificationsRead, markNotificationRead, type NotificationList, type StaffNotification } from '../../api/inventory';
import { formatWhen } from '../../lib/orderText';
import { useVisiblePolling } from '../../lib/useVisiblePolling';
import { useWorkspace, type Workspace } from '../workspace';
import { problemOf, useSubmit } from '../suppliers/supplierUi';

const EVERY_MS = 60_000;
const LIST_SIZE = 20;

/** Where a notification leads: its restock, else its supplier, in the workspace the bell is in (/staff or /admin). */
function target(n: StaffNotification, w: Workspace): string | null {
  if (n.restockId) return w.restock(n.restockId);
  if (n.supplierId) return w.supplier(n.supplierId);
  if (n.employeeId) return `/admin/employees/${n.employeeId}`; // only an Administrator is ever told about employees
  return null;
}

/**
 * The bell of both dashboards (phase 6 for /staff, phase 8 for /admin). It is drawn only inside /staff or /admin, once someone has signed in, so a
 * customer page never calls these routes. Under /admin the client sends the same three calls to /api/admin/notifications with the admin cookie;
 * the rows are the signed-in person's own, whichever door they came through.
 * It asks for the unread count about every minute, only while the tab is visible (useVisiblePolling), and again each time it is opened.
 * A 401 stops the polling at once: the shared staff sign-in handling (api/client.ts -> StaffAuth) has already ended the session and the
 * header removes the bell.
 */
export function StaffBell() {
  const w = useWorkspace();
  const [data, setData] = useState<NotificationList | null>(null);
  const [open, setOpen] = useState(false);
  const [ended, setEnded] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const { busy, run } = useSubmit();
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const seen = useRef<number | null>(null);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const response = await listNotifications({ pageSize: LIST_SIZE });
      setData(response.data);
      // said aloud only when the number CHANGES after the first answer, not on every poll
      const count = response.data.unreadCount;
      if (seen.current !== null && seen.current !== count) setAnnounce(count === 0 ? 'No unread notifications.' : `${count} unread ${count === 1 ? 'notification' : 'notifications'}.`);
      seen.current = count;
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setEnded(true);
      return false;
    }
  }, []);

  useVisiblePolling(refresh, { every: EVERY_MS, enabled: !ended });
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    void refresh(); // refresh on open
    const outside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, refresh]);

  if (ended) return null;
  const unread = data?.unreadCount ?? 0;
  const shown = unread > 99 ? '99+' : String(unread);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const markOne = (n: StaffNotification) =>
    void run(async () => {
      try {
        const response = await markNotificationRead(n.id);
        setAlert(null);
        seen.current = response.data.unreadCount;
        setData((d) => (d ? { ...d, unreadCount: response.data.unreadCount, notifications: d.notifications.map((x) => (x.id === n.id ? response.data.notification : x)) } : d));
      } catch (error) {
        setAlert(problemOf(error, []).message ?? 'Could not mark it read.');
      }
    });
  const markAll = () =>
    void run(async () => {
      try {
        const response = await markAllNotificationsRead();
        setAlert(null);
        seen.current = response.data.unreadCount;
        setData((d) => (d ? { ...d, unreadCount: response.data.unreadCount, notifications: d.notifications.map((x) => ({ ...x, read: true })) } : d));
      } catch (error) {
        setAlert(problemOf(error, []).message ?? 'Could not mark them read.');
      }
    });

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={data === null ? 'Notifications' : `Notifications, ${unread === 0 ? 'none' : unread > 99 ? 'more than 99' : unread} unread`}
        className="btn btn-secondary btn-small relative"
        data-testid="bell"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
        {unread > 0 && (
          <span aria-hidden="true" className="inline-flex min-w-5 items-center justify-center rounded-sm bg-ink px-1 text-xs font-semibold text-cream" data-testid="bell-count">
            {shown}
          </span>
        )}
      </button>
      <p role="status" className="sr-only">
        {announce}
      </p>
      {open && (
        <div id={panelId} role="region" aria-label="Notifications" className="fixed inset-x-2 z-40 mt-2 max-h-[70vh] overflow-y-auto border border-brown bg-cream p-3 shadow-menu sm:absolute sm:inset-x-auto sm:right-0 sm:w-96" data-testid="bell-panel">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xl">Notifications</h2>
            <button type="button" className="btn btn-secondary btn-small disabled:opacity-60" disabled={busy || unread === 0} onClick={markAll} data-testid="bell-read-all">
              {busy ? 'Working…' : 'Mark all read'}
            </button>
          </div>
          {alert && (
            <p role="alert" className="mt-2 font-medium text-brown-dark">
              {alert}
            </p>
          )}
          {data === null || data.notifications.length === 0 ? (
            <p className="mt-3 text-muted" data-testid="bell-empty">
              {data === null ? 'Loading…' : 'No notifications.'}
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-tan" data-testid="bell-list">
              {data.notifications.map((n) => {
                const to = target(n, w);
                return (
                  <li key={n.id} className="py-3" data-read={n.read}>
                    <p className="break-words font-semibold text-ink">
                      {!n.read && <span className="mr-1.5 inline-block size-2 rounded-full bg-ink align-middle" aria-hidden="true" />}
                      {n.title}
                      {!n.read && <span className="sr-only"> (unread)</span>}
                    </p>
                    <p className="break-words text-sm">{n.body}</p>
                    <p className="text-xs text-muted">{formatWhen(n.createdAt)}</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {to && (
                        <Link to={to} onClick={() => setOpen(false)} className="btn btn-secondary btn-small">
                          Open
                        </Link>
                      )}
                      {!n.read && (
                        <button type="button" className="btn btn-secondary btn-small disabled:opacity-60" disabled={busy} onClick={() => markOne(n)}>
                          Mark read
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
