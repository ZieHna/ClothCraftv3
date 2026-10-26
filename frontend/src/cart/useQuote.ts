import { useCallback, useEffect, useRef, useState } from 'react';
import { quoteCart } from '../api/cart';
import { ApiError } from '../api/client';
import type { Quote, Simulation } from '../api/types';
import type { CartLine } from './cartStore';

type State =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; quote: Quote; simulation: Simulation | null; key: string }
  | { phase: 'error'; message: string };

const keyOf = (lines: readonly CartLine[]) => JSON.stringify(lines.map((l) => [l.sku, l.quantity, l.designId ?? null]));

/** What is sent to be priced: never a price. A designed line names its design (step 9), a plain one is sent exactly as before. */
export const toQuoteLines = (lines: readonly CartLine[]) => lines.map((l) => (l.designId ? { sku: l.sku, quantity: l.quantity, designId: l.designId } : { sku: l.sku, quantity: l.quantity }));

/**
 * The cart priced by the server. While a newer cart is being priced the last quote stays on screen (`fresh` is false then, so
 * a page can say "updating" instead of showing a total that no longer matches the quantities). With no lines, or `enabled` false (the
 * cart reuses its other quote), nothing is asked and the state is `idle`.
 */
export function useQuote(lines: readonly CartLine[], enabled = true) {
  const key = keyOf(lines);
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const first = useRef(true);

  useEffect(() => {
    if (!enabled || lines.length === 0) return;
    const controller = new AbortController();
    // typing in a quantity field changes the cart on every key: wait a moment before asking again
    const wait = first.current ? 0 : 200;
    first.current = false;
    const timer = setTimeout(() => {
      quoteCart(toQuoteLines(lines), controller.signal)
        .then((response) => setState({ phase: 'ready', quote: response.data, simulation: response.simulation, key }))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setState({ phase: 'error', message: error instanceof ApiError ? error.message : 'Could not price your cart.' });
        });
    }, wait);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `lines` is represented by `key`
  }, [key, attempt, enabled]);

  const retry = useCallback(() => {
    setState({ phase: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  /** Take a newer quote the server sent along with an error (409 price_changed). */
  const adopt = useCallback((quote: Quote, simulation: Simulation | null) => setState({ phase: 'ready', quote, simulation, key }), [key]);

  if (!enabled || lines.length === 0) return { state: { phase: 'idle' } as State, fresh: false, retry, adopt };
  return { state, fresh: state.phase === 'ready' && state.key === key, retry, adopt };
}
