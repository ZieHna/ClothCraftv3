import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { getRunRequest, startRunNow, type DssRequestState } from '../../api/adminDss';

/**
 * Run now (B8 S5a). POST /admin/dss/run-now only QUEUES a request (202 + requestId); Odoo's cron makes the run a moment later, so the page polls
 * GET /admin/dss/run-now/{requestId}. Polite on purpose: the first poll comes 2 s after the 202, then 3 s, 5 s, then every 10 s (never faster),
 * nothing is asked while the tab is hidden (coming back waits one full step again), polling stops at once on done / failed / unknown, on unmount
 * and after 10 minutes. A 409 run_in_progress is not an error: someone (or the weekly job) already has a run going, and the page follows that one.
 */
export const POLL_STEPS_MS = [2000, 3000, 5000, 10000] as const;
export const GIVE_UP_MS = 10 * 60 * 1000;

export type RunNowPhase = 'idle' | 'starting' | 'queued' | 'running' | 'done' | 'failed' | 'unknown' | 'conflict' | 'timeout' | 'error';
export interface RunNowState {
  phase: RunNowPhase;
  requestId: string | null;
  runId: string | null;
  /** the server's sentence (a failed run's message, the 409 text) or ours (timeout, unknown) */
  message: string | null;
}
export const IDLE: RunNowState = { phase: 'idle', requestId: null, runId: null, message: null };
export const isBusy = (phase: RunNowPhase): boolean => phase === 'starting' || phase === 'queued' || phase === 'running';

export const TIMEOUT_TEXT = 'Still running. It will appear here when it has finished.';
export const UNKNOWN_TEXT = 'This request is no longer known. Reload the page to see the latest run.';

/** The two server calls, so a test can pass fakes. */
export interface RunNowApi {
  start(signal: AbortSignal): Promise<{ requestId: string }>;
  poll(requestId: string, signal: AbortSignal): Promise<{ state: DssRequestState; runId: string | null; detail: string | null }>;
}
const REAL: RunNowApi = {
  start: async (signal) => (await startRunNow(signal)).data,
  poll: async (requestId, signal) => (await getRunRequest(requestId, signal)).data,
};

export interface RunNowOptions {
  /** a request ended: done / failed / unknown (the page then reloads what it shows) */
  onFinished?: (state: 'done' | 'failed' | 'unknown', runId: string | null) => void;
  /** a 409: another request is already queued or running (the page then asks the overview which one) */
  onConflict?: () => void;
  api?: RunNowApi;
}

/** The timing logic, apart from React so it can be tested on its own. `dispose` stops everything. */
export function createRunNow(set: (state: RunNowState) => void, options: () => RunNowOptions) {
  const controller = new AbortController();
  const api = () => options().api ?? REAL;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let step = 0;
  let startedAt = 0;
  let id: string | null = null; // the request being followed
  let starting = false;
  let disposed = false;

  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    cancelTimer();
    if (disposed || id === null || document.hidden) return; // hidden: nothing is asked; becoming visible schedules again
    timer = setTimeout(() => void poll(), POLL_STEPS_MS[Math.min(step, POLL_STEPS_MS.length - 1)]);
  };
  const finish = (state: RunNowState) => {
    id = null;
    cancelTimer();
    set(state);
  };

  async function poll() {
    timer = undefined;
    const requestId = id;
    if (requestId === null || disposed) return;
    try {
      const body = await api().poll(requestId, controller.signal);
      if (disposed || id !== requestId) return;
      step += 1;
      if (body.state === 'queued' || body.state === 'running') {
        if (Date.now() - startedAt >= GIVE_UP_MS) {
          finish({ phase: 'timeout', requestId, runId: body.runId, message: TIMEOUT_TEXT });
          return;
        }
        set({ phase: body.state, requestId, runId: body.runId, message: null });
        schedule();
        return;
      }
      finish({ phase: body.state, requestId, runId: body.runId, message: body.state === 'failed' ? (body.detail ?? 'The run failed.') : body.state === 'unknown' ? UNKNOWN_TEXT : null });
      options().onFinished?.(body.state, body.runId);
    } catch (error) {
      if (disposed || controller.signal.aborted) return;
      finish({ phase: 'error', requestId, runId: null, message: error instanceof ApiError ? error.message : 'Could not check on the run.' });
    }
  }

  const begin = (requestId: string, phase: 'queued' | 'running') => {
    id = requestId;
    step = 0;
    startedAt = Date.now();
    set({ phase, requestId, runId: null, message: null });
    schedule();
  };

  return {
    /** Press Run now. Ignored while a request is being started or followed. */
    async start() {
      if (starting || id !== null || disposed) return;
      starting = true;
      set({ phase: 'starting', requestId: null, runId: null, message: null });
      try {
        const { requestId } = await api().start(controller.signal);
        if (!disposed) begin(requestId, 'queued');
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 409 && error.code === 'run_in_progress') {
          set({ phase: 'conflict', requestId: null, runId: null, message: error.message });
          options().onConflict?.();
        } else {
          set({ phase: 'error', requestId: null, runId: null, message: error instanceof ApiError ? error.message : 'Could not ask for a run.' });
        }
      } finally {
        starting = false;
      }
    },
    /** Follow a request that is already queued or running (the overview's `queue`, or the one a 409 pointed at). */
    follow(requestId: string, phase: 'queued' | 'running' = 'queued') {
      if (disposed || id !== null || starting) return;
      begin(requestId, phase);
    },
    /** The tab was hidden or shown. Hidden: stop asking. Shown: ask again after one full step, not at once. */
    visibility() {
      if (document.hidden) cancelTimer();
      else if (id !== null && timer === undefined) schedule();
    },
    dispose() {
      disposed = true;
      cancelTimer();
      controller.abort();
    },
  };
}

export function useRunNow(options: RunNowOptions = {}) {
  const [state, setState] = useState<RunNowState>(IDLE);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const engine = useRef<ReturnType<typeof createRunNow> | null>(null);
  useEffect(() => {
    const created = createRunNow(setState, () => latest.current);
    engine.current = created;
    const onVisibility = () => created.visibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      created.dispose();
      engine.current = null;
    };
  }, []);
  const start = useCallback(() => void engine.current?.start(), []);
  const follow = useCallback((requestId: string, phase: 'queued' | 'running' = 'queued') => engine.current?.follow(requestId, phase), []);
  return { state, busy: isBusy(state.phase), start, follow };
}
