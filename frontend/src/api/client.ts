import type { ApiErrorBody, ApiResponse } from './types';

/**
 * VITE_API switches where /api is answered. The app always calls /api on its own origin, in both modes:
 *   mock : MSW answers in the browser (src/mocks). The default, because no API service exists yet.
 *   odoo : nothing is intercepted; the Vite dev/preview proxy forwards /api to the API service in front of Odoo.
 */
export type ApiMode = 'mock' | 'odoo';

function readMode(raw: string | undefined): ApiMode {
  if (raw === undefined || raw === '') return 'mock';
  if (raw === 'mock' || raw === 'odoo') return raw;
  throw new Error(`VITE_API must be "mock" or "odoo", got "${raw}"`);
}

export const API_MODE: ApiMode = readMode(import.meta.env.VITE_API);
export const API_BASE = '/api';

type ErrorDetails = Omit<ApiErrorBody['error'], 'code' | 'message'>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** what the server added to the error: field messages (422), short lines (409), a new quote (409) */
  readonly details: ErrorDetails;
  constructor(status: number, code: string, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * The customer's session. The real service keeps it in an httpOnly cookie the browser sends by itself and the page can never read.
 * A cookie cannot be set by the in-browser mock, so the mock hands out a token in the X-Mock-Session response header, which is kept
 * in this tab's sessionStorage and sent back on every request (an empty one means "the session is over").
 */
export const MOCK_SESSION_KEY = 'cc.mock.session';
/** The staff dashboard's session is a separate one (the real service uses a separate cookie), so a customer never holds it by accident. */
export const MOCK_STAFF_SESSION_KEY = 'cc.mock.staff.session';
const MOCK_TOKENS = [
  { key: MOCK_SESSION_KEY, header: 'X-Mock-Session' },
  { key: MOCK_STAFF_SESSION_KEY, header: 'X-Mock-Staff-Session' },
] as const;

function sessionHeaders(): Record<string, string> {
  if (API_MODE !== 'mock') return {};
  const headers: Record<string, string> = {};
  for (const { key, header } of MOCK_TOKENS) {
    try {
      const token = sessionStorage.getItem(key);
      if (token) headers[header] = token;
    } catch {
      /* storage blocked: no session */
    }
  }
  return headers;
}

function rememberMockSession(response: Response): void {
  if (API_MODE !== 'mock') return;
  for (const { key, header } of MOCK_TOKENS) {
    const token = response.headers.get(header);
    if (token === null) continue;
    try {
      if (token) sessionStorage.setItem(key, token);
      else sessionStorage.removeItem(key);
    } catch {
      /* storage blocked: the session then lasts until the page is reloaded */
    }
  }
}

/** Told when the server says the session is over (a 401 "unauthorised"): expired, signed out elsewhere, or never there. */
const sessionEnded = new Set<() => void>();
export function onSessionEnded(listener: () => void): () => void {
  sessionEnded.add(listener);
  return () => sessionEnded.delete(listener);
}
/** The same for the staff session. A staff 401 never signs the customer out, and a customer 401 never signs staff out. */
const staffSessionEnded = new Set<() => void>();
export function onStaffSessionEnded(listener: () => void): () => void {
  staffSessionEnded.add(listener);
  return () => staffSessionEnded.delete(listener);
}

/** The same for the Administrator's own session (/admin). An admin 401 never signs an employee or a customer out, and the reverse. */
const adminSessionEnded = new Set<() => void>();
export function onAdminSessionEnded(listener: () => void): () => void {
  adminSessionEnded.add(listener);
  return () => adminSessionEnded.delete(listener);
}

/**
 * Which workspace the reused staff pages are in (set by staff/workspace.tsx). Under the admin dashboard their /staff/... calls go to /admin/...
 * (the same routes under the admin prefix, which read only the admin cookie). The sign-in routes (/staff/auth/...) never move.
 */
let apiWorkspace: 'staff' | 'admin' = 'staff';
export function setApiWorkspace(workspace: 'staff' | 'admin'): void {
  apiWorkspace = workspace;
}
export function apiPath(path: string): string {
  return apiWorkspace === 'admin' && path.startsWith('/staff/') && !path.startsWith('/staff/auth/') ? `/admin/${path.slice('/staff/'.length)}` : path;
}

async function request<T>(method: string, path: string, params: Record<string, string | undefined>, body: unknown, extra: Record<string, string>, signal?: AbortSignal, keepalive = false): Promise<ApiResponse<T>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const wire = apiPath(path);
  const url = `${API_BASE}${wire}${query.size ? `?${query}` : ''}`;
  const headers: Record<string, string> = { Accept: 'application/json', ...sessionHeaders(), ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, ...(keepalive ? { keepalive: true } : {}) });
  rememberMockSession(response);
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as Partial<ApiErrorBody> | null;
    const { code, message, ...details } = parsed?.error ?? {};
    if (response.status === 401 && code === 'unauthorised') (wire.startsWith('/admin/') ? adminSessionEnded : wire.startsWith('/staff/') ? staffSessionEnded : sessionEnded).forEach((listener) => listener());
    throw new ApiError(response.status, code ?? 'unknown', message ?? `Request failed (${response.status})`, details);
  }
  return (await response.json()) as ApiResponse<T>;
}

export function apiGet<T>(path: string, params: Record<string, string | undefined> = {}, signal?: AbortSignal): Promise<ApiResponse<T>> {
  return request<T>('GET', path, params, undefined, {}, signal);
}

/** POST (or another verb) with a JSON body. `headers` are extra request headers, for example Idempotency-Key. */
export function apiSend<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body: unknown = {}, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<ApiResponse<T>> {
  return request<T>(method, path, {}, body, headers, signal);
}

/**
 * Sign-out: the request is sent with keepalive, so the browser finishes it even when the page is reloaded or closed right after (a plain
 * fetch is cancelled with the page, and the server then never ends the session: the cookie would keep working until it ran out).
 * Read the headers first, then call forgetMockSession: the token has to be in the request.
 */
export const apiSignOut = <T>(path: string): Promise<ApiResponse<T>> => request<T>('POST', path, {}, {}, {}, undefined, true);

/** Forget the mock session token at once (sign-out). The real service's cookie is cleared by the server's answer; in the mock there is no answer a closing page could read. */
export function forgetMockSession(kind: 'customer' | 'staff'): void {
  if (API_MODE !== 'mock') return;
  try {
    sessionStorage.removeItem(kind === 'staff' ? MOCK_STAFF_SESSION_KEY : MOCK_SESSION_KEY);
  } catch {
    /* storage blocked: nothing to forget */
  }
}
