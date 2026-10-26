// Real browser (Edge): the Fabric editor with real IndexedDB. A design is built, saved by the editor screen itself, the
// screen is left, and a new visit restores it. Keys, Escape and layout are checked by scripts/check-editor-drafts.mjs.
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorStage } from '../editor/EditorStage';
import { PNG_B64 } from '../test/fixtures';
import { setDraftDbForTests } from './db';
import { openIdbDb } from './idbDb';
import { draftKey, type DraftDb } from './types';

const GARMENT = {
  image: '/garments/m-tee/white.webp',
  color: 'white',
  size: 'M',
  colorImages: { white: '/garments/m-tee/white.webp', navy: '/garments/m-tee/navy.webp' },
};
const OPTIONS = {
  productName: 'Crew Tee',
  colors: [
    { id: 'white', name: 'White', hex: '#fff' },
    { id: 'navy', name: 'Navy', hex: '#123' },
  ],
  sizes: ['S', 'M', 'L'],
  soldOut: () => false,
};
const KEY = draftKey('ana', 'p1', 'simple');
const DRAFTS = { user: 'ana', productId: 'p1', sku: 'P1-WHT-M' };

const picture = () => new File([Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))], 'logo.png', { type: 'image/png' });
const stages = () => document.querySelectorAll('[data-editor-stage]').length;
const layers = (view: ReturnType<typeof render>) => view.container.querySelectorAll('[data-testid="layers-list"] li');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('drafts with the real editor (Edge)', () => {
  let db: DraftDb;
  let dbName: string;
  beforeEach(async () => {
    dbName = `cc-stage-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db = await openIdbDb(dbName);
    setDraftDbForTests(db);
  });
  afterEach(() => {
    cleanup();
    setDraftDbForTests(undefined);
  });

  const open = () => {
    const router = createMemoryRouter(
      [
        { path: '/design', element: <EditorStage mode="simple" garment={GARMENT} options={OPTIONS} drafts={DRAFTS} /> },
        { path: '/browse', element: <p>Browse page</p> },
      ],
      { initialEntries: ['/design'] },
    );
    const view = render(<RouterProvider router={router} />);
    return { router, view };
  };
  const ready = async (view: ReturnType<typeof render>) => {
    await waitFor(() => expect(view.getByRole('button', { name: 'Add text' })).toBeEnabled());
    await waitFor(() => expect(stages()).toBe(1));
  };
  const cleanUp = async () => {
    db.close();
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase(dbName);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  };

  it('saves what is edited, flushes the last edit when the screen is left, and a new visit restores all of it', async () => {
    const first = open();
    await ready(first.view);
    act(() => first.view.getByRole('button', { name: 'Add text' }).click());
    const fileInput = first.view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [picture()] } });
    });
    await waitFor(() => expect(layers(first.view)).toHaveLength(2));
    await waitFor(async () => expect((await db.get(KEY))?.layerCount).toBe(2), { timeout: 4000 });
    expect(await db.assetKeys()).toHaveLength(1);
    const stored = (await db.get(KEY))!;
    expect(stored).toMatchObject({ garment: { color: 'white', size: 'M' }, sku: 'P1-WHT-M', productName: 'Crew Tee', colorName: 'White', revision: 1 });
    const savedAt = stored.revision;

    // one more edit, then leave at once: the debounce has not fired, the leave must write it
    act(() => first.view.getByRole('button', { name: 'Add rectangle' }).click());
    await waitFor(() => expect(layers(first.view)).toHaveLength(3));
    expect((await db.get(KEY))?.layerCount).toBe(2);
    await act(() => first.router.navigate('/browse'));
    await waitFor(async () => expect((await db.get(KEY))?.layerCount).toBe(3), { timeout: 2000 });
    expect((await db.get(KEY))!.revision).toBeGreaterThan(savedAt);
    await waitFor(() => expect(stages()).toBe(0)); // the editor was still torn down after the flush
    first.view.unmount();

    // a new visit
    const second = open();
    await ready(second.view);
    const dialog = await waitFor(() => {
      const d = document.querySelector<HTMLDialogElement>('[data-testid="draft-prompt"]');
      expect(d?.open).toBe(true);
      return d!;
    });
    expect(within(dialog).getByRole('heading', { name: 'Continue your draft?' })).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Continue your draft' })); // natively focused
    expect(layers(second.view)).toHaveLength(0);
    await act(async () => {
      within(dialog).getByRole('button', { name: 'Continue your draft' }).click();
    });
    await waitFor(() => expect(layers(second.view)).toHaveLength(3));
    expect(document.querySelector('[data-testid="draft-prompt"]')).toBeNull();
    await sleep(1500);
    expect((await db.get(KEY))!.revision).toBe(2); // restoring is not an edit: still the revision the leave wrote
    second.view.unmount();
    await cleanUp();
  });

  it('deleting a picture from the design removes its stored copy at the next save', async () => {
    const { view } = open();
    await ready(view);
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [picture()] } });
    });
    await waitFor(async () => expect(await db.assetKeys()).toHaveLength(1), { timeout: 4000 });
    await act(async () => {
      view.getAllByRole('button', { name: /Delete/ })[0]!.click();
    });
    act(() => view.getByRole('button', { name: 'Add text' }).click()); // a design with no layers is never written, so keep one
    await waitFor(async () => expect(await db.assetKeys()).toEqual([]), { timeout: 4000 });
    expect((await db.get(KEY))?.assetIds).toEqual([]);
    view.unmount();
    await cleanUp();
  });
});
