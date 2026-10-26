import { parseMode, type EditorMode } from './types';

/**
 * What /design shows for a given ?mode=, flag state and screen width.
 *  - flag off: always Simple, never the chooser
 *  - flag on, no ?mode=: the chooser
 *  - flag on, ?mode=pro on a phone: the chooser again (Pro cannot be used there)
 *  - anything else: that engine ("simple" for unknown values)
 */
export function resolveEntry(raw: string | null, proEnabled: boolean, phone: boolean): { mode: EditorMode; showChooser: boolean } {
  const parsed = parseMode(raw);
  if (!proEnabled) return { mode: 'simple', showChooser: false };
  return { mode: parsed, showChooser: raw === null || (parsed === 'pro' && phone) };
}
