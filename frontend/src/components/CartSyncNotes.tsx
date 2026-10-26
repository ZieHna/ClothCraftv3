import { cartStore, useCartSync } from '../cart/cartStore';

/**
 * Step 12 (real shop): what happened to the saved cart, in words, on the cart page. An edit is never lost without a word: when it could
 * not be saved the page says so, keeps it on this device and tries again; when another tab or device changed the cart, the changes are
 * combined and the page says that too.
 */
export function CartSyncNotes() {
  const sync = useCartSync();
  if (sync.phase === 'off') return null;
  return (
    <>
      {sync.offline && sync.pending && <OfflineNote />}
      {sync.refused === -1 && (
        <div role="alert" className="mt-3 border-2 border-brown-dark bg-cream p-4" data-testid="cart-not-saved">
          <p className="font-medium text-brown-dark">Your latest cart changes could not be saved to your account. They are kept on this device.</p>
          <button type="button" className="btn btn-secondary btn-small mt-3" onClick={() => cartStore.retry()}>
            Try again
          </button>
        </div>
      )}
      {(sync.conflict || sync.added > 0 || sync.refused > 0) && (
        <div role="status" className="mt-3 border border-sage-dark bg-cream p-4" data-testid="cart-merged">
          {sync.conflict && <p className="font-medium text-ink">Your cart was also changed in another tab or on another device. We combined the changes, and nothing was removed.</p>}
          {sync.added > 0 && (
            <p className="font-medium text-ink" data-testid="cart-added-from-device">
              We added {sync.added === 1 ? '1 item' : `${sync.added} items`} saved on this device to your cart.
            </p>
          )}
          {sync.refused > 0 && (
            <p className="font-medium text-brown-dark" data-testid="cart-refused">
              {sync.refused === 1 ? '1 item is' : `${sync.refused} items are`} no longer available and {sync.refused === 1 ? 'was' : 'were'} taken out of your cart.
            </p>
          )}
          <button type="button" className="mt-2 text-sm font-medium underline underline-offset-4" onClick={() => cartStore.dismissNotes()}>
            OK
          </button>
        </div>
      )}
    </>
  );
}

/** The cart's edits are waiting for the connection: said on every page, since an "Add to cart" can happen anywhere. */
export function OfflineNote({ bar = false }: { bar?: boolean }) {
  const text = "You're offline. Your cart changes are kept on this device and will be saved when the connection is back.";
  if (bar) {
    return (
      <p role="status" className="border-b border-brown-dark bg-cream px-4 py-2 text-center text-sm font-medium text-brown-dark" data-testid="cart-offline-bar">
        {text}{' '}
        <button type="button" className="underline underline-offset-4" onClick={() => cartStore.retry()}>
          Try again
        </button>
      </p>
    );
  }
  return (
    <div role="status" className="mt-3 border-2 border-brown-dark bg-cream p-4" data-testid="cart-offline">
      <p className="font-medium text-brown-dark">{text}</p>
      <button type="button" className="btn btn-secondary btn-small mt-3" onClick={() => cartStore.retry()}>
        Try again
      </button>
    </div>
  );
}

/** Every page but the cart (which has its own note): a thin bar while cart edits wait for the connection. */
export function CartOfflineBar() {
  const sync = useCartSync();
  return sync.phase !== 'off' && sync.offline && sync.pending ? <OfflineNote bar /> : null;
}
