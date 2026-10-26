import { HttpResponse } from 'msw';
import type { ApiErrorBody, ApiResponse } from '../api/types';
import { waitWords } from './accounts';
import { simulation } from './shopDb';

/** The MOCK SERVER's HTTP helpers, shared by the customer routes (handlers.ts) and the staff routes (staffHandlers.ts). */
export function respond<T>(data: T, status = 200, headers?: Record<string, string>) {
  const body: ApiResponse<T> = { data, simulation };
  return HttpResponse.json(body, { status, headers });
}

export function fail(status: number, code: string, message: string, extra: Omit<ApiErrorBody['error'], 'code' | 'message'> & { retryAfter?: number } = {}, headers?: Record<string, string>) {
  const body: ApiErrorBody = { error: { code, message, ...extra } };
  return HttpResponse.json(body, { status, headers });
}

/** The attempt counters are per client address; a test client says which one it is with X-Forwarded-For, as the real service allows. */
export const clientAddress = (request: Request) => request.headers.get('X-Forwarded-For')?.split(',')[0].trim() || 'browser';

export function tooMany(seconds: number, what: string) {
  return fail(429, 'too_many_attempts', `Too many ${what}. Please wait ${waitWords(seconds)} and try again.`, { retryAfter: seconds }, { 'Retry-After': String(seconds) });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
