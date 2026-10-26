import type { ViewState } from '../types';

interface Props {
  view: ViewState;
  handTool: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  onActual: () => void;
  onHand: () => void;
}

const btn = 'btn btn-secondary btn-small min-w-11 px-3 max-sm:min-h-11 pointer-coarse:min-h-11';

/** Zoom out, zoom in, Fit, 100% and the hand tool. The same actions are on the keyboard: +, -, 0, and Space-drag. */
export function ZoomControls({ view, handTool, onZoomOut, onZoomIn, onFit, onActual, onHand }: Props) {
  const pct = Math.round(view.zoom * 100);
  return (
    <div role="group" aria-label="Zoom" className="flex flex-wrap items-center gap-2 lg:gap-1.5" data-testid="zoom-controls">
      <button type="button" aria-label="Zoom out" title="Zoom out (-)" aria-disabled={view.zoom <= view.minZoom + 1e-6} onClick={onZoomOut} className={btn}>
        <span aria-hidden="true">−</span>
      </button>
      <output aria-live="off" className="min-w-14 text-center text-sm font-semibold tabular-nums text-ink" data-testid="zoom-value">
        {pct}%
      </output>
      <button type="button" aria-label="Zoom in" title="Zoom in (+)" aria-disabled={view.zoom >= view.maxZoom - 1e-6} onClick={onZoomIn} className={btn}>
        <span aria-hidden="true">+</span>
      </button>
      <button type="button" title="Fit the whole design in view (0)" aria-pressed={view.atFit} onClick={onFit} className={`${btn} aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-cream`}>
        Fit
      </button>
      <button type="button" title="Actual size: 100%" aria-pressed={Math.abs(view.zoom - 1) < 0.005} onClick={onActual} className={`${btn} aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-cream`}>
        100%
      </button>
      <button type="button" title="Hand tool: drag the canvas to move around (or hold Space)" aria-pressed={handTool} onClick={onHand} className={`${btn} aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-cream`}>
        Hand
      </button>
    </div>
  );
}
