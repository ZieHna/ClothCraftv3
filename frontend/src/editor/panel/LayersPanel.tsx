import { useId, useState } from 'react';
import type { DesignLayer } from '../types';

interface Props {
  /** the layers, TOP layer first. The garment is never in this list. */
  layers: DesignLayer[];
  selectedId: string | null;
  /** a sentence about the last thing that was refused (a locked layer, for example); shown as text */
  notice: string;
  onSelect: (id: string) => void;
  onMove: (id: string, direction: 'up' | 'down') => void;
  onToggleVisible: (id: string) => void;
  onToggleLocked: (id: string) => void;
  onDelete: (id: string) => void;
  /** a name being typed (live) and the end of that (commit) */
  onRename: (id: string, name: string) => void;
  onRenameDone: () => void;
  /** inside a bottom sheet: no box and no visible heading of its own (the sheet has both) */
  bare?: boolean;
}

const TYPE_WORD = { text: 'text', shape: 'shape', image: 'picture' } as const;

/**
 * The layers of the design, top first. A real ordered list with labelled buttons; hidden layers are listed and dimmed
 * (and say "Hidden" in words), locked ones say "Locked". A locked or hidden layer can still be selected here, which is
 * how it gets unlocked or shown again. Names are edited in place: Rename, type, Enter.
 */
export function LayersPanel({ layers, selectedId, notice, onSelect, onMove, onToggleVisible, onToggleLocked, onDelete, onRename, onRenameDone, bare }: Props) {
  const titleId = useId();
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <section aria-labelledby={titleId} className={bare ? '' : 'stitched border border-tan bg-cream p-4'} data-testid="layers-panel">
      <h2 id={titleId} className={bare ? 'sr-only' : 'relative text-2xl'}>
        Layers
      </h2>
      <p className="relative mt-1 text-sm text-muted">Top layer first. The garment is not a layer: it stays in place.</p>
      {notice && (
        <p className="relative mt-3 border-l-4 border-brown-dark bg-paper-warm py-2 pl-3 text-sm font-medium text-ink" data-testid="layer-notice">
          <span className="font-semibold">Not changed.</span> {notice}
        </p>
      )}
      {layers.length === 0 ? (
        <p className="relative mt-3 text-sm text-text">Nothing added yet.</p>
      ) : (
        <ol aria-label="Layers, top first" className={`relative mt-3 space-y-2 pr-1 ${bare ? '' : 'max-h-[26rem] overflow-y-auto'}`} data-testid="layers-list">
          {layers.map((l, i) => {
            const selected = l.id === selectedId;
            const stateWords = [l.visible ? '' : 'hidden', l.locked ? 'locked' : ''].filter(Boolean).join(', ');
            return (
              <li
                key={l.id}
                data-layer-id={l.id}
                className={`border bg-paper px-2 py-2 text-sm ${selected ? 'border-ink ring-2 ring-ink' : l.visible ? 'border-tan' : 'border-dashed border-muted'}`}
              >
                <div className="flex items-start gap-2">
                  {renaming === l.id ? (
                    <input
                      autoFocus
                      aria-label={`New name for ${l.name}`}
                      value={l.name}
                      maxLength={40}
                      onChange={(e) => onRename(l.id, e.target.value)}
                      onBlur={() => {
                        setRenaming(null);
                        onRenameDone();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Escape') {
                          e.preventDefault();
                          setRenaming(null);
                          onRenameDone();
                        }
                      }}
                      className="min-w-0 flex-1 border border-brown-dark bg-cream px-2 py-1 text-base text-ink"
                    />
                  ) : (
                    <button
                      type="button"
                      aria-current={selected ? 'true' : undefined}
                      aria-label={`${l.name}, ${TYPE_WORD[l.type]}${stateWords ? `, ${stateWords}` : ''}${selected ? ', selected' : ''}. Select`}
                      onClick={() => onSelect(l.id)}
                      className={`min-h-9 max-sm:min-h-11 pointer-coarse:min-h-11 min-w-0 flex-1 text-left ${l.visible ? 'text-ink' : 'text-muted'}`}
                    >
                      <span className="block truncate font-semibold">{l.name}</span>
                      <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs uppercase tracking-wider text-muted">
                        <span>{TYPE_WORD[l.type]}</span>
                        {!l.visible && <span className="font-semibold text-ink">Hidden</span>}
                        {l.locked && <span className="font-semibold text-ink">Locked</span>}
                      </span>
                    </button>
                  )}
                </div>
                <div className="mt-1 grid grid-cols-3 gap-x-2 sm:flex sm:flex-wrap sm:gap-x-2.5 sm:gap-y-1">
                  <Action label="Up" layer={l.name} disabled={i === 0} onClick={() => onMove(l.id, 'up')} />
                  <Action label="Down" layer={l.name} disabled={i === layers.length - 1} onClick={() => onMove(l.id, 'down')} />
                  <Action label={l.visible ? 'Hide' : 'Show'} layer={l.name} onClick={() => onToggleVisible(l.id)} />
                  <Action label={l.locked ? 'Unlock' : 'Lock'} layer={l.name} onClick={() => onToggleLocked(l.id)} />
                  <Action label="Rename" layer={l.name} onClick={() => (l.locked ? onRename(l.id, l.name) : setRenaming(l.id))} />
                  <Action label="Delete" layer={l.name} onClick={() => onDelete(l.id)} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Action({ label, layer, disabled, onClick }: { label: string; layer: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="min-h-7 px-1 text-sm text-ink underline underline-offset-4 disabled:cursor-not-allowed disabled:text-muted disabled:no-underline max-sm:min-h-11 max-sm:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
    >
      {label}
      <span className="sr-only"> {layer}</span>
    </button>
  );
}
