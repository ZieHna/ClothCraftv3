// Real browser (Edge): a native <dialog>'s close event is queued, so it arrives a few ms after the dialog has closed. If the
// sheet is opened again in that gap (a fast Esc then Enter), the late event must not close it or tell the parent it closed.
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BottomSheet } from './BottomSheet';

describe('BottomSheet (real browser)', () => {
  it('ignores a close event that arrives after the sheet was opened again', async () => {
    const onClose = vi.fn();
    const view = (openId: number) => (
      <BottomSheet open openId={openId} title="Shapes" onClose={onClose}>
        <p>content</p>
      </BottomSheet>
    );
    const { rerender } = render(view(1));
    const dialog = document.querySelector('dialog')!;
    expect(dialog.open).toBe(true);

    let closeEvents = 0;
    const closed = new Promise<void>((resolve) =>
      dialog.addEventListener('close', () => {
        closeEvents++;
        resolve();
      }),
    );
    dialog.close(); // what Esc or the Close button does: the dialog closes now, its close event is only queued
    act(() => rerender(view(2))); // the next key opens the same sheet again before that event runs
    expect(closeEvents).toBe(0); // the race really happened: the event was still pending at the reopen

    await closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(dialog.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});
