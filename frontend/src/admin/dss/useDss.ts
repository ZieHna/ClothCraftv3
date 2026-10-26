import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';

export type DssLoad<T> = { phase: 'loading' } | { phase: 'ready'; data: T } | { phase: 'error'; message: string; code: string };

/**
 * One DSS read, the way the other admin pages do it: an AbortController per request (leaving the page cancels it), the error's own sentence, and
 * `reload()` to ask again. While a reload runs the previous answer stays in `data` (the page dims it) instead of going back to a skeleton.
 */
export function useDss<T>(fetcher: (signal: AbortSignal) => Promise<T>, fallbackMessage: string) {
  const latest = useRef(fetcher);
  useEffect(() => {
    latest.current = fetcher;
  });
  const [state, setState] = useState<DssLoad<T>>({ phase: 'loading' });
  const [last, setLast] = useState<T | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: 'loading' });
    latest.current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ phase: 'ready', data });
        setLast(data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ phase: 'error', message: error instanceof ApiError ? error.message : fallbackMessage, code: error instanceof ApiError ? error.code : 'unknown' });
      });
    return () => controller.abort();
  }, [attempt, fallbackMessage]);
  const data = state.phase === 'ready' ? state.data : state.phase === 'loading' ? last : null;
  return { state, data, hadData: last !== null, reload: () => setAttempt((n) => n + 1) };
}
