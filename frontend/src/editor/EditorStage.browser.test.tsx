// Real browser (Edge): the Fabric editor under React 19 StrictMode, which mounts, unmounts and mounts again, and a
// navigation away from the editor and back. Every editor stage that is ever created must be removed again, and nothing
// may be logged to console.error or console.warn.
import { StrictMode } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorStage } from './EditorStage';

const GARMENT = {
  image: '/garments/m-tee/white.webp',
  color: 'white',
  size: 'M',
  colorImages: { white: '/garments/m-tee/white.webp', navy: '/garments/m-tee/navy.webp' },
};

describe('EditorStage lifecycle (real browser)', () => {
  let created: Element[];
  let observer: MutationObserver;
  let errors: ReturnType<typeof vi.spyOn>;
  let warnings: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    created = [];
    observer = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof Element && n.matches('[data-editor-stage]')) created.push(n);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    errors = vi.spyOn(console, 'error');
    warnings = vi.spyOn(console, 'warn');
  });
  afterEach(() => {
    observer.disconnect();
    vi.restoreAllMocks();
  });

  const liveStages = () => document.querySelectorAll('[data-editor-stage]').length;

  it('StrictMode double mount leaves exactly one editor, and navigating away and back leaks nothing', async () => {
    const router = createMemoryRouter(
      [
        { path: '/design', element: <EditorStage mode="simple" garment={GARMENT} /> },
        { path: '/browse', element: <p>Browse page</p> },
      ],
      { initialEntries: ['/design'] },
    );
    const view = render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );

    await waitFor(() => expect(liveStages()).toBe(1));
    await waitFor(() => expect(view.getByRole('button', { name: 'Add text' })).toBeEnabled());
    await new Promise((r) => setTimeout(r, 300)); // give a stray second editor time to appear if one would
    expect(liveStages()).toBe(1);
    expect(document.querySelectorAll('[data-testid="editor-host"] canvas')).toHaveLength(3);

    // use it, so there is a design (and its listeners) to tear down
    act(() => view.getByRole('button', { name: 'Add rectangle' }).click());
    await waitFor(() => expect(view.getByRole('heading', { name: 'Shape settings' })).toBeTruthy());

    await act(() => router.navigate('/browse'));
    expect(view.getByText('Browse page')).toBeTruthy();
    expect(liveStages()).toBe(0);
    expect(document.querySelectorAll('canvas')).toHaveLength(0);

    await act(() => router.navigate('/design'));
    await waitFor(() => expect(liveStages()).toBe(1));
    await waitFor(() => expect(view.getByRole('button', { name: 'Add text' })).toBeEnabled());
    expect(view.queryByRole('heading', { name: 'Shape settings' })).toBeNull(); // a fresh, empty design

    view.unmount();
    expect(liveStages()).toBe(0);
    expect(created.length).toBeGreaterThanOrEqual(2);
    for (const stage of created) expect(stage.isConnected).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  it('the Pro mode renders a notice and creates no editor', async () => {
    const view = render(
      <StrictMode>
        <EditorStage mode="pro" garment={GARMENT} />
      </StrictMode>,
    );
    expect(view.getByRole('status').textContent).toMatch(/not available yet/);
    await new Promise((r) => setTimeout(r, 100));
    expect(created).toHaveLength(0);
    view.unmount();
  });
});
