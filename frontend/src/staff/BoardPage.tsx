import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useWorkspace } from './workspace';
import { ApiError } from '../api/client';
import { listStaffOrders, moveStaffOrder } from '../api/staff';
import type { Simulation, StaffOrderSummary, TrackedState } from '../api/types';
import { BoardColumnSkeleton } from '../components/skeleton/routeSkeletons';
import { SimulatedBadge } from '../components/SimulatedBadge';
import { formatMoney } from '../lib/format';
import { METHOD_LABEL } from '../lib/orderText';
import { STAFF_MIN_SKELETON_MS } from '../lib/skeletonTiming';
import { useSkeletonGate } from '../lib/useSkeletonGate';
import { useVisiblePolling } from '../lib/useVisiblePolling';
import { staffStateLabel, stateClass } from './staffText';

/**
 * Step 11: the board, the staff dashboard's default view in the real shop. One column per step an order can be moved through; closed and
 * cancelled orders are not on it (they are in the list view, the archive). Every card has a real "Move to next step" button, so the board
 * works with a keyboard and on a touch screen; dragging a card onto the next column (mouse) does the same move. The server decides: the
 * move carries the state the card showed, and a 409 is shown on the card in the shop's own words.
 */
const COLUMNS: { state: TrackedState; title: string }[] = [
  { state: 'awaiting_payment', title: 'Awaiting payment' },
  { state: 'confirmed', title: 'Received & preparing' },
  { state: 'shipped', title: 'Shipped' },
  { state: 'out_for_delivery', title: 'On delivery' },
  { state: 'delivered', title: 'Delivered' },
];
const NEXT: Partial<Record<TrackedState, TrackedState>> = { awaiting_payment: 'confirmed', confirmed: 'shipped', shipped: 'out_for_delivery', out_for_delivery: 'delivered' };
const titleOf = (state: TrackedState) => COLUMNS.find((c) => c.state === state)?.title ?? state;
export const BOARD_PAGE = 20;
const MAX_PAGE = 100;

type Column = { phase: 'loading' | 'ready' | 'error'; items: StaffOrderSummary[]; total: number; message: string; more: boolean };
type Problem = { text: string; now?: TrackedState };
const emptyColumn = (): Column => ({ phase: 'loading', items: [], total: 0, message: '', more: false });

/** A column's body: its skeleton while its first answer is awaited (shown after the delay, held for the staff minimum), then its cards. */
function ColumnGate({ column, children }: { column: Column; children: ReactNode }) {
  const gate = useSkeletonGate(column.phase === 'loading' && column.items.length === 0, {
    immediate: column.phase === 'error' || (column.phase === 'ready' && column.items.length === 0),
    minMs: STAFF_MIN_SKELETON_MS,
  });
  return gate === 'content' ? <>{children}</> : <BoardColumnSkeleton gate={gate} />;
}

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${Math.round(hours / 24)} days`;
}

function useWide() {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const on = () => setWide(list.matches);
    list.addEventListener('change', on);
    return () => list.removeEventListener('change', on);
  }, []);
  return wide;
}

export function BoardPage() {
  const w = useWorkspace();
  const [columns, setColumns] = useState<Record<string, Column>>(() => Object.fromEntries(COLUMNS.map((c) => [c.state, emptyColumn()])));
  const [archive, setArchive] = useState<{ closed: number; cancelled: number } | null>(null);
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const [problems, setProblems] = useState<Record<string, Problem>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [tab, setTab] = useState(1);
  const [dropTarget, setDropTarget] = useState<TrackedState | null>(null);
  const dragging = useRef<{ id: string; from: TrackedState; to: TrackedState } | null>(null);
  const moving = useRef(false);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const wide = useWide();
  const ids = useId();
  const canDrag = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;

  /** Ask one column again for as many cards as it shows now (at least a page), so a refresh never takes away cards loaded with "Load more". */
  const fetchColumn = useCallback(async (state: TrackedState, keep = true) => {
    const shown = keep ? columnsRef.current[state]?.items.length ?? 0 : 0;
    const size = Math.min(MAX_PAGE, Math.max(BOARD_PAGE, shown));
    const response = await listStaffOrders({ state, page: 1, pageSize: size });
    setSimulation(response.simulation);
    const next: Column = { phase: 'ready', items: response.data.orders, total: response.data.total, message: '', more: response.data.total > response.data.orders.length };
    setColumns((all) => (JSON.stringify(all[state]) === JSON.stringify(next) ? all : { ...all, [state]: next }));
  }, []);

  const fetchArchive = useCallback(async () => {
    const [closed, cancelled] = await Promise.all([listStaffOrders({ state: 'closed', pageSize: 1 }), listStaffOrders({ state: 'cancelled', pageSize: 1 })]);
    setArchive((was) => (was && was.closed === closed.data.total && was.cancelled === cancelled.data.total ? was : { closed: closed.data.total, cancelled: cancelled.data.total }));
  }, []);

  const refreshAll = useCallback(async () => {
    const results = await Promise.allSettled([...COLUMNS.map((c) => fetchColumn(c.state)), fetchArchive()]);
    results.forEach((r, i) => {
      const state = COLUMNS[i]?.state;
      if (r.status === 'rejected' && state && columnsRef.current[state]?.phase !== 'ready') {
        setColumns((all) => ({ ...all, [state]: { ...all[state]!, phase: 'error', message: r.reason instanceof ApiError ? r.reason.message : 'Could not load these orders.' } }));
      }
    });
    return results.every((r) => r.status === 'fulfilled');
  }, [fetchArchive, fetchColumn]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);
  // every 30 s while the board is on screen, never during a drag or while a move is on its way
  useVisiblePolling(refreshAll, { every: 30_000, enabled: true, paused: () => !!dragging.current || moving.current });

  const loadMore = async (state: TrackedState) => {
    const column = columnsRef.current[state]!;
    const page = Math.floor(column.items.length / BOARD_PAGE) + 1;
    try {
      const response = await listStaffOrders({ state, page, pageSize: BOARD_PAGE });
      setColumns((all) => {
        const now = all[state]!;
        const seen = new Set(now.items.map((o) => o.id));
        const items = [...now.items, ...response.data.orders.filter((o) => !seen.has(o.id))];
        return { ...all, [state]: { ...now, items, total: response.data.total, more: response.data.total > items.length } };
      });
    } catch (error) {
      setColumns((all) => ({ ...all, [state]: { ...all[state]!, message: error instanceof ApiError ? error.message : 'Could not load more orders.' } }));
    }
  };

  const move = async (order: StaffOrderSummary, to: TrackedState, returnFocus: boolean) => {
    if (moving.current) return;
    moving.current = true;
    setBusy(order.id);
    setProblems(({ [order.id]: _gone, ...rest }) => rest);
    const from = order.state;
    try {
      await moveStaffOrder(order.id, { to, expectedState: from });
      const column = columnsRef.current[from]!;
      const index = column.items.findIndex((o) => o.id === order.id);
      setColumns((all) => ({ ...all, [from]: { ...all[from]!, items: all[from]!.items.filter((o) => o.id !== order.id), total: Math.max(0, all[from]!.total - 1) } }));
      setSaid(`${order.reference} moved to ${titleOf(to)}.`);
      if (returnFocus) {
        // the card has gone: focus the next card's button in the same column, else the column's heading
        requestAnimationFrame(() => {
          const rest = column.items.filter((o) => o.id !== order.id);
          const next = rest[Math.min(index, rest.length - 1)];
          (document.querySelector<HTMLElement>(next ? `[data-move-for="${next.id}"]` : `#${CSS.escape(`${ids}-${from}`)}`) ?? null)?.focus();
        });
      }
      await Promise.allSettled([fetchColumn(to), fetchColumn(from)]);
    } catch (error) {
      if (error instanceof ApiError) {
        const now = error.details.currentState;
        setProblems((all) => ({ ...all, [order.id]: { text: error.message, now } }));
        setSaid(`${order.reference} was not moved. ${error.message}`);
      } else {
        setProblems((all) => ({ ...all, [order.id]: { text: 'Could not reach the shop. Nothing was changed. Try again.' } }));
      }
    } finally {
      moving.current = false;
      setBusy(null);
    }
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = COLUMNS.length - 1;
    const to = event.key === 'ArrowRight' ? Math.min(last, tab + 1) : event.key === 'ArrowLeft' ? Math.max(0, tab - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (to === null) return;
    event.preventDefault();
    setTab(to);
    document.getElementById(`${ids}-tab-${to}`)?.focus();
  };

  const startDrag = (event: DragEvent<HTMLElement>, order: StaffOrderSummary) => {
    const to = NEXT[order.state];
    if (!to) return;
    dragging.current = { id: order.id, from: order.state, to };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', order.id);
    setDropTarget(to);
  };
  const endDrag = () => {
    dragging.current = null;
    setDropTarget(null);
  };

  return (
    <section className="mx-auto max-w-7xl px-4 py-8 sm:py-10" data-testid="staff-board">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-4xl sm:text-5xl">Order board</h1>
          <SimulatedBadge simulation={simulation} />
        </div>
        <Link to={`${w.orders}?state=closed`} className="text-sm font-medium underline underline-offset-4" data-testid="board-archive">
          Archive: {archive ? `${archive.closed.toLocaleString('en-US')} closed, ${archive.cancelled.toLocaleString('en-US')} cancelled` : 'closed and cancelled orders'}
        </Link>
      </div>
      <p className="mt-2 text-sm text-muted">Move each order on one step at a time. Closed and cancelled orders are in the archive.</p>
      <p role="status" className="sr-only" data-testid="board-said">
        {said}
      </p>

      {!wide && (
        <div role="tablist" aria-label="Board columns" className="mt-4 flex flex-wrap gap-2" data-testid="board-tabs">
          {COLUMNS.map((c, i) => (
            <button
              key={c.state}
              id={`${ids}-tab-${i}`}
              type="button"
              role="tab"
              aria-selected={tab === i}
              aria-controls={`${ids}-panel-${i}`}
              tabIndex={tab === i ? 0 : -1}
              onClick={() => setTab(i)}
              onKeyDown={onTabKey}
              className={`min-h-11 border px-3 py-1.5 text-sm font-medium ${tab === i ? 'border-ink bg-ink text-cream' : 'border-brown-dark bg-cream text-ink'}`}
            >
              {c.title} <span className="font-normal">({columns[c.state]?.total ?? 0})</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-5" data-testid="board-columns">
        {COLUMNS.map((c, i) => {
          const column = columns[c.state]!;
          const allowed = dropTarget === c.state;
          return (
            <section
              key={c.state}
              id={`${ids}-panel-${i}`}
              role={wide ? 'region' : 'tabpanel'}
              aria-labelledby={wide ? `${ids}-${c.state}` : `${ids}-tab-${i}`}
              hidden={!wide && tab !== i}
              data-testid="board-column"
              data-state={c.state}
              onDragOver={(e) => {
                if (dragging.current?.to === c.state) e.preventDefault();
              }}
              onDrop={(e) => {
                const d = dragging.current;
                endDrag();
                if (!d || d.to !== c.state) return;
                e.preventDefault();
                const order = columnsRef.current[d.from]?.items.find((o) => o.id === d.id);
                if (order) void move(order, d.to, false);
              }}
              className={`min-w-0 border bg-cream p-3 ${allowed ? 'border-2 border-dashed border-sage-dark' : 'border-tan'}`}
            >
              <h2 id={`${ids}-${c.state}`} tabIndex={-1} className="flex items-baseline justify-between gap-2 text-xl font-semibold text-ink outline-none">
                <span>{c.title}</span>
                <span className="font-sans text-sm font-normal text-muted" data-testid="column-total">{column.total}</span>
              </h2>
              {allowed && <p className="mt-1 text-xs font-medium text-sage-dark">Drop here to move it on</p>}
              <ColumnGate column={column}>
              {column.phase === 'error' && (
                <p role="alert" className="mt-3 text-sm font-medium text-brown-dark">
                  {column.message}
                </p>
              )}
              {column.phase === 'ready' && column.items.length === 0 && <p className="mt-3 text-sm text-muted">No orders here.</p>}
              <ul className="mt-3 space-y-3" aria-label={`Orders: ${c.title}`}>
                {column.items.map((o) => {
                  const to = NEXT[o.state];
                  const problem = problems[o.id];
                  return (
                    <li
                      key={o.id}
                      draggable={canDrag && !!to && !busy}
                      onDragStart={(e) => startDrag(e, o)}
                      onDragEnd={endDrag}
                      className="border border-brown-dark bg-paper p-3"
                      data-testid="board-card"
                      data-order={o.id}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <Link to={w.order(o.id)} state={{ from: w.board }} className="font-sans font-semibold text-ink underline underline-offset-4">
                          {o.reference}
                        </Link>
                        <span className="text-sm font-semibold text-ink">{formatMoney(o.total, 'PHP')}</span>
                      </div>
                      <p className="mt-1 truncate text-sm" title={o.customer.name}>
                        {o.customer.name}
                      </p>
                      <p className="text-xs text-muted">
                        {o.itemCount} {o.itemCount === 1 ? 'item' : 'items'} · {METHOD_LABEL[o.paymentMethod]}
                        {o.paid ? ' · paid' : ''}
                      </p>
                      <p className="text-xs text-muted">In this step for {ago(o.statusChangedAt)}</p>
                      {o.hasDesign && (
                        <p className="mt-1 inline-block rounded-sm border border-sage-dark px-1.5 text-xs font-semibold text-sage-dark" data-testid="card-design">
                          Customized
                        </p>
                      )}
                      {problem && (
                        <div role="alert" className="mt-2 border-2 border-brown-dark bg-cream p-2 text-sm font-medium text-brown-dark" data-testid="card-problem">
                          <p>{problem.text}</p>
                          {problem.now && (
                            <p className="mt-1">
                              Now:{' '}
                              <span className={`inline-block rounded-sm border px-1.5 text-xs font-semibold uppercase ${stateClass(problem.now)}`}>{staffStateLabel(problem.now, o.paymentMethod)}</span>
                            </p>
                          )}
                        </div>
                      )}
                      {to ? (
                        <button
                          type="button"
                          data-move-for={o.id}
                          aria-label={`Move ${o.reference} to next step: ${titleOf(to)}`}
                          aria-disabled={busy !== null || undefined}
                          onClick={() => busy === null && void move(o, to, true)}
                          className="btn btn-primary btn-small mt-3 w-full flex-col aria-disabled:cursor-wait aria-disabled:opacity-60"
                          data-testid="card-move"
                        >
                          {busy === o.id ? 'Moving…' : 'Move to next step'}
                          <span aria-hidden="true" className="block text-xs font-normal">
                            to {titleOf(to)}
                          </span>
                        </button>
                      ) : (
                        <p className="mt-2 text-xs text-muted">Waiting for the customer to confirm they received it.</p>
                      )}
                    </li>
                  );
                })}
              </ul>
              </ColumnGate>
              {column.more && (
                <button type="button" onClick={() => void loadMore(c.state)} className="btn btn-secondary btn-small mt-3 w-full" data-testid="column-more">
                  Load more ({column.total - column.items.length} more)
                </button>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
