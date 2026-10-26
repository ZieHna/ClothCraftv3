import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeEditor } from '../editor/fake/FakeEditor';
import { SNAPSHOT_SCHEMA_VERSION } from '../editor/types';
import { DraftSession } from './DraftSession';
import { setDraftDbForTests } from './db';
import { createMemoryDb } from './memoryDb';
import { clearDraftsOnSignOut } from './registry';
import { DraftSaver } from './saver';
import { newEditor, polyfillDialog, png } from './testSupport';
import { DRAFT_FORMAT, draftKey, type DraftDb, type DraftRow } from './types';

const KEY = draftKey('ana', 'p1', 'simple');
const OPTIONS = {
  productName: 'Crew Tee',
  colors: [
    { id: 'white', name: 'White', hex: '#fff' },
    { id: 'navy', name: 'Navy', hex: '#123' },
  ],
  sizes: ['S', 'M', 'L'],
  soldOut: () => false,
};

const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

/** Stores a draft the way the saver would: a design with some text (and optionally a picture), navy and size L. */
async function seed(db: DraftDb, user = 'ana', over: Partial<DraftRow> = {}, withPicture = false) {
  const e = await newEditor();
  e.addText('Hello');
  if (withPicture) await e.addImage(png(), 'pic');
  const snap = await e.exportState();
  const row = {
    key: draftKey(user, 'p1', 'simple'),
    user,
    productId: 'p1',
    engine: 'simple' as const,
    format: DRAFT_FORMAT,
    schemaVersion: snap.schemaVersion,
    garment: { color: 'navy', size: 'L' },
    sku: 'P1-NVY-L',
    productName: 'Crew Tee',
    colorName: 'Navy',
    state: snap.state,
    assetIds: Object.keys(snap.assets),
    layerCount: e.getLayers().length,
    bytes: 500,
    updatedAt: Date.now() - 60_000,
    ...over,
  };
  const { revision: _r, ...write } = row as DraftRow;
  await db.commit({ row: write, expectedRevision: 0, putAssets: snap.assets });
  return write;
}

function mount(editor: FakeEditor, over: Partial<Parameters<typeof DraftSession>[0]> = {}) {
  const leaveRef = { current: null as (() => Promise<void>) | null };
  const onDownload = vi.fn();
  const announce = vi.fn();
  const props = { editor, user: 'ana', productId: 'p1', engine: 'simple' as const, describe: () => ({ sku: 'P1-WHT-M', productName: 'Crew Tee', colorName: 'White' }), options: OPTIONS, onDownload, announce, leaveRef, ...over };
  const view = render(<DraftSession {...props} />);
  return { view, leaveRef, onDownload, announce };
}

describe('DraftSession', () => {
  let db: ReturnType<typeof createMemoryDb>;
  beforeEach(() => {
    vi.useFakeTimers();
    polyfillDialog();
    db = createMemoryDb();
    setDraftDbForTests(db);
  });
  afterEach(() => {
    vi.useRealTimers();
    setDraftDbForTests(undefined);
  });

  it('with no draft there is no prompt, and the first edit is saved', async () => {
    const editor = await newEditor();
    mount(editor);
    await settle();
    expect(screen.queryByTestId('draft-prompt')).toBeNull();
    editor.addText('Hi');
    await settle(1100);
    expect((await db.get(KEY))?.layerCount).toBe(1);
  });

  it('an edit made while the database is still opening is saved as soon as saving starts', async () => {
    const realGet = db.get.bind(db);
    vi.spyOn(db, 'get').mockImplementation(async (k) => {
      await new Promise((r) => setTimeout(r, 500)); // the first open of the database is slow
      return realGet(k);
    });
    const editor = await newEditor();
    mount(editor);
    await settle(50);
    editor.addText('early');
    await settle(100);
    expect(await realGet(KEY)).toBeUndefined();
    await settle(2000);
    expect((await realGet(KEY))?.layerCount).toBe(1);
  });

  it('an edit made before a prompt appeared does not overwrite the draft the person has not answered for', async () => {
    await seed(db);
    const realGet = db.get.bind(db);
    vi.spyOn(db, 'get').mockImplementation(async (k) => {
      await new Promise((r) => setTimeout(r, 500));
      return realGet(k);
    });
    const editor = await newEditor();
    mount(editor);
    await settle(50);
    editor.addText('early');
    await settle(600);
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    await settle(8000);
    expect((await realGet(KEY))?.revision).toBe(1);
  });

  describe('the restore prompt', () => {
    it('offers Continue your draft and Start fresh in a modal dialog, first button focused', async () => {
      await seed(db);
      mount(await newEditor());
      await settle();
      const dialog = screen.getByTestId('draft-prompt');
      expect(dialog).toHaveAttribute('open');
      expect(within(dialog).getByRole('heading', { name: 'Continue your draft?' })).toBeInTheDocument();
      expect(within(dialog).getByText(/Crew Tee \(Navy, size L\)/)).toBeInTheDocument();
      expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Continue your draft', 'Start fresh']);
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Continue your draft' }));
    });

    it('Continue restores in order: let the editor settle, colour, size, then the design', async () => {
      await seed(db);
      const editor = await newEditor();
      const calls: string[] = [];
      for (const name of ['whenIdle', 'setColor', 'setSize', 'loadState'] as const) {
        const real = (editor[name] as (...a: never[]) => unknown).bind(editor);
        (editor as unknown as Record<string, unknown>)[name] = (...a: never[]) => {
          calls.push(name);
          return real(...a);
        };
      }
      const { announce } = mount(editor);
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Continue your draft' }));
      await settle();
      expect(calls).toEqual(expect.arrayContaining(['whenIdle', 'setColor', 'setSize', 'loadState']));
      expect(calls.indexOf('whenIdle')).toBeLessThan(calls.indexOf('setColor'));
      expect(calls.indexOf('setColor')).toBeLessThan(calls.indexOf('setSize'));
      expect(calls.indexOf('setSize')).toBeLessThan(calls.indexOf('loadState'));
      expect(editor.getGarment()).toEqual({ color: 'navy', size: 'L' });
      expect(editor.getLayers().map((l) => l.name)).toEqual(['Hello']);
      expect(screen.queryByTestId('draft-prompt')).toBeNull();
      expect(announce).toHaveBeenCalledWith('Your draft was opened.');
    });

    it('a draft saved with slanted elements opens straightened, and says so on screen and aloud (step 9: slanting is off)', async () => {
      // the fake editor keeps its own state; the slanted Fabric objects ride along as they would in a Simple editor draft
      const plain = await seed(db);
      await db.remove(KEY);
      await seed(db, 'ana', { state: { ...(plain.state as object), objects: [{ layerId: 'a', skewX: 18, skewY: 0 }, { layerId: 'b', skewX: 0, skewY: 0 }] } });
      const editor = await newEditor();
      let loaded: unknown = null;
      const real = editor.loadState.bind(editor);
      editor.loadState = (s) => {
        loaded = s.state;
        return real(s);
      };
      const { announce } = mount(editor);
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Continue your draft' }));
      await settle();
      expect((loaded as { objects: { skewX: number }[] }).objects.map((o) => o.skewX)).toEqual([0, 0]);
      expect(screen.getByTestId('draft-straightened')).toHaveTextContent('One slanted element was straightened');
      expect(announce).toHaveBeenCalledWith(expect.stringMatching(/^Your draft was opened\. One slanted element was straightened/));
    });

    it('restoring does not count as an edit: nothing is written until the person changes something', async () => {
      await seed(db);
      const editor = await newEditor();
      mount(editor);
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Continue your draft' }));
      await settle(6000);
      expect((await db.get(KEY))?.revision).toBe(1);
      editor.addText('more');
      await settle(1100);
      expect((await db.get(KEY))?.revision).toBe(2);
      expect((await db.get(KEY))?.layerCount).toBe(2);
    });

    it('Start fresh keeps the old draft until the first edit; leaving without editing deletes nothing', async () => {
      await seed(db);
      const editor = await newEditor();
      const { view } = mount(editor);
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
      await settle(6000);
      expect(editor.getLayers()).toEqual([]);
      expect((await db.get(KEY))?.revision).toBe(1);
      view.unmount();
      await settle(6000);
      expect((await db.get(KEY))?.layerCount).toBe(1);
      // a second visit sees the draft again
      const again = mount(await newEditor());
      await settle();
      expect(screen.getByTestId('draft-prompt')).toBeInTheDocument();
      again.view.unmount();
    });

    it('after Start fresh the first edit replaces the old draft (no conflict), pictures included', async () => {
      await seed(db, 'ana', {}, true);
      expect(await db.assetKeys()).toHaveLength(1);
      const editor = await newEditor();
      mount(editor);
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
      editor.addText('brand new');
      await settle(1100);
      const row = await db.get(KEY);
      expect(row?.revision).toBe(2);
      expect(row?.assetIds).toEqual([]);
      expect(await db.assetKeys()).toEqual([]);
      expect(screen.queryByTestId('draft-conflict')).toBeNull();
    });

    it('Escape does not close it, and a browser that closes it anyway gets it opened again', async () => {
      await seed(db);
      mount(await newEditor());
      await settle();
      const dialog = screen.getByTestId('draft-prompt') as HTMLDialogElement;
      const esc = new Event('cancel', { cancelable: true });
      dialog.dispatchEvent(esc);
      expect(esc.defaultPrevented).toBe(true);
      dialog.close(); // what Chromium does on a second Escape with no click between
      await settle();
      expect(dialog.open).toBe(true);
    });

    it('Tab and Shift+Tab stay inside the dialog', async () => {
      await seed(db);
      mount(await newEditor());
      await settle();
      const dialog = screen.getByTestId('draft-prompt');
      const [first, last] = within(dialog).getAllByRole('button') as [HTMLElement, HTMLElement];
      last.focus();
      fireEvent.keyDown(last, { key: 'Tab' });
      expect(document.activeElement).toBe(first);
      fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(last);
      document.body.focus(); // focus that has already left: Tab brings it back
      fireEvent.keyDown(dialog, { key: 'Tab' });
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('a damaged draft offers only Start fresh, and Start fresh works', async () => {
      await seed(db, 'ana', { state: null as unknown as object });
      const editor = await newEditor();
      mount(editor);
      await settle();
      const dialog = screen.getByTestId('draft-prompt');
      expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Start fresh']);
      expect(dialog.textContent).toMatch(/damaged/);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start fresh' }));
      editor.addText('new');
      await settle(1100);
      expect((await db.get(KEY))?.revision).toBe(2);
    });

    it('a draft whose picture is missing turns into the damaged prompt when Continue is pressed, and the design is untouched', async () => {
      await seed(db, 'ana', {}, true);
      vi.spyOn(db, 'getAssets').mockResolvedValue({}); // the row names a picture whose record is gone
      const editor = await newEditor();
      editor.addText('mine');
      mount(editor);
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Continue your draft' }));
      await settle();
      const dialog = screen.getByTestId('draft-prompt');
      expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Start fresh']);
      expect(editor.getLayers().map((l) => l.name)).toEqual(['mine']);
    });

    it('a draft from a newer version: Keep it works without saving and leaves it alone', async () => {
      await seed(db, 'ana', { format: DRAFT_FORMAT + 1 });
      const editor = await newEditor();
      mount(editor);
      await settle();
      const dialog = screen.getByTestId('draft-prompt');
      expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Keep it (work without saving)', 'Discard']);
      fireEvent.click(within(dialog).getByRole('button', { name: /Keep it/ }));
      await settle();
      expect(screen.getByTestId('drafts-kept')).toBeInTheDocument();
      editor.addText('edit');
      await settle(6000);
      const row = (await db.get(KEY))!;
      expect(row.revision).toBe(1);
      expect(row.format).toBe(DRAFT_FORMAT + 1);
    });

    it('a draft from a newer snapshot version is "newer" as well, and Discard deletes it and starts saving', async () => {
      await seed(db, 'ana', { schemaVersion: SNAPSHOT_SCHEMA_VERSION + 1 });
      const editor = await newEditor();
      mount(editor);
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      await settle();
      expect(await db.get(KEY)).toBeUndefined();
      editor.addText('new');
      await settle(1100);
      expect((await db.get(KEY))?.revision).toBe(1);
    });
  });

  it('when drafts cannot work here the person is told, with a way to download the design', async () => {
    setDraftDbForTests(null);
    const { onDownload } = mount(await newEditor());
    await settle();
    const note = screen.getByTestId('drafts-unavailable');
    expect(note.textContent).toMatch(/not available in this browser/);
    expect(note.textContent).toMatch(/cannot be opened again for editing/);
    fireEvent.click(within(note).getByRole('button', { name: 'Download design' }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it('too many pictures: a persistent alert with Download design and the plain line, which clears when the design fits again', async () => {
    const editor = await newEditor();
    const { onDownload } = mount(editor);
    await settle();
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push(await editor.addImage(png(), `p${i}`));
    await settle(1100);
    const alert = screen.getByTestId('draft-alert');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert.textContent).toMatch(/9 pictures.*at most 8/);
    expect(alert.textContent).toMatch(/cannot be opened again for editing/);
    fireEvent.click(within(alert).getByRole('button', { name: 'Download design' }));
    expect(onDownload).toHaveBeenCalledTimes(1);
    await settle(10_000);
    expect(screen.getByTestId('draft-alert')).toBeInTheDocument(); // persistent: nothing dismisses it
    editor.removeLayer(ids[0]!);
    await settle(1100);
    expect(screen.queryByTestId('draft-alert')).toBeNull();
    expect((await db.get(KEY))?.assetIds).toHaveLength(8);
  });

  it('a conflict asks before overwriting: replace writes this tab\'s design, and the other choice stops saving here', async () => {
    const editor = await newEditor();
    mount(editor);
    await settle();
    editor.addText('mine');
    await settle(1100);
    // another tab saves
    const other = await newEditor();
    const rival = new DraftSaver({ db, editor: other, user: 'ana', productId: 'p1', engine: 'simple', describe: () => ({ sku: 's', productName: 'Crew Tee', colorName: 'White' }), baseRevision: 1, storedAssetIds: [] });
    rival.arm();
    other.addText('theirs');
    await settle(1100);
    expect((await db.get(KEY))?.revision).toBe(2);
    editor.addText('mine 2');
    await settle(1100);
    const conflict = screen.getByTestId('draft-conflict');
    expect(conflict).toHaveAttribute('role', 'alert');
    expect((await db.get(KEY))?.revision).toBe(2); // not overwritten
    fireEvent.click(within(conflict).getByRole('button', { name: /Replace it with this tab/ }));
    await settle();
    expect(screen.queryByTestId('draft-conflict')).toBeNull();
    expect((await db.get(KEY))?.revision).toBe(3);

    // second conflict, other answer
    rival.resolveConflict('overwrite'); // not paused: no-op
    const other2 = await newEditor();
    const rival2 = new DraftSaver({ db, editor: other2, user: 'ana', productId: 'p1', engine: 'simple', describe: () => ({ sku: 's', productName: 'Crew Tee', colorName: 'White' }), baseRevision: 3, storedAssetIds: [] });
    rival2.arm();
    other2.addText('again');
    await settle(1100);
    editor.addText('mine 3');
    await settle(1100);
    fireEvent.click(within(screen.getByTestId('draft-conflict')).getByRole('button', { name: 'Do not save in this tab' }));
    await settle();
    expect(screen.getByTestId('drafts-declined').textContent).toMatch(/not saving/);
    expect((await db.get(KEY))?.revision).toBe(4);
  });

  it('leaving the page writes the unsaved edits at once through leaveRef', async () => {
    const editor = await newEditor();
    const { leaveRef } = mount(editor);
    await settle();
    expect(leaveRef.current).toBeTypeOf('function');
    editor.addText('last second');
    expect(await db.get(KEY)).toBeUndefined();
    await act(async () => {
      await leaveRef.current!();
    });
    expect((await db.get(KEY))?.layerCount).toBe(1);
  });

  describe('sign-out', () => {
    it('a design whose first save is still pending cannot create a draft after sign-out', async () => {
      // no draft exists, so the revision check cannot refuse a late write: only the seal stops it
      const editor = await newEditor();
      mount(editor);
      await settle();
      editor.addText('typed, never saved yet');
      const done = clearDraftsOnSignOut('ana');
      await settle(0);
      await done;
      await settle(10_000);
      expect(await db.list('ana')).toEqual([]);
      expect(await db.assetKeys()).toEqual([]);
    });

    it('seals the saver first, then clears that person\'s drafts: a pending save cannot bring one back', async () => {
      await seed(db, 'ana');
      await seed(db, 'ben');
      const editor = await newEditor();
      mount(editor);
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Continue your draft' }));
      await settle();
      editor.addText('typed just before signing out'); // a save is now scheduled for 1 s later
      const done = clearDraftsOnSignOut('ana');
      await settle(0);
      await done;
      await settle(10_000); // the scheduled save would fire here if the saver had not been sealed
      expect(await db.list('ana')).toEqual([]);
      expect(await db.assetKeys()).toEqual([]);
      expect((await db.list('ben')).length).toBe(1);
    });
  });
});
