import { forwardRef, useId, useRef, useState } from 'react';
import { FONT_LIST } from '../fonts';
import { DESIGN_SIZE, LAYER_LIMITS, type DesignLayer, type EditOptions, type LayerPatch, type LayerStyle, type StylePatch, type TextAlign } from '../types';
import { ColorField, NumberField, PercentField, SelectField, textInputClass } from './fields';

interface Props {
  layer: DesignLayer | null;
  style: LayerStyle | null;
  /** apply a style change; `live` changes are recorded by onCommit */
  onStyle: (patch: StylePatch, opts?: EditOptions) => Promise<void>;
  onLayer: (patch: LayerPatch, opts?: EditOptions) => void;
  onCommit: () => void;
  onDelete: () => void;
  /** inside a bottom sheet: no box and no visible heading of its own */
  bare?: boolean;
  /** step 9 (the real shop): inches per design unit on this garment at size Small, to show sizes in inches beside px (display only) */
  inchPerUnit?: number;
}

const ALIGNS: ReadonlyArray<{ value: TextAlign; label: string }> = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
];

const KIND_NAME = { text: 'Text', shape: 'Shape', image: 'Picture' } as const;
const { position, size, rotation } = LAYER_LIMITS;

/**
 * The properties of whatever is selected, then its exact position and size. Everything is a normal labelled form
 * control. Edits that arrive as a stream (typing, dragging a slider) are applied live and recorded as ONE history step
 * when they end (see fields.tsx). A locked layer shows its settings but cannot be changed until it is unlocked.
 */
export const PropertiesPanel = forwardRef<HTMLElement, Props>(function PropertiesPanel({ layer, style, onStyle, onLayer, onCommit, onDelete, bare, inchPerUnit }, ref) {
  const titleId = useId();
  const textId = useId();
  const lockId = useId();
  // the font being loaded: the list shows the new choice at once, even though the layer only switches once the file is in
  const [loadingFont, setLoadingFont] = useState<string | null>(null);
  // "keep proportions" is remembered per layer; pictures start with it on, everything else off
  const keep = useRef(new Map<string, boolean>());
  const [, rerender] = useState(0);

  const live = (patch: StylePatch) => void onStyle(patch, { live: true });
  const step = (patch: StylePatch) => void onStyle(patch);
  const locked = layer?.locked === true;
  const proportional = layer ? (keep.current.get(layer.id) ?? layer.type === 'image') : false;

  const setWidth = (width: number) => {
    if (!layer) return;
    onLayer(proportional && layer.width > 0 ? { width, height: Math.min(size.max, Math.max(size.min, (width * layer.height) / layer.width)) } : { width }, { live: true });
  };
  const setHeight = (height: number) => {
    if (!layer) return;
    onLayer(proportional && layer.height > 0 ? { height, width: Math.min(size.max, Math.max(size.min, (height * layer.width) / layer.height)) } : { height }, { live: true });
  };

  return (
    <section ref={ref} tabIndex={-1} aria-labelledby={titleId} className={bare ? 'outline-offset-4' : 'stitched border border-tan bg-cream p-4 outline-offset-4'} data-testid="properties-panel">
      <h2 id={titleId} className={bare ? 'sr-only' : 'relative text-2xl'}>
        {style ? `${KIND_NAME[style.type]} settings` : 'Settings'}
      </h2>
      {!style || !layer ? (
        <p className="relative mt-2 text-sm text-text">
          Nothing is selected. Click something on the garment or in the layers list, or add text, a picture or a shape from the tools.
        </p>
      ) : (
        <div className="relative">
          {!bare && <p className="mt-1 truncate text-sm text-muted">{layer.name}</p>}
          {locked && (
            <p id={lockId} role="note" className="mt-3 border-l-4 border-brown-dark bg-paper-warm py-2 pl-3 text-sm font-medium text-ink" data-testid="locked-note">
              This layer is locked, so it cannot be changed. Unlock it in the layers list to edit it.
            </p>
          )}

          <fieldset disabled={locked} aria-describedby={locked ? lockId : undefined} className="min-w-0">
            <legend className="sr-only">Settings for {layer.name}</legend>

            {style.type === 'text' && (
              <>
                <div className="mt-4">
                  <label htmlFor={textId} className="text-sm font-medium text-ink">
                    Your words
                  </label>
                  <textarea
                    id={textId}
                    rows={2}
                    value={style.text}
                    onChange={(e) => live({ text: e.target.value })}
                    onBlur={onCommit}
                    className={`mt-1 ${textInputClass} resize-y`}
                  />
                  <p className="mt-1 text-sm text-muted">You can also double-click the words on the garment to type there.</p>
                </div>
                <SelectField
                  label="Font"
                  value={loadingFont ?? style.fontFamily}
                  options={FONT_LIST.map((f) => ({ value: f.family, label: `${f.label}, ${f.note}` }))}
                  onChange={(family) => {
                    setLoadingFont(family);
                    void onStyle({ fontFamily: family }).finally(() => setLoadingFont(null));
                  }}
                  note={loadingFont ? 'Loading the font…' : undefined}
                />
                <div className="mt-4">
                  <NumberField label="Font size" unit="8 to 400" value={style.fontSize} min={8} max={400} onChange={(fontSize) => live({ fontSize })} onCommit={onCommit} />
                </div>
                <ColorField label="Text colour" value={style.fill} onChange={(fill, isLive) => (isLive ? live({ fill }) : step({ fill }))} onCommit={onCommit} />
                <fieldset className="mt-4">
                  <legend className="text-sm font-medium text-ink">Alignment</legend>
                  <div className="mt-1 flex gap-2">
                    {ALIGNS.map((a) => (
                      <button key={a.value} type="button" aria-pressed={style.textAlign === a.value} onClick={() => step({ textAlign: a.value })} className="btn btn-secondary btn-small aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-cream">
                        {a.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              </>
            )}

            {style.type === 'shape' && (
              <>
                <ColorField label={style.shape === 'line' ? 'Line colour' : 'Fill colour'} value={style.fill} onChange={(fill, isLive) => (isLive ? live({ fill }) : step({ fill }))} onCommit={onCommit} />
                {style.shape !== 'line' && <ColorField label="Outline colour" value={style.stroke} onChange={(stroke, isLive) => (isLive ? live({ stroke }) : step({ stroke }))} onCommit={onCommit} />}
                <div className="mt-4">
                  <NumberField
                    label={style.shape === 'line' ? 'Thickness' : 'Outline width'}
                    unit={style.shape === 'line' ? 'px, 1 to 60' : 'px, 0 to 60'}
                    value={style.strokeWidth}
                    min={style.shape === 'line' ? 1 : 0}
                    max={60}
                    onChange={(strokeWidth) => live({ strokeWidth })}
                    onCommit={onCommit}
                  />
                </div>
              </>
            )}

            <PercentField label="Opacity" value={style.opacity} onChange={(opacity) => live({ opacity })} onCommit={onCommit} />

            <fieldset className="mt-5 min-w-0 border-t border-tan pt-3" data-testid="geometry">
              <legend className="pr-2 text-sm font-semibold text-ink">Position and size</legend>
              <p className="text-sm text-muted">The centre of the layer, measured from the top left of the design area ({DESIGN_SIZE} px square).</p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <NumberField label="X" unit="px" value={layer.x} min={position.min} max={position.max} onChange={(x) => onLayer({ x }, { live: true })} onCommit={onCommit} />
                <NumberField label="Y" unit="px" value={layer.y} min={position.min} max={position.max} onChange={(y) => onLayer({ y }, { live: true })} onCommit={onCommit} />
                <NumberField label="Width" unit="px" value={layer.width} min={size.min} max={size.max} onChange={setWidth} onCommit={onCommit} />
                {!(style.type === 'shape' && style.shape === 'line') && <NumberField label="Height" unit="px" value={layer.height} min={size.min} max={size.max} onChange={setHeight} onCommit={onCommit} />}
                <NumberField label="Rotation" unit="°" value={layer.rotation} min={rotation.min} max={rotation.max} onChange={(r) => onLayer({ rotation: r }, { live: true })} onCommit={onCommit} />
              </div>
              {inchPerUnit ? (
                <p className="mt-2 text-sm text-muted" data-testid="geometry-inches">
                  Printed about {(layer.width * inchPerUnit).toFixed(1)} × {(layer.height * inchPerUnit).toFixed(1)} in on size Small.
                </p>
              ) : null}
              {!(style.type === 'shape' && style.shape === 'line') && (
                <label className="mt-3 flex min-h-11 items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={proportional}
                    onChange={(e) => {
                      keep.current.set(layer.id, e.target.checked);
                      rerender((n) => n + 1);
                    }}
                    className="size-6 accent-sage-dark"
                  />
                  Keep proportions
                </label>
              )}
            </fieldset>
          </fieldset>

          <p className="mt-4 text-sm text-muted">Move it with the mouse or finger, or with the arrow keys (hold Shift for bigger steps).</p>

          <button type="button" onClick={onDelete} className="btn btn-secondary mt-5 w-full">
            Delete {KIND_NAME[style.type].toLowerCase()}
          </button>
        </div>
      )}
    </section>
  );
});
