// "How it works": a 15 s paper-cut-out motion graphic. Everything is a pure function of time: renderAt(t) draws the
// frame for second t exactly (no CSS animations, no Date, no randomness at draw time), so a renderer can step frame by
// frame. The loop is seamless: render(0) is built to match render(15).
import { BEATS, COLORS as C, COPY, DURATION as D, SCENES } from './timeline.js';

const W = 1280, H = 720, NS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- math
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
const E = {
  outCubic: (x) => 1 - Math.pow(1 - x, 3),
  inCubic: (x) => x * x * x,
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  outBack: (x, c = 1.70158) => 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2),
  outElastic: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(2, -9 * x) * Math.sin((x * 10 - 0.75) * (TAU / 3)) + 1),
  outQuint: (x) => 1 - Math.pow(1 - x, 5),
};
const mod = (a, n) => ((a % n) + n) % n;
function rngSeeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixHex = (a, b, k) => { const A = hex(a), B = hex(b); return `rgb(${A.map((v, i) => Math.round(lerp(v, B[i], k))).join(',')})`; };

// ---------------------------------------------------------------- svg helpers
const svg = document.getElementById('stage');
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const place = (g, x = 0, y = 0, rot = 0, sx = 1, sy = sx) =>
  g.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rot.toFixed(3)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)})`);
const op = (g, v) => g.setAttribute('opacity', clamp(v).toFixed(3));

// ---------------------------------------------------------------- filters (paper edge, soft shadow, grain)
const defs = el('defs', {}, svg);
function paperFilters(name, { disp = 3.2, freq = '0.035 0.05', dy = 5, sd = 6, shadow = 0.24, region = 14, border = 0 } = {}) {
  for (let i = 0; i < 3; i++) {
    const f = el('filter', { id: `${name}${i}`, x: `-${region}%`, y: `-${region}%`, width: `${100 + 2 * region}%`, height: `${100 + 2 * region}%`, 'color-interpolation-filters': 'sRGB' }, defs);
    let source = 'SourceGraphic';
    if (border) {
      el('feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: border, result: 'grow' }, f);
      el('feFlood', { 'flood-color': C.cream, result: 'fc' }, f);
      el('feComposite', { in: 'fc', in2: 'grow', operator: 'in', result: 'edge' }, f);
      const merge = el('feMerge', { result: 'both' }, f);
      el('feMergeNode', { in: 'edge' }, merge); el('feMergeNode', { in: 'SourceGraphic' }, merge);
      source = 'both';
    }
    el('feTurbulence', { type: 'fractalNoise', baseFrequency: freq, numOctaves: 2, seed: 11 + i * 7, result: 'n' }, f);
    el('feDisplacementMap', { in: source, in2: 'n', scale: disp, xChannelSelector: 'R', yChannelSelector: 'G', result: 'd' }, f);
    el('feDropShadow', { in: 'd', dx: 0, dy, stdDeviation: sd, 'flood-color': '#2b2118', 'flood-opacity': shadow }, f);
  }
}
paperFilters('paper', {});
paperFilters('thin', { disp: 2, dy: 3, sd: 3.5, shadow: 0.22, region: 20 });
paperFilters('hill', { disp: 5, freq: '0.012 0.03', dy: -5, sd: 6, shadow: 0.2, region: 6 });
paperFilters('sticker', { disp: 3.4, dy: 9, sd: 9, shadow: 0.28, region: 12, border: 5 });
const variant = (name, u) => `url(#${name}${Math.floor(u * 8) % 3})`;   // the paper "boils" at 8 fps, like hand-cut stop motion

// multiply tints for the tee photo: shading survives, colour changes
const TEE_TINTS = { sage: C.sage, tan: '#D9C9A8', brown: '#A08462', charcoal: '#4B443C' };
for (const [name, color] of Object.entries(TEE_TINTS)) {
  const f = el('filter', { id: `tint-${name}`, 'color-interpolation-filters': 'sRGB', x: '0', y: '0', width: '100%', height: '100%' }, defs);
  el('feFlood', { 'flood-color': color, result: 'c' }, f);
  el('feBlend', { in: 'SourceGraphic', in2: 'c', mode: 'multiply', result: 'm' }, f);
  el('feComposite', { in: 'm', in2: 'SourceGraphic', operator: 'in' }, f);
}
const grain = el('filter', { id: 'grain', x: 0, y: 0, width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB' }, defs);
el('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.85', numOctaves: 2, seed: 5, result: 'g' }, grain);
el('feColorMatrix', { in: 'g', type: 'matrix', values: '0 0 0 0 0.30  0 0 0 0 0.23  0 0 0 0 0.16  1.1 0 0 0 -0.38' }, grain);
const blur2 = el('filter', { id: 'blur2', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
el('feGaussianBlur', { stdDeviation: 2.4 }, blur2);
const vig = el('radialGradient', { id: 'vig', cx: '50%', cy: '48%', r: '75%' }, defs);
el('stop', { offset: '60%', 'stop-color': '#3b2f20', 'stop-opacity': 0 }, vig);
el('stop', { offset: '100%', 'stop-color': '#3b2f20', 'stop-opacity': 0.16 }, vig);
const wipeClip = el('clipPath', { id: 'teeWipe' }, defs);
const wipePoly = el('polygon', { points: '0,0' }, wipeClip);

// ---------------------------------------------------------------- scene graph
const bgRect = el('rect', { x: -40, y: -40, width: W + 80, height: H + 80, fill: C.warm }, svg);
const cam = el('g', { id: 'cam' }, svg);
const layer = (id) => el('g', { id }, cam);
const gNumerals = layer('numerals'), gSun = layer('sun'), gHills = layer('hills'), gThread = layer('thread'), gWorld = layer('world');
const gBoxBack = layer('boxBack'), gTee = layer('tee'), gBoxFront = layer('boxFront'), gUI = layer('ui'), gText = layer('text'), gScraps = layer('scraps');
const grainRect = el('rect', { x: 0, y: 0, width: W, height: H, filter: 'url(#grain)', opacity: 0.16, style: 'mix-blend-mode:multiply' }, svg);
el('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#vig)', 'pointer-events': 'none' }, svg);

// ---- a big paper sun/disc behind the focal object; it changes colour and size from scene to scene
const sun = el('circle', { r: 100, fill: C.tan }, gSun);
const SUN_KEYS = [[0, 930, 395, 235, '#E9DEC6'], [3.3, 930, 395, 235, '#E9DEC6'], [4.2, 905, 385, 268, '#C6D8C8'], [6.8, 905, 385, 268, '#C6D8C8'],
  [7.6, 850, 350, 218, '#EAD7B0'], [10.2, 850, 350, 218, '#EAD7B0'], [11.1, 800, 330, 205, '#F6F0DF'], [14.0, 800, 330, 205, '#F6F0DF'], [14.9, 930, 395, 235, '#E9DEC6'], [15, 930, 395, 235, '#E9DEC6']];
function sunAt(u) {
  for (let i = 0; i < SUN_KEYS.length - 1; i++) {
    const a = SUN_KEYS[i], b = SUN_KEYS[i + 1];
    if (u >= a[0] && u <= b[0]) { const k = E.inOut(seg(u, a[0], b[0])); return { x: lerp(a[1], b[1], k), y: lerp(a[2], b[2], k), r: lerp(a[3], b[3], k), fill: mixHex(a[4], b[4], k) }; }
  }
  return { x: 930, y: 395, r: 235, fill: '#E9DEC6' };
}

// ---- torn-paper hills (parallax bands)
const hillRng = rngSeeded(41);
function hillPath(base, amp, f1, f2, ph) {
  const pts = [];
  for (let x = -160; x <= W + 160; x += 28) {
    pts.push([x, base + amp * Math.sin(x * f1 + ph) + amp * 0.45 * Math.sin(x * f2 + ph * 1.7) + (hillRng() - 0.5) * 4]);
  }
  return 'M' + pts.map((p) => p.join(' ')).join(' L') + ` L${W + 160} ${H + 60} L-160 ${H + 60} Z`;
}
const hills = [
  { g: el('g', {}, gHills), d: hillPath(548, 22, 0.006, 0.014, 0.4), fill: '#BBD0BC', par: 0.25 },
  { g: el('g', {}, gHills), d: hillPath(602, 18, 0.008, 0.02, 2.1), fill: '#D6C8AC', par: 0.55 },
  { g: el('g', {}, gHills), d: hillPath(656, 14, 0.011, 0.03, 4.0), fill: '#9C8465', par: 1.0 },
];
for (const h of hills) { el('path', { d: h.d, fill: h.fill }, h.g); }

// ---- big faded step numerals
const numerals = ['01', '02', '03', '04'].map((n, i) => {
  const g = el('g', {}, gNumerals);
  el('text', { x: 40, y: 560, 'font-family': 'Cormorant Garamond', 'font-weight': 700, 'font-size': 420, fill: C.brown, 'fill-opacity': 0.1 }, g).textContent = n;
  return g;
});

// ---- stitched thread that runs through the whole piece
const threadPts = [[40, 660], [250, 600], [520, 640], [760, 560], [960, 640], [1130, 540], [1250, 600]];
function smoothPath(p) {
  let d = `M${p[0][0]} ${p[0][1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(p.length - 1, i + 2)];
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]} ${p2[1]}`;
  }
  return d;
}
const threadD = smoothPath(threadPts);
const threadMask = el('mask', { id: 'threadMask', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, defs);
const threadReveal = el('path', { d: threadD, fill: 'none', stroke: '#fff', 'stroke-width': 14, 'stroke-linecap': 'round' }, threadMask);
const threadLen = threadReveal.getTotalLength();
threadReveal.setAttribute('stroke-dasharray', `${threadLen} ${threadLen}`);
const gThreadDraw = el('g', { mask: 'url(#threadMask)' }, gThread);
el('path', { d: threadD, fill: 'none', stroke: C.brown, 'stroke-width': 3.2, 'stroke-dasharray': '1 8', 'stroke-linecap': 'round', opacity: 0.85 }, gThreadDraw);
const needle = el('g', {}, gThread);
el('path', { d: 'M-16 0 L10 -3 L10 3 Z', fill: C.brownDark }, needle);
el('ellipse', { cx: 6, cy: 0, rx: 1.6, ry: 1, fill: C.cream }, needle);
const threadProbe = el('path', { d: threadD, fill: 'none' }, gThread);

// ---------------------------------------------------------------- text (kinetic headline, support strip)
await Promise.all(['700 112px "Cormorant Garamond"', 'italic 700 112px "Cormorant Garamond"', '500 28px Jost', '600 18px Jost', '600 22px Jost', 'italic 600 40px "Cormorant Garamond"'].map((f) => document.fonts.load(f, 'Aa')));
const ctx = document.createElement('canvas').getContext('2d');
const advance = (font, s) => { ctx.font = font; return ctx.measureText(s).width; };

const HEAD_SIZE = 112, HEAD_X = 84, HEAD_Y = 292, HEAD_LH = 108;
const sceneText = COPY.map((copy, si) => {
  const g = el('g', {}, gText);
  const shell = el('g', {}, g);                    // gets the paper filter
  const letters = [];
  let index = 0;
  copy.lines.forEach(([line, italic], li) => {
    const font = `${italic ? 'italic ' : ''}700 ${HEAD_SIZE}px "Cormorant Garamond"`;
    let x = HEAD_X;
    for (const ch of line) {
      const w = advance(font, ch);
      if (ch !== ' ') {
        const node = el('g', {}, shell);
        el('text', { x: 0, y: 0, 'font-family': 'Cormorant Garamond', 'font-weight': 700, 'font-style': italic ? 'italic' : 'normal', 'font-size': HEAD_SIZE,
          fill: italic ? C.brown : C.ink, stroke: C.cream, 'stroke-width': 11, 'stroke-linejoin': 'round', 'paint-order': 'stroke' }, node).textContent = ch;
        letters.push({ node, x, y: HEAD_Y + li * HEAD_LH, i: index++ });
      }
      x += w;
    }
  });
  // support strip: cream paper tag with a taped corner
  const strip = el('g', {}, g);
  const supportW = advance('500 28px Jost', copy.support) + 56;
  const tag = el('g', {}, strip);
  el('path', { d: `M0 0 L${supportW} 3 L${supportW - 4} 52 L3 50 Z`, fill: C.cream }, tag);
  el('path', { d: `M7 8 L${supportW - 8} 10 L${supportW - 11} 44 L9 42 Z`, fill: 'none', stroke: C.brown, 'stroke-width': 1.6, 'stroke-dasharray': '2 6', 'stroke-linecap': 'round', opacity: 0.7 }, tag);
  el('text', { x: 28, y: 35, 'font-family': 'Jost', 'font-weight': 500, 'font-size': 28, fill: C.text }, tag).textContent = copy.support;
  el('rect', { x: supportW - 34, y: -9, width: 54, height: 20, fill: C.tan, opacity: 0.9, transform: `rotate(24 ${supportW - 7} 1)` }, strip);
  // step tag (18 px is small text: sageDark measured 4.26-4.43:1 on the scene 2-4 backgrounds, so it uses the text colour)
  const tagText = el('g', {}, g);
  el('text', { x: HEAD_X + 4, y: 168, 'font-family': 'Jost', 'font-weight': 600, 'font-size': 18, 'letter-spacing': 5, fill: C.text }, tagText).textContent = copy.tag;
  el('path', { d: `M${HEAD_X + 4} 182 L${HEAD_X + 190} 182`, stroke: C.sageDark, 'stroke-width': 2.2, 'stroke-dasharray': '1 7', 'stroke-linecap': 'round', fill: 'none' }, tagText);
  return { g, shell, letters, strip, tagText, supportW };
});

// ---------------------------------------------------------------- the recurring tee (assets-v1 Women/T-shirt, trimmed copy)
const TEE_W = 286, TEE_H = 271;
const teeRoot = el('g', {}, gTee);
const teeSticker = el('g', {}, teeRoot);
const teeBase = el('g', { filter: 'url(#tint-sage)' }, teeSticker);
const teeTop = el('g', { 'clip-path': 'url(#teeWipe)' }, teeSticker);
const imgAttrs = { href: './assets/tee.png', x: -TEE_W / 2, y: -TEE_H / 2, width: TEE_W, height: TEE_H };
el('image', imgAttrs, teeBase);
const teeTopInner = el('g', { filter: 'url(#tint-tan)' }, teeTop);
el('image', imgAttrs, teeTopInner);

// design elements that land on the tee in scene 2 (tee-local coordinates)
const design = el('g', {}, teeRoot);
const designText = el('g', {}, design);
const designLetters = [...'hello'].map((ch, i) => {
  const g = el('g', {}, designText);
  el('text', { x: 0, y: 0, 'font-family': 'Cormorant Garamond', 'font-weight': 600, 'font-style': 'italic', 'font-size': 46, fill: C.cream }, g).textContent = ch;
  return { g, x: -52 + [...'hello'].slice(0, i).reduce((a, c) => a + advance('italic 600 46px "Cormorant Garamond"', c), 0) };
});
const designImage = el('g', {}, design);
{
  const g = el('g', {}, designImage);
  el('rect', { x: -38, y: -42, width: 76, height: 88, fill: C.cream }, g);
  el('rect', { x: -31, y: -35, width: 62, height: 58, fill: '#E8DDC4' }, g);
  el('circle', { cx: 8, cy: -14, r: 9, fill: '#D9A441' }, g);
  el('path', { d: 'M-31 23 L-31 2 Q-18 -10 -6 2 Q6 -6 18 6 L31 -2 L31 23 Z', fill: C.sage }, g);
  el('path', { d: 'M-31 23 L-31 12 Q-14 4 0 14 Q14 8 31 14 L31 23 Z', fill: C.sageDark }, g);
  el('rect', { x: -14, y: -50, width: 28, height: 11, fill: C.tan, opacity: 0.92, transform: 'rotate(-6)' }, g);
}
const designStar = el('g', {}, design);
{
  const pts = [];
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 11 : 26; const a = (i / 10) * TAU - Math.PI / 2; pts.push(`${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)}`); }
  el('polygon', { points: pts.join(' '), fill: '#E3B04B', stroke: C.cream, 'stroke-width': 3.2, 'stroke-linejoin': 'round' }, designStar);
}
const handles = el('g', {}, design);
el('rect', { x: -48, y: -52, width: 96, height: 108, fill: 'none', stroke: C.cream, 'stroke-width': 1.8, 'stroke-dasharray': '4 4' }, handles);
for (const [hx, hy] of [[-48, -52], [48, -52], [48, 56], [-48, 56]]) el('rect', { x: hx - 4.5, y: hy - 4.5, width: 9, height: 9, fill: C.cream, stroke: C.sageDark, 'stroke-width': 1.4 }, handles);

// ---------------------------------------------------------------- scene 1 UI: colour chips and size chips
const CHIP_COLORS = [[C.sage, 'sage'], ['#D9C9A8', 'tan'], ['#A08462', 'brown'], ['#4B443C', 'charcoal']];
const chips = CHIP_COLORS.map(([color], i) => {
  const g = el('g', {}, gUI);
  const inner = el('g', {}, g);
  el('circle', { r: 33, fill: C.cream }, inner);
  el('circle', { r: 25, fill: color }, inner);
  return { g, inner, x: 1178, y: 268 + i * 82 };
});
const chipRing = el('g', {}, gUI);
el('circle', { r: 41, fill: 'none', stroke: C.ink, 'stroke-width': 2.4, 'stroke-dasharray': '3 6', 'stroke-linecap': 'round' }, chipRing);
const SIZES = ['S', 'M', 'L', 'XL'];
const sizeChips = SIZES.map((label, i) => {
  const g = el('g', {}, gUI);
  const inner = el('g', {}, g);
  const bg = el('rect', { x: -31, y: -27, width: 62, height: 54, rx: 6, fill: C.cream }, inner);
  const t = el('text', { x: 0, y: 8, 'text-anchor': 'middle', 'font-family': 'Jost', 'font-weight': 600, 'font-size': 24, fill: C.text }, inner);
  t.textContent = label;
  return { g, inner, bg, t, x: 806 + i * 82, y: 176 };
});
const sizeRing = el('g', {}, gUI);
const sizeRingPath = el('rect', { x: -38, y: -33, width: 76, height: 66, rx: 9, fill: 'none', stroke: C.sageDark, 'stroke-width': 2.6, 'stroke-dasharray': '3 6', 'stroke-linecap': 'round' }, sizeRing);
const sizeRingLen = 2 * (76 + 66);
sizeRingPath.setAttribute('stroke-dasharray', `${sizeRingLen} ${sizeRingLen}`);

// ---------------------------------------------------------------- the box (scene 3 and 4)
const BS = 0.8;
const boxBack = el('g', {}, gBoxBack);
el('path', { d: 'M-130 -190 L130 -190 L150 -150 L-150 -150 Z', fill: '#B59A74' }, boxBack);
el('path', { d: 'M-130 -190 L130 -190 L134 -182 L-134 -182 Z', fill: '#9B8159' }, boxBack);
const boxFront = el('g', {}, gBoxFront);
const boxShell = el('g', {}, boxFront);
el('rect', { x: -150, y: -150, width: 300, height: 150, fill: '#CDB794' }, boxShell);
el('rect', { x: -150, y: -150, width: 300, height: 14, fill: '#B99F78' }, boxShell);
el('path', { d: 'M-150 -150 L-150 0', stroke: '#A98E66', 'stroke-width': 3, fill: 'none' }, boxShell);
const label = el('g', {}, boxShell);
el('rect', { x: -118, y: -104, width: 108, height: 54, fill: C.cream, transform: 'rotate(-2 -64 -77)' }, label);
el('rect', { x: -112, y: -98, width: 96, height: 42, fill: 'none', stroke: C.brown, 'stroke-width': 1.4, 'stroke-dasharray': '2 5', 'stroke-linecap': 'round', transform: 'rotate(-2 -64 -77)' }, label);
el('text', { x: -64, y: -70, 'text-anchor': 'middle', 'font-family': 'Cormorant Garamond', 'font-weight': 700, 'font-style': 'italic', 'font-size': 25, fill: C.brownDark, transform: 'rotate(-2 -64 -77)' }, label).textContent = 'ClothCraft';
const lid = el('path', { d: 'M0 0', fill: '#DCC8A5' }, boxFront);
const tape = el('g', {}, boxFront);
el('rect', { x: -22, y: -194, width: 44, height: 70, fill: '#E9DCC0', opacity: 0.95 }, tape);
el('path', { d: 'M-16 -190 L-16 -128 M16 -190 L16 -128', stroke: C.brown, 'stroke-width': 1.6, 'stroke-dasharray': '2 5', 'stroke-linecap': 'round', fill: 'none' }, tape);
const tapeClip = el('clipPath', { id: 'tapeClip' }, defs);
const tapeClipRect = el('rect', { x: -26, y: -200, width: 52, height: 0 }, tapeClip);
tape.setAttribute('clip-path', 'url(#tapeClip)');

// ---------------------------------------------------------------- scene 3: payment tabs and the order stamp
function makeTab(label, icon) {
  const g = el('g', {}, gUI), inner = el('g', {}, g);
  el('path', { d: 'M-112 -36 L110 -33 L113 35 L-110 38 Z', fill: C.cream }, inner);
  el('path', { d: 'M-103 -27 L101 -25 L104 27 L-101 29 Z', fill: 'none', stroke: icon === 'cash' ? C.sageDark : C.brown, 'stroke-width': 1.8, 'stroke-dasharray': '2 6', 'stroke-linecap': 'round' }, inner);
  const ic = el('g', { transform: 'translate(-78 0)' }, inner);
  if (icon === 'cash') {
    el('rect', { x: -17, y: -11, width: 34, height: 22, rx: 3, fill: C.sage }, ic);
    el('circle', { r: 6, fill: C.cream }, ic);
  } else {
    el('path', { d: 'M-17 -4 L0 -15 L17 -4 Z', fill: C.brown }, ic);
    for (const x of [-11, 0, 11]) el('rect', { x: x - 2.6, y: -3, width: 5.2, height: 14, fill: C.brown }, ic);
    el('rect', { x: -17, y: 11, width: 34, height: 3.5, fill: C.brownDark }, ic);
  }
  el('text', { x: -46, y: 7, 'font-family': 'Jost', 'font-weight': 600, 'font-size': 20, fill: C.text }, inner).textContent = label;
  el('rect', { x: 80, y: -46, width: 40, height: 16, fill: C.tan, opacity: 0.92, transform: 'rotate(28 100 -38)' }, inner);
  return { g, inner };
}
const tabA = makeTab('Cash on delivery', 'cash'), tabB = makeTab('Bank transfer', 'bank');
const orWord = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'font-family': 'Cormorant Garamond', 'font-weight': 700, 'font-style': 'italic', 'font-size': 34, fill: C.brown }, gUI);
orWord.textContent = 'or';
function makeStamp(color, lines) {
  const g = el('g', {}, gUI), inner = el('g', {}, g);
  el('circle', { r: 66, fill: C.cream }, inner);
  el('circle', { r: 58, fill: 'none', stroke: color, 'stroke-width': 3 }, inner);
  el('circle', { r: 51, fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-dasharray': '2 5', 'stroke-linecap': 'round' }, inner);
  return { g, inner };
}
const stampOrder = makeStamp(C.brown);
// 21 px is small text: brown on cream measured 4.41:1, so the words use the text colour (the rings stay brown)
el('text', { x: 0, y: -4, 'text-anchor': 'middle', 'font-family': 'Jost', 'font-weight': 600, 'font-size': 21, 'letter-spacing': 3, fill: C.text }, stampOrder.inner).textContent = 'ORDER';
el('text', { x: 0, y: 22, 'text-anchor': 'middle', 'font-family': 'Jost', 'font-weight': 600, 'font-size': 21, 'letter-spacing': 3, fill: C.text }, stampOrder.inner).textContent = 'PLACED';

// ---------------------------------------------------------------- scene 4: the house, the delivered stamp
const house = el('g', {}, gWorld), houseInner = el('g', {}, house);
el('rect', { x: -110, y: -150, width: 220, height: 150, fill: '#EADFC6' }, houseInner);
el('path', { d: 'M-132 -148 L0 -236 L132 -148 Z', fill: C.brown }, houseInner);
el('path', { d: 'M-132 -148 L132 -148 L128 -136 L-128 -136 Z', fill: C.brownDark, opacity: 0.55 }, houseInner);
el('rect', { x: 62, y: -222, width: 26, height: 56, fill: C.brownDark }, houseInner);
el('rect', { x: -30, y: -96, width: 62, height: 96, rx: 3, fill: C.sage }, houseInner);
el('circle', { cx: 20, cy: -48, r: 4, fill: C.cream }, houseInner);
el('path', { d: 'M-24 -90 L26 -90 L26 -6 L-24 -6 Z', fill: 'none', stroke: C.cream, 'stroke-width': 1.5, 'stroke-dasharray': '2 5', 'stroke-linecap': 'round' }, houseInner);
el('rect', { x: -96, y: -110, width: 46, height: 46, fill: '#F7F1E1' }, houseInner);
el('path', { d: 'M-73 -110 L-73 -64 M-96 -87 L-50 -87', stroke: C.brown, 'stroke-width': 3 }, houseInner);
const stampOk = makeStamp(C.sageDark);
const checkPath = el('path', { d: 'M-27 -4 L-9 15 L29 -26', fill: 'none', stroke: C.sageDark, 'stroke-width': 9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, stampOk.inner);
const checkLen = checkPath.getTotalLength();
checkPath.setAttribute('stroke-dasharray', `${checkLen} ${checkLen}`);
el('text', { x: 0, y: 40, 'text-anchor': 'middle', 'font-family': 'Jost', 'font-weight': 600, 'font-size': 13, 'letter-spacing': 2.5, fill: C.sageDark }, stampOk.inner).textContent = 'DELIVERED';
// grass tufts that stream past while the box travels (a repeating pattern, so it loops)
const tufts = el('g', {}, gWorld);
const TUFT_GAP = 160, TUFT_COUNT = 11;
const tuftNodes = Array.from({ length: TUFT_COUNT }, (_, i) => {
  const g = el('g', {}, tufts);
  el('path', { d: 'M0 0 Q-6 -34 -16 -46 Q-2 -34 0 -50 Q4 -32 14 -44 Q8 -22 6 0 Z', fill: i % 2 ? C.sageDark : C.sage }, g);
  return g;
});

// ---------------------------------------------------------------- foreground scraps (fast parallax, soft focus)
const scrapRng = rngSeeded(7);
const scraps = Array.from({ length: 9 }, (_, i) => {
  const r = 8 + scrapRng() * 16, n = 5 + Math.floor(scrapRng() * 2);
  const pts = Array.from({ length: n }, (_, k) => { const a = (k / n) * TAU, rr = r * (0.6 + scrapRng() * 0.6); return `${(Math.cos(a) * rr).toFixed(1)},${(Math.sin(a) * rr).toFixed(1)}`; });
  const g = el('g', { filter: i % 3 === 0 ? 'url(#blur2)' : 'none' }, gScraps);
  el('polygon', { points: pts.join(' '), fill: [C.tan, C.sage, '#C9B48F', C.brown][i % 4], opacity: 0.85 }, g);
  return { g, x: 60 + scrapRng() * 1160, y: 80 + scrapRng() * 560, amp: 10 + scrapRng() * 24, k: 1 + (i % 3), ph: scrapRng() * TAU, spin: (i % 2 ? 1 : -1) * (1 + (i % 3)) };
});

// ---------------------------------------------------------------- per-frame state
const loc = (u, start) => mod(u - start, D);
const env = (s, len, fi = 0.3, fo = 0.45) => E.outCubic(seg(s, 0, fi)) * (1 - E.inCubic(seg(s, len - fo, len)));
const BG_KEYS = [[0, C.warm], [3.3, C.warm], [4.0, '#EFE6D5'], [6.8, '#EFE6D5'], [7.5, '#F4EADA'], [10.2, '#F4EADA'], [10.9, '#E6ECDD'], [14.1, '#E6ECDD'], [14.9, C.warm], [15, C.warm]];
function backgroundAt(u) {
  for (let i = 0; i < BG_KEYS.length - 1; i++) {
    const [a, ca] = BG_KEYS[i], [b, cb] = BG_KEYS[i + 1];
    if (u >= a && u <= b) return mixHex(ca, cb, E.inOut(seg(u, a, b)));
  }
  return C.warm;
}

const A = { x: 930, y: 392, s: 1.18, r: 0 };         // tee at rest, scene 1 (and the loop seam)
const B = { x: 905, y: 376, s: 1.52, r: -2.5 };      // scene 2
const BOX_X = 850, BOX_Y = 585;
function boxPose(u) {
  const pop = E.outBack(seg(u, 6.95, 7.55));
  let x = BOX_X, y = lerp(BOX_Y + 300, BOX_Y, pop), sx = 1, sy = 1;
  BEATS.hops.forEach((start, i) => {
    const k = seg(u, start, start + 0.5);
    if (k > 0 && k < 1) { y -= 70 * 4 * k * (1 - k); }
    x += 24 * E.inOut(k);
    if (k >= 1) { const j = seg(u, start + 0.5, start + 0.75); const squash = Math.sin(j * Math.PI) * (1 - j) * 0.16; sy = 1 - squash; sx = 1 + squash * 0.8; }
  });
  const thump = seg(u, BEATS.thump, BEATS.thump + 0.4);
  if (thump > 0 && thump < 1) { const q = Math.sin(thump * Math.PI) * (1 - thump) * 0.2; sy = 1 - q; sx = 1 + q * 0.8; }
  // the box sinks away once the tee is out, and is fully gone before the tee comes down in front of where it stood
  const sink = E.inCubic(seg(u, 14.25, 14.6));
  y += sink * 90;
  const vis = u < 6.9 ? 0 : 1 - sink;
  return { x, y, sx: sx * BS * (1 - sink * 0.5), sy: sy * BS * (1 - sink * 0.5), vis };
}

function teePose(u, box) {
  const wobble = (w) => ({ r: 1.6 * w * Math.sin((TAU * u) / 3), y: 5 * w * Math.sin((TAU * u) / 2.5) });
  let p;
  if (u < 3.3) {
    // hook: the tee lands on the seam (it arrives moving down, see the last branch) and squashes from its hem, then settles
    const w = wobble(1), j = seg(u, BEATS.land, BEATS.land + 0.42), q = 0.11 * Math.sin(j * Math.PI) * (1 - j);
    p = { x: A.x, y: A.y + w.y + (TEE_H / 2) * A.s * q, s: A.s, r: A.r + w.r, fx: 1 + q * 0.8, fy: 1 - q };
  }
  else if (u < 6.75) {
    const k = E.outBack(seg(u, 3.3, 4.2), 1.2); const w = wobble(seg(u, 4.0, 4.6));
    p = { x: lerp(A.x, B.x, k), y: lerp(A.y, B.y, k) + w.y, s: lerp(A.s, B.s, k), r: lerp(A.r, B.r, k) + w.r };
  } else if (u < 7.85) {
    const k = E.inOut(seg(u, 6.75, 7.6));
    p = { x: lerp(B.x, BOX_X, k), y: lerp(B.y, 336, k) - 70 * Math.sin(k * Math.PI), s: lerp(B.s, 0.62, k), r: lerp(B.r, -4, k) };
  } else if (u < 13.9) {
    const drop = E.inCubic(seg(u, BEATS.teeDrops, BEATS.teeDrops + 0.6));
    const hidden = { x: box.x, y: box.y - 60 * (box.sy / BS), s: 0.42 * (box.sx / BS), r: 0 };
    p = { x: lerp(BOX_X, hidden.x, drop), y: lerp(336, hidden.y, drop), s: lerp(0.62, hidden.s, drop), r: lerp(-4, 0, drop) };
    if (drop >= 1) p = hidden;
  } else {
    const hidden = boxPose(13.9); const hy = hidden.y - 60 * (hidden.sy / BS);
    // x, size and turn ease in and out; the height runs on linear time so the tee pops up fast and comes down with
    // momentum, landing exactly on the scene 1 pose at 15.0 (= 0.0)
    const lin = seg(u, 13.9, 15.0), k = E.inOut(lin);
    p = { x: lerp(hidden.x, A.x, k), y: lerp(hy, A.y, lin) - 110 * Math.sin(lin * Math.PI), s: lerp(0.42, A.s, k), r: lerp(0, A.r, k) };
  }
  return p;
}

function frame(t) {
  const u = mod(t, D);
  const cx = 14 * Math.sin((TAU * u) / D), zoom = 1 + 0.014 * Math.sin((TAU * u) / D);
  cam.setAttribute('transform', `translate(${W / 2 - cx * 0.25} ${H / 2}) scale(${zoom.toFixed(4)}) translate(${-W / 2} ${-H / 2})`);
  bgRect.setAttribute('fill', backgroundAt(u));
  const bg = Math.floor(u * 8) % 3;

  // sun
  const sn = sunAt(u);
  sun.setAttribute('r', sn.r.toFixed(1)); sun.setAttribute('fill', sn.fill); place(gSun, sn.x + cx * 0.4 - 0, sn.y + 6 * Math.sin((TAU * u) / 5), 0, 1); sun.setAttribute('filter', `url(#paper${bg})`);
  // hills
  hills.forEach((h, i) => { place(h.g, cx * h.par * 1.6 + 10 * Math.sin((TAU * u) / 7.5 + i), 0); h.g.setAttribute('filter', `url(#hill${bg})`); });

  // numerals
  SCENES.forEach((sc, i) => {
    const s = loc(u, sc.start), len = sc.end - sc.start - 0.2;
    const on = s <= len + 0.001 ? env(s, len, 0.5, 0.5) : 0;
    op(numerals[i], on);
    place(numerals[i], -30 * (1 - E.outCubic(seg(s, 0, 0.8))) + cx * -0.5, 0);
  });

  // thread
  const p = E.inOut(seg(u, 0.5, 14.0));
  threadReveal.setAttribute('stroke-dashoffset', (threadLen * (1 - p)).toFixed(1));
  const head = threadProbe.getPointAtLength(Math.max(0.01, threadLen * p)), ahead = threadProbe.getPointAtLength(Math.min(threadLen, threadLen * p + 4));
  const threadOn = seg(u, 0.5, 1.0) * (1 - seg(u, 14.0, 14.7));
  op(gThread, threadOn);
  place(needle, head.x, head.y, (Math.atan2(ahead.y - head.y, ahead.x - head.x) * 180) / Math.PI);

  // box
  const box = boxPose(u);
  const closeK = E.inOut(seg(u, BEATS.flapClose, BEATS.flapClose + 0.5)), openK = E.inOut(seg(u, BEATS.flapOpen, BEATS.flapOpen + 0.45));
  const lidK = Math.min(closeK, 1 - openK);
  const lidFront = lerp(-286, -150, lidK);
  lid.setAttribute('d', `M-130 -190 L130 -190 L${lerp(120, 150, lidK)} ${lidFront} L${lerp(-120, -150, lidK)} ${lidFront} Z`);
  lid.setAttribute('fill', mixHex('#E4D3B2', '#D2BC98', lidK));
  place(boxBack, box.x, box.y, 0, box.sx, box.sy); place(boxFront, box.x, box.y, 0, box.sx, box.sy);
  op(boxBack, box.vis); op(boxFront, box.vis);
  boxShell.setAttribute('filter', `url(#paper${bg})`); lid.setAttribute('filter', `url(#thin${bg})`);
  const tapeK = E.outCubic(seg(u, BEATS.tape, BEATS.tape + 0.35)) * (1 - openK);
  tapeClipRect.setAttribute('height', (76 * tapeK).toFixed(1)); op(tape, tapeK > 0 ? 1 : 0);

  // tee
  const tp = teePose(u, box);
  place(teeRoot, tp.x, tp.y, tp.r, tp.s * (tp.fx ?? 1), tp.s * (tp.fy ?? 1));
  teeSticker.setAttribute('filter', `url(#sticker${bg})`);
  const flips = BEATS.flip, tints = ['sage', 'tan', 'brown', 'charcoal', 'sage'];
  let idx = 0; flips.forEach((f, i) => { if (u >= f) idx = i + 1; });
  const wipeK = idx === 0 ? 1 : E.inOut(seg(u, flips[idx - 1], flips[idx - 1] + 0.32));
  teeBase.setAttribute('filter', `url(#tint-${tints[Math.max(0, idx - 1)]})`);
  teeTopInner.setAttribute('filter', `url(#tint-${tints[idx]})`);
  const xk = lerp(-250, 260, wipeK);
  wipePoly.setAttribute('points', idx === 0 || wipeK >= 1 ? '-300,-300 300,-300 300,300 -300,300' : `-300,-300 ${xk},-300 ${xk - 70},300 -300,300`);

  // design elements on the tee
  const peel = E.inCubic(seg(u, 14.45, 14.95));
  op(design, 1 - seg(u, 14.7, 14.95));
  const dText = u >= BEATS.textLands;
  designLetters.forEach((l, i) => {
    const k = E.outBack(seg(u, BEATS.textLands + i * 0.055, BEATS.textLands + i * 0.055 + 0.32), 2.2);
    place(l.g, l.x, -26 - (1 - k) * 90 - peel * 40 * (1 + i * 0.2), (1 - k) * (i % 2 ? 12 : -12) + peel * (i % 2 ? 40 : -40), 0.6 + 0.4 * k);
    op(l.g, seg(u, BEATS.textLands + i * 0.055, BEATS.textLands + i * 0.055 + 0.1));
  });
  designText.setAttribute('filter', dText ? `url(#thin${bg})` : 'none');
  const ik = E.outBack(seg(u, BEATS.imageLands, BEATS.imageLands + 0.55), 1.6);
  place(designImage, lerp(-380, -40, ik) - peel * 120, lerp(260, 30, ik) + peel * 90, lerp(-50, -8, ik) - peel * 60, 0.55 + 0.45 * ik);
  op(designImage, seg(u, BEATS.imageLands, BEATS.imageLands + 0.08));
  designImage.setAttribute('filter', `url(#thin${bg})`);
  const sk = E.outElastic(seg(u, BEATS.shapeLands, BEATS.shapeLands + 0.8));
  place(designStar, lerp(340, 50, E.outCubic(seg(u, BEATS.shapeLands, BEATS.shapeLands + 0.45))) + peel * 110, lerp(-220, 36, E.outCubic(seg(u, BEATS.shapeLands, BEATS.shapeLands + 0.45))) - peel * 90, lerp(220, 14, E.outCubic(seg(u, BEATS.shapeLands, BEATS.shapeLands + 0.5))) + peel * 120, 0.5 + 0.5 * sk);
  op(designStar, seg(u, BEATS.shapeLands, BEATS.shapeLands + 0.06));
  designStar.setAttribute('filter', `url(#thin${bg})`);
  const hk = E.outBack(seg(u, BEATS.handles, BEATS.handles + 0.35)) * (1 - seg(u, 6.95, 7.2));
  place(handles, -40, 30, -8, Math.max(0.001, hk)); op(handles, hk > 0 ? 1 : 0);

  // scene 1 UI: colour chips, size chips
  // the chips clear out (colour chips to the right, size chips upward) before the tee grows into their space in scene 2
  const s1 = loc(u, 0), exitK = E.inCubic(seg(u, 3.25, 3.65)), exit1 = 1 - exitK;
  chips.forEach((c, i) => {
    const k = E.outBack(seg(u, 0.25 + i * 0.07, 0.6 + i * 0.07));
    place(c.g, c.x + 90 * exitK, c.y, 0, Math.max(0.001, k) * (0.4 + 0.6 * exit1)); op(c.g, Math.min(1, k * 3) * exit1);
    c.inner.setAttribute('filter', `url(#thin${bg})`);
  });
  let sel = 0, from = 0, at = 0;
  BEATS.flip.forEach((f, i) => { if (u >= f) { from = sel; sel = [1, 2, 3, 0][i]; at = f; } });
  const ringK = E.outBack(seg(u, at, at + 0.28), 2.2);
  const ringY = lerp(chips[from].y, chips[sel].y, ringK) + (at === 0 ? 0 : 0);
  place(chipRing, 1178 + 90 * exitK, at === 0 ? chips[0].y : ringY, (u * 40) % 360, 1); op(chipRing, seg(u, 0.5, 0.7) * exit1);
  sizeChips.forEach((c, i) => {
    const k = E.outBack(seg(u, BEATS.chips[i], BEATS.chips[i] + 0.35));
    place(c.g, c.x, c.y + (1 - k) * 36 - 80 * exitK, (1 - k) * (i % 2 ? 10 : -10), Math.max(0.001, k)); op(c.g, Math.min(1, k * 3) * exit1);
    c.inner.setAttribute('filter', `url(#thin${bg})`);
    const chosen = i === 1 && u >= BEATS.sizeTick;
    c.bg.setAttribute('fill', chosen ? C.sage : C.cream); c.t.setAttribute('fill', chosen ? C.cream : C.text);
  });
  const rk = E.outCubic(seg(u, BEATS.sizeTick, BEATS.sizeTick + 0.4));
  place(sizeRing, sizeChips[1].x, sizeChips[1].y - 80 * exitK, 0, 1); sizeRingPath.setAttribute('stroke-dashoffset', (sizeRingLen * (1 - rk)).toFixed(1)); op(sizeRing, rk > 0 ? exit1 : 0);

  // scene 3: tabs, "or", order stamp
  const exit3 = 1 - E.inCubic(seg(u, 10.2, 10.65));
  [[tabA, BEATS.tabA, 758, 292, -5], [tabB, BEATS.tabB, 1062, 292, 4]].forEach(([tab, at3, x, y, r]) => {
    const k = E.outBack(seg(u, at3, at3 + 0.45), 2);
    place(tab.g, x, y + (1 - k) * 60, r * k, Math.max(0.001, k)); op(tab.g, Math.min(1, k * 3) * exit3);
    tab.inner.setAttribute('filter', `url(#paper${bg})`);
  });
  op(orWord, seg(u, BEATS.tabB, BEATS.tabB + 0.3) * exit3); place(orWord, 910, 300, -4);
  const sl = seg(u, BEATS.stamp - 0.14, BEATS.stamp);
  const stampScale = u < BEATS.stamp - 0.14 ? 0.001 : (u < BEATS.stamp ? lerp(1.7, 1, E.inCubic(sl)) : 1 + 0.06 * Math.sin(seg(u, BEATS.stamp, BEATS.stamp + 0.3) * Math.PI));
  place(stampOrder.g, 912, 176, -9, stampScale); op(stampOrder.g, (u >= BEATS.stamp - 0.14 ? 1 : 0) * exit3);
  stampOrder.inner.setAttribute('filter', `url(#paper${bg})`);

  // scene 4: house slides in, grass streams past, delivered stamp
  const houseIn = E.inOut(seg(u, 10.9, 12.2)), houseOut = E.inCubic(seg(u, 14.25, 14.85));
  place(house, lerp(1560, 1172, houseIn) + houseOut * 400, 618, 0, 1);
  houseInner.setAttribute('filter', `url(#paper${bg})`);
  const grassOn = (seg(u, 10.7, 11.1)) * (1 - seg(u, 13.0, 13.5));
  const speed = (TUFT_GAP * TUFT_COUNT) / D * 2;   // 2 full cycles of the tuft strip per loop, so the pattern repeats
  tuftNodes.forEach((g, i) => place(g, W + 100 - mod(i * TUFT_GAP + u * speed, TUFT_GAP * TUFT_COUNT) + 20, 648 + (i % 3) * 8, 0, 1)); op(tufts, grassOn * 0.9);
  const ck = seg(u, BEATS.check, BEATS.check + 0.2), checkScale = u < BEATS.check ? 0.001 : (ck < 1 ? lerp(1.6, 1, E.inCubic(ck)) : 1 + 0.05 * Math.sin(seg(u, BEATS.check + 0.2, BEATS.check + 0.5) * Math.PI));
  const stampOut = 1 - E.inCubic(seg(u, 14.1, 14.5));
  place(stampOk.g, 1010, 268, 7, checkScale); op(stampOk.g, (u >= BEATS.check ? 1 : 0) * stampOut);
  checkPath.setAttribute('stroke-dashoffset', (checkLen * (1 - E.outCubic(seg(u, BEATS.check + 0.08, BEATS.check + 0.5)))).toFixed(1));
  stampOk.inner.setAttribute('filter', `url(#paper${bg})`);

  // headline + support + step tag for each scene
  SCENES.forEach((sc, si) => {
    const s = loc(u, sc.start), len = sc.end - sc.start - 0.2, text = sceneText[si];
    const active = s <= len + 0.001;
    op(text.g, active ? 1 : 0);
    if (!active) return;
    text.shell.setAttribute('filter', `url(#paper${bg})`);
    text.letters.forEach((l) => {
      const a = (si === 0 ? BEATS.headline1 : 0.15) + l.i * 0.035, k = E.outBack(seg(s, a, a + 0.55), 1.9);
      const d = len - 0.55 + l.i * 0.012, ex = E.inCubic(seg(s, d, d + 0.38));
      place(l.node, l.x, l.y + (1 - k) * 120 - ex * 150, (1 - k) * (l.i % 2 ? 10 : -9) + ex * (l.i % 2 ? -6 : 6), 0.72 + 0.28 * k);
      op(l.node, seg(s, a, a + 0.14) * (1 - ex));
    });
    const sk2 = E.outCubic(seg(s, 0.75, 1.3)), sx = 1 - E.inCubic(seg(s, len - 0.5, len - 0.1));
    place(text.strip, HEAD_X + 2 - (1 - sk2) * 80, HEAD_Y + HEAD_LH + 40, -1.2, 1); op(text.strip, sk2 * sx);
    text.strip.setAttribute('filter', `url(#thin${bg})`);
    // the step tag leads the hook in scene 1; later it waits for the previous headline to fly up past it
    const tagIn = si === 0 ? 0 : 0.4, tk = E.outCubic(seg(s, tagIn, tagIn + 0.45)), tx = 1 - E.inCubic(seg(s, len - 0.55, len - 0.2));
    place(text.tagText, 0, (1 - tk) * -16, 0, 1); op(text.tagText, tk * tx);
  });

  // foreground scraps
  scraps.forEach((sc, i) => {
    const a = (TAU * u * sc.k) / D + sc.ph;
    place(sc.g, sc.x + sc.amp * Math.sin(a) + cx * -2.2, sc.y + sc.amp * 0.7 * Math.cos(a * 1.3), sc.spin * 360 * (u / D) + i * 23, 1);
  });
}

window.renderAt = (t) => { frame(t); };
window.__ready = true;
const params = new URLSearchParams(location.search);
if (params.has('play')) {
  const t0 = performance.now(); const loop = () => { frame(((performance.now() - t0) / 1000) % D); requestAnimationFrame(loop); }; loop();
} else frame(parseFloat(params.get('t') ?? '0'));
