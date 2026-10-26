import { cartStore, useJustMadeNote } from '../cart/cartStore';

/**
 * After "Proceed to checkout" on the Design page ticked only the new design: says so, in the cart and at checkout, until it is
 * dismissed or a tick changes. It is kept in memory only, so a reload does not show it again.
 */
export function JustMadeNote() {
  const show = useJustMadeNote();
  if (!show) return null;
  return (
    <div className="mt-3 flex items-start justify-between gap-3 border border-sage-dark bg-cream p-3" data-testid="just-made-note">
      <p className="text-sm font-medium text-sage-dark">Checking out the design you just made. Your other items are still in your cart.</p>
      <button type="button" onClick={() => cartStore.dismissJustMade()} className="btn btn-secondary btn-small shrink-0" aria-label="Dismiss this note">
        Dismiss
      </button>
    </div>
  );
}
