import { DraftIntegrityError, type CommitResult, type DraftCommit, type DraftDb, type DraftRow } from './types';

const assetKey = (draftKey: string, assetId: string) => JSON.stringify([draftKey, assetId]);
const copyRow = (row: DraftRow): DraftRow => JSON.parse(JSON.stringify(row)) as DraftRow;

/** The drafts database in a Map. For jsdom tests and for browsers with no IndexedDB. Runs the same contract suite as the real one. */
export function createMemoryDb(): DraftDb & { plantOrphan(draftKey: string, assetId: string, blob: Blob): void } {
  const rows = new Map<string, DraftRow>();
  const assets = new Map<string, { draftKey: string; assetId: string; blob: Blob }>();

  const dropAssetsOf = (key: string, keep: ReadonlySet<string> = new Set()) => {
    for (const [k, a] of assets) if (a.draftKey === key && !keep.has(a.assetId)) assets.delete(k);
  };

  return {
    async get(key) {
      const row = rows.get(key);
      return row ? copyRow(row) : undefined;
    },
    async getAssets(key, ids) {
      const out: Record<string, Blob> = {};
      for (const id of ids) {
        const a = assets.get(assetKey(key, id));
        if (a) out[id] = a.blob;
      }
      return out;
    },
    async list(user) {
      return [...rows.values()]
        .filter((r) => r.user === user)
        .map(copyRow)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async commit({ row, expectedRevision, putAssets }: DraftCommit): Promise<CommitResult> {
      const current = rows.get(row.key);
      if ((current?.revision ?? 0) !== expectedRevision) return { ok: false, reason: 'conflict', current: current ? copyRow(current) : undefined };
      // verify first, change after: a write that fails halfway must leave nothing behind
      for (const id of row.assetIds) {
        if (!(id in putAssets) && !assets.has(assetKey(row.key, id))) throw new DraftIntegrityError(id);
      }
      const named = new Set(row.assetIds);
      dropAssetsOf(row.key, named);
      for (const id of row.assetIds) {
        const blob = putAssets[id];
        if (blob) assets.set(assetKey(row.key, id), { draftKey: row.key, assetId: id, blob });
      }
      const revision = expectedRevision + 1;
      rows.set(row.key, copyRow({ ...row, revision }));
      return { ok: true, revision };
    },
    async remove(key) {
      rows.delete(key);
      dropAssetsOf(key);
    },
    async removeUser(user) {
      for (const [key, row] of [...rows]) {
        if (row.user !== user) continue;
        rows.delete(key);
        dropAssetsOf(key);
      }
    },
    async sweep() {
      let n = 0;
      for (const [k, a] of assets) {
        if (rows.has(a.draftKey)) continue;
        assets.delete(k);
        n++;
      }
      return n;
    },
    async assetKeys() {
      return [...assets.values()].map((a) => `${a.draftKey}|${a.assetId}`);
    },
    close() {},
    /** for tests: a picture record with no draft, as an interrupted older write could leave one */
    plantOrphan(draftKey, assetId, blob) {
      assets.set(assetKey(draftKey, assetId), { draftKey, assetId, blob });
    },
  };
}
