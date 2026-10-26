import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Before real accounts every draft belonged to a made-up "demo customer". The drafts database is deleted ONCE, before this build
 * first opens it, and never again.
 */
const opened = vi.fn();
vi.mock('./idbDb', () => ({ DB_NAME: 'clothcraft-drafts', openIdbDb: () => (opened(), Promise.resolve({ sweep: () => Promise.resolve() })) }));

type Outcome = 'success' | 'blocked' | 'error';
function stubIndexedDb(outcome: Outcome) {
  const deleteDatabase = vi.fn(() => {
    const request: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {};
    queueMicrotask(() => ({ success: request.onsuccess, blocked: request.onblocked, error: request.onerror })[outcome]?.());
    return request;
  });
  vi.stubGlobal('indexedDB', { deleteDatabase });
  return deleteDatabase;
}
async function freshGetDraftDb() {
  vi.resetModules();
  return (await import('./db')).getDraftDb;
}

beforeEach(() => {
  localStorage.clear();
  opened.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('the one-time purge of the old demo drafts', () => {
  it('deletes the old database, then opens it, and remembers it did', async () => {
    const deleteDatabase = stubIndexedDb('success');
    const getDraftDb = await freshGetDraftDb();
    expect(await getDraftDb()).not.toBeNull();
    expect(deleteDatabase).toHaveBeenCalledWith('clothcraft-drafts');
    expect(localStorage.getItem('cc.drafts.demoPurged.v1')).toBe('1');
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('never deletes again, so a real account\'s drafts are safe from the next page load on', async () => {
    const deleteDatabase = stubIndexedDb('success');
    await (await freshGetDraftDb())();
    await (await freshGetDraftDb())();   // a second page load
    expect(deleteDatabase).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it('opens the database even when another tab holds the old one open, and tries again next time', async () => {
    const deleteDatabase = stubIndexedDb('blocked');
    await (await freshGetDraftDb())();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('cc.drafts.demoPurged.v1')).toBeNull();
    await (await freshGetDraftDb())();
    expect(deleteDatabase).toHaveBeenCalledTimes(2);
  });

  it('opens the database when the delete fails, and leaves the flag unset', async () => {
    stubIndexedDb('error');
    await (await freshGetDraftDb())();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('cc.drafts.demoPurged.v1')).toBeNull();
  });

  it('does nothing where there is no IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await (await freshGetDraftDb())();
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
