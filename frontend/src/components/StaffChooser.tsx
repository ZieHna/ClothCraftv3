import { useEffect, useId, useRef } from 'react';
import { useNavigate } from 'react-router';

/**
 * The "CC user" popup: two ways in. Admin login goes to /admin/login (only an Administrator account is accepted there), Employee login to
 * /staff (the employee dashboard). A native modal dialog: the page behind is inert, Escape closes it, Tab stays inside, focus starts on the
 * first button and goes back to whatever had it (the menu button) when the dialog closes. Loaded on demand (HeaderMenu lazy-loads it).
 * `admin` is false in the frozen mock build, which has no admin area, so the Admin button is not offered there.
 */
export function StaffChooser({ admin, onClose }: { admin: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const navigate = useNavigate();
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    const d = ref.current;
    if (d && !d.open) d.showModal();
    d?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      if (ref.current?.open) ref.current.close();
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid="staff-chooser"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
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
      className="m-auto w-[min(92vw,26rem)] border border-brown bg-cream p-0 text-text backdrop:bg-ink/55"
    >
      <div className="m-2 border border-dashed border-brown/70 p-5">
        <h2 id={titleId} className="text-3xl">
          Staff sign in
        </h2>
        <p className="mt-2 text-sm text-muted">Choose how you sign in. Customers sign in with Login.</p>
        <div className="mt-5 flex flex-col gap-3">
          {admin && (
            <button type="button" className="btn btn-primary w-full" onClick={() => go('/admin/login')} data-testid="chooser-admin">
              Admin login
            </button>
          )}
          <button type="button" className="btn btn-primary w-full" onClick={() => go('/staff')} data-testid="chooser-employee">
            Employee login
          </button>
          <button type="button" className="btn btn-secondary w-full" onClick={onClose} data-testid="chooser-cancel">
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
}
