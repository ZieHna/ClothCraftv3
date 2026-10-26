/**
 * Step 12: how many unfinished designs (drafts) this device holds for a customer, so sign-out can warn before they are deleted. The
 * count is asked for when the customer signs in and kept; once an editor starts saving (registerSaver) it is unknown again and is asked
 * for afresh at sign-out. The database code is loaded only when a count is asked for, as in registry.ts.
 */
let known: { user: string; count: number } | null = null;

/** The last count for this customer, or null when it is not known now (never asked, or an editor may have saved since). */
export function knownDraftCount(user: string): number | null {
  return known && known.user === user ? known.count : null;
}

/** Ask the drafts database. Never rejects: drafts that cannot be read here (no IndexedDB, blocked storage) count as none. */
export function countDrafts(user: string): Promise<number> {
  return import('./db')
    .then(async ({ getDraftDb }) => {
      const db = await getDraftDb();
      return db ? (await db.list(user)).length : 0;
    })
    .catch(() => 0)
    .then((count) => {
      known = { user, count };
      return count;
    });
}

/** An editor is saving drafts: the count may change. */
export function draftsMayChange(): void {
  known = null;
}
