import { useEffect, useId, useRef, useState } from 'react';

const inputClass = 'block min-h-11 w-full border border-brown-dark bg-paper px-3 py-2 text-base text-ink disabled:text-muted';

/**
 * Every field here follows one rule so that history stays honest: while the person is still typing or dragging, the
 * change is applied LIVE (the design follows along, no history step); when they finish (leave the field, press Enter,
 * let go of the slider, close the colour picker) onCommit() is called and everything since the last step becomes ONE step.
 */

/** Preset colours: the shop's palette plus a few print-friendly extras. Each has a NAME, so colour is never the only cue. */
export const SWATCHES: ReadonlyArray<{ name: string; hex: string }> = [
  { name: 'Ink', hex: '#1a1714' },
  { name: 'Cream', hex: '#fffdf8' },
  { name: 'Red', hex: '#a8353a' },
  { name: 'Navy', hex: '#243049' },
  { name: 'Sage', hex: '#6b8f71' },
  { name: 'Brown', hex: '#8b7355' },
  { name: 'Gold', hex: '#c9a227' },
  { name: 'Rose', hex: '#d98ca0' },
];

/**
 * A colour: named preset buttons (each click is its own step) plus the browser's own colour picker for anything else
 * (live while it is open, one step when it closes). The value is always shown as text.
 */
export function ColorField({ label, value, onChange, onCommit }: { label: string; value: string; onChange: (hex: string, live: boolean) => void; onCommit: () => void }) {
  const groupId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const current = value.toLowerCase();
  const preset = SWATCHES.find((s) => s.hex === current);
  // React's onChange on a colour input is the browser's "input" event (every drag inside the picker). The picker's
  // own "change" event is the one that means "finished".
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const el = picker.current;
    if (!el) return;
    const done = () => commit.current();
    el.addEventListener('change', done);
    el.addEventListener('blur', done);
    return () => {
      el.removeEventListener('change', done);
      el.removeEventListener('blur', done);
    };
  }, []);
  return (
    <div role="group" aria-labelledby={groupId} className="mt-4">
      <p id={groupId} className="text-sm font-medium text-ink">
        {label}: <span className="font-normal text-muted">{preset ? `${preset.name} (${current})` : current}</span>
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {SWATCHES.map((s) => {
          const on = s.hex === current;
          return (
            <button
              key={s.hex}
              type="button"
              aria-label={`${label}: ${s.name}`}
              aria-pressed={on}
              onClick={() => onChange(s.hex, false)}
              className={`size-9 max-sm:size-11 pointer-coarse:size-11 rounded-full border-2 ${on ? 'border-ink shadow-[inset_0_0_0_3px_var(--color-cream)]' : 'border-brown-dark'}`}
              style={{ background: s.hex }}
            />
          );
        })}
        <label className="flex items-center gap-2 text-sm text-text">
          <span className="sr-only">{label}: pick any colour</span>
          <input ref={picker} type="color" value={/^#[0-9a-f]{6}$/.test(current) ? current : '#000000'} onChange={(e) => onChange(e.target.value, true)} className="h-9 w-12 max-sm:h-11 max-sm:w-14 cursor-pointer border border-brown-dark bg-paper p-0.5" />
          <span aria-hidden="true">Other</span>
        </label>
      </div>
    </div>
  );
}

/**
 * A whole number the person types, with its unit and range. It keeps its own draft so typing "1" on the way to "120"
 * is not forced up to the minimum mid-keystroke. A valid number is applied live at once; one that is out of range says
 * so in words and is NOT applied; the field snaps back to the real value when it loses focus. Enter or leaving the
 * field calls onCommit.
 */
export function NumberField({
  label,
  unit,
  value,
  min,
  max,
  onChange,
  onCommit,
  disabled,
}: {
  label: string;
  /** shown after the label, such as "px" or "°" */
  unit?: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  onCommit: () => void;
  disabled?: boolean;
}) {
  const id = useId();
  const hint = `${id}-hint`;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value));
  const bad = draft !== null && !(draft.trim() !== '' && Number.isInteger(Number(draft)) && Number(draft) >= min && Number(draft) <= max);
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
        {unit ? ` (${unit})` : ''}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={shown}
        disabled={disabled}
        aria-invalid={bad}
        aria-describedby={bad ? hint : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isInteger(n) && n >= min && n <= max) onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit();
            setDraft(null);
          }
        }}
        onBlur={() => {
          onCommit();
          setDraft(null);
        }}
        className={`mt-1 ${inputClass}`}
      />
      {bad && (
        <p id={hint} className="mt-1 text-sm font-medium text-brown-dark">
          Problem: use a whole number from {min} to {max}.
        </p>
      )}
    </div>
  );
}

/** 0 to 100 percent as a slider. Dragging (or holding an arrow key) is live; letting go is one step. */
export function PercentField({ label, value, onChange, onCommit }: { label: string; value: number; onChange: (fraction: number) => void; onCommit: () => void }) {
  const id = useId();
  const pct = Math.round(value * 100);
  return (
    <div className="mt-4">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}: <span className="font-normal text-muted">{pct}%</span>
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={5}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
        className="mt-1 block h-11 w-full accent-sage-dark"
      />
    </div>
  );
}

export function SelectField<T extends string>({ label, value, options, onChange, note }: { label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (v: T) => void; note?: string }) {
  const id = useId();
  return (
    <div className="mt-4">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} className={`mt-1 ${inputClass}`}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {note && (
        <p className="mt-1 text-sm text-muted" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

export const textInputClass = inputClass;
