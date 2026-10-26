// Real browser (Edge): the same contract as the Map, against real IndexedDB, plus what only a real transaction can show.
import { afterAll, describe, expect, it } from 'vitest';
import { blob, rowFor, runDbContract } from './dbContract';
import { openIdbDb } from './idbDb';
import { DraftIntegrityError, draftKey, type DraftDb } from './types';

const opened: Array<{ name: string; db: DraftDb }> = [];
let n = 0;
async function fresh(): Promise<{ name: string; db: DraftDb }> {
  const name = `cc-test-${Date.now()}-${++n}`;
  const db = await openIdbDb(name);
  opened.push({ name, db });
  return { name, db };
}

afterAll(async () => {
  for (const { name, db } of opened) {
    db.close();
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  }
});

runDbContract('IndexedDB (real Edge)', async () => {
  const { name, db } = await fresh();
  return {
    db,
    async plantOrphan(draftKey, assetId, picture) {
      // a second connection writes a picture record straight into the store, as a dead tab would have left it
      const raw = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = raw.transaction('assets', 'readwrite');
        tx.objectStore('assets').put({ draftKey, assetId, blob: picture });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      raw.close();
    },
  };
});

describe('IndexedDB specifics (real Edge)', () => {
  it('keeps the picture bytes exactly', async () => {
    const { db } = await fresh();
    const row = rowFor('ana', 'p1', ['a']);
    await db.commit({ row, expectedRevision: 0, putAssets: { a: new Blob([new Uint8Array([0, 1, 2, 254, 255])], { type: 'image/png' }) } });
    const back = (await db.getAssets(row.key, ['a'])).a!;
    expect(back.type).toBe('image/png');
    expect([...new Uint8Array(await back.arrayBuffer())]).toEqual([0, 1, 2, 254, 255]);
  });

  it('two writers that both start from revision 0: exactly one wins, the other is told, and no picture of the loser is left', async () => {
    const { db } = await fresh();
    const row = rowFor('ana', 'p1', ['x']);
    const results = await Promise.all([
      db.commit({ row: { ...row, assetIds: ['one'] }, expectedRevision: 0, putAssets: { one: blob('1') } }),
      db.commit({ row: { ...row, assetIds: ['two'] }, expectedRevision: 0, putAssets: { two: blob('2') } }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    const winner = (await db.get(row.key))!;
    expect(winner.revision).toBe(1);
    expect(await db.assetKeys()).toEqual([`${row.key}|${winner.assetIds[0]}`]);
  });

  it('an integrity failure aborts the whole transaction: the old row, its pictures and the new pictures', async () => {
    const { db } = await fresh();
    const row = rowFor('ana', 'p1', ['a']);
    await db.commit({ row, expectedRevision: 0, putAssets: { a: blob('A') } });
    await expect(db.commit({ row: { ...row, assetIds: ['n', 'ghost'] }, expectedRevision: 1, putAssets: { n: blob('N') } })).rejects.toBeInstanceOf(DraftIntegrityError);
    expect((await db.get(row.key))?.revision).toBe(1);
    expect(await db.assetKeys()).toEqual([`${row.key}|a`]);
  });

  it('a stored draft survives closing and reopening the database', async () => {
    const { name, db } = await fresh();
    const row = rowFor('ana', 'p1', ['a']);
    await db.commit({ row, expectedRevision: 0, putAssets: { a: blob('A') } });
    db.close();
    const again = await openIdbDb(name);
    opened.push({ name, db: again });
    expect((await again.get(row.key))?.key).toBe(draftKey('ana', 'p1', 'simple'));
    expect(Object.keys(await again.getAssets(row.key, ['a']))).toEqual(['a']);
  });

  it('opening a database made by a newer build fails cleanly instead of throwing later', async () => {
    const { name, db } = await fresh();
    db.close();
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(name, 5);
      r.onsuccess = () => {
        r.result.close();
        resolve();
      };
      r.onerror = () => reject(r.error);
    });
    await expect(openIdbDb(name)).rejects.toBeTruthy();
  });
});
