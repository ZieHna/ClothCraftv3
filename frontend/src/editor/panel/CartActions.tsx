/**
 * "Add this customization to cart" and "Proceed to checkout" (step 9). Off, with the reason in words next to them and tied to them
 * (aria-describedby), whenever they cannot work: nothing to print yet, the editor finishing a step, a sold-out size, a garment that
 * cannot be customized, the mock shop. `header` sits in the page header row (tablet and desktop); `phone` is the slim row in the
 * bottom bar, with the reason on one line above the buttons so the row never changes height; `inline` is a phone on its side, where
 * there is no height for a row: the reason and the buttons sit at the end of the tool bar.
 */
export interface CartActionsProps {
  variant: 'header' | 'phone' | 'inline';
  /** why the buttons are off, or null when they work */
  reason: string | null;
  /** preparing or sending: the buttons say so and wait */
  working: string | null;
  editing: boolean;
  onAdd: () => void;
  onCheckout: () => void;
}

export function CartActions({ variant, reason, working, editing, onAdd, onCheckout }: CartActionsProps) {
  const reasonId = `cart-actions-reason-${variant}`;
  const off = !!reason || !!working;
  const button = 'btn aria-disabled:cursor-not-allowed aria-disabled:border-muted aria-disabled:bg-paper-warm aria-disabled:text-muted';
  const short = variant !== 'header';
  const add = editing ? (short ? 'Update cart' : 'Update this customization in the cart') : short ? 'Add to cart' : 'Add this customization to cart';
  const fill = variant === 'phone' ? 'min-h-11 flex-1 px-2' : variant === 'inline' ? 'min-h-11 px-3' : '';
  const buttons = (
    <>
      <button type="button" aria-disabled={off} aria-describedby={reason ? reasonId : undefined} onClick={() => !off && onAdd()} className={`${button} btn-primary btn-small ${fill}`} data-testid="design-add-to-cart">
        {working ?? add}
      </button>
      <button type="button" aria-disabled={off} aria-describedby={reason ? reasonId : undefined} onClick={() => !off && onCheckout()} className={`${button} btn-secondary btn-small ${fill}`} data-testid="design-checkout">
        {short ? 'Checkout' : 'Proceed to checkout'}
      </button>
    </>
  );
  if (variant === 'inline') {
    return (
      <div className="flex shrink-0 items-center gap-2" data-testid="design-action-row">
        <p id={reasonId} className="line-clamp-2 max-w-[11rem] text-xs leading-tight text-muted" data-testid="design-actions-reason">
          {reason ?? ''}
        </p>
        {buttons}
      </div>
    );
  }
  if (variant === 'phone') {
    return (
      <div className="border-b border-tan px-3 pt-1 pb-1.5" data-testid="design-action-row">
        <p id={reasonId} className="h-4 truncate text-center text-xs leading-4 text-muted" data-testid="design-actions-reason">
          {reason ?? ''}
        </p>
        <div className="mx-auto mt-1 flex max-w-xl gap-2">{buttons}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1" data-testid="design-actions">
      {reason && (
        <p id={reasonId} className="text-sm text-muted" data-testid="design-actions-reason">
          {reason}
        </p>
      )}
      {buttons}
    </div>
  );
}
