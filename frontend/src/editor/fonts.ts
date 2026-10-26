/**
 * The five fonts of the Simple editor. Names and weights only: no font file is referenced here, so the list costs
 * nothing. The files are fetched on first use (simple/fontLoader.ts), except the site's own two, which the page already
 * loads at start-up (src/main.tsx).
 *
 * Why these five: each one has a different job on a garment, and none can be mistaken for another.
 *   Jost                the shop's sans: plain, modern, the safe choice for names and numbers (site font)
 *   Cormorant Garamond  the shop's serif: elegant, for wedding, family and "established" prints (site font)
 *   Bebas Neue          tall, bold capitals: slogans, team names, big short words. Capitals only.
 *   Caveat              handwriting: personal notes, kids' names, a signature feel
 *   Pacifico            a soft retro script: playful, gifts, hobby prints
 * Left out on purpose: Playfair Display (too close to Cormorant), Oswald (too close to Bebas Neue). Every one is SIL OFL
 * from @fontsource, latin subset, ONE weight (smallest download); Cormorant is the 700 the site already ships.
 */
export interface FontChoice {
  family: string;
  label: string;
  weight: 400 | 700;
  /** short description for the picker */
  note: string;
}

export const FONT_LIST: readonly FontChoice[] = [
  { family: 'Jost', label: 'Jost', weight: 400, note: 'clean sans' },
  { family: 'Cormorant Garamond', label: 'Cormorant Garamond', weight: 700, note: 'elegant serif' },
  { family: 'Bebas Neue', label: 'Bebas Neue', weight: 400, note: 'bold capitals' },
  { family: 'Caveat', label: 'Caveat', weight: 400, note: 'handwriting' },
  { family: 'Pacifico', label: 'Pacifico', weight: 400, note: 'retro script' },
];

export const DEFAULT_FONT = 'Jost';

export function fontChoice(family: string): FontChoice {
  return FONT_LIST.find((f) => f.family === family) ?? FONT_LIST[0]!;
}
