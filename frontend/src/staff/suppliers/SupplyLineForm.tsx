import { useEffect, useRef, useState, type FormEvent } from 'react';
import { addSupplyLine, getGarmentOptions, updateSupplyLine, type GarmentOption, type SupplierDetail, type SupplyLine } from '../../api/suppliers';
import { control, Field, FormAlert, NO_PROBLEM, problemOf, useFocusFirstError, useSubmit, type Problem } from './supplierUi';

const FIELDS = ['garmentTypeId', 'sizeValueId', 'colorValueId', 'unitCost'] as const;

type Options = { phase: 'loading' } | { phase: 'ready'; garments: GarmentOption[] } | { phase: 'error' };

/**
 * Add or change one supply line. Garment type first; then only the sizes that garment is made in, and, for the chosen size, only the colours
 * it comes in (the valid size x colour pairs the server sent). The cost is typed with VAT included; the VAT and net parts shown in the table
 * afterwards are the server's, and nothing is worked out here while typing.
 */
export function SupplyLineForm({ supplierId, line, onSaved, onCancel }: {
  supplierId: string;
  line?: SupplyLine;
  onSaved: (supplier: SupplierDetail, message: string) => void;
  onCancel: () => void;
}) {
  const [options, setOptions] = useState<Options>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [garmentId, setGarmentId] = useState(line?.garmentType.id ?? '');
  const [sizeId, setSizeId] = useState(line?.size.id ?? '');
  const [colorId, setColorId] = useState(line?.color.id ?? '');
  const [cost, setCost] = useState(line ? String(line.unitCost) : '');
  const [problem, setProblem] = useState<Problem>(NO_PROBLEM);
  const [stamp, setStamp] = useState(0);
  const { busy, run } = useSubmit();
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, stamp);

  useEffect(() => {
    const controller = new AbortController();
    setOptions({ phase: 'loading' });
    getGarmentOptions(controller.signal)
      .then((response) => setOptions({ phase: 'ready', garments: response.data.garmentTypes }))
      .catch(() => !controller.signal.aborted && setOptions({ phase: 'error' }));
    return () => controller.abort();
  }, [attempt]);

  // the form opens above a long list: once it is drawn, the first field takes focus (the page scrolls to the form itself)
  useEffect(() => {
    if (options.phase === 'ready') form.current?.querySelector<HTMLElement>('select, input, textarea')?.focus({ preventScroll: true });
  }, [options.phase]);

  const fail = (next: Problem) => {
    setProblem(next);
    setStamp((n) => n + 1);
  };

  if (options.phase === 'loading') return <p role="status" className="mt-3 text-muted">Loading garment types…</p>;
  if (options.phase === 'error') {
    return (
      <div role="alert" className="mt-3">
        <p className="font-medium text-brown-dark">Could not load the garment types.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const garment = options.garments.find((g) => g.id === garmentId);
  const sizeIds = new Set(garment?.combos.map(([s]) => s));
  const sizes = garment?.sizes.filter((s) => sizeIds.has(s.id)) ?? [];
  const colours = garment?.colors.filter((c) => garment.combos.some(([s, col]) => s === sizeId && col === c.id)) ?? [];
  const err = (name: string) => problem.fields[name];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const fields: Record<string, string> = {};
      if (!garment) fields.garmentTypeId = 'Choose a garment type.';
      if (!sizeId || !sizes.some((s) => s.id === sizeId)) fields.sizeValueId = 'Choose a size.';
      if (!colorId || !colours.some((c) => c.id === colorId)) fields.colorValueId = 'Choose a colour.';
      const amount = cost.trim() === '' ? Number.NaN : Number(cost);
      if (!Number.isFinite(amount) || amount < 0) fields.unitCost = 'Enter the cost as an amount, for example 56.50.';
      if (Object.keys(fields).length > 0) return fail({ fields, message: null });
      setProblem(NO_PROBLEM);
      const body = { garmentTypeId: garmentId, sizeValueId: sizeId, colorValueId: colorId, unitCost: amount };
      try {
        const response = line ? await updateSupplyLine(line.id, body) : await addSupplyLine(supplierId, body);
        onSaved(response.data.supplier, line ? 'Supply line saved.' : 'Supply line added.');
      } catch (error) {
        fail(problemOf(error, FIELDS));
      }
    });
  };

  return (
    <form ref={form} onSubmit={submit} noValidate aria-label={line ? 'Change supply line' : 'Add supply line'} aria-busy={busy} className="mt-4 space-y-4 border-2 border-dashed border-brown-dark p-4" data-testid="line-form">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Garment type" error={err('garmentTypeId')}>
          {(p) => (
            <select
              {...p}
              value={garmentId}
              onChange={(e) => {
                setGarmentId(e.target.value);
                setSizeId('');
                setColorId('');
              }}
              className={control}
            >
              <option value="">Choose…</option>
              {options.garments.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Size" error={err('sizeValueId')}>
          {(p) => (
            <select
              {...p}
              value={sizeId}
              disabled={!garment}
              onChange={(e) => {
                setSizeId(e.target.value);
                setColorId('');
              }}
              className={`${control} disabled:opacity-60`}
            >
              <option value="">{garment ? 'Choose…' : 'Choose a garment type first'}</option>
              {sizes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Colour" error={err('colorValueId')}>
          {(p) => (
            <select {...p} value={colorId} disabled={!sizeId} onChange={(e) => setColorId(e.target.value)} className={`${control} disabled:opacity-60`}>
              <option value="">{sizeId ? 'Choose…' : 'Choose a size first'}</option>
              {colours.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Unit cost (₱, VAT included)" error={err('unitCost')}>
          {(p) => <input {...p} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} className={control} />}
        </Field>
      </div>
      <FormAlert message={problem.message} />
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className="btn btn-primary disabled:cursor-wait disabled:opacity-70" data-testid="line-save">
          {busy ? 'Saving…' : line ? 'Save supply line' : 'Add supply line'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="btn btn-secondary disabled:opacity-60">
          Cancel
        </button>
      </div>
    </form>
  );
}
