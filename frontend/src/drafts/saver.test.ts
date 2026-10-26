import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeEditor } from '../editor/fake/FakeEditor';
import { createMemoryDb } from './memoryDb';
import { DraftSaver, type SaverOptions } from './saver';
import { newEditor, pageHidden, png } from './testSupport';
import { draftKey } from './types';

const KEY = draftKey('ana', 'p1', 'simple');
const META = { sku: 'P1-WHT-M', productName: 'Crew Tee', colorName: 'White' };

async function setup(over: Partial<SaverOptions> = {}, editorIn?: FakeEditor) {
  const editor = editorIn ?? (await newEditor());
  const db = createMemoryDb();
  const real = db.commit.bind(db); // before the spy: the spy must call the database, not itself
  const commit = vi.spyOn(db, 'commit');
  const saver = new DraftSaver({ db, editor, user: 'ana', productId: 'p1', engine: 'simple', describe: () => META, baseRevision: 0, ...over });
  saver.arm();
  return { editor, db, commit, saver, real };
}
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('DraftSaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    pageHidden(false);
  });

  it('saves about 1 s after the last change, not before', async () => {
    const { editor, commit, db } = await setup();
    editor.addText('Hello');
    await tick(999);
    expect(commit).not.toHaveBeenCalled();
    await tick(2);
    expect(commit).toHaveBeenCalledTimes(1);
    const row = await db.get(KEY);
    expect(row).toMatchObject({ revision: 1, layerCount: 1, sku: 'P1-WHT-M', productName: 'Crew Tee', garment: { color: 'white', size: 'M' } });
  });

  it('a burst of changes inside the second is ONE save', async () => {
    const { editor, commit } = await setup();
    for (let i = 0; i < 5; i++) {
      editor.addText(`t${i}`);
      await tick(300);
    }
    await tick(1100);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('never waits longer than 5 s from the first unsaved change, however long the editing goes on', async () => {
    const { editor, commit } = await setup();
    editor.addText('start');
    for (let t = 0; t < 4800; t += 800) {
      await tick(800);
      editor.addText('more'); // every 800 ms: the 1 s debounce alone would never fire
    }
    expect(commit).not.toHaveBeenCalled();
    await tick(250);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('saves at once when the page is hidden, and when it is closed', async () => {
    const { editor, commit } = await setup();
    editor.addText('a');
    pageHidden(true);
    await tick(0);
    expect(commit).toHaveBeenCalledTimes(1);
    editor.addText('b');
    window.dispatchEvent(new Event('pagehide'));
    await tick(0);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('ignores edits made before arm() (a draft being chosen or restored is not an edit)', async () => {
    const editor = await newEditor();
    const db = createMemoryDb();
    const commit = vi.spyOn(db, 'commit');
    const saver = new DraftSaver({ db, editor, user: 'ana', productId: 'p1', engine: 'simple', describe: () => META, baseRevision: 0 });
    editor.addText('before');
    await tick(6000);
    expect(commit).not.toHaveBeenCalled();
    saver.arm();
    editor.addText('after');
    await tick(1100);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('never writes a design with no layers, and leaves an existing draft alone', async () => {
    const { editor, commit, db } = await setup();
    const id = editor.addText('x');
    await tick(1100);
    expect(commit).toHaveBeenCalledTimes(1);
    editor.removeLayer(id);
    await tick(1100);
    expect(commit).toHaveBeenCalledTimes(1);
    expect((await db.get(KEY))?.layerCount).toBe(1);
  });

  it('writes one save at a time, and a change during a save is saved right after it', async () => {
    const { editor, db, commit, real } = await setup();
    let running = 0;
    let most = 0;
    commit.mockImplementation(async (c) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 400));
      running--;
      return real(c);
    });
    editor.addText('one');
    await tick(1000); // the first save starts and takes 400 ms
    editor.addText('two'); // during it
    editor.addText('three');
    await tick(5000);
    expect(most).toBe(1);
    expect(commit).toHaveBeenCalledTimes(2);
    expect((await db.get(KEY))?.layerCount).toBe(3);
  });

  it('drops a snapshot taken while an undo, redo or load had started, and saves the settled design instead', async () => {
    const { editor, db, commit } = await setup();
    editor.addText('settled');
    let reads = 0;
    const real = editor.exportState.bind(editor);
    editor.exportState = async () => {
      reads++;
      const snap = await real();
      return reads === 1 ? { ...snap, state: { stale: true } } : snap;
    };
    editor.isBusy = () => reads === 1; // the editor turned busy right after the first read
    await tick(1100);
    expect(reads).toBe(2);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((await db.get(KEY))?.state)).not.toContain('stale');
  });

  it('only sends pictures that are not stored yet', async () => {
    const { editor, commit } = await setup();
    await editor.addImage(png(), 'pic');
    await tick(1100);
    expect(Object.keys(commit.mock.calls[0]![0].putAssets)).toHaveLength(1);
    editor.addText('later');
    await tick(1100);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]![0].putAssets).toEqual({});
    expect(commit.mock.calls[1]![0].row.assetIds).toHaveLength(1);
  });

  it('removes a picture from storage when the design stops using it (orphan cleanup per save)', async () => {
    const { editor, db } = await setup();
    const id = await editor.addImage(png(), 'pic');
    await tick(1100);
    expect(await db.assetKeys()).toHaveLength(1);
    editor.removeLayer(id);
    editor.addText('kept');
    await tick(1100);
    expect(await db.assetKeys()).toEqual([]);
  });

  describe('limits: work is never lost silently', () => {
    it('more than 8 pictures: nothing is written, the previous draft stays, the status says why', async () => {
      const { editor, db, commit, saver } = await setup();
      editor.addText('first');
      await tick(1100);
      expect(commit).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 9; i++) await editor.addImage(png(), `p${i}`);
      await tick(1100);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(saver.status).toMatchObject({ kind: 'blocked', reason: 'pictures' });
      expect((await db.get(KEY))?.assetIds).toEqual([]);
    });

    it('exactly 8 pictures is fine', async () => {
      const { editor, saver, db } = await setup();
      for (let i = 0; i < 8; i++) await editor.addImage(png(), `p${i}`);
      await tick(1100);
      expect(saver.status.kind).toBe('saved');
      expect((await db.get(KEY))?.assetIds).toHaveLength(8);
    });

    it('a draft over its size limit is blocked, and saving resumes once it is small enough', async () => {
      const { editor, saver, commit } = await setup({ limits: { draftBytes: 1500 } });
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push(await editor.addImage(png(), `p${i}`));
      await tick(1100);
      expect(saver.status).toMatchObject({ kind: 'blocked', reason: 'draft-size' });
      expect(commit).not.toHaveBeenCalled();
      for (const id of ids.slice(1)) editor.removeLayer(id);
      await tick(1100);
      expect(saver.status.kind).toBe('saved');
    });

    it('the total over all of a person\'s drafts is limited too, counting the other drafts', async () => {
      const { editor, db, saver } = await setup({ limits: { totalBytes: 10_000 } });
      await db.commit({ row: { ...(await import('./dbContract')).rowFor('ana', 'other'), bytes: 9_900 }, expectedRevision: 0, putAssets: {} });
      editor.addText('hello');
      await tick(1100);
      expect(saver.status).toMatchObject({ kind: 'blocked', reason: 'total-size' });
      expect(await db.get(KEY)).toBeUndefined();
    });

    it('a browser refusal (quota) is blocked with a plain message, and a later save that works clears it', async () => {
      const { editor, commit, saver, real } = await setup();
      commit.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
      editor.addText('a');
      await tick(1100);
      expect(saver.status).toMatchObject({ kind: 'blocked', reason: 'storage' });
      expect((saver.status as { message: string }).message).toMatch(/no room left/);
      commit.mockImplementation(real);
      editor.addText('b');
      await tick(1100);
      expect(saver.status.kind).toBe('saved');
    });
  });

  describe('two tabs', () => {
    it('a second writer that has not seen the first one pauses and asks, and nothing is overwritten', async () => {
      const a = await setup();
      const editorB = await newEditor();
      const b = new DraftSaver({ db: a.db, editor: editorB, user: 'ana', productId: 'p1', engine: 'simple', describe: () => META, baseRevision: 0 });
      b.arm();
      a.editor.addText('from tab A');
      await tick(1100);
      expect((await a.db.get(KEY))?.revision).toBe(1);
      const before = JSON.stringify(await a.db.get(KEY));
      editorB.addText('from tab B');
      editorB.addText('and more');
      await tick(1100);
      expect(b.status).toMatchObject({ kind: 'conflict', otherRevision: 1 });
      expect(JSON.stringify(await a.db.get(KEY))).toBe(before);
      // while paused, more edits do not write either
      editorB.addText('still paused');
      await tick(6000);
      expect(JSON.stringify(await a.db.get(KEY))).toBe(before);

      b.resolveConflict('overwrite');
      await tick(0);
      expect(b.status.kind).toBe('saved');
      expect((await a.db.get(KEY))?.revision).toBe(2);
      expect((await a.db.get(KEY))?.layerCount).toBe(3);
    });

    it('"do not save in this tab" stops this tab for good and leaves the other version alone', async () => {
      const a = await setup();
      const editorB = await newEditor();
      const b = new DraftSaver({ db: a.db, editor: editorB, user: 'ana', productId: 'p1', engine: 'simple', describe: () => META, baseRevision: 0 });
      b.arm();
      a.editor.addText('A');
      await tick(1100);
      editorB.addText('B');
      await tick(1100);
      b.resolveConflict('stop');
      expect(b.status).toEqual({ kind: 'off', why: 'declined' });
      editorB.addText('B2');
      await tick(6000);
      expect((await a.db.get(KEY))?.revision).toBe(1);
    });

    it('a draft deleted by the other tab is a conflict too, not a silent re-create', async () => {
      const { editor, db, saver } = await setup();
      editor.addText('one');
      await tick(1100);
      await db.remove(KEY);
      editor.addText('two');
      await tick(1100);
      expect(saver.status).toMatchObject({ kind: 'conflict', otherRevision: 0 });
      expect(await db.get(KEY)).toBeUndefined();
    });

    it('starting fresh over an old draft overwrites it at the first edit without a conflict, and drops its pictures', async () => {
      const first = await setup();
      await first.editor.addImage(png(), 'old');
      await tick(1100);
      const old = await first.db.get(KEY);
      expect(old?.assetIds).toHaveLength(1);
      // a new visit chose "Start fresh": base revision is the old one, no pictures are assumed stored
      const editor2 = await newEditor();
      const second = new DraftSaver({ db: first.db, editor: editor2, user: 'ana', productId: 'p1', engine: 'simple', describe: () => META, baseRevision: old!.revision });
      second.arm();
      await tick(6000);
      expect((await first.db.get(KEY))?.revision).toBe(1); // untouched until the first edit
      editor2.addText('new');
      await tick(1100);
      expect(second.status.kind).toBe('saved');
      expect((await first.db.get(KEY))?.revision).toBe(2);
      expect(await first.db.assetKeys()).toEqual([]);
    });
  });

  describe('seal (sign-out)', () => {
    it('after seal nothing is written, even for a save that was already scheduled', async () => {
      const { editor, commit, db, saver } = await setup();
      editor.addText('pending');
      void saver.seal();
      await tick(10_000);
      expect(commit).not.toHaveBeenCalled();
      expect(await db.get(KEY)).toBeUndefined();
      expect(saver.status).toEqual({ kind: 'off', why: 'sealed' });
    });

    it('a write that had already begun finishes before seal() settles, and none starts after', async () => {
      const { editor, commit, saver, real } = await setup();
      let finished = false;
      commit.mockImplementation(async (c) => {
        await new Promise((r) => setTimeout(r, 500));
        finished = true;
        return real(c);
      });
      editor.addText('one');
      await tick(1100); // the write is under way
      editor.addText('two'); // an edit queued behind it
      let sealedAt = false;
      void saver.seal().then(() => (sealedAt = finished));
      await tick(2000);
      expect(sealedAt).toBe(true);
      expect(commit).toHaveBeenCalledTimes(1);
    });
  });
});
