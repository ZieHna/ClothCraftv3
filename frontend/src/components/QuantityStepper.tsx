interface Props {
  /** the id the visible <label> points at, or omit it and pass `label` */
  id?: string;
  /** the accessible name when there is no visible label, for example "Quantity of Men Crew Tee" */
  label?: string;
  value: number;
  min?: number;
  max: number;
  disabled?: boolean;
  /** shown empty (for a sold-out variant) */
  blank?: boolean;
  describedBy?: string;
  onChange: (value: number) => void;
}

/** A number field with "one less" and "one more" buttons, 48 px high targets, for whole numbers between min and max. */
export function QuantityStepper({ id, label, value, min = 1, max, disabled = false, blank = false, describedBy, onChange }: Props) {
  const set = (n: number) => onChange(Math.min(max, Math.max(min, Number.isFinite(n) ? Math.floor(n) : min)));
  return (
    <div className="inline-flex items-stretch">
      <button type="button" aria-label="One less" disabled={disabled || value <= min} onClick={() => set(value - 1)} className="btn btn-secondary min-w-12 px-0 disabled:cursor-not-allowed">
        <span aria-hidden="true">−</span>
      </button>
      <input
        id={id}
        aria-label={label}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={blank ? '' : value}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === '') return; // being retyped: wait for a number
          set(e.target.valueAsNumber);
        }}
        aria-describedby={describedBy}
        className="w-16 border-y border-brown-dark bg-cream px-1 text-center text-lg font-semibold text-ink disabled:bg-paper-warm disabled:text-muted"
      />
      <button type="button" aria-label="One more" disabled={disabled || value >= max} onClick={() => set(value + 1)} className="btn btn-secondary min-w-12 px-0 disabled:cursor-not-allowed">
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}
