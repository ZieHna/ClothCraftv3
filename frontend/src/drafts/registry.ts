import { draftsMayChange } from './deviceDrafts';

/**
 * The savers that are running, so sign-out can stop every one of them BEFORE it deletes anything. Kept apart from the
 * saver and the database so the main bundle (which sign-out lives in) carries only these few lines.
 */
export interface Sealable {
  /** Stops all saving at once (synchronously) and settles when a save that was already writing has finished. */
  seal(): Promise<void>;
}

const running = new Set<Sealable>();

export function registerSaver(saver: Sealable): () => void {
  running.add(saver);
  draftsMayChange(); // the sign-out warning counts the drafts again
  return () => running.delete(saver);
}

export function sealAllSavers(): Promise<void> {
  return Promise.all([...running].map((s) => s.seal())).then(() => undefined);
}

/**
 * Sign-out: seal every saver first, then delete this person's drafts. The database code is loaded only now, so signing out
 * never costs the entry bundle anything. Never rejects.
 */
export function clearDraftsOnSignOut(user: string): Promise<void> {
  const sealed = sealAllSavers(); // the seal itself happens now, before this function returns
  return sealed
    .then(() => import('./db'))
    .then(async ({ getDraftDb }) => {
      const db = await getDraftDb();
      await db?.removeUser(user);
    })
    .catch(() => undefined);
}
