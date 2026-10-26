import { DB_NAME, openIdbDb } from './idbDb';
import type { DraftDb } from './types';

let shared: Promise<DraftDb | null> | null = null;

const PURGED = 'cc.drafts.demoPurged.v1';

/**
 * Until real accounts (step 6d) every draft belonged to a made-up "demo customer" filed under a display name. Those cannot belong to
 * any real account, so the whole drafts database is deleted ONCE, before it is first opened by this build. It runs before anything
 * is written for a real account (the flag is set only after the delete went through), so no real draft is ever lost. If another tab
 * still has the old database open the delete is blocked: it is skipped now and tried again at the next page load.
 */
function purgeLegacyDemoDrafts(): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined' || localStorage.getItem(PURGED) === '1') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => {
        try {
          localStorage.setItem(PURGED, '1');
        } catch {
          /* storage blocked: it will be deleted again next time, which is harmless before any real draft exists */
        }
        resolve();
      };
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  } catch {
    return Promise.resolve();
  }
}

/**
 * The one drafts database of this page. Resolves to null when drafts cannot work here (no IndexedDB, blocked storage, a
 * private window, or a database made by a newer build): callers then show "drafts are unavailable" and never throw.
 * The first open also sweeps picture records whose draft is gone (a tab that died between two steps, or an old bug).
 */
export function getDraftDb(): Promise<DraftDb | null> {
  shared ??= purgeLegacyDemoDrafts().then(() => openIdbDb()).then(
    async (db) => {
      try {
        await db.sweep();
      } catch {
        /* a failed sweep only leaves orphans for the next page load */
      }
      return db;
    },
    () => null,
  );
  return shared;
}

/** For tests: use this database (or null for "unavailable") instead of opening IndexedDB. */
export function setDraftDbForTests(db: DraftDb | null | undefined): void {
  shared = db === undefined ? null : Promise.resolve(db);
}
