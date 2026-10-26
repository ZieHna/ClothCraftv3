import { useEffect, useId, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled])';

/**
 * The admin navigation as a drawer, for screens too narrow for the sidebar. A native modal dialog: the page behind is inert, Escape closes it,
 * a press on the dimmed area outside closes it, Tab stays inside, focus starts on the first control and goes back to whatever opened the drawer
 * (the menu button) when it closes. It is mounted only while open.
 */
export function AdminDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    const d = ref.current;
    if (d && !d.open) d.showModal();
    d?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      if (ref.current?.open) ref.current.close();
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      id="admin-drawer"
      aria-labelledby={titleId}
      data-testid="admin-drawer"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // the panel fills the dialog, so only the dimmed area outside it reaches the dialog itself
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return;
        const d = ref.current;
        if (!d) return;
        const stops = [...d.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (!first || !last) return;
        const at = document.activeElement;
        if (!d.contains(at) || (e.shiftKey && at === first)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (!e.shiftKey && at === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      className="fixed inset-y-0 left-0 m-0 h-dvh max-h-dvh w-72 max-w-[86vw] border-r border-brown bg-cream p-0 text-text backdrop:bg-ink/55"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-tan px-3 py-2">
          <h2 id={titleId} className="text-xl">
            Admin menu
          </h2>
          <button type="button" onClick={onClose} className="btn btn-secondary btn-small" data-testid="drawer-close">
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </dialog>
  );
}
