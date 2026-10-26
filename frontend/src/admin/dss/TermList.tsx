import { TERMS, type TermKey } from './glossary';

/** The meaning of each term, always visible (a hover or a tap is never needed): the term, what it stands for, and one short sentence. */
export function TermList({ terms, label, className = '' }: { terms: TermKey[]; label: string; className?: string }) {
  return (
    <dl className={`space-y-1.5 text-sm ${className}`} aria-label={label} data-testid="term-list">
      {terms.map((key) => {
        const t: { term: string; full?: string; text: string } = TERMS[key];
        return (
          <div key={key} data-term={key}>
            <dt className="inline font-semibold text-ink">
              {t.term}
              {t.full ? <span className="font-normal text-muted"> ({t.full})</span> : null}:{' '}
            </dt>
            <dd className="inline text-text">{t.text}</dd>
          </div>
        );
      })}
    </dl>
  );
}
