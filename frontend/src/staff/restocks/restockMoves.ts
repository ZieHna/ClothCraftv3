import { ApiError } from '../../api/client';
import type { RestockDetail } from '../../api/inventory';

/** What the page does with the ticket the server sent back, and the sentence to show. */
export type Changed = (restock: RestockDetail, message: string) => void;

/** A refusal that carries the ticket as it is now (someone else moved it first): the page shows that ticket and the server's sentence. */
export function movedOn(error: unknown): RestockDetail | null {
  return error instanceof ApiError && error.status === 409 ? ((error.details as { restock?: RestockDetail }).restock ?? null) : null;
}
