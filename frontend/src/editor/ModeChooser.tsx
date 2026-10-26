import { useId, useState, type FormEvent } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { PHONE_QUERY } from './flags';
import type { EditorMode } from './types';

interface Props {
  onChoose: (mode: EditorMode) => void;
}

const cardClass =
  'group relative flex cursor-pointer flex-col gap-2 border border-brown-dark bg-cream p-5 has-checked:border-ink has-checked:bg-paper-warm has-checked:ring-2 has-checked:ring-ink has-focus-visible:outline-3 has-focus-visible:outline-offset-4 has-focus-visible:outline-ink has-disabled:cursor-not-allowed has-disabled:border-dashed has-disabled:border-muted has-disabled:bg-paper-warm';

/** the visible radio: an empty ring, filled when chosen, dashed when it cannot be chosen */
function Dot() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-5 shrink-0 rounded-full border-2 border-brown-dark bg-cream group-has-checked:border-ink group-has-checked:bg-ink group-has-checked:shadow-[inset_0_0_0_3px_var(--color-cream)] group-has-disabled:border-dashed group-has-disabled:border-muted"
    />
  );
}

/**
 * Step before the canvas: Simple or Pro. Native radio inputs give arrow-key selection and a real tab stop; the focus
 * ring is drawn on the card (has-focus-visible) because the radio itself is visually hidden. Pro is disabled on phone
 * width, and nothing here loads any editor code.
 */
export function ModeChooser({ onChoose }: Props) {
  const phone = useMediaQuery(PHONE_QUERY);
  const [mode, setMode] = useState<EditorMode>('simple');
  const name = useId();
  const proNoteId = useId();
  const selected: EditorMode = phone ? 'simple' : mode;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onChoose(selected);
  };

  return (
    <form onSubmit={submit} className="mt-6" data-testid="mode-chooser">
      <fieldset>
        <legend className="font-display text-3xl font-bold text-ink">How do you want to design?</legend>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className={cardClass}>
            <input
              type="radio"
              name={name}
              value="simple"
              checked={selected === 'simple'}
              onChange={() => setMode('simple')}
              className="peer sr-only"
            />
            <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Dot />
              <span className="font-display text-2xl font-bold text-ink">Simple</span>
              <span className="rounded-sm border border-sage-dark bg-sage-dark px-2 py-0.5 text-xs font-semibold uppercase tracking-widest text-cream">
                Recommended
              </span>
            </span>
            <span className="text-text">Quick and easy. Add text, pictures and shapes. Works on phone and computer.</span>
          </label>

          <label className={cardClass}>
            <input
              type="radio"
              name={name}
              value="pro"
              checked={selected === 'pro'}
              disabled={phone}
              aria-describedby={phone ? proNoteId : undefined}
              onChange={() => setMode('pro')}
              className="peer sr-only"
            />
            <span className="flex items-center gap-3">
              <Dot />
              <span className="font-display text-2xl font-bold text-ink">Pro</span>
            </span>
            <span className="text-text">A full editor with advanced tools. Best on a computer.</span>
            {phone && (
              <span id={proNoteId} className="text-sm font-medium text-muted">
                Pro is not available on a phone-sized screen.
              </span>
            )}
          </label>
        </div>
      </fieldset>

      <p className="mt-4 max-w-prose border border-dashed border-brown/70 bg-cream p-3 text-sm text-text" role="note">
        Heads up: a design can&rsquo;t be moved between Simple and Pro. To switch later, you&rsquo;ll start a new design.
      </p>

      <button type="submit" className="btn btn-primary mt-6">
        Continue with {selected === 'pro' ? 'Pro' : 'Simple'}
      </button>
    </form>
  );
}
