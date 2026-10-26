import { useEffect, useId, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  /** which opening this is (a new number each time the sheet is opened, even the same sheet again) */
  openId: number;
  title: string;
  /** the dialog has closed; called with the openId it was showing */
  onClose: (openId: number) => void;
  children: ReactNode;
}

const isField = (el: EventTarget | null): el is HTMLElement => el instanceof HTMLElement && el.matches('input, textarea, select');

/**
 * A panel that comes up from the bottom of a phone screen. It is a native modal <dialog>, so the browser provides the
 * focus trap, Escape to close, the inert page behind it and focus returning to the button that opened it. A Close button
 * is always there for people who do not have an Escape key. It has no animation under "reduce motion" (see .sheet in
 * index.css). It sits above the on-screen keyboard and shrinks to the visible area (--vv-bottom and --vv-h, set by
 * useVisualViewport), and a text field that is focused is scrolled into the visible part.
 *
 * The native close event arrives a few ms (measured up to 20) after the dialog has closed. By then a fast key may have
 * opened it again (a new openId) or opened another sheet, so a close event for a dialog that is open again is ignored, and
 * onClose says which opening closed so the parent clears only that one.
 */
export function BottomSheet({ open, openId, title, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const shownId = useRef(0);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      shownId.current = openId;
    }
    if (!open && dialog.open) dialog.close();
  }, [open, openId]);

  // keep the focused field visible when the keyboard opens (the visual viewport shrinks)
  useEffect(() => {
    const vv = window.visualViewport;
    if (!open || !vv) return;
    const reveal = () => {
      const el = document.activeElement;
      if (isField(el) && ref.current?.contains(el)) el.scrollIntoView({ block: 'center' });
    };
    vv.addEventListener('resize', reveal);
    return () => vv.removeEventListener('resize', reveal);
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        if (!ref.current?.open) onClose(shownId.current);
      }}
      onFocus={(e) => {
        if (isField(e.target)) setTimeout(() => (e.target as HTMLElement).scrollIntoView({ block: 'center' }), 250);
      }}
      onClick={(e) => e.target === ref.current && ref.current.close()}
      className="sheet bg-cream text-text"
      data-testid="sheet"
    >
      <div className="flex items-center justify-between gap-3 border-b border-tan px-4 py-2">
        <h2 id={titleId} className="text-2xl">
          {title}
        </h2>
        <button type="button" onClick={() => ref.current?.close()} className="btn btn-secondary min-h-11 min-w-11">
          Close
        </button>
      </div>
      <div className="sheet-body px-4 pb-4 pt-3">{open ? children : null}</div>
    </dialog>
  );
}
