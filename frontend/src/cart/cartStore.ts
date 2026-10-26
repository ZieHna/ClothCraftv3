import { useMemo, useSyncExternalStore } from 'react';
import { getCart, putCart, putCartOnLeave, type CartWrite } from '../api/cart';
import { API_MODE, ApiError } from '../api/client';
import type { ServerCart } from '../api/types';
import { lineKey, type CartLine } from './line';
import { adoptDeviceCart, mergeCarts, sameLines, takeOrdered, type CartFields } from './merge';

export { lineKey, type CartLine };

/**
 * The customer's cart (see line.ts for what a line holds). There is no guest cart: a cart belongs to a signed-in customer (its `owner`,
 * set by AuthProvider), so a shared computer never shows the previous person's cart. With no owner the cart is empty and adding does
 * nothing (the product page asks for sign-in first).
 *
 * Two places keep it, chosen by VITE_API:
 *  - mock (unchanged since step 10): localStorage under the customer's own key (cc.cart.v1:<id>), cleared on sign-out. If the browser
 *    blocks storage the cart works in memory for this page load, and `storageBlocked` says so. Other tabs are kept in sync.
 *  - odoo (step 12): the account's saved cart (GET/PUT /api/cart), so it follows the customer to every browser and device. This device
 *    keeps a copy (cc.cart.v2:<id>) so the cart answers at once and an edit made offline is never lost. Edits are saved a moment after
 *    the last one (at most 3 s after the first), as the whole cart with the version this device last saw; if another tab or device saved
 *    first (409), the edits are merged into the newer cart (merge.ts) and saved again. A save that cannot reach the shop is kept and
 *    tried again (with growing pauses, when the browser is back online, and when the window gets focus), and the page says so.
 */

/** The storage key prefix; each customer's cart is stored under cartKeyFor(their id). The bare key is the old shared guest cart. */
export const CART_KEY = 'cc.cart.v1';
export const cartKeyFor = (owner: string) => `${CART_KEY}:${owner}`;
/** Step 12: this device's copy of the saved cart, per customer, and when each customer was last signed in on this device. */
export const CART_V2_KEY = 'cc.cart.v2';
export const cartV2KeyFor = (owner: string) => `${CART_V2_KEY}:${owner}`;
export const CART_SEEN_KEY = 'cc.cart.seen';
/** A customer who has not signed in on this device for this long has their copies (v1 and v2) removed from it. */
export const FORGET_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** A sanity limit on one line. What can really be supplied is the server's answer, shown on the cart page. */
export const MAX_QUANTITY = 99;
const SAVE_DELAY_MS = 500;
const SAVE_AT_MOST_MS = 3000;
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 30000;

interface Snapshot {
  lines: readonly CartLine[];
  storageBlocked: boolean;
}

/** The saved cart's state on this page (odoo mode). In mock mode it stays "off". */
export interface CartSync {
  /** off: mock mode or nobody signed in. loading: the saved cart is being fetched (the cart is not shown yet). */
  phase: 'off' | 'loading' | 'ready';
  /** edits this device has not saved to the account yet */
  pending: boolean;
  /** the last load or save could not reach the shop; it is tried again */
  offline: boolean;
  /** the cart was also changed in another tab or on another device and the changes were combined (until dismissed) */
  conflict: boolean;
  /** lines this device kept from before step 12 that were added to the account's cart (until dismissed) */
  added: number;
  /** the shop refused part of the cart: those lines were taken out (a number), or it could not be saved at all (-1) */
  refused: number;
}
const SYNC_OFF: CartSync = { phase: 'off', pending: false, offline: false, conflict: false, added: 0, refused: 0 };

const clampQuantity = (n: number) => Math.min(MAX_QUANTITY, Math.max(1, Math.floor(Number.isFinite(n) ? n : 1)));

/** The line ticked or not; an unticked line has no `selected` field at all. */
function withTick(line: CartLine, on: boolean): CartLine {
  if (on) return { ...line, selected: true };
  const { selected: _dropped, ...rest } = line;
  return rest;
}

let serverBacked = API_MODE === 'odoo';
let owner: string | null = null;
/** The line "Proceed to checkout" on the Design page just ticked on its own (for the note in the cart and at checkout). Memory only:
 *  a reload forgets it, so the note is not shown again. */
let justMade: string | null = null;

/** Stored lines, checked one by one: anything damaged is dropped, never guessed. */
function parseLines(parsed: unknown): CartLine[] {
  const lines: CartLine[] = [];
  if (!Array.isArray(parsed)) return lines;
  for (const item of parsed) {
    const line = item as Partial<CartLine> | null;
    if (!line || typeof line.sku !== 'string' || typeof line.productId !== 'string' || typeof line.quantity !== 'number') continue;
    const designId = typeof line.designId === 'string' && /^\d{1,12}$/.test(line.designId) ? line.designId : undefined;
    if (line.designId !== undefined && !designId) continue; // a damaged design reference is dropped, never priced as the plain garment
    const next: CartLine = { sku: line.sku, productId: line.productId, quantity: clampQuantity(line.quantity) };
    if (designId) {
      next.designId = designId;
      if (typeof line.estimate === 'number' && Number.isFinite(line.estimate)) next.estimate = line.estimate;
    }
    if (line.selected === true) next.selected = true; // anything else (absent, as before step 10) is unticked
    if (!lines.some((l) => lineKey(l) === lineKey(next))) lines.push(next);
  }
  return lines;
}

function readV1(who: string | null): Snapshot {
  if (who === null) return { lines: [], storageBlocked: false };
  try {
    const stored = localStorage.getItem(cartKeyFor(who));
    return { lines: parseLines(stored ? JSON.parse(stored) : []), storageBlocked: false };
  } catch {
    return { lines: [], storageBlocked: true };
  }
}

let snapshot: Snapshot = serverBacked ? { lines: [], storageBlocked: false } : readV1(owner);
let sync: CartSync = SYNC_OFF;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// ---- odoo mode: the account's saved cart -------------------------------------------------------------------------------------------

/** The saved cart as this device last saw it, and its version: the "base" of the three-way merge. */
let base: CartFields[] = [];
let version = 0;
/** this device's cart differs from `base` and is not saved yet */
let dirty = false;
/** the next load comes with this device's cart from before step 12 (cc.cart.v1), to be added to the account's cart */
let fromDevice = false;
/** cc.cart.v1 for this customer is removed once the account's cart is confirmed to hold what it had */
let dropV1 = false;
/** fetch the saved cart again on the next run (after an order, or another tab saved) */
let reloadWanted = false;
/** an owner change makes every answer still on its way meaningless */
let generation = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let firstEdit: number | null = null;
let retryDelay = 0;
let running: Promise<void> | null = null;
let again = false;

const fieldsOf = (l: CartLine): CartFields => ({ sku: l.sku, productId: l.productId, quantity: l.quantity, ...(l.designId ? { designId: l.designId } : {}), ...(l.selected ? { selected: true } : {}) });
const fromServer = (cart: ServerCart): CartFields[] => cart.lines.map((l) => ({ sku: l.sku, productId: l.productId, quantity: l.quantity, ...(l.designId ? { designId: l.designId } : {}), ...(l.selected ? { selected: true as const } : {}) }));
const writeOf = (lines: readonly CartLine[]): CartWrite => ({
  baseVersion: version,
  lines: lines.map((l) => ({ sku: l.sku, quantity: l.quantity, selected: !!l.selected, ...(l.designId ? { designId: l.designId } : {}) })),
});

function setSync(change: Partial<CartSync>): void {
  sync = { ...sync, ...change };
}

/** This device's copy: what the cart page shows at once, and what keeps an unsaved edit through a reload or a lost connection. */
function storeV2(): boolean {
  if (owner === null) return true;
  try {
    localStorage.setItem(cartV2KeyFor(owner), JSON.stringify({ version, base, lines: snapshot.lines, pending: dirty, savedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

function readV2(who: string): { version: number; base: CartFields[]; lines: CartLine[]; pending: boolean } | null {
  try {
    const stored = localStorage.getItem(cartV2KeyFor(who));
    if (!stored) return null;
    const parsed = JSON.parse(stored) as { version?: unknown; base?: unknown; lines?: unknown; pending?: unknown } | null;
    if (!parsed || typeof parsed.version !== 'number' || !Number.isInteger(parsed.version) || parsed.version < 0) return null;
    return { version: parsed.version, base: parseLines(parsed.base).map(fieldsOf), lines: parseLines(parsed.lines), pending: parsed.pending === true };
  } catch {
    return null;
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage blocked: nothing stored */
  }
}

/** Remember that this customer signed in on this device today, and remove the copies of customers who have not for 30 days. */
export function forgetIdleCarts(now = Date.now(), signedIn: string | null = null): void {
  try {
    const seen = (JSON.parse(localStorage.getItem(CART_SEEN_KEY) ?? '{}') ?? {}) as Record<string, unknown>;
    const next: Record<string, number> = {};
    const prefixes = [`${CART_KEY}:`, `${CART_V2_KEY}:`];
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && prefixes.some((p) => key.startsWith(p))) keys.push(key);
    }
    for (const key of keys) {
      const who = key.slice(key.indexOf(':') + 1);
      const when = who === signedIn ? now : typeof seen[who] === 'number' ? (seen[who] as number) : now; // a copy from before this rule: its 30 days start now
      if (now - when > FORGET_AFTER_MS) removeKey(key);
      else next[who] = when;
    }
    if (signedIn !== null) next[signedIn] = now;
    localStorage.setItem(CART_SEEN_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: nothing kept, nothing to forget */
  }
}

function commitServer(lines: readonly CartLine[]): void {
  dirty = true;
  snapshot = { lines, storageBlocked: false };
  snapshot = { lines, storageBlocked: !storeV2() }; // stored with the new lines (storeV2 reads the snapshot)
  setSync({ pending: true, refused: sync.refused === -1 ? 0 : sync.refused });
  notify();
  scheduleSave();
}

function scheduleSave(): void {
  if (owner === null || sync.phase !== 'ready') return; // while loading, the edits wait and are merged with the saved cart when it comes
  clearTimeout(saveTimer);
  const now = Date.now();
  firstEdit ??= now;
  saveTimer = setTimeout(() => void runSync(), Math.max(0, Math.min(SAVE_DELAY_MS, firstEdit + SAVE_AT_MOST_MS - now)));
}

/** One load or save at a time; asked again while one is running, it runs once more right after. */
function runSync(): Promise<void> {
  clearTimeout(saveTimer);
  clearTimeout(retryTimer);
  firstEdit = null;
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await syncStep();
      } while (again && owner !== null);
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Put the account's cart (`server`) and this device's cart together and show the result. `against` is what both started from. */
function adopt(cart: ServerCart, against: readonly CartFields[], conflict: boolean): void {
  const server = fromServer(cart);
  const local = snapshot.lines;
  let merged: CartLine[];
  let added = sync.added;
  if (fromDevice) {
    const result = adoptDeviceCart(server, local);
    merged = result.lines;
    added = result.added;
    fromDevice = false;
    dropV1 = true;
  } else {
    merged = mergeCarts(against, local, server);
  }
  base = server;
  version = cart.version;
  dirty = !sameLines(merged, server);
  if (!dirty && dropV1 && owner !== null) {
    removeKey(cartKeyFor(owner)); // the account's cart now holds what this device kept: the old copy goes
    dropV1 = false;
  }
  // tell the customer only when what they see changed because of another tab or device
  const changedHere = !sameLines(merged, local);
  snapshot = { lines: merged, storageBlocked: snapshot.storageBlocked };
  snapshot = { lines: merged, storageBlocked: !storeV2() };
  setSync({ phase: 'ready', pending: dirty, offline: false, added, conflict: sync.conflict || (conflict && changedHere) });
  retryDelay = 0;
  if (dirty) again = true;
  notify();
}

/** 422: the shop named lines it will not keep (an item no longer sold, a design that is gone). Those lines are taken out and the rest
 *  is saved; if it named no line, nothing is saved and the page says so (no endless retrying). */
function refuse(sent: readonly CartLine[], fields: Record<string, string> | undefined): void {
  const bad = new Set<string>();
  for (const name of Object.keys(fields ?? {})) {
    const at = /^lines\[(\d+)\]/.exec(name);
    const line = at ? sent[Number(at[1])] : undefined;
    if (line) bad.add(lineKey(line));
  }
  if (bad.size === 0) {
    setSync({ refused: -1, pending: true });
    notify();
    return;
  }
  snapshot = { lines: snapshot.lines.filter((l) => !bad.has(lineKey(l))), storageBlocked: snapshot.storageBlocked };
  storeV2();
  setSync({ refused: sync.refused + bad.size });
  again = true;
  notify();
}

function retryLater(): void {
  retryDelay = retryDelay ? Math.min(RETRY_MAX_MS, retryDelay * 2) : RETRY_FIRST_MS;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void runSync(), retryDelay);
}

async function syncStep(): Promise<void> {
  if (owner === null) return;
  const gen = generation;
  const load = sync.phase === 'loading' || reloadWanted;
  if (!load && (!dirty || sync.refused === -1)) return;
  try {
    if (load) {
      reloadWanted = false;
      const startedFrom = base;
      const { data } = await getCart();
      if (gen !== generation) return;
      adopt(data, startedFrom, dirty);
      return;
    }
    const sent = snapshot.lines;
    const startedFrom = base;
    try {
      const { data } = await putCart(writeOf(sent));
      if (gen !== generation) return;
      adopt(data, sent.map(fieldsOf), false); // the shop now holds what was sent; edits made since are this device's
    } catch (error) {
      if (gen !== generation) return;
      if (error instanceof ApiError && error.status === 409 && error.details.cart) adopt(error.details.cart, startedFrom, true);
      else if (error instanceof ApiError && error.status === 422) refuse(sent, error.details.fields);
      else throw error;
    }
  } catch (error) {
    if (gen !== generation) return;
    if (error instanceof ApiError && error.status === 401) return; // the session is over: AuthProvider signs out, the edits stay on this device
    if (error instanceof ApiError && (error.status === 400 || error.status === 413)) {
      setSync({ refused: -1 });
      notify();
      return;
    }
    setSync({ offline: true }); // no answer, a server error or "too many": kept, and tried again
    notify();
    retryLater();
  }
}

function setServerOwner(next: string | null): void {
  generation += 1;
  clearTimeout(saveTimer);
  clearTimeout(retryTimer);
  firstEdit = null;
  retryDelay = 0;
  reloadWanted = false;
  fromDevice = false;
  dropV1 = false;
  owner = next;
  justMade = null;
  if (next === null) {
    base = [];
    version = 0;
    dirty = false;
    snapshot = { lines: [], storageBlocked: false };
    sync = SYNC_OFF;
    notify();
    return;
  }
  forgetIdleCarts(Date.now(), next);
  const kept = readV2(next);
  let lines: readonly CartLine[] = [];
  let blocked = false;
  if (kept) {
    ({ base, version, lines } = kept);
    dirty = kept.pending;
  } else {
    base = [];
    version = 0;
    dirty = false;
    const old = readV1(next);
    lines = old.lines;
    blocked = old.storageBlocked;
    fromDevice = lines.length > 0;
    if (!fromDevice) removeKey(cartKeyFor(next));
  }
  snapshot = { lines, storageBlocked: blocked };
  sync = { ...SYNC_OFF, phase: 'loading', pending: dirty };
  notify();
  void runSync();
}

// ---- mock mode: this browser's storage only (as in step 10) -----------------------------------------------------------------------

function commit(lines: readonly CartLine[]): void {
  if (owner === null) return; // no customer, no cart
  if (serverBacked) {
    commitServer(lines);
    return;
  }
  let blocked = snapshot.storageBlocked;
  try {
    localStorage.setItem(cartKeyFor(owner), JSON.stringify(lines));
    blocked = false;
  } catch {
    blocked = true;
  }
  snapshot = { lines, storageBlocked: blocked };
  notify();
}

export const cartStore = {
  get: () => snapshot,
  getSync: () => sync,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  /** Add `quantity` of a SKU (with a design, step 9); if that line is already in the cart the quantities are added together. */
  add(sku: string, productId: string, quantity = 1, design?: { id: string; estimate?: number }): void {
    const key = lineKey({ sku, designId: design?.id });
    const existing = snapshot.lines.find((l) => lineKey(l) === key);
    const fresh: CartLine = { sku, productId, quantity: clampQuantity(quantity), ...(design ? { designId: design.id, ...(design.estimate === undefined ? {} : { estimate: design.estimate }) } : {}) };
    commit(existing ? snapshot.lines.map((l) => (lineKey(l) === key ? { ...l, quantity: clampQuantity(l.quantity + quantity) } : l)) : [...snapshot.lines, fresh]);
  },
  /** `key` is lineKey(line): the SKU for a plain garment. */
  setQuantity(key: string, quantity: number): void {
    commit(snapshot.lines.map((l) => (lineKey(l) === key ? { ...l, quantity: clampQuantity(quantity) } : l)));
  },
  remove(key: string): void {
    commit(snapshot.lines.filter((l) => lineKey(l) !== key));
  },
  /** "Edit design" saved a new design for a line: the line keeps its place and quantity and now names the new design. */
  replaceDesign(key: string, design: { id: string; estimate?: number }, sku?: string): void {
    commit(snapshot.lines.map((l) => (lineKey(l) === key ? { ...l, sku: sku ?? l.sku, designId: design.id, estimate: design.estimate } : l)));
  },
  /** Put a removed line back where it was (the "Undo" after Remove). */
  restore(line: CartLine, index: number): void {
    if (snapshot.lines.some((l) => lineKey(l) === lineKey(line))) return;
    const next = [...snapshot.lines];
    next.splice(Math.min(index, next.length), 0, line);
    commit(next);
  },
  /** Tick or untick one line (`key` is lineKey(line)). */
  setSelected(key: string, on: boolean): void {
    justMade = null;
    commit(snapshot.lines.map((l) => (lineKey(l) === key ? withTick(l, on) : l)));
  },
  /** "Select all": tick or untick every line. */
  setAllSelected(on: boolean): void {
    justMade = null;
    commit(snapshot.lines.map((l) => withTick(l, on)));
  },
  /** "Proceed to checkout" on the Design page: that line alone is ticked; the others stay in the cart, unticked. */
  selectOnly(key: string): void {
    justMade = key;
    commit(snapshot.lines.map((l) => withTick(l, lineKey(l) === key)));
  },
  /**
   * After an order: take away exactly what was ordered. A line ordered in full goes; a line whose quantity was raised in another tab
   * meanwhile keeps the extra, unticked (it was not ordered). Lines that were not ordered are left as they are.
   * odoo mode: the shop already took the order's lines off the saved cart. The same is taken off this device's cart AND off its idea of
   * the saved cart, then the saved cart is fetched and merged, so an edit still waiting to be saved can never bring an ordered line back.
   */
  removeOrdered(ordered: readonly Pick<CartLine, 'sku' | 'designId' | 'quantity'>[]): void {
    justMade = null;
    if (serverBacked) {
      if (owner === null) return;
      base = takeOrdered(base, ordered);
      snapshot = { lines: takeOrdered(snapshot.lines, ordered), storageBlocked: snapshot.storageBlocked };
      storeV2();
      reloadWanted = true;
      notify();
      void runSync();
      return;
    }
    commit(takeOrdered(snapshot.lines, ordered));
  },
  /** The line "Proceed to checkout" ticked on its own, until the note about it is dismissed (or a tick changes, or a reload). */
  justMade: () => justMade,
  dismissJustMade(): void {
    justMade = null;
    notify();
  },
  /** mock mode: empty the cart (sign-out). */
  clear(): void {
    justMade = null;
    commit([]);
  },
  /** Whose cart this is: the signed-in customer's id, or null (signed out: an empty cart that cannot be added to). */
  setOwner(next: string | null): void {
    if (next === owner) return;
    if (serverBacked) {
      setServerOwner(next);
      return;
    }
    owner = next;
    justMade = null;
    snapshot = readV1(owner);
    notify();
  },
  owner: () => owner,
  /** Read the stored cart again (another tab changed it, or a test reset storage). odoo mode: fetch the saved cart and merge. */
  reload(): void {
    if (serverBacked) {
      if (owner === null || sync.phase === 'off') return;
      reloadWanted = true;
      void runSync();
      return;
    }
    snapshot = readV1(owner);
    notify();
  },
  /**
   * odoo mode: save what is waiting now. True when nothing is left unsaved; false when it could not be saved within `ms` (offline, the
   * shop refused it, or still loading). Mock mode: always true (the cart is in this browser).
   */
  async flush(ms = 3000): Promise<boolean> {
    if (!serverBacked || owner === null) return true;
    if (!dirty && sync.phase === 'ready' && !running) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    await Promise.race([runSync(), late]);
    clearTimeout(timer);
    return !dirty && sync.phase === 'ready';
  },
  /** Sign-out. Mock mode: the cart is emptied (as in step 10). odoo mode: the account keeps its cart; this device's copy is removed,
   *  unless it holds edits that could not be saved (the customer chose to sign out anyway): they stay for their next sign-in here. */
  signOut(): void {
    if (!serverBacked) {
      cartStore.clear();
      cartStore.setOwner(null);
      return;
    }
    if (owner !== null && !dirty) removeKey(cartV2KeyFor(owner));
    cartStore.setOwner(null);
  },
  /** Dismiss the notes about a merge, the cart brought from this device, and refused lines. */
  dismissNotes(): void {
    setSync({ conflict: false, added: 0, refused: sync.refused === -1 ? -1 : 0 });
    notify();
  },
  /** Try a load or save again now ("Try again" on the offline note). */
  retry(): void {
    if (sync.refused === -1) setSync({ refused: 0 });
    void runSync();
  },
};

function savedVersion(raw: string | null): number {
  try {
    const v = (JSON.parse(raw ?? 'null') as { version?: unknown } | null)?.version;
    return typeof v === 'number' ? v : -1;
  } catch {
    return -1;
  }
}

/** Tests only: run the odoo-mode store (with fetch answered by the test) or the mock-mode one. Resets the owner. */
export function setServerCartForTests(on: boolean): void {
  cartStore.setOwner(null);
  serverBacked = on;
  snapshot = on ? { lines: [], storageBlocked: false } : readV1(null);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (owner === null) return;
    if (serverBacked) {
      // another tab SAVED a newer version (not just edited): fetch it and merge. Comparing versions keeps two tabs from waking each other forever.
      if (event.key === null) cartStore.reload();
      else if (event.key === cartV2KeyFor(owner) && savedVersion(event.newValue) > version) cartStore.reload();
    } else if (event.key === null || event.key === cartKeyFor(owner)) cartStore.reload();
  });
  // odoo mode: an edit waiting to be saved is sent when the page is hidden or closed (keepalive), and tried again as soon as it can be
  const leave = () => {
    if (serverBacked && owner !== null && dirty && sync.phase === 'ready') putCartOnLeave(writeOf(snapshot.lines));
  };
  window.addEventListener('pagehide', leave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') leave();
    else if (serverBacked && sync.offline) void runSync();
  });
  window.addEventListener('online', () => serverBacked && owner !== null && void runSync());
  window.addEventListener('focus', () => serverBacked && sync.offline && void runSync());
  // the shared guest cart of the earlier shop: nobody owns it, so it is dropped
  removeKey(CART_KEY);
  if (serverBacked) forgetIdleCarts();
}

export function useCart() {
  const { lines, storageBlocked } = useSyncExternalStore(cartStore.subscribe, cartStore.get, cartStore.get);
  const { phase } = useSyncExternalStore(cartStore.subscribe, cartStore.getSync, cartStore.getSync);
  // the badge: the sum of what the shopper asked for, their own numbers (prices and stock are never summed here)
  const count = lines.reduce((sum, l) => sum + l.quantity, 0);
  const selectedLines = useMemo(() => lines.filter((l) => l.selected), [lines]);
  // odoo mode, while the saved cart is fetched: what this device has may not be the account's cart, so nothing is shown as the cart yet
  return { lines, selectedLines, count, storageBlocked, loading: phase === 'loading' };
}

/** odoo mode: the saved cart's state (loading, unsaved, offline, merged, refused). */
export function useCartSync(): CartSync {
  return useSyncExternalStore(cartStore.subscribe, cartStore.getSync, cartStore.getSync);
}

/** True while the note "Checking out the design you just made…" applies: that line, and only it, is still ticked. */
export function useJustMadeNote(): boolean {
  const key = useSyncExternalStore(cartStore.subscribe, cartStore.justMade, cartStore.justMade);
  const { lines } = useSyncExternalStore(cartStore.subscribe, cartStore.get, cartStore.get);
  const ticked = lines.filter((l) => l.selected);
  return key !== null && ticked.length === 1 && lineKey(ticked[0]!) === key;
}
