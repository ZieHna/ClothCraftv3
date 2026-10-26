import type { EditorMode, EditorSnapshot } from '../editor/types';
import type { Sealable } from './registry';
import { DRAFT_FORMAT, DRAFT_LIMITS, draftKey, formatBytes, type DraftDb, type DraftWrite } from './types';

/** The part of the editor the saver may touch: reading the design, and nothing that changes it. */
export interface SaverEditor {
  exportState(): Promise<EditorSnapshot>;
  isBusy(): boolean;
  whenIdle(): Promise<void>;
  getGarment(): { color: string; size: string };
  getLayers(): ReadonlyArray<unknown>;
  onChange(listener: () => void): () => void;
}

export interface DraftMeta {
  sku: string;
  productName: string;
  colorName: string;
}

export type BlockReason = 'pictures' | 'draft-size' | 'total-size' | 'storage';

/**
 *  idle      nothing written yet in this visit
 *  saved     the last write went through
 *  blocked   the work is NOT being saved (too big, or the browser refused). The last good draft is untouched.
 *  conflict  another tab changed this draft since this tab last saw it. Saving is paused until a person decides.
 *  off       saving is switched off: signed out, or the person chose not to save in this tab
 */
export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saved'; at: number }
  | { kind: 'blocked'; reason: BlockReason; message: string }
  | { kind: 'conflict'; otherRevision: number; otherUpdatedAt: number | null }
  | { kind: 'off'; why: 'sealed' | 'declined' };

export interface SaverOptions {
  db: DraftDb;
  editor: SaverEditor;
  user: string;
  productId: string;
  engine: EditorMode;
  /** read at the moment of each write, so a colour or size change is in the next save */
  describe: () => DraftMeta;
  /** the revision stored when this visit began (0 = none). Needed to overwrite a draft the person chose to start fresh over. */
  baseRevision: number;
  /** pictures already stored for that revision, so only new ones are written */
  storedAssetIds?: readonly string[];
  limits?: Partial<typeof DRAFT_LIMITS>;
  debounceMs?: number;
  maxWaitMs?: number;
  now?: () => number;
}

const REASON_STORAGE = 'This design could not be saved on this device.';

function storageMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === 'QuotaExceededError') return 'This design could not be saved because the browser has no room left for it.';
  return REASON_STORAGE;
}

/**
 * Keeps one design saved as a draft while it is edited.
 *  - Nothing is written until arm(): edits made while a draft was being restored or chosen are not "edits".
 *  - A change schedules a save about debounceMs later (default 1 s), but never later than maxWaitMs (default 5 s) after the
 *    first unsaved change, so a long burst of edits is still saved. The page being hidden or closed saves at once.
 *  - One save at a time. A save reads the design with exportState() only (never a method that changes it), checks that
 *    the editor did not start an undo, redo or load meanwhile (it would be a stale scene: dropped and read again), checks
 *    the limits, then writes row and pictures in one transaction.
 *  - A design with no layers is never written: it would replace a draft with nothing.
 *  - If another tab wrote since this one last did, saving PAUSES and a person decides (resolveConflict). Never silent.
 *  - seal() (sign-out) stops everything at once; a write already under way is allowed to finish, nothing starts after.
 */
export class DraftSaver implements Sealable {
  status: SaveStatus = { kind: 'idle' };
  readonly key: string;
  private readonly listeners = new Set<() => void>();
  private readonly limits: typeof DRAFT_LIMITS;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private cleanups: Array<() => void> = [];
  private armed = false;
  private sealed = false;
  private stopped = false;
  private paused = false;
  private dirty = false;
  private firstDirtyAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> | null = null;
  private revision: number;
  private stored: Set<string>;

  constructor(private readonly o: SaverOptions) {
    this.key = draftKey(o.user, o.productId, o.engine);
    this.limits = { ...DRAFT_LIMITS, ...o.limits };
    this.now = o.now ?? Date.now;
    this.debounceMs = o.debounceMs ?? 1000;
    this.maxWaitMs = o.maxWaitMs ?? 5000;
    this.revision = o.baseRevision;
    this.stored = new Set(o.storedAssetIds ?? []);
  }

  onStatus(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(next: SaveStatus): void {
    this.status = next;
    for (const l of this.listeners) l();
  }

  /** Starts listening for edits and for the page going away. */
  arm(): void {
    if (this.armed || this.sealed) return;
    this.armed = true;
    const hide = () => {
      if (document.visibilityState === 'hidden') void this.flush();
    };
    const leave = () => void this.flush();
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', leave);
    this.cleanups.push(
      this.o.editor.onChange(() => this.touch()),
      () => document.removeEventListener('visibilitychange', hide),
      () => window.removeEventListener('pagehide', leave),
    );
  }

  /** Something changed: save soon. */
  touch(): void {
    if (!this.armed || this.sealed || this.stopped) return;
    this.dirty = true;
    if (this.paused) return;
    const t = this.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = t;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), Math.max(0, Math.min(this.debounceMs, this.firstDirtyAt + this.maxWaitMs - t)));
  }

  /** Saves what is unsaved now (or waits for the save that is under way). Never rejects. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.sealed || this.stopped || this.paused) return this.inflight ?? Promise.resolve();
    if (!this.inflight) {
      if (!this.dirty) return Promise.resolve();
      this.inflight = this.drain().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Stops saving for good (sign-out). Synchronous in effect; settles when a write that had already begun has finished. */
  seal(): Promise<void> {
    this.sealed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.setStatus({ kind: 'off', why: 'sealed' });
    return (this.inflight ?? Promise.resolve()).catch(() => undefined);
  }

  /** Stops listening and timing. A save that was already asked for (flush) still completes. */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const c of this.cleanups) c();
    this.cleanups = [];
  }

  /** The person's answer to a conflict: write this tab's version over the other one, or stop saving in this tab. */
  resolveConflict(choice: 'overwrite' | 'stop'): void {
    if (!this.paused) return;
    if (choice === 'stop') {
      this.stopped = true;
      this.setStatus({ kind: 'off', why: 'declined' });
      return;
    }
    const s = this.status;
    this.revision = s.kind === 'conflict' ? s.otherRevision : 0;
    this.stored = new Set(); // the other tab's pictures are not known: write ours all
    this.paused = false;
    this.dirty = true;
    this.setStatus({ kind: 'idle' });
    void this.flush();
  }

  /** After a blocked save: try again now (for the "Try again" button). */
  retry(): void {
    this.dirty = true;
    void this.flush();
  }

  private async drain(): Promise<void> {
    while (this.dirty && !this.sealed && !this.stopped && !this.paused) {
      this.dirty = false;
      this.firstDirtyAt = 0;
      let snapshot: EditorSnapshot;
      try {
        snapshot = await this.o.editor.exportState();
      } catch {
        this.setStatus({ kind: 'blocked', reason: 'storage', message: 'This design could not be read for saving.' });
        return;
      }
      if (this.sealed || this.stopped) return;
      // an undo, redo or load began meanwhile: this snapshot is of a scene that is about to be replaced. Read again when it is done.
      if (this.o.editor.isBusy()) {
        this.dirty = true;
        await this.o.editor.whenIdle();
        continue;
      }
      await this.write(snapshot);
    }
  }

  private async write(snapshot: EditorSnapshot): Promise<void> {
    const { editor, db } = this.o;
    if (editor.getLayers().length === 0) return;
    const ids = Object.keys(snapshot.assets);
    if (ids.length > this.limits.pictures) {
      this.block('pictures', `This design has ${ids.length} pictures. A draft keeps at most ${this.limits.pictures}, so your latest changes are not being saved.`);
      return;
    }
    const bytes = JSON.stringify(snapshot.state).length + ids.reduce((sum, id) => sum + snapshot.assets[id]!.size, 0);
    if (bytes > this.limits.draftBytes) {
      this.block('draft-size', `This design is ${formatBytes(bytes)}. A draft keeps at most ${formatBytes(this.limits.draftBytes)}, so your latest changes are not being saved.`);
      return;
    }
    try {
      const others = (await db.list(this.o.user)).filter((r) => r.key !== this.key).reduce((sum, r) => sum + r.bytes, 0);
      if (others + bytes > this.limits.totalBytes) {
        this.block('total-size', `Your drafts would use ${formatBytes(others + bytes)} of the ${formatBytes(this.limits.totalBytes)} kept. Delete a draft you no longer need (Account, Your drafts) so this one can be saved. Your latest changes are not being saved.`);
        return;
      }
      if (this.sealed || this.stopped) return; // signed out while the size was being checked: nothing may start now
      const meta = this.o.describe();
      const row: DraftWrite = {
        key: this.key,
        user: this.o.user,
        productId: this.o.productId,
        engine: this.o.engine,
        format: DRAFT_FORMAT,
        schemaVersion: snapshot.schemaVersion,
        garment: editor.getGarment(),
        sku: meta.sku,
        productName: meta.productName,
        colorName: meta.colorName,
        state: snapshot.state,
        assetIds: ids,
        layerCount: editor.getLayers().length,
        bytes,
        updatedAt: this.now(),
      };
      const putAssets = Object.fromEntries(ids.filter((id) => !this.stored.has(id)).map((id) => [id, snapshot.assets[id]!]));
      const result = await db.commit({ row, expectedRevision: this.revision, putAssets });
      if (!result.ok) {
        this.paused = true;
        this.dirty = true;
        clearTimeout(this.timer);
        this.setStatus({ kind: 'conflict', otherRevision: result.current?.revision ?? 0, otherUpdatedAt: result.current?.updatedAt ?? null });
        return;
      }
      this.revision = result.revision;
      this.stored = new Set(ids);
      if (!this.sealed) this.setStatus({ kind: 'saved', at: row.updatedAt });
    } catch (e) {
      this.block('storage', storageMessage(e));
    }
  }

  private block(reason: BlockReason, message: string): void {
    if (!this.sealed) this.setStatus({ kind: 'blocked', reason, message });
  }
}
