import { apiGet, apiSend } from './client';
import type { CheckoutOptions, Order, PlaceOrderRequest } from './types';

export const getCheckoutOptions = (signal?: AbortSignal) => apiGet<CheckoutOptions>('/checkout/options', {}, signal);

/** `idempotencyKey` is made once per attempt, so a double click or a retry cannot create two orders. */
export const placeOrder = (request: PlaceOrderRequest, idempotencyKey: string, signal?: AbortSignal) =>
  apiSend<Order>('POST', '/orders', request, { 'Idempotency-Key': idempotencyKey }, signal);

export const listOrders = (signal?: AbortSignal) => apiGet<Order[]>('/orders', {}, signal);
export const getOrder = (id: string, signal?: AbortSignal) => apiGet<Order>(`/orders/${encodeURIComponent(id)}`, {}, signal);
/** Step 11, real service only: the customer confirms they received their delivered order, which closes it (the same answer when pressed again). */
export const confirmReceived = (id: string, signal?: AbortSignal) => apiSend<Order>('POST', `/orders/${encodeURIComponent(id)}/received`, {}, {}, signal);
