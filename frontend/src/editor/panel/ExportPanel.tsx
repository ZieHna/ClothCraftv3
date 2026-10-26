import { useId, useState } from 'react';
import { MAX_EXPORT_PX, exportSize } from '../types';
import type { ExportKind } from '../exportName';

interface Props {
  disabled: boolean;
  /** resolves when the file has been handed to the browser */
  onExport: (kind: ExportKind, scale: 1 | 2) => Promise<void>;
  /** inside a bottom sheet: no box of its own */
  bare?: boolean;
  /** in the narrow left rail of the desktop: 1x and 2x side by side, buttons stacked, smaller text */
  compact?: boolean;
}

/**
 * Two downloads: the design on the garment, and the design alone on a transparent background, each at 1x (800 px) or 2x
 * (1600 px). Nothing is uploaded: the file is made in this browser. The output never exceeds MAX_EXPORT_PX on a side.
 * No price appears here.
 */
export function ExportPanel({ disabled, onExport, bare, compact }: Props) {
  const name = useId();
  const [scale, setScale] = useState<1 | 2>(2);
  const [working, setWorking] = useState<ExportKind | null>(null);
  const px = exportSize(scale).px;
  const go = (kind: ExportKind) => {
    setWorking(kind);
    void onExport(kind, scale).finally(() => setWorking(null));
  };
  return (
    <section aria-labelledby={`${name}-title`} className={bare ? '' : compact ? 'stitched border border-tan bg-cream px-3 py-2' : 'stitched border border-tan bg-cream p-4'} data-testid="export-panel">
      <h2 id={`${name}-title`} className={compact ? 'relative text-xl' : 'relative text-2xl'}>
        Download
      </h2>
      <fieldset className="relative mt-2">
        <legend className="text-sm font-medium text-ink">Size</legend>
        <div className={compact ? 'mt-1 grid grid-cols-2 gap-1.5' : 'mt-1 flex gap-2'}>
          {([1, 2] as const).map((s) => (
            <span key={s}>
              <input type="radio" className="sr-only" name={`${name}-scale`} id={`${name}-scale-${s}`} checked={scale === s} onChange={() => setScale(s)} />
              <label htmlFor={`${name}-scale-${s}`} className={compact ? 'option flex-col gap-0 px-1 text-sm leading-tight' : 'option'}>
                {s}x{' '}
                <span className={compact ? 'text-xs font-normal' : ''}>({exportSize(s).px} px)</span>
              </label>
            </span>
          ))}
        </div>
      </fieldset>
      <div className={compact ? 'relative mt-2 flex flex-col gap-1.5' : 'relative mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap'}>
        <button type="button" disabled={disabled || working !== null} onClick={() => go('preview')} className={compact ? 'btn btn-primary min-h-11 whitespace-normal text-center text-sm leading-tight' : 'btn btn-primary min-h-11'}>
          {working === 'preview' ? 'Making the preview…' : 'Download preview'}
        </button>
        <button type="button" disabled={disabled || working !== null} onClick={() => go('design')} className={compact ? 'btn btn-secondary min-h-11 whitespace-normal text-center text-sm leading-tight' : 'btn btn-secondary min-h-11'}>
          {working === 'design' ? 'Making the file…' : 'Download design only (transparent)'}
        </button>
      </div>
      <p className={compact ? 'relative mt-2 text-xs leading-snug text-text' : 'relative mt-3 text-sm text-text'}>
        <strong className="font-semibold">Preview:</strong> your design on the garment. It uses a small garment photo, so it is for looking at, not for printing.
      </p>
      <p className={compact ? 'relative mt-1 text-xs leading-snug text-text' : 'relative mt-1 text-sm text-text'}>
        <strong className="font-semibold">Design only:</strong> your design alone on a transparent background, {px} by {px} px. This is the file to use for printing.
      </p>
      <p className={compact ? 'relative mt-1 text-xs leading-snug text-muted' : 'relative mt-1 text-xs text-muted'}>Made in your browser; nothing is uploaded. The longest side is never more than {MAX_EXPORT_PX} px.</p>
    </section>
  );
}
