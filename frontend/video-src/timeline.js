// One source of truth for timing. The picture (scene.js) and the sound (audio.mjs) both read it, so they cannot drift apart.
export const DURATION = 15;     // seconds, the loop length
export const FPS = 30;
export const HOOK = 2.0;        // seconds: the opening hook. The tee lands, the headline rises and three colour flips all happen inside it.

// scene windows (seconds). Each scene's text enters 0.15 s after its start (scene 1: at BEATS.headline1, the very first
// frame) and leaves over its last 0.5 s.
export const SCENES = [
  { id: 1, start: 0.0, end: 3.9 },
  { id: 2, start: 3.5, end: 7.4 },
  { id: 3, start: 7.0, end: 11.0 },
  { id: 4, start: 10.5, end: 15.0 },
];

// beats that make a sound (seconds). kind -> which synth voice audio.mjs uses.
export const BEATS = {
  // scene 1: choose a garment (land = the tee coming back from scene 4 touches down on the loop seam)
  land: 0.0, headline1: 0.0, flip: [0.7, 1.2, 1.7, 2.2], chips: [2.35, 2.5, 2.65, 2.8], sizeTick: 3.05,
  // scene 2: design it
  move2: 3.35, textLands: 4.5, imageLands: 5.2, shapeLands: 5.9, handles: 6.3,
  // scene 3: order it
  move3: 6.75, boxPops: 7.05, teeDrops: 7.85, flapClose: 8.45, tape: 9.05, tabA: 9.2, tabB: 9.45, stamp: 9.95,
  // scene 4: receive it
  move4: 10.45, hops: [11.0, 11.65, 12.3], thump: 12.95, check: 13.25, flapOpen: 13.6, teeOut: 14.25,
};

// on-screen words, per scene. scene.js draws them and captions.mjs writes the transcript from them, so they stay identical.
export const COPY = [
  { tag: '01  CHOOSE', lines: [['Pick your', false], ['piece.', true]], support: 'Pick a garment, color and size.' },
  { tag: '02  DESIGN', lines: [['Make it', false], ['yours.', true]], support: 'Add text, an image or a shape.' },
  { tag: '03  ORDER', lines: [['Place your', false], ['order.', true]], support: 'Cash on delivery or bank transfer.' },
  { tag: '04  RECEIVE', lines: [['Delivered', false], ['to you.', true]], support: 'It arrives. You check it off.' },
];

export const COLORS = {
  bg: '#FAF8F5', warm: '#F5F0E8', brown: '#8B7355', brownDark: '#6E5A41', sage: '#6B8F71', sageDark: '#557358',
  sageLight: '#A9C2AC', tan: '#D4C4A8', ink: '#1A1714', text: '#2C2825', muted: '#7A7068', cream: '#FFFDF8',
};
