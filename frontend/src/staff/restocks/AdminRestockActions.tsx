import { useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { approveRestock, notReceivedRestock, rejectRestock, type RestockDetail } from '../../api/inventory';
import { FormDialog } from '../FormDialog';
import { control, Field, FormAlert, NO_PROBLEM, problemOf, useFocusFirstError, useSubmit, type Problem } from '../suppliers/supplierUi';
import { useWorkspace } from '../workspace';
import { ReceiveDialog } from './ReceiveDialog';
import { movedOn, type Changed } from './restockMoves';

type Move = 'approve' | 'reject' | 'not-received' | 'receive';

interface Ask {
  title: string;
  question: string;
  yes: string;
  hint: string;
  noteLabel: string;
  optional: boolean;
}
const ASK: Record<Exclude<Move, 'receive'>, Ask> = {
  approve: { title: 'Approve this restock', question: 'Approve this request? It is then waiting for the goods.', yes: 'Approve', hint: 'Up to 500 characters.', noteLabel: 'Note', optional: true },
  reject: { title: 'Reject this restock', question: 'Reject this request? A rejected request is final.', yes: 'Reject', hint: '5 to 500 characters. The employee who asked will read it.', noteLabel: 'Why is it rejected', optional: false },
  'not-received': {
    title: 'Did not receive on the expected date',
    question: 'Mark this restock as not received? It stays on the list and can still be marked as received later.',
    yes: 'Mark as not received',
    hint: 'Up to 500 characters.',
    noteLabel: 'Note',
    optional: true,
  },
};

/**
 * The Administrator's buttons on a restock: Approve and Reject (requested), Receive and "Did not receive on the expected date" (approved), and
 * "Mark as received" (not received). They are drawn ONLY in the admin workspace: the workspace is `staff` unless /admin's own provider says
 * otherwise, and this returns nothing for any other kind, so /staff never renders them (the page also loads this file only for the admin
 * workspace). The server checks the role on every call regardless. Each move asks first, in a dialog; nothing is sent twice while a request is in flight.
 */
export function AdminRestockActions({ restock, onChanged }: { restock: RestockDetail; onChanged: Changed }) {
  const w = useWorkspace();
  const [move, setMove] = useState<Move | null>(null);
  if (w.kind !== 'admin') return null;
  const s = restock.state;
  const offered: { move: Move; label: string }[] =
    s === 'requested'
      ? [{ move: 'approve', label: 'Approve' }, { move: 'reject', label: 'Reject' }]
      : s === 'approved'
        ? [{ move: 'receive', label: 'Receive' }, { move: 'not-received', label: 'Did not receive on the expected date' }]
        : s === 'not_received'
          ? [{ move: 'receive', label: 'Mark as received' }]
          : [];
  if (offered.length === 0) return null;
  const done = (next: RestockDetail, message: string) => {
    setMove(null);
    onChanged(next, message);
  };
  return (
    <>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Administrator actions" data-testid="restock-admin-actions">
        {offered.map((o) => (
          <button key={o.move} type="button" className={`btn ${o.move === 'reject' || o.move === 'not-received' ? 'btn-secondary' : 'btn-primary'}`} onClick={() => setMove(o.move)} data-testid={`restock-${o.move}`}>
            {o.label}
          </button>
        ))}
      </div>
      {move === 'receive' ? (
        <ReceiveDialog restock={restock} onClose={() => setMove(null)} onDone={done} />
      ) : (
        move && <NoteDialog restock={restock} move={move} onClose={() => setMove(null)} onDone={done} />
      )}
    </>
  );
}

function NoteDialog({ restock, move, onClose, onDone }: { restock: RestockDetail; move: Exclude<Move, 'receive'>; onClose: () => void; onDone: Changed }) {
  const ask = ASK[move];
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<Problem>(NO_PROBLEM);
  const [stamp, setStamp] = useState(0);
  const { busy, run } = useSubmit();
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, stamp);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setProblem(NO_PROBLEM);
      try {
        const text = note.trim();
        const response =
          move === 'approve' ? await approveRestock(restock.id, text ? { note: text } : {}) : move === 'reject' ? await rejectRestock(restock.id, { note: text }) : await notReceivedRestock(restock.id, text ? { note: text } : {});
        onDone(response.data.restock, `${restock.name}: ${move === 'approve' ? 'approved' : move === 'reject' ? 'rejected' : 'marked as not received'}.`);
      } catch (error) {
        const current = movedOn(error);
        if (current) return onDone(current, error instanceof ApiError ? error.message : 'This restock has already moved on.');
        setProblem(problemOf(error, ['note']));
        setStamp((n) => n + 1);
      }
    });
  };

  return (
    <FormDialog title={ask.title} busy={busy} onClose={onClose} testId="restock-move-dialog">
      <form ref={form} onSubmit={submit} noValidate className="space-y-4">
        <p>{ask.question}</p>
        <Field label={ask.noteLabel} optional={ask.optional} hint={ask.hint} error={problem.fields.note}>
          {(p) => <textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={500} className={control} data-testid="restock-move-note" />}
        </Field>
        <FormAlert message={problem.message} />
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} className="btn btn-primary disabled:cursor-wait disabled:opacity-70" data-testid="restock-move-yes">
            {busy ? 'Working…' : ask.yes}
          </button>
          <button type="button" disabled={busy} onClick={onClose} className="btn btn-secondary disabled:opacity-60">
            Cancel
          </button>
        </div>
      </form>
    </FormDialog>
  );
}
