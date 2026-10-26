import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export type SheetName = 'shapes' | 'layers' | 'colour' | 'settings' | 'more';

// The action row (step 9) is 4.75rem tall, fixed, so the bar above it (ContextBar raised: 3.5 + 4.75 = 8.25rem) and the page's
// bottom padding in EditorStage can be offset by exactly that much. The three numbers move together.
const safeBottom = 'pb-[env(safe-area-inset-bottom)]';

function BarButton({ label, icon, onClick, disabled, pressed, describedBy }: { label: string; icon: IconName; onClick: () => void; disabled?: boolean; pressed?: boolean; describedBy?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-haspopup={pressed === undefined ? undefined : 'dialog'}
      aria-describedby={describedBy}
      onClick={onClick}
      className="flex min-h-14 min-w-11 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-xs font-semibold text-ink disabled:text-muted"
    >
      <Icon name={icon} className="size-6 shrink-0" />
      {label}
    </button>
  );
}

/**
 * The phone's bottom tool bar, fixed to the screen's bottom edge (above the home-indicator area): Text, Picture, Shapes,
 * Layers, Colour and size, More. Text and Picture act at once; the rest open a bottom sheet. `actions` (step 9: Add to cart, Checkout)
 * is a slim row of its own above them, 4.75rem tall, still above the home-indicator area.
 */
export function PhoneToolbar({ disabled, uploadProblemId, onText, onPicture, onSheet, actions, inlineActions }: { disabled: boolean; uploadProblemId?: string; onText: () => void; onPicture: () => void; onSheet: (s: SheetName) => void; actions?: ReactNode; inlineActions?: ReactNode }) {
  return (
    <nav aria-label="Design tools" className={`fixed inset-x-0 bottom-0 z-30 border-t border-brown-dark bg-cream ${safeBottom}`} data-testid="phone-toolbar">
      {actions && <div className="h-[4.75rem] overflow-hidden">{actions}</div>}
      {/* a short screen (a phone on its side) has no height for a row of its own: the actions sit at the end of the tool bar instead */}
      <div className={inlineActions ? 'mx-auto flex max-w-[58rem] items-center gap-2 pr-2' : ''}>
        <div className={`mx-auto grid max-w-xl grid-cols-6 ${inlineActions ? 'flex-1' : ''}`} data-testid="phone-tools">
          <BarButton label="Text" icon="text" disabled={disabled} onClick={onText} />
          <BarButton label="Picture" icon="picture" disabled={disabled} onClick={onPicture} describedBy={uploadProblemId} />
          <BarButton label="Shapes" icon="shapes" disabled={disabled} pressed={false} onClick={() => onSheet('shapes')} />
          <BarButton label="Layers" icon="layers" disabled={disabled} pressed={false} onClick={() => onSheet('layers')} />
          <BarButton label="Colour" icon="colour" disabled={disabled} pressed={false} onClick={() => onSheet('colour')} />
          <BarButton label="More" icon="more" disabled={disabled} pressed={false} onClick={() => onSheet('more')} />
        </div>
        {inlineActions}
      </div>
    </nav>
  );
}

const ctx = 'flex min-h-11 min-w-11 items-center justify-center gap-1.5 border border-brown-dark bg-cream px-3 text-sm font-semibold text-ink';

/**
 * The bar above the tool bar while a layer is selected: its name, Settings (which opens the properties and the numeric
 * fields), rotate left and right (15 degrees a tap), and Delete. All at least 44 px.
 */
export function ContextBar({ name, locked, onSettings, onRotate, onDelete, raised = false }: { name: string; locked: boolean; onSettings: () => void; onRotate: (degrees: number) => void; onDelete: () => void; raised?: boolean }) {
  return (
    <div role="toolbar" aria-label={`Selected: ${name}`} className={`fixed inset-x-0 z-20 border-t border-tan bg-paper-warm px-2 py-1.5 ${raised ? 'bottom-[calc(8.25rem+env(safe-area-inset-bottom))]' : 'bottom-[calc(3.5rem+env(safe-area-inset-bottom))]'}`} data-testid="context-bar">
      <div className="mx-auto flex max-w-xl items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {name}
          {locked && <span className="font-normal text-muted"> (locked)</span>}
        </p>
        <button type="button" onClick={onSettings} className={ctx}>
          <Icon name="settings" />
          Settings
        </button>
        <button type="button" aria-label="Rotate left 15 degrees" onClick={() => onRotate(-15)} className={ctx}>
          <Icon name="rotateLeft" />
        </button>
        <button type="button" aria-label="Rotate right 15 degrees" onClick={() => onRotate(15)} className={ctx}>
          <Icon name="rotateRight" />
        </button>
        <button type="button" aria-label={`Delete ${name}`} onClick={onDelete} className={ctx}>
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}
