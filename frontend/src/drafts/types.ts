import { SNAPSHOT_SCHEMA_VERSION, type EditorMode } from '../editor/types';

/** The shape of a stored draft row. A build that finds a larger number than this one writes treats the draft as "newer". */
export const DRAFT_FORMAT = 1;

const MB = 1024 * 1024;
/** What one person's drafts may hold. Pictures are counted per draft, bytes are state JSON plus picture blobs. */
export const DRAFT_LIMITS = {
  pictures: 8,
  draftBytes: 6 * MB,
  totalBytes: 30 * MB,
} as const;

/**
 * Who owns the drafts is the account (userKey() in src/auth/userKey.ts: the account id, never the name), so a different account in
 * the same browser never sees them. Drafts live in this browser only.
 * The sku is deliberately NOT part of the key: the garment (colour and size) is stored inside the row, so changing colour
 * or size keeps working on the same draft.
 */
export function draftKey(user: string, productId: string, engine: EditorMode): string {
  return JSON.stringify([user, productId, engine]);
}

export interface DraftGarment {
  color: string;
  size: string;
}

export interface DraftRow {
  /** draftKey(user, productId, engine) */
  key: string;
  user: string;
  productId: string;
  engine: EditorMode;
  format: number;
  /** the editor snapshot's schemaVersion */
  schemaVersion: number;
  garment: DraftGarment;
  /** where "Open" in the drafts list goes. Informational only: NOT part of the key. */
  sku: string;
  productName: string;
  colorName: string;
  /** the snapshot's opaque state (plain data, pictures named by asset id) */
  state: unknown;
  /** the pictures this draft uses; every one has a record in the assets store */
  assetIds: string[];
  layerCount: number;
  bytes: number;
  /** goes up by one on every write; a writer must name the revision it started from (0 = no draft yet) */
  revision: number;
  updatedAt: number;
}

export type DraftWrite = Omit<DraftRow, 'revision'>;

export interface DraftCommit {
  row: DraftWrite;
  /** the revision this tab believes is stored (0 when it believes there is none) */
  expectedRevision: number;
  /** pictures that are not stored yet. Pictures named by row.assetIds that are neither here nor already stored abort the write. */
  putAssets: Record<string, Blob>;
}

export type CommitResult = { ok: true; revision: number } | { ok: false; reason: 'conflict'; current: DraftRow | undefined };

/** The write found a picture the row names but nobody stored. Nothing was changed. */
export class DraftIntegrityError extends Error {
  constructor(assetId: string) {
    super(`Picture ${assetId} is neither in this save nor already stored.`);
    this.name = 'DraftIntegrityError';
  }
}

/**
 * Where drafts live. Two implementations run the same contract suite (drafts.contract.ts): IndexedDB (idbDb.ts, in real
 * Edge) and a Map (memoryDb.ts, for jsdom). Every method that writes is ONE atomic step.
 */
export interface DraftDb {
  get(key: string): Promise<DraftRow | undefined>;
  /** the stored pictures among `ids`; ids with no record are left out */
  getAssets(key: string, ids: readonly string[]): Promise<Record<string, Blob>>;
  /** this person's drafts, newest first */
  list(user: string): Promise<DraftRow[]>;
  /**
   * Writes a draft. In one transaction: checks the revision, removes the draft's pictures that the new row no longer
   * names (an orphan is never left behind), stores the new pictures, verifies every picture the row names exists, and
   * writes the row. A wrong revision changes nothing and says so.
   */
  commit(commit: DraftCommit): Promise<CommitResult>;
  /** the draft and its pictures, together */
  remove(key: string): Promise<void>;
  /** every draft of this person, and their pictures */
  removeUser(user: string): Promise<void>;
  /** deletes picture records whose draft no longer exists. Returns how many. */
  sweep(): Promise<number>;
  /** "draftKey|assetId" of every stored picture, for tests and diagnostics */
  assetKeys(): Promise<string[]>;
  close(): void;
}

export type ParsedRow = { kind: 'ok'; row: DraftRow } | { kind: 'newer' } | { kind: 'damaged'; why: string };

const isString = (v: unknown): v is string => typeof v === 'string';
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Judges a row read from storage. Anything a stranger, an older bug or a half-finished write could have left is "damaged". */
export function parseRow(value: unknown, expectedKey: string): ParsedRow {
  if (typeof value !== 'object' || value === null) return { kind: 'damaged', why: 'The saved draft is not readable.' };
  const r = value as Partial<DraftRow>;
  if (isCount(r.format) && r.format > DRAFT_FORMAT) return { kind: 'newer' };
  if (isCount(r.schemaVersion) && r.schemaVersion > SNAPSHOT_SCHEMA_VERSION) return { kind: 'newer' };
  const g = r.garment as Partial<DraftGarment> | undefined;
  const ok =
    r.key === expectedKey &&
    r.format === DRAFT_FORMAT &&
    isCount(r.schemaVersion) &&
    isString(r.user) &&
    isString(r.productId) &&
    (r.engine === 'simple' || r.engine === 'pro') &&
    typeof g === 'object' &&
    g !== null &&
    isString(g.color) &&
    isString(g.size) &&
    typeof r.state === 'object' &&
    r.state !== null &&
    Array.isArray(r.assetIds) &&
    r.assetIds.every(isString) &&
    isCount(r.layerCount) &&
    isCount(r.bytes) &&
    isCount(r.revision) &&
    isCount(r.updatedAt);
  return ok ? { kind: 'ok', row: r as DraftRow } : { kind: 'damaged', why: 'The saved draft is damaged.' };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}
