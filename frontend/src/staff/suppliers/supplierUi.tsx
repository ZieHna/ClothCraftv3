import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ApiError } from '../../api/client';
import type { SupplierStatus } from '../../api/suppliers';
import { STATUS_LABEL, statusClass } from './supplierText';

/** The classes every input shares (the same as the order list's filters). */
export const control = 'mt-1 block min-h-11 w-full border border-brown-dark bg-paper px-3 py-2 text-base';

export function StatusBadge({ status }: { status: SupplierStatus }) {
  return (
    <span className={`inline-block rounded-sm border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${statusClass(status)}`} data-testid="supplier-status">
      {STATUS_LABEL[status]}
    </span>
  );
}

/** What a failed request means for a form: the sentences that belong next to a field, and one for the alert. */
export interface Problem {
  fields: Record<string, string>;
  message: string | null;
}
export const NO_PROBLEM: Problem = { fields: {}, message: null };

/** `known` are the fields the form draws; a sentence about any other field goes in the alert, so nothing the server says is lost. */
export function problemOf(error: unknown, known: readonly string[]): Problem {
  if (!(error instanceof ApiError)) return { fields: {}, message: 'Could not reach the shop. Check your connection and try again.' };
  const sent = error.details.fields ?? {};
  const fields: Record<string, string> = {};
  const other: string[] = [];
  for (const [name, sentence] of Object.entries(sent)) {
    if (known.includes(name)) fields[name] = sentence;
    else other.push(sentence);
  }
  const message = other.length > 0 ? other.join(' ') : Object.keys(sent).length === 0 ? error.message : null;
  return { fields, message };
}

/** One request at a time: a second click while one is in flight does nothing (creates are not idempotent). */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { busy, run };
}

/** After a failed submit (`stamp` goes up), focus moves to the first field with an error, else to the alert. */
export function useFocusFirstError(container: RefObject<HTMLElement | null>, stamp: number) {
  useEffect(() => {
    if (stamp === 0) return;
    const root = container.current;
    const target = root?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? root?.querySelector<HTMLElement>('[role="alert"]');
    target?.focus();
  }, [container, stamp]);
}

export function FormAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" tabIndex={-1} className="mt-4 border-2 border-brown-dark bg-cream px-3 py-2 font-medium text-brown-dark" data-testid="form-alert">
      {message}
    </p>
  );
}

interface InputProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
}

/** A label, the control (given the id and the aria links), an optional hint, and the error sentence linked with aria-describedby. */
export function Field({ label, optional = false, hint, error, children }: { label: string; optional?: boolean; hint?: string; error?: string; children: (props: InputProps) => ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
        {optional && <span className="font-normal text-muted"> (optional)</span>}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && (
        <p id={hintId} className="mt-1 text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-sm font-medium text-brown-dark" data-testid="field-error">
          <span className="sr-only">Error: </span>
          {error}
        </p>
      )}
    </div>
  );
}

/** A table cell that, on a narrow screen, becomes a "label, value" line of a card (the label is drawn from data-label). */
export function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <td
      data-label={label}
      className="flex items-start justify-between gap-4 py-1 before:shrink-0 before:text-sm before:font-medium before:text-muted before:content-[attr(data-label)] md:table-cell md:px-3 md:py-3 md:align-top md:before:hidden"
    >
      {children}
    </td>
  );
}

/** The row being changed: marked in words as well as by its look. */
export const EDITING_ROW = 'bg-paper-warm outline outline-2 -outline-offset-2 outline-ink';

/** "Hoodie XS Black": a supply line named for people. */
export const lineName = (l: { garmentType: { name: string }; size: { name: string }; color: { name: string } }): string => `${l.garmentType.name} ${l.size.name} ${l.color.name}`;
