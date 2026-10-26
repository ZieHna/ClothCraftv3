// Loads a font on first use. Each fontsource stylesheet is a dynamic import(), so Vite makes it a small separate CSS
// chunk plus a woff2 file that nothing fetches until this runs. The site's own two fonts are loaded by src/main.tsx
// (they are in the entry), so they have no loader here; document.fonts.load() just confirms them.
import { fontChoice } from '../fonts';

const sheets: Record<string, () => Promise<unknown>> = {
  'Bebas Neue': () => import('@fontsource/bebas-neue/latin-400.css'),
  Caveat: () => import('@fontsource/caveat/latin-400.css'),
  Pacifico: () => import('@fontsource/pacifico/latin-400.css'),
};

const loading = new Map<string, Promise<void>>();
const ready = new Set<string>();

/** True when the font needs no loading (a site font) or has been loaded already: text in it is measured with its real glyphs. */
export const fontReady = (family: string): boolean => !(family in sheets) || ready.has(family);

/** Resolves once the font is usable on a canvas. Safe to call repeatedly; never rejects (a failed font falls back). */
export function loadFont(family: string): Promise<void> {
  let pending = loading.get(family);
  if (!pending) {
    const { weight } = fontChoice(family);
    pending = (async () => {
      try {
        await sheets[family]?.();
        await document.fonts.load(`${weight} 64px "${family}"`);
        ready.add(family);
      } catch {
        /* the font could not load: text keeps the fallback font, which is still readable */
      }
    })();
    loading.set(family, pending);
  }
  return pending;
}
