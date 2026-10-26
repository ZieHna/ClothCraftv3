import { useId, useRef } from 'react';
import { SHAPE_KINDS, type ShapeKind } from '../types';
import { Icon } from './icons';

interface Props {
  disabled: boolean;
  onAddText: () => void;
  onAddShape: (kind: ShapeKind) => void;
  onPickFile: (file: File) => void;
  /** a sentence about the last upload that was refused; shown as text, not just colour */
  uploadProblem: string;
}

export const SHAPE_LABEL: Record<ShapeKind, string> = { rectangle: 'Rectangle', circle: 'Circle', triangle: 'Triangle', star: 'Star', line: 'Line' };

const toolClass = 'btn btn-secondary justify-start gap-3 text-left';

/** The picture file chooser, and the problem text for a refused file. Shared by the rail (desktop, tablet) and the phone toolbar. */
export function usePictureInput(onPickFile: (file: File) => void) {
  const input = useRef<HTMLInputElement>(null);
  const element = (
    <input
      ref={input}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      tabIndex={-1}
      aria-hidden="true"
      className="sr-only"
      data-testid="picture-input"
      onChange={(e) => {
        const picked = e.target.files?.[0];
        e.target.value = ''; // so choosing the same file again still fires
        if (picked) onPickFile(picked);
      }}
    />
  );
  return { open: () => input.current?.click(), element };
}

/**
 * The tools: Text, Picture, Shapes. A column on the left of a desktop, a wrapping row above the canvas on a tablet. Every
 * tool is a real <button> with a visible text label; the picture button opens the file chooser. The file is only ever read
 * in this browser. Which files are acceptable is decided by the editor from the file's bytes, not by the accept hint.
 */
export function ToolRail({ disabled, onAddText, onAddShape, onPickFile, uploadProblem }: Props) {
  const picture = usePictureInput(onPickFile);
  const shapesId = useId();
  const problemId = useId();
  return (
    <nav aria-label="Design tools" className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start lg:flex-col lg:gap-2">
      <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start lg:flex-col lg:gap-1.5">
        <li>
          <button type="button" disabled={disabled} onClick={onAddText} className={`${toolClass} w-full`}>
            <Icon name="text" />
            Add text
          </button>
        </li>
        <li className="sm:max-w-56 lg:max-w-none">
          <button type="button" disabled={disabled} onClick={picture.open} aria-describedby={uploadProblem ? problemId : undefined} className={`${toolClass} w-full`}>
            <Icon name="picture" />
            Add picture
          </button>
          {picture.element}
          <p className="mt-1 text-xs text-muted">PNG, JPEG or WebP, up to 10 MB. Stays in your browser.</p>
          {uploadProblem && <UploadProblem id={problemId} text={uploadProblem} />}
        </li>
      </ul>
      <div role="group" aria-labelledby={shapesId} className="sm:min-w-0 sm:flex-1 lg:flex-none">
        <p id={shapesId} className="eyebrow">
          Shapes
        </p>
        <ul className="mt-2 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:grid lg:grid-cols-1 lg:gap-1.5">
          {SHAPE_KINDS.map((kind) => (
            <li key={kind}>
              <button type="button" disabled={disabled} aria-label={`Add ${SHAPE_LABEL[kind].toLowerCase()}`} onClick={() => onAddShape(kind)} className={`${toolClass} w-full`}>
                <Icon name={kind} />
                {SHAPE_LABEL[kind]}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

export function UploadProblem({ id, text }: { id: string; text: string }) {
  return (
    <p id={id} className="mt-2 border-l-4 border-brown-dark bg-paper-warm py-1 pl-2 text-sm font-medium text-ink" data-testid="upload-problem">
      <span className="font-semibold">Picture not added.</span> {text}
    </p>
  );
}
