import { apiGet, apiSend, apiSignOut } from './client';
import type { StaffAuthResult, StaffOrder, StaffOrderList, StaffOrderQuery, StaffTransitionRequest } from './types';

/** The staff dashboard's calls (see the notes in types.ts). The session is the server's: a cookie the page cannot read. */
export const signInStaff = (request: { email: string; password: string }, signal?: AbortSignal) => apiSend<StaffAuthResult>('POST', '/staff/auth/login', request, {}, signal);
export const signOutStaff = () => apiSignOut<{ signedOut: true }>('/staff/auth/logout');
export const staffMe = (signal?: AbortSignal) => apiGet<StaffAuthResult>('/staff/auth/me', {}, signal);

export const listStaffOrders = (query: StaffOrderQuery, signal?: AbortSignal) =>
  apiGet<StaffOrderList>(
    '/staff/orders',
    { state: query.state, method: query.method, from: query.from, to: query.to, q: query.q, page: query.page ? String(query.page) : undefined, pageSize: query.pageSize ? String(query.pageSize) : undefined },
    signal,
  );
export const getStaffOrder = (id: string, signal?: AbortSignal) => apiGet<StaffOrder>(`/staff/orders/${encodeURIComponent(id)}`, {}, signal);
export const moveStaffOrder = (id: string, request: StaffTransitionRequest, signal?: AbortSignal) =>
  apiSend<StaffOrder>('POST', `/staff/orders/${encodeURIComponent(id)}/transition`, request, {}, signal);
