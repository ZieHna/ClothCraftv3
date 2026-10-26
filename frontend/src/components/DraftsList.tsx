import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { userKey } from '../auth/userKey';
import { DRAFT_LIMITS, formatBytes, type DraftDb, type DraftRow } from '../drafts/types';
import { useSkeletonGate } from '../lib/useSkeletonGate';
import { DraftsSkeleton } from './skeleton/pageSkeletons';

type Load = { phase: 'loading' } | { phase: 'unavailable' } | { phase: 'ready'; rows: DraftRow[] };

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * "Your drafts" on the account page: the unfinished designs this browser holds for the signed-in person, with Open (the
 * designer then offers to continue the draft), Delete (asks first), and how much room they use. The storage code is loaded
 * only when this list is shown, so the account page's own bundle stays small.
 */
export function DraftsList() {
  const { user } = useAuth();
  const name = user ? userKey(user) : '';
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [db, setDb] = useState<DraftDb | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const gate = useSkeletonGate(load.phase === 'loading', { immediate: load.phase === 'unavailable' || (load.phase === 'ready' && load.rows.length === 0) });

  const refresh = useCallback(async (database: DraftDb) => {
    setLoad({ phase: 'ready', rows: await database.list(name) });
  }, [name]);

  useEffect(() => {
    let alive = true;
    setLoad({ phase: 'loading' });
    import('../drafts/db')
      .then(({ getDraftDb }) => getDraftDb())
      .then(async (database) => {
        if (!alive) return;
        if (!database) {
          setLoad({ phase: 'unavailable' });
          return;
        }
        setDb(database);
        await refresh(database);
      })
      .catch(() => alive && setLoad({ phase: 'unavailable' }));
    return () => {
      alive = false;
    };
  }, [refresh]);

  const remove = async (row: DraftRow) => {
    if (!db) return;
    setProblem('');
    try {
      await db.remove(row.key);
      setAsking(null);
      await refresh(db);
    } catch {
      setProblem('That draft could not be deleted. Please try again.');
    }
  };

  const total = load.phase === 'ready' ? load.rows.reduce((sum, r) => sum + r.bytes, 0) : 0;

  return (
    <div className="mt-8" data-testid="drafts">
      <h2 className="text-3xl">Your drafts</h2>
      {gate !== 'content' && <DraftsSkeleton gate={gate} />}
      {gate === 'content' && load.phase === 'unavailable' && (
        <p role="status" className="mt-3" data-testid="drafts-list-unavailable">
          Drafts are not available in this browser, so unfinished designs are not kept.
        </p>
      )}
      {gate === 'content' && load.phase === 'ready' && load.rows.length === 0 && (
        <p className="mt-3" data-testid="drafts-empty">
          No drafts yet. A design you start is kept here automatically.
        </p>
      )}
      {gate === 'content' && load.phase === 'ready' && load.rows.length > 0 && (
        <>
          <p className="mt-1 text-sm text-muted" data-testid="drafts-total">
            Using {formatBytes(total)} of {formatBytes(DRAFT_LIMITS.totalBytes)}, in this browser only.
          </p>
          <ul className="mt-3 divide-y divide-tan border-y border-tan" data-testid="drafts-list">
            {load.rows.map((row) => (
              <li key={row.key} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3" data-testid="draft-row">
                <div className="min-w-0">
                  <p className="text-lg font-semibold text-ink">{row.productName}</p>
                  <p className="text-sm text-muted">
                    {row.colorName}, size {row.garment.size} · {row.layerCount} {row.layerCount === 1 ? 'layer' : 'layers'} · {formatBytes(row.bytes)} · saved {when(row.updatedAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {asking === row.key ? (
                    <>
                      <span className="text-sm">Delete this draft for good?</span>
                      <button type="button" className="btn btn-primary btn-small" onClick={() => void remove(row)}>
                        Yes, delete
                      </button>
                      <button type="button" className="btn btn-secondary btn-small" autoFocus onClick={() => setAsking(null)}>
                        Keep it
                      </button>
                    </>
                  ) : (
                    <>
                      <Link to={`/design?product=${encodeURIComponent(row.productId)}&variant=${encodeURIComponent(row.sku)}`} className="btn btn-secondary btn-small" aria-label={`Open the ${row.productName} draft`}>
                        Open
                      </Link>
                      <button type="button" className="btn btn-secondary btn-small" aria-label={`Delete the ${row.productName} draft`} onClick={() => setAsking(row.key)}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {problem && (
        <p role="alert" className="mt-3 text-brown-dark">
          {problem}
        </p>
      )}
    </div>
  );
}
