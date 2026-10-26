import { useEffect, useId, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]';

/**
 * A native modal dialog that holds a form (ConfirmDialog is for yes/no questions). The page behind is inert, Escape closes it (unless `busy`),
 * Tab stays inside, focus starts on the first field and goes back to whatever opened the dialog when it closes.
 */
export function FormDialog({ title, busy = false, onClose, children, testId }: { title: string; busy?: boolean; onClose: () => void; children: ReactNode; testId?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    const d = ref.current;
    if (d && !d.open) d.showModal();
    d?.querySelector<HTMLElement>('input, select, textarea')?.focus();
    return () => {
      if (ref.current?.open) ref.current.close();
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
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
      className="m-auto w-[min(92vw,32rem)] border border-brown bg-cream p-0 text-text backdrop:bg-ink/55"
    >
      <div className="m-2 border border-dashed border-brown/70 p-5">
        <h2 id={titleId} className="text-3xl">
          {title}
        </h2>
        <div className="mt-3">{children}</div>
      </div>
    </dialog>
  );
}
