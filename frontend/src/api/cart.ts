import { apiGet, apiSend } from './client';
import type { CartLineInput, Quote, ServerCart } from './types';

/** The server prices the cart and says what can be supplied. The browser never works out a price or a stock level. */
export const quoteCart = (lines: CartLineInput[], signal?: AbortSignal) => apiSend<Quote>('POST', '/cart/quote', { lines }, {}, signal);

/** Step 12 (real shop only): the customer's saved cart, written whole. */
export interface CartWrite {
  /** the version this device last saw; another version is 409 cart_conflict with the cart as it is now (error.cart) */
  baseVersion: number;
  lines: { sku: string; quantity: number; selected: boolean; designId?: string }[];
}

export const getCart = (signal?: AbortSignal) => apiGet<ServerCart>('/cart', {}, signal);
export const putCart = (body: CartWrite, signal?: AbortSignal) => apiSend<ServerCart>('PUT', '/cart', body, {}, signal);

/** The page is being hidden or closed: the last edits are sent with keepalive, so the browser finishes the request after the page is gone.
 *  Nobody reads the answer; a conflict is merged the next time the cart is loaded (the edits are still kept on this device). */
export function putCartOnLeave(body: CartWrite): void {
  try {
    void fetch('/api/cart', { method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => undefined);
  } catch {
    /* the browser refused (a keepalive body over its limit): the edits stay on this device and are sent next time */
  }
}
