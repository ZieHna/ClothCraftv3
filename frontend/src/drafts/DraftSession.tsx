import { useCallback, useEffect, useId, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { GarmentOptions } from '../editor/panel/ColorSizePicker';
import { STRAIGHTENED_NOTE, straightenSnapshot } from '../editor/skew';
import { SnapshotError, type EditorMode, type SimpleEditorTools } from '../editor/types';
import { getDraftDb } from './db';
import { registerSaver } from './registry';
import { DraftSaver, type DraftMeta, type SaveStatus } from './saver';
import { draftKey, parseRow, type DraftDb, type DraftRow } from './types';

interface Props {
  editor: SimpleEditorTools;
  user: string;
  productId: string;
  engine: EditorMode;
  /** the garment as the page knows it now (sku, product and colour names), read when a save is written */
  describe: () => DraftMeta;
  options?: GarmentOptions;
  /** saves the print picture (design only). The editor screen owns how. */
  onDownload: () => void;
  announce: (text: string) => void;
  /** set while a saver is running: leaving the page calls it (before the editor is torn down) so the last edits are not lost */
  leaveRef: MutableRefObject<(() => Promise<void>) | null>;
}

type Phase =
  | { name: 'checking' }
  | { name: 'continue'; row: DraftRow }
  | { name: 'restoring'; row: DraftRow }
  | { name: 'damaged'; message: string; revision: number | null }
  | { name: 'newer' }
  | { name: 'kept' }
  | { name: 'unavailable' }
  | { name: 'ready' };

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The drafts side of the editor screen. When the editor is ready it looks for this person's draft of this product (key =
 * user + product + engine; the garment is inside the row) and either starts saving or asks what to do:
 *   a draft            -> "Continue your draft" / "Start fresh". Start fresh KEEPS the old draft until the first edit.
 *   a damaged draft    -> only "Start fresh"
 *   a newer-format one -> "Keep it (work without saving)" / "Discard"
 * The prompt is a modal <dialog> that Escape does not close and Tab cannot leave. Nothing is saved until the person has
 * answered and then edits. Everything that cannot be saved is said out loud, in an alert with a way to download the design.
 */
export function DraftSession({ editor, user, productId, engine, describe, options, onDownload, announce, leaveRef }: Props) {
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [straightened, setStraightened] = useState(0);
  const dbRef = useRef<DraftDb | null>(null);
  const saverRef = useRef<DraftSaver | null>(null);
  const describeRef = useRef(describe);
  describeRef.current = describe;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const key = draftKey(user, productId, engine);
  const alive = useRef(true);
  const stopSaver = useRef<(() => void) | null>(null);
  // The editor can be edited in the moments before the answer is known (opening the database the first time takes a while).
  // Such an edit is real work: remember it, and once saving starts, save it. A restore replaces the design, so it clears this.
  const editedBefore = useRef(false);
  useEffect(() => editor.onChange(() => (editedBefore.current = true)), [editor]);

  const startSaver = useCallback(
    (db: DraftDb, baseRevision: number, storedAssetIds: readonly string[]) => {
      const saver = new DraftSaver({
        db,
        editor,
        user,
        productId,
        engine,
        describe: () => describeRef.current(),
        baseRevision,
        storedAssetIds,
      });
      const unregister = registerSaver(saver);
      const off = saver.onStatus(() => setStatus(saver.status));
      const leave = () => saver.flush();
      saverRef.current = saver;
      leaveRef.current = leave;
      saver.arm();
      if (editedBefore.current) saver.touch();
      editedBefore.current = false;
      stopSaver.current = () => {
        off();
        unregister();
        saver.dispose();
        if (leaveRef.current === leave) leaveRef.current = null;
      };
      setPhase({ name: 'ready' });
    },
    [editor, user, productId, engine, leaveRef],
  );

  useEffect(() => {
    alive.current = true;
    (async () => {
      const db = await getDraftDb();
      if (!alive.current) return;
      if (!db) {
        setPhase({ name: 'unavailable' });
        return;
      }
      dbRef.current = db;
      try {
        const raw = await db.get(key);
        if (!alive.current) return;
        if (raw === undefined) {
          startSaver(db, 0, []);
          return;
        }
        // a prompt is coming: whatever was drawn in the moments before it is not carried over a draft the person has not answered for
        editedBefore.current = false;
        const parsed = parseRow(raw, key);
        if (parsed.kind === 'ok') setPhase({ name: 'continue', row: parsed.row });
        else if (parsed.kind === 'newer') setPhase({ name: 'newer' });
        else setPhase({ name: 'damaged', message: parsed.why, revision: typeof (raw as { revision?: unknown }).revision === 'number' ? (raw as { revision: number }).revision : null });
      } catch {
        if (alive.current) setPhase({ name: 'unavailable' });
      }
    })();
    return () => {
      alive.current = false;
      stopSaver.current?.();
      stopSaver.current = null;
      saverRef.current = null;
    };
  }, [key, startSaver]);

  const restore = async (row: DraftRow) => {
    const db = dbRef.current;
    if (!db) return;
    setPhase({ name: 'restoring', row });
    try {
      const assets = await db.getAssets(row.key, row.assetIds);
      if (row.assetIds.some((id) => !(id in assets))) throw new SnapshotError('A picture in this draft is missing.');
      // loadBase has run (the editor screen waits for it). Order: let the editor settle, garment, then the design.
      await editor.whenIdle();
      const o = optionsRef.current;
      if (!o || o.colors.some((c) => c.id === row.garment.color)) {
        try {
          editor.setColor(row.garment.color);
        } catch {
          /* the product no longer has that colour: the colour from the page stays */
        }
      }
      if (!o || o.sizes.includes(row.garment.size)) editor.setSize(row.garment.size);
      // a draft saved while slanting was still possible is straightened, and the screen says so (see editor/skew.ts)
      const { snapshot, straightened } = straightenSnapshot({ schemaVersion: row.schemaVersion, engine: row.engine, state: row.state, assets });
      await editor.loadState(snapshot);
      if (!alive.current) return;
      editedBefore.current = false; // the design on screen is now the draft itself
      startSaver(db, row.revision, row.assetIds);
      setStraightened(straightened);
      announce(straightened ? `Your draft was opened. ${STRAIGHTENED_NOTE(straightened)}` : 'Your draft was opened.');
    } catch (e) {
      if (alive.current) setPhase({ name: 'damaged', message: e instanceof SnapshotError ? e.message : 'This draft could not be opened.', revision: row.revision });
    }
  };

  /** Start fresh: the saved draft stays exactly as it is until the first edit replaces it. */
  const startFresh = async (revision: number | null) => {
    const db = dbRef.current;
    if (!db) return;
    try {
      // a row whose revision cannot be read cannot be written over safely: it is unusable anyway, so it goes now
      if (revision === null) {
        await db.remove(key);
        revision = 0;
      }
      if (!alive.current) return;
      startSaver(db, revision, []);
      announce('Starting a new design. Your saved draft is kept until you make a change.');
    } catch {
      if (alive.current) setPhase({ name: 'unavailable' });
    }
  };

  const discard = async () => {
    const db = dbRef.current;
    if (!db) return;
    try {
      await db.remove(key);
      if (alive.current) startSaver(db, 0, []);
    } catch {
      if (alive.current) setPhase({ name: 'unavailable' });
    }
  };

  const saver = saverRef.current;
  const download = (
    <>
      <button type="button" onClick={onDownload} className="btn btn-secondary btn-small">
        Download design
      </button>
      <p className="mt-1 text-sm text-muted">The download is a picture for printing or sharing. It cannot be opened again for editing.</p>
    </>
  );

  let prompt: ReactNode = null;
  if (phase.name === 'continue' || phase.name === 'restoring') {
    const row = phase.row;
    const working = phase.name === 'restoring';
    prompt = (
      <ModalPrompt
        title="Continue your draft?"
        actions={[
          { label: working ? 'Opening your draft…' : 'Continue your draft', primary: true, disabled: working, onClick: () => void restore(row) },
          { label: 'Start fresh', disabled: working, onClick: () => void startFresh(row.revision) },
        ]}
      >
        <p>
          You have an unfinished design for {row.productName} ({row.colorName}, size {row.garment.size}), saved {when(row.updatedAt)}. It has {row.layerCount} {row.layerCount === 1 ? 'layer' : 'layers'}.
        </p>
        <p className="mt-2 text-sm text-muted">Start fresh keeps your saved draft until you make your first change.</p>
      </ModalPrompt>
    );
  } else if (phase.name === 'damaged') {
    const revision = phase.revision;
    prompt = (
      <ModalPrompt title="This draft cannot be opened" actions={[{ label: 'Start fresh', primary: true, onClick: () => void startFresh(revision) }]}>
        <p>{phase.message}</p>
        <p className="mt-2 text-sm text-muted">You can start a new design. The damaged draft is replaced when you make your first change.</p>
      </ModalPrompt>
    );
  } else if (phase.name === 'newer') {
    prompt = (
      <ModalPrompt
        title="This draft is from a newer version"
        actions={[
          { label: 'Keep it (work without saving)', primary: true, onClick: () => setPhase({ name: 'kept' }) },
          { label: 'Discard', onClick: () => void discard() },
        ]}
      >
        <p>A newer version of this site saved a draft that this version cannot open. Keep it as it is and work without saving, or discard it.</p>
      </ModalPrompt>
    );
  }

  return (
    <>
      {prompt}
      {phase.name === 'unavailable' && (
        <div role="status" className="mt-3 px-4 text-sm text-text sm:px-0" data-testid="drafts-unavailable">
          <p>Drafts are not available in this browser, so this design is not being saved.</p>
          <div className="mt-2">{download}</div>
        </div>
      )}
      {straightened > 0 && (
        <p role="status" className="mt-3 border border-brown bg-cream p-3 text-sm font-medium text-brown-dark max-sm:mx-4" data-testid="draft-straightened">
          {STRAIGHTENED_NOTE(straightened)}
        </p>
      )}
      {phase.name === 'kept' && (
        <p role="status" className="mt-3 px-4 text-sm text-text sm:px-0" data-testid="drafts-kept">
          Your saved draft is kept as it is. Changes in this session are not being saved.
        </p>
      )}
      {status.kind === 'blocked' && (
        <div role="alert" className="mt-3 border border-brown bg-cream p-3 text-sm text-text max-sm:mx-4" data-testid="draft-alert">
          <p className="font-medium text-brown-dark">{status.message}</p>
          <div className="mt-2 flex flex-wrap items-start gap-3">
            {status.reason === 'storage' && (
              <button type="button" onClick={() => saver?.retry()} className="btn btn-secondary btn-small">
                Try again
              </button>
            )}
            <div>{download}</div>
          </div>
        </div>
      )}
      {status.kind === 'conflict' && (
        <div role="alert" className="mt-3 border border-brown bg-cream p-3 text-sm text-text max-sm:mx-4" data-testid="draft-conflict">
          <p className="font-medium text-brown-dark">
            This design was saved from another tab{status.otherUpdatedAt ? ` at ${when(status.otherUpdatedAt)}` : ''}, and this tab has not seen that version. Saving is paused so nothing is overwritten.
          </p>
          <div className="mt-2 flex flex-wrap items-start gap-3">
            <button type="button" onClick={() => saver?.resolveConflict('overwrite')} className="btn btn-primary btn-small">
              Replace it with this tab&rsquo;s design
            </button>
            <button type="button" onClick={() => saver?.resolveConflict('stop')} className="btn btn-secondary btn-small">
              Do not save in this tab
            </button>
            <div>{download}</div>
          </div>
        </div>
      )}
      {status.kind === 'off' && status.why === 'declined' && (
        <div role="status" className="mt-3 px-4 text-sm text-text sm:px-0" data-testid="drafts-declined">
          <p>This tab is not saving. Changes made here are lost when you leave.</p>
          <div className="mt-2">{download}</div>
        </div>
      )}
    </>
  );
}

interface PromptAction {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * A modal native <dialog> that has to be answered. Escape does not close it (and if the browser closes it anyway, which
 * Chromium does on a second Escape with no click in between, it is opened again). Tab and Shift+Tab stay inside it: the
 * browser's own modal dialog lets Tab walk out to the address bar.
 */
function ModalPrompt({ title, actions, children }: { title: string; actions: PromptAction[]; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid="draft-prompt"
      onCancel={(e) => e.preventDefault()}
      onClose={() => {
        const d = ref.current;
        if (d && !d.open) d.showModal();
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
        <div className="mt-3">{children}</div>
        <div className="mt-5 flex flex-wrap gap-3">
          {actions.map((a, i) => (
            <button
              key={a.label}
              type="button"
              autoFocus={i === 0}
              aria-disabled={a.disabled || undefined}
              onClick={() => !a.disabled && a.onClick()}
              className={`btn ${a.primary ? 'btn-primary' : 'btn-secondary'} aria-disabled:cursor-wait aria-disabled:opacity-70`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </dialog>
  );
}
