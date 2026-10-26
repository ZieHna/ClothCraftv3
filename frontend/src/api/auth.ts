import { apiGet, apiSend, apiSignOut } from './client';
import type { AuthResult, LoginRequest, RegisterRequest } from './types';

/** Register, sign in and out, and "who am I". The session itself is the server's (see client.ts); these only ask. */
export const registerCustomer = (request: RegisterRequest, signal?: AbortSignal) => apiSend<AuthResult>('POST', '/auth/register', request, {}, signal);
export const signInCustomer = (request: LoginRequest, signal?: AbortSignal) => apiSend<AuthResult>('POST', '/auth/login', request, {}, signal);
export const signOutCustomer = () => apiSignOut<{ signedOut: true }>('/auth/logout');
export const whoAmI = (signal?: AbortSignal) => apiGet<AuthResult>('/auth/me', {}, signal);
