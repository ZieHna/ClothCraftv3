import { apiGet, apiSend, apiSignOut } from './client';
import type { StaffAuthResult } from './types';

/**
 * The Administrator's own sign-in (/admin), step 7a. A cookie of its own (cc_admin) that the page cannot read; a different one from the
 * employee dashboard's. POST /api/admin/auth/login {email, password} -> {user} | 401 invalid_credentials | 429 too_many_attempts |
 * 403 not_admin ("This is an employee account. Use Employee login.", said only after a CORRECT password) | 403 mfa_unsupported.
 * GET /api/admin/auth/me -> {user} | 401 unauthorised | 403 forbidden (an employee session is open here: it is not an admin one).
 */
export const signInAdmin = (request: { email: string; password: string }, signal?: AbortSignal) => apiSend<StaffAuthResult>('POST', '/admin/auth/login', request, {}, signal);
export const signOutAdmin = () => apiSignOut<{ signedOut: true }>('/admin/auth/logout');
export const adminMe = (signal?: AbortSignal) => apiGet<StaffAuthResult>('/admin/auth/me', {}, signal);
