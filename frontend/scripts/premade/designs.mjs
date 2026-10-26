// The artwork of the premade designs (step F7). ORIGINAL work drawn for ClothCraft: text and shapes the editor can edit, plus vector
// illustrations (the functions below return SVG text) that become picture layers. Nothing is copied from a brand, a logo or another
// artist's design. scripts/make-premade-designs.mjs draws each design in the REAL editor and saves its snapshot as a template.
//
// Coordinates are design units (the editor's 800 x 800 square); every design sits in a FRAME of 600 units centred at (400, 400), so it can
// be fitted into any garment's print box (src/designs/template.ts). x and y of an item are its CENTRE.

export const FRAME = 600;

// the shop's palette, plus a darker gold that stays readable on a white garment
const INK = '#1a1714';
const CREAM = '#f4efe6';
const GOLD = '#c9a24b';
const GOLD_DEEP = '#a8832f';
const BROWN = '#8b7355';
const SAGE = '#6b8f71';
const SAGE_DEEP = '#3f5e47';
const TERRA = '#b5533c';
const BLUSH = '#d8a7a0';

const text = (name, value, o) => ({ kind: 'text', name, text: value, fontFamily: 'Jost', fontSize: 80, fill: INK, textAlign: 'center', rotation: 0, ...o });
const shape = (name, shapeKind, o) => ({ kind: 'shape', name, shape: shapeKind, rotation: 0, strokeWidth: 0, stroke: INK, opacity: 1, ...o });
const picture = (name, svg, size, o) => ({ kind: 'image', name, svg, size, rotation: 0, ...o });

// ---------------------------------------------------------------------------------------------------------------- illustrations
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

function mountains() {
  return svg(560, 400, `
    <circle cx="400" cy="112" r="54" fill="${GOLD}"/>
    <polygon points="0,340 90,190 170,270 270,130 370,262 450,182 560,330 560,400 0,400" fill="#a9c2ac"/>
    <polygon points="0,372 120,236 210,314 320,204 430,304 520,244 560,272 560,400 0,400" fill="${SAGE}"/>
    <polygon points="0,400 0,356 100,306 200,348 300,296 420,352 560,314 560,400" fill="${SAGE_DEEP}"/>
    <rect x="30" y="228" width="500" height="18" rx="9" fill="#ffffff" opacity="0.6"/>
    <rect x="110" y="270" width="390" height="14" rx="7" fill="#ffffff" opacity="0.5"/>
    <path d="M88 84 q14 -15 28 0 q14 -15 28 0" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
    <path d="M168 128 q9 -10 18 0 q9 -10 18 0" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`);
}

function fern() {
  // one frond: a curved stem and pairs of leaflets that shorten towards the tip
  const parts = [];
  const stem = (y) => 200 + Math.sin((y - 40) / 70) * 14 - (480 - y) * 0.03;
  parts.push(`<path d="M${stem(500)} 505 C 186 400 214 220 ${stem(30)} 28" fill="none" stroke="${SAGE_DEEP}" stroke-width="7" stroke-linecap="round"/>`);
  for (let i = 0; i < 19; i++) {
    const y = 470 - i * 23.5;
    const len = 118 * (1 - i / 22) + 14;
    const x = stem(y);
    for (const side of [-1, 1]) {
      const cx = x + side * (len / 2) * 0.9;
      const cy = y - len * 0.18;
      parts.push(`<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(len / 2).toFixed(1)}" ry="${(7 + (1 - i / 22) * 6).toFixed(1)}" transform="rotate(${side * -32} ${cx.toFixed(1)} ${cy.toFixed(1)})" fill="${i % 2 ? SAGE : SAGE_DEEP}"/>`);
    }
  }
  parts.push(`<ellipse cx="${stem(24).toFixed(1)}" cy="40" rx="7" ry="22" fill="${SAGE_DEEP}"/>`);
  return svg(400, 520, parts.join(''));
}

function leaf() {
  // a heart-shaped leaf with slits cut out by a mask, a lighter half and a mid-rib
  const slits = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const y = 150 + i * 62;
      const x = 250 + side * 46;
      slits.push(`<ellipse cx="${x}" cy="${y}" rx="${64 - i * 6}" ry="9" transform="rotate(${side * 24} ${x} ${y})" fill="#000"/>`);
    }
  }
  return svg(500, 500, `
    <defs><mask id="m"><rect width="500" height="500" fill="#fff"/>${slits.join('')}</mask></defs>
    <g mask="url(#m)">
      <path d="M250 480 C 60 390 20 200 118 92 C 170 38 232 58 250 112 C 268 58 330 38 382 92 C 480 200 440 390 250 480 Z" fill="${SAGE_DEEP}"/>
      <path d="M250 112 C 268 58 330 38 382 92 C 480 200 440 390 250 480 Z" fill="${SAGE}"/>
    </g>
    <path d="M250 480 L 250 118" stroke="${CREAM}" stroke-width="7" stroke-linecap="round" fill="none"/>`);
}

// ---------------------------------------------------------------------------------------------------------------- compositions
const ring = (count, radius, centre, make) => Array.from({ length: count }, (_, i) => make((360 / count) * i, centre.x + radius * Math.sin(((360 / count) * i * Math.PI) / 180), centre.y - radius * Math.cos(((360 / count) * i * Math.PI) / 180), i));

export const DESIGNS = {
  'night-shift': [
    text('NIGHT', 'NIGHT', { fontFamily: 'Bebas Neue', fontSize: 250, fill: CREAM, x: 400, y: 262 }),
    text('SHIFT', 'SHIFT', { fontFamily: 'Bebas Neue', fontSize: 250, fill: GOLD, x: 400, y: 462 }),
    shape('Star left', 'star', { x: 330, y: 606, width: 46, height: 46, fill: GOLD }),
    shape('Star middle', 'star', { x: 400, y: 606, width: 56, height: 56, fill: GOLD }),
    shape('Star right', 'star', { x: 470, y: 606, width: 46, height: 46, fill: GOLD }),
    text('Tagline', 'MANILA AFTER DARK', { fontSize: 36, fill: CREAM, x: 400, y: 672 }),
  ],
  bloom: [
    ...ring(6, 96, { x: 400, y: 372 }, (_, x, y, i) => shape(`Petal ${i + 1}`, 'circle', { x, y, width: 168, height: 168, fill: i % 2 ? TERRA : BLUSH })),
    shape('Centre', 'circle', { x: 400, y: 372, width: 118, height: 118, fill: GOLD, stroke: GOLD_DEEP, strokeWidth: 5 }),
    text('bloom', 'bloom', { fontFamily: 'Pacifico', fontSize: 104, fill: INK, x: 400, y: 600 }),
  ],
  'quiet-hours': [
    text('QUIET', 'QUIET', { fontFamily: 'Bebas Neue', fontSize: 190, fill: CREAM, x: 400, y: 290 }),
    text('HOURS', 'HOURS', { fontFamily: 'Bebas Neue', fontSize: 190, fill: CREAM, x: 400, y: 450 }),
    shape('Rule', 'rectangle', { x: 400, y: 540, width: 320, height: 5, fill: GOLD }),
    text('do not disturb', 'do not disturb', { fontFamily: 'Caveat', fontSize: 84, fill: GOLD, x: 400, y: 616 }),
  ],
  'mountain-mist': [
    picture('Mountains', mountains(), [560, 400], { x: 400, y: 330, width: 560, height: 400 }),
    text('Mountain Mist', 'Mountain Mist', { fontFamily: 'Cormorant Garamond', fontSize: 92, fill: INK, x: 400, y: 575 }),
    text('Cordillera morning', 'Cordillera morning', { fontSize: 34, fill: BROWN, x: 400, y: 648 }),
  ],
  'little-sun': [
    ...ring(8, 148, { x: 400, y: 372 }, (angle, x, y, i) => shape(`Ray ${i + 1}`, 'triangle', { x, y, width: 62, height: 116, fill: GOLD, rotation: angle })),
    shape('Sun', 'circle', { x: 400, y: 372, width: 150, height: 150, fill: GOLD, stroke: CREAM, strokeWidth: 6 }),
    text('Araw', 'Araw', { fontFamily: 'Pacifico', fontSize: 100, fill: CREAM, x: 400, y: 610 }),
  ],
  'slow-mornings': [
    text('SLOW', 'SLOW', { fontFamily: 'Cormorant Garamond', fontSize: 200, fill: INK, x: 400, y: 300 }),
    text('mornings', 'mornings', { fontFamily: 'Caveat', fontSize: 132, fill: GOLD_DEEP, x: 400, y: 442 }),
    shape('Rule', 'rectangle', { x: 400, y: 528, width: 380, height: 5, fill: GOLD_DEEP }),
    text('& good coffee', '& good coffee', { fontSize: 44, fill: BROWN, x: 400, y: 588 }),
  ],
  'kape-muna': [
    shape('Steam left', 'rectangle', { x: 342, y: 236, width: 12, height: 74, fill: BROWN, rotation: -8 }),
    shape('Steam middle', 'rectangle', { x: 392, y: 224, width: 12, height: 94, fill: BROWN }),
    shape('Steam right', 'rectangle', { x: 442, y: 236, width: 12, height: 74, fill: BROWN, rotation: 8 }),
    shape('Handle', 'rectangle', { x: 500, y: 362, width: 56, height: 82, fill: TERRA }),
    shape('Cup', 'rectangle', { x: 392, y: 366, width: 200, height: 160, fill: TERRA }),
    shape('Saucer', 'rectangle', { x: 392, y: 458, width: 270, height: 18, fill: INK }),
    text('Kape muna', 'Kape muna', { fontFamily: 'Pacifico', fontSize: 120, fill: INK, x: 400, y: 566 }),
    text('coffee first', 'coffee first', { fontSize: 42, fill: BROWN, x: 400, y: 648 }),
  ],
  'banig-weave': [
    ...Array.from({ length: 16 }, (_, n) => {
      const col = n % 4;
      const row = Math.floor(n / 4);
      const colours = [TERRA, INK, GOLD, SAGE];
      return shape(`Weave ${row + 1}-${col + 1}`, 'rectangle', { x: 400 + (col - 1.5) * 104, y: 335 + (row - 1.5) * 104, width: 100, height: 100, fill: colours[(row + col) % 4], rotation: 45 });
    }),
    text('Hinabi', 'Hinabi', { fontFamily: 'Pacifico', fontSize: 84, fill: INK, x: 400, y: 648 }),
  ],
  'wild-fern': [
    picture('Fern', fern(), [400, 520], { x: 400, y: 345, width: 340, height: 442 }),
    text('wild & free', 'wild & free', { fontFamily: 'Caveat', fontSize: 120, fill: SAGE_DEEP, x: 400, y: 620 }),
  ],
  'tropical-leaf': [
    picture('Leaf', leaf(), [500, 500], { x: 400, y: 340, width: 430, height: 430 }),
    text('tropical state of mind', 'tropical state of mind', { fontSize: 42, fill: INK, x: 400, y: 620 }),
  ],
  'shapes-in-motion': [
    shape('Circle', 'circle', { x: 350, y: 300, width: 240, height: 240, fill: GOLD }),
    shape('Triangle', 'triangle', { x: 462, y: 400, width: 230, height: 210, fill: TERRA, rotation: 14 }),
    shape('Square', 'rectangle', { x: 372, y: 442, width: 180, height: 180, fill: INK, rotation: -12 }),
    shape('Star', 'star', { x: 498, y: 262, width: 130, height: 130, fill: SAGE }),
    shape('Rule', 'rectangle', { x: 400, y: 600, width: 360, height: 5, fill: INK }),
    text('shapes in motion', 'shapes in motion', { fontSize: 46, fill: INK, x: 400, y: 656 }),
  ],
  'weekend-club': [
    shape('Badge', 'circle', { x: 400, y: 360, width: 360, height: 360, fill: GOLD, stroke: CREAM, strokeWidth: 8 }),
    text('WEEKEND', 'WEEKEND', { fontFamily: 'Bebas Neue', fontSize: 120, fill: INK, x: 400, y: 318 }),
    text('CLUB', 'CLUB', { fontFamily: 'Bebas Neue', fontSize: 120, fill: INK, x: 400, y: 418 }),
    shape('Star', 'star', { x: 400, y: 222, width: 50, height: 50, fill: INK }),
    text('Members only', 'MEMBERS ONLY · NO RULES', { fontSize: 36, fill: CREAM, x: 400, y: 610 }),
  ],
};
