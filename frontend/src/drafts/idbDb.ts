import { DraftIntegrityError, type CommitResult, type DraftCommit, type DraftDb, type DraftRow } from './types';

export const DB_NAME = 'clothcraft-drafts';
const DB_VERSION = 1;
const DRAFTS = 'drafts';
const ASSETS = 'assets';

interface AssetRecord {
  draftKey: string;
  assetId: string;
  blob: Blob;
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

/** Settles when the transaction has COMMITTED (not when its last request succeeded). */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction was aborted.'));
  });
}

/** Deletes every picture record of one draft, inside the caller's transaction. */
async function deleteAssetsOf(assets: IDBObjectStore, draftKey: string, keep: ReadonlySet<string> = new Set()): Promise<void> {
  const keys = (await req(assets.index('draftKey').getAllKeys(draftKey))) as Array<[string, string]>;
  for (const k of keys) if (!keep.has(k[1])) assets.delete(k);
}

/** Opens (and on first use creates) the drafts database. Rejects when IndexedDB is missing, blocked, or made by a newer build. */
export function openIdbDb(name: string = DB_NAME): Promise<DraftDb> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available.'));
      return;
    }
    let opened: IDBOpenDBRequest;
    try {
      opened = indexedDB.open(name, DB_VERSION);
    } catch (e) {
      reject(e instanceof Error ? e : new Error('IndexedDB could not be opened.'));
      return;
    }
    opened.onupgradeneeded = () => {
      const db = opened.result;
      const drafts = db.createObjectStore(DRAFTS, { keyPath: 'key' });
      drafts.createIndex('user', 'user');
      const assets = db.createObjectStore(ASSETS, { keyPath: ['draftKey', 'assetId'] });
      assets.createIndex('draftKey', 'draftKey');
    };
    opened.onerror = () => reject(opened.error ?? new Error('IndexedDB could not be opened.'));
    opened.onblocked = () => reject(new Error('IndexedDB is blocked by another tab.'));
    opened.onsuccess = () => {
      const db = opened.result;
      db.onversionchange = () => db.close();
      resolve(wrap(db));
    };
  });
}

function wrap(db: IDBDatabase): DraftDb {
  return {
    async get(key) {
      return (await req(db.transaction(DRAFTS, 'readonly').objectStore(DRAFTS).get(key))) as DraftRow | undefined;
    },

    async getAssets(key, ids) {
      const tx = db.transaction(ASSETS, 'readonly');
      const store = tx.objectStore(ASSETS);
      const out: Record<string, Blob> = {};
      await Promise.all(
        ids.map(async (id) => {
          const rec = (await req(store.get([key, id]))) as AssetRecord | undefined;
          if (rec) out[id] = rec.blob;
        }),
      );
      return out;
    },

    async list(user) {
      const rows = (await req(db.transaction(DRAFTS, 'readonly').objectStore(DRAFTS).index('user').getAll(user))) as DraftRow[];
      return rows.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async commit({ row, expectedRevision, putAssets }: DraftCommit): Promise<CommitResult> {
      const tx = db.transaction([DRAFTS, ASSETS], 'readwrite');
      const finished = done(tx);
      finished.catch(() => undefined); // a rejection is reported through the awaits below; keep it from also being unhandled
      const drafts = tx.objectStore(DRAFTS);
      const assets = tx.objectStore(ASSETS);
      try {
        // everything that can say no is read FIRST; the writes below are issued together, so a refusal leaves nothing behind
        const current = (await req(drafts.get(row.key))) as DraftRow | undefined;
        if ((current?.revision ?? 0) !== expectedRevision) {
          tx.abort();
          await finished.catch(() => undefined);
          return { ok: false, reason: 'conflict', current };
        }
        const stored = (await req(assets.index('draftKey').getAllKeys(row.key))) as Array<[string, string]>;
        const storedIds = new Set(stored.map((k) => k[1]));
        for (const id of row.assetIds) {
          if (!(id in putAssets) && !storedIds.has(id)) throw new DraftIntegrityError(id);
        }
        const named = new Set(row.assetIds);
        for (const k of stored) if (!named.has(k[1])) assets.delete(k); // orphans: pictures this draft no longer uses
        for (const id of row.assetIds) {
          const blob = putAssets[id];
          if (blob) assets.put({ draftKey: row.key, assetId: id, blob } satisfies AssetRecord);
        }
        const revision = expectedRevision + 1;
        drafts.put({ ...row, revision });
        await finished;
        return { ok: true, revision };
      } catch (e) {
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
        await finished.catch(() => undefined);
        throw e;
      }
    },

    async remove(key) {
      const tx = db.transaction([DRAFTS, ASSETS], 'readwrite');
      const finished = done(tx);
      tx.objectStore(DRAFTS).delete(key);
      await deleteAssetsOf(tx.objectStore(ASSETS), key);
      await finished;
    },

    async removeUser(user) {
      const tx = db.transaction([DRAFTS, ASSETS], 'readwrite');
      const finished = done(tx);
      const drafts = tx.objectStore(DRAFTS);
      const keys = (await req(drafts.index('user').getAllKeys(user))) as string[];
      for (const key of keys) {
        drafts.delete(key);
        await deleteAssetsOf(tx.objectStore(ASSETS), key);
      }
      await finished;
    },

    async sweep() {
      const tx = db.transaction([DRAFTS, ASSETS], 'readwrite');
      const finished = done(tx);
      const drafts = tx.objectStore(DRAFTS);
      const assets = tx.objectStore(ASSETS);
      const all = (await req(assets.getAllKeys())) as Array<[string, string]>;
      const gone = new Set<string>();
      for (const draftKey of new Set(all.map((k) => k[0]))) {
        if ((await req(drafts.getKey(draftKey))) === undefined) gone.add(draftKey);
      }
      let n = 0;
      for (const k of all) {
        if (!gone.has(k[0])) continue;
        assets.delete(k);
        n++;
      }
      await finished;
      return n;
    },

    async assetKeys() {
      const keys = (await req(db.transaction(ASSETS, 'readonly').objectStore(ASSETS).getAllKeys())) as Array<[string, string]>;
      return keys.map((k) => `${k[0]}|${k[1]}`);
    },

    close() {
      db.close();
    },
  };
}
