import type { EditorSnapshot } from './types';

/** Shown when an old design is opened with slanted elements in it (they are straightened). */
export const STRAIGHTENED_NOTE = (n: number) =>
  `${n === 1 ? 'One slanted element was' : `${n} slanted elements were`} straightened: slanting is no longer available, because every element is priced by the rectangle around it. Check your design before you order.`;

/**
 * Slanting (skew) is turned off in the Simple editor (step 9). A draft or design saved before that may still hold slanted elements:
 * this returns the snapshot with every slant set to 0 (nothing else changes) and how many elements were straightened, so the screen
 * can say so. The engine straightens on load as well; this is what lets the screen tell the person. A snapshot of another engine,
 * or one whose state is not the Simple editor's, is returned untouched.
 */
export function straightenSnapshot(snapshot: EditorSnapshot): { snapshot: EditorSnapshot; straightened: number } {
  const state = snapshot.state as { objects?: unknown } | null;
  if (snapshot.engine !== 'simple' || !state || !Array.isArray(state.objects)) return { snapshot, straightened: 0 };
  let straightened = 0;
  const objects = state.objects.map((o: unknown) => {
    if (!o || typeof o !== 'object') return o;
    const { skewX, skewY } = o as { skewX?: unknown; skewY?: unknown };
    if ((typeof skewX === 'number' && skewX !== 0) || (typeof skewY === 'number' && skewY !== 0)) {
      straightened++;
      return { ...(o as object), skewX: 0, skewY: 0 };
    }
    return o;
  });
  return straightened ? { snapshot: { ...snapshot, state: { ...(state as object), objects } }, straightened } : { snapshot, straightened: 0 };
}
