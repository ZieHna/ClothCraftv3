import { useId } from 'react';

/** What the picker offers, built by the page from the product's variants. It shows no price: that is decided at ordering. */
export interface GarmentOptions {
  productName: string;
  colors: ReadonlyArray<{ id: string; name: string; hex: string }>;
  sizes: readonly string[];
  /** is this exact colour in this exact size sold out right now? (a variant that does not exist counts as sold out) */
  soldOut: (color: string, size: string) => boolean;
}

interface Props {
  options: GarmentOptions;
  value: { color: string; size: string };
  onPick: (pick: { color?: string; size?: string }) => void;
  disabled?: boolean;
}

/**
 * Colour and size of the garment, as two groups of real radio buttons (arrow keys move within a group). An option that
 * would give a variant that is sold out is shown disabled and struck through, and the reason is written out below it.
 * Changing either keeps the design. The print area is the same on every size.
 */
export function ColorSizePicker({ options, value, onPick, disabled }: Props) {
  const name = useId();
  const colourName = (id: string) => options.colors.find((c) => c.id === id)?.name ?? id;
  const goneColours = options.colors.filter((c) => c.id !== value.color && options.soldOut(c.id, value.size));
  const goneSizes = options.sizes.filter((s) => s !== value.size && options.soldOut(value.color, s));

  return (
    <div data-testid="colour-size">
      <fieldset>
        <legend className="text-sm font-medium text-ink">
          Colour: <span className="font-normal text-muted">{colourName(value.color)}</span>
        </legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {options.colors.map((c) => {
            const gone = options.soldOut(c.id, value.size);
            return (
              <span key={c.id}>
                <input
                  type="radio"
                  className="sr-only"
                  name={`${name}-colour`}
                  id={`${name}-colour-${c.id}`}
                  value={c.id}
                  checked={c.id === value.color}
                  disabled={disabled || (gone && c.id !== value.color)}
                  onChange={() => onPick({ color: c.id })}
                />
                <label htmlFor={`${name}-colour-${c.id}`} className="option">
                  <span aria-hidden="true" className="size-5 rounded-full border-2 border-cream shadow-[0_0_0_1px_var(--color-ink)]" style={{ background: c.hex }} />
                  {c.name}
                  {gone && <span className="sr-only"> (sold out in size {value.size})</span>}
                </label>
              </span>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-ink">
          Size: <span className="font-normal text-muted">{value.size}</span>
        </legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {options.sizes.map((s) => {
            const gone = options.soldOut(value.color, s);
            return (
              <span key={s}>
                <input
                  type="radio"
                  className="sr-only"
                  name={`${name}-size`}
                  id={`${name}-size-${s}`}
                  value={s}
                  checked={s === value.size}
                  disabled={disabled || (gone && s !== value.size)}
                  onChange={() => onPick({ size: s })}
                />
                <label htmlFor={`${name}-size-${s}`} className={`option ${gone ? 'is-soldout' : ''}`}>
                  {s}
                  {gone && <span className="sr-only"> (sold out in {colourName(value.color)})</span>}
                </label>
              </span>
            );
          })}
        </div>
      </fieldset>

      {(goneColours.length > 0 || goneSizes.length > 0 || options.soldOut(value.color, value.size)) && (
        <div className="mt-3 border-l-4 border-brown-dark bg-paper-warm py-2 pl-3 text-sm font-medium text-ink" data-testid="soldout-note">
          {options.soldOut(value.color, value.size) && (
            <p>
              {colourName(value.color)} in size {value.size} is sold out right now.
            </p>
          )}
          {goneColours.length > 0 && (
            <p>
              Sold out in size {value.size}: {goneColours.map((c) => c.name).join(', ')}. Choose another size first to pick {goneColours.length === 1 ? 'it' : 'them'}.
            </p>
          )}
          {goneSizes.length > 0 && (
            <p>
              Sold out in {colourName(value.color)}: {goneSizes.join(', ')}.
            </p>
          )}
        </div>
      )}
      <p className="mt-3 text-sm text-muted">Changing colour or size keeps your design. The print area is the same on every size.</p>
    </div>
  );
}
