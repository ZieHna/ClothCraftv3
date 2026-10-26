import { useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { receiveRestock, type ReceiveBody, type RestockDetail } from '../../api/inventory';
import { FormDialog } from '../FormDialog';
import { control, Field, FormAlert, NO_PROBLEM, problemOf, useFocusFirstError, useSubmit, type Problem } from '../suppliers/supplierUi';
import { movedOn, type Changed } from './restockMoves';
import { todayManila } from './restockText';

const FIELDS = ['quantities', 'lots', 'receivedOn', 'note'] as const;

/**
 * Receive the goods: the quantity that arrived on each line (what was asked for to start with), an optional lot name typed per line, the day they
 * arrived and a note. The browser only sends what was typed; the stock, the receipt, the costs and every refusal (a lot name that already exists
 * for the product included) are the server's, shown as it sent them. Receiving happens once and cannot be undone, which the dialog says.
 */
export function ReceiveDialog({ restock, onClose, onDone }: { restock: RestockDetail; onClose: () => void; onDone: Changed }) {
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(restock.lines.map((l) => [l.id, String(l.quantity)])));
  const [lots, setLots] = useState<Record<string, string>>({});
  const [on, setOn] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<Problem>(NO_PROBLEM);
  const [stamp, setStamp] = useState(0);
  const { busy, run } = useSubmit();
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, stamp);
  const fail = (next: Problem) => {
    setProblem(next);
    setStamp((n) => n + 1);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const quantities: Record<string, number> = {};
      for (const l of restock.lines) {
        const raw = (qty[l.id] ?? '').trim();
        if (!/^\d+$/.test(raw)) return fail({ fields: { quantities: `${l.sku ?? l.name}: enter a whole number, 0 or more.` }, message: null });
        quantities[l.id] = Number(raw);
      }
      const typed: Record<string, string> = {};
      for (const [id, value] of Object.entries(lots)) if (value.trim()) typed[id] = value.trim();
      const body: ReceiveBody = { quantities, ...(Object.keys(typed).length ? { lots: typed } : {}), ...(on ? { receivedOn: on } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
      setProblem(NO_PROBLEM);
      try {
        const response = await receiveRestock(restock.id, body);
        onDone(response.data.restock, `${restock.name}: received${response.data.restock.receivedLate ? ', late' : ''}.`);
      } catch (error) {
        const current = movedOn(error);
        if (current) return onDone(current, error instanceof ApiError ? error.message : 'This restock has already moved on.');
        fail(problemOf(error, FIELDS));
      }
    });
  };

  return (
    <FormDialog title={restock.state === 'not_received' ? 'Mark as received' : 'Receive the goods'} busy={busy} onClose={onClose} testId="restock-receive-dialog">
      <form ref={form} onSubmit={submit} noValidate className="space-y-4">
        <p>Enter what arrived. Receiving adds the stock once and cannot be undone.</p>
        <ul className="space-y-3" data-testid="receive-lines">
          {restock.lines.map((l) => (
            <li key={l.id} className="border border-tan bg-paper p-3" data-testid="receive-line">
              <p className="font-semibold text-ink">{l.sku ?? l.name}</p>
              <p className="text-sm text-muted">Asked for {l.quantity}</p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label="Received">
                  {(p) => <input {...p} inputMode="numeric" value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} className={control} />}
                </Field>
                <Field label="Lot name" optional hint="Left empty, the ticket number and SKU are used.">
                  {(p) => <input {...p} value={lots[l.id] ?? ''} onChange={(e) => setLots({ ...lots, [l.id]: e.target.value })} maxLength={64} className={control} />}
                </Field>
              </div>
            </li>
          ))}
        </ul>
        {(problem.fields.quantities || problem.fields.lots) && (
          <p role="alert" tabIndex={-1} className="font-medium text-brown-dark">
            {[problem.fields.quantities, problem.fields.lots].filter(Boolean).join(' ')}
          </p>
        )}
        <Field label="Day it arrived" optional hint="Today, in Manila time, when left empty. It cannot be in the future." error={problem.fields.receivedOn}>
          {(p) => <input {...p} type="date" value={on} max={todayManila()} onChange={(e) => setOn(e.target.value)} className={control} />}
        </Field>
        <Field label="Note" optional hint="Up to 500 characters." error={problem.fields.note}>
          {(p) => <textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} className={control} />}
        </Field>
        <FormAlert message={problem.message} />
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} className="btn btn-primary disabled:cursor-wait disabled:opacity-70" data-testid="restock-receive-yes">
            {busy ? 'Receiving…' : 'Receive'}
          </button>
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-secondary disabled:opacity-60">
            Cancel
          </button>
        </div>
      </form>
    </FormDialog>
  );
}
