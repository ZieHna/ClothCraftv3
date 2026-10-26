// One suite, two databases: memoryDb.test.ts runs it in jsdom, idbDb.browser.test.ts runs it against real IndexedDB in Edge.
import { describe, expect, it } from 'vitest';
import { DRAFT_FORMAT, DraftIntegrityError, draftKey, type DraftDb, type DraftWrite } from './types';

export interface DbHarness {
  db: DraftDb;
  /** writes a picture record that no draft owns, the way a dead tab or an old bug could leave one */
  plantOrphan(draftKey: string, assetId: string, blob: Blob): Promise<void>;
}

export const blob = (text: string) => new Blob([text], { type: 'image/png' });

export function rowFor(user: string, productId: string, assetIds: string[] = [], over: Partial<DraftWrite> = {}): DraftWrite {
  return {
    key: draftKey(user, productId, 'simple'),
    user,
    productId,
    engine: 'simple',
    format: DRAFT_FORMAT,
    schemaVersion: 1,
    garment: { color: 'navy', size: 'M' },
    sku: `${productId}-NVY-M`,
    productName: 'Crew Tee',
    colorName: 'Navy',
    state: { objects: [], counter: 0 },
    assetIds,
    layerCount: 1,
    bytes: 100,
    updatedAt: 1000,
    ...over,
  };
}

export function runDbContract(name: string, make: () => Promise<DbHarness>): void {
  describe(`DraftDb contract: ${name}`, () => {
    it('writes a draft with its pictures and reads both back, revision 1', async () => {
      const { db } = await make();
      const row = rowFor('ana', 'p1', ['a', 'b']);
      expect(await db.commit({ row, expectedRevision: 0, putAssets: { a: blob('AAA'), b: blob('BB') } })).toEqual({ ok: true, revision: 1 });
      const read = await db.get(row.key);
      expect(read).toMatchObject({ key: row.key, revision: 1, assetIds: ['a', 'b'], garment: { color: 'navy', size: 'M' } });
      const pics = await db.getAssets(row.key, ['a', 'b', 'zzz']);
      expect(Object.keys(pics).sort()).toEqual(['a', 'b']);
      expect(pics.a!.size).toBe(3);
      expect(pics.b!.size).toBe(2);
    });

    it('stores a picture once: a later save that names it without sending it keeps it', async () => {
      const { db } = await make();
      const row = rowFor('ana', 'p1', ['a']);
      await db.commit({ row, expectedRevision: 0, putAssets: { a: blob('AAA') } });
      expect(await db.commit({ row: { ...row, updatedAt: 2 }, expectedRevision: 1, putAssets: {} })).toEqual({ ok: true, revision: 2 });
      expect((await db.getAssets(row.key, ['a'])).a!.size).toBe(3);
      expect(await db.assetKeys()).toHaveLength(1);
    });

    it('removes the pictures a save no longer names (no orphan is left behind)', async () => {
      const { db } = await make();
      const row = rowFor('ana', 'p1', ['a', 'b']);
      await db.commit({ row, expectedRevision: 0, putAssets: { a: blob('A'), b: blob('B') } });
      await db.commit({ row: { ...row, assetIds: ['a'] }, expectedRevision: 1, putAssets: {} });
      expect(Object.keys(await db.getAssets(row.key, ['a', 'b']))).toEqual(['a']);
      expect(await db.assetKeys()).toEqual([`${row.key}|a`]);
    });

    it('refuses a write from a stale revision and changes nothing, pictures included', async () => {
      const { db } = await make();
      const row = rowFor('ana', 'p1', ['a']);
      await db.commit({ row, expectedRevision: 0, putAssets: { a: blob('A') } });
      const result = await db.commit({ row: { ...row, assetIds: ['a', 'n'], garment: { color: 'red', size: 'L' } }, expectedRevision: 0, putAssets: { n: blob('NEW') } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.current?.revision).toBe(1);
      expect((await db.get(row.key))?.garment).toEqual({ color: 'navy', size: 'M' });
      expect(await db.assetKeys()).toEqual([`${row.key}|a`]);
    });

    it('a first write that expects an existing draft is a conflict (the draft was deleted elsewhere)', async () => {
      const { db } = await make();
      const result = await db.commit({ row: rowFor('ana', 'p1'), expectedRevision: 3, putAssets: {} });
      expect(result).toMatchObject({ ok: false, reason: 'conflict', current: undefined });
      expect(await db.get(rowFor('ana', 'p1').key)).toBeUndefined();
    });

    it('rejects a row that names a picture nobody stored, and writes nothing at all', async () => {
      const { db } = await make();
      const row = rowFor('ana', 'p1', ['a', 'ghost']);
      await expect(db.commit({ row, expectedRevision: 0, putAssets: { a: blob('A') } })).rejects.toBeInstanceOf(DraftIntegrityError);
      expect(await db.get(row.key)).toBeUndefined();
      expect(await db.assetKeys()).toEqual([]);
    });

    it('an integrity failure on a later save leaves the previous draft and pictures exactly as they were', async () => {
      const { db } = await make();
      const row = rowFor('ana', 'p1', ['a']);
      await db.commit({ row, expectedRevision: 0, putAssets: { a: blob('A') } });
      await expect(db.commit({ row: { ...row, assetIds: ['ghost'] }, expectedRevision: 1, putAssets: {} })).rejects.toBeInstanceOf(DraftIntegrityError);
      expect((await db.get(row.key))?.assetIds).toEqual(['a']);
      expect(await db.assetKeys()).toEqual([`${row.key}|a`]);
    });

    it('lists only one person\'s drafts, newest first', async () => {
      const { db } = await make();
      await db.commit({ row: rowFor('ana', 'p1', [], { updatedAt: 10 }), expectedRevision: 0, putAssets: {} });
      await db.commit({ row: rowFor('ana', 'p2', [], { updatedAt: 30 }), expectedRevision: 0, putAssets: {} });
      await db.commit({ row: rowFor('ben', 'p1', [], { updatedAt: 20 }), expectedRevision: 0, putAssets: {} });
      expect((await db.list('ana')).map((r) => r.productId)).toEqual(['p2', 'p1']);
      expect((await db.list('ben')).map((r) => r.productId)).toEqual(['p1']);
      expect(await db.list('cy')).toEqual([]);
    });

    it('keeps drafts of the same person for different products and engines apart', async () => {
      const { db } = await make();
      await db.commit({ row: rowFor('ana', 'p1'), expectedRevision: 0, putAssets: {} });
      await db.commit({ row: rowFor('ana', 'p2'), expectedRevision: 0, putAssets: {} });
      expect(await db.get(draftKey('ana', 'p1', 'simple'))).toBeDefined();
      expect(await db.get(draftKey('ana', 'p1', 'pro'))).toBeUndefined();
    });

    it('remove deletes the draft and its pictures, and only those', async () => {
      const { db } = await make();
      const a = rowFor('ana', 'p1', ['x']);
      const b = rowFor('ana', 'p2', ['x']);
      await db.commit({ row: a, expectedRevision: 0, putAssets: { x: blob('1') } });
      await db.commit({ row: b, expectedRevision: 0, putAssets: { x: blob('2') } });
      await db.remove(a.key);
      expect(await db.get(a.key)).toBeUndefined();
      expect(await db.assetKeys()).toEqual([`${b.key}|x`]);
      expect(await db.get(b.key)).toBeDefined();
    });

    it('removeUser deletes every draft and picture of that person and nobody else\'s', async () => {
      const { db } = await make();
      const a1 = rowFor('ana', 'p1', ['x']);
      const a2 = rowFor('ana', 'p2', ['y']);
      const b1 = rowFor('ben', 'p1', ['x']);
      await db.commit({ row: a1, expectedRevision: 0, putAssets: { x: blob('1') } });
      await db.commit({ row: a2, expectedRevision: 0, putAssets: { y: blob('2') } });
      await db.commit({ row: b1, expectedRevision: 0, putAssets: { x: blob('3') } });
      await db.removeUser('ana');
      expect(await db.list('ana')).toEqual([]);
      expect(await db.assetKeys()).toEqual([`${b1.key}|x`]);
      expect((await db.list('ben')).length).toBe(1);
    });

    it('sweep deletes picture records with no draft, keeps the rest, and says how many', async () => {
      const { db, plantOrphan } = await make();
      const row = rowFor('ana', 'p1', ['a']);
      await db.commit({ row, expectedRevision: 0, putAssets: { a: blob('A') } });
      const lost = draftKey('ana', 'gone', 'simple');
      await plantOrphan(lost, 'o1', blob('O'));
      await plantOrphan(lost, 'o2', blob('O'));
      expect(await db.assetKeys()).toHaveLength(3);
      expect(await db.sweep()).toBe(2);
      expect(await db.assetKeys()).toEqual([`${row.key}|a`]);
      expect(await db.sweep()).toBe(0);
    });
  });
}
