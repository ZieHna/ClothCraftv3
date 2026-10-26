import type { AuthUser } from '../api/types';

/**
 * The key a customer's local drafts are filed under: the account's id, never the name (two people can share a name, and a name
 * can change). Drafts are stored on this device only, and a different account on the same device never sees them.
 */
export const userKey = (user: Pick<AuthUser, 'id'>): string => `u${user.id}`;
