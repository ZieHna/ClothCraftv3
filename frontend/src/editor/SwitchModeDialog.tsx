import { useEffect, useRef } from 'react';

interface Props {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirms leaving the current engine. Drafts do not exist yet, so this says plainly that unsaved work is lost. */
export function SwitchModeDialog({ open, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="switch-title"
      onClose={onCancel}
      className="m-auto w-[min(92vw,28rem)] border border-brown bg-cream p-0 text-text backdrop:bg-ink/55"
    >
      <div className="m-2 border border-dashed border-brown/70 p-6">
        <h2 id="switch-title" className="text-3xl">Switch editor?</h2>
        <p className="mt-3">
          Switching between Simple and Pro starts a new design. Your current design can&rsquo;t be moved across, and your unsaved work will
          be lost.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={onConfirm} className="btn btn-primary">
            Start a new design
          </button>
          <button type="button" autoFocus onClick={() => ref.current?.close()} className="btn btn-secondary">
            Keep working
          </button>
        </div>
      </div>
    </dialog>
  );
}
