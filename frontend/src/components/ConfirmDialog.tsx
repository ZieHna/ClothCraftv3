import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A yes/no question in a native modal dialog (the page behind is inert). Escape and "No" both cancel. Focus starts on the safe choice
 * ("No"), Tab stays inside, and when the dialog closes focus goes back to whatever opened it.
 */
export function ConfirmDialog({ title, yes, no, busy = false, onYes, onNo, children, testId }: {
  title: string; yes: string; no: string; busy?: boolean; onYes: () => void; onNo: () => void; children?: ReactNode; testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const opener = useRef<Element | null>(null);
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    const d = ref.current;
    if (d && !d.open) d.showModal();
    safe.current?.focus();
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
        e.preventDefault();               // Escape: the same as "No", done by React so the state and the dialog stay in step
        if (!busy) onNo();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return;
        const d = ref.current;
        if (!d) return;
        const stops = [...d.querySelectorAll<HTMLElement>('button')];
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
      className="m-auto w-[min(92vw,30rem)] border border-brown bg-cream p-0 text-text backdrop:bg-ink/55"
    >
      <div className="m-2 border border-dashed border-brown/70 p-5">
        <h2 id={titleId} className="text-3xl">
          {title}
        </h2>
        {children && <div className="mt-3">{children}</div>}
        <div className="mt-5 flex flex-wrap gap-3">
          <button type="button" onClick={() => !busy && onYes()} aria-disabled={busy || undefined} className="btn btn-primary aria-disabled:cursor-wait aria-disabled:opacity-70" data-testid="confirm-yes">
            {busy ? 'Working…' : yes}
          </button>
          <button ref={safe} type="button" onClick={() => !busy && onNo()} className="btn btn-secondary" data-testid="confirm-no">
            {no}
          </button>
        </div>
      </div>
    </dialog>
  );
}
