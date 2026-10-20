// Text alternatives for the video, written from the same timeline as the picture and sound.
//   node captions.mjs   -> ../public/video/how-it-works.vtt (WebVTT, one cue per scene) and how-it-works-transcript.txt
// The words come from COPY; the cue times from SCENES (each cue runs to the next scene's start, so cues never overlap).
// The stamp words and sound notes below are drawn/synthesised in scene.js and audio.mjs; keep them in step by hand.
import { mkdir, writeFile } from 'node:fs/promises';
import { COPY, DURATION, SCENES } from './timeline.js';

const OUT = '../public/video';
const EXTRA = [
  { sound: 'the shirt lands, paper rustles, color swatches pop' },
  { sound: 'paper pieces land on the shirt' },
  { onScreen: 'Stamp: ORDER PLACED.', sound: 'box closes, tape, stamp and a soft bell' },   // the tab labels repeat the support line
  { onScreen: 'Stamp: DELIVERED.', sound: 'box hops and lands at the door' },
];

const stamp = (s) => {
  const ms = Math.round(s * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
const headline = (c) => c.lines.map(([l]) => l).join(' ');

const vtt = ['WEBVTT', '', 'NOTE ClothCraft "How it works", 15 s loop. No speech; these cues carry the on-screen words and the sound.', ''];
const txt = ['ClothCraft: how it works (15-second looping video, no speech)', ''];
SCENES.forEach((sc, i) => {
  const end = i + 1 < SCENES.length ? SCENES[i + 1].start : DURATION, c = COPY[i], x = EXTRA[i];
  const step = c.tag.replace(/\s+/, ' ');
  vtt.push(`scene-${sc.id}`, `${stamp(sc.start)} --> ${stamp(end)}`, `${step}: ${headline(c)}`, c.support + (x.onScreen ? ` ${x.onScreen}` : ''), `[${x.sound}]`, '');
  txt.push(`${step}. ${headline(c)} ${c.support}${x.onScreen ? ' ' + x.onScreen : ''}`);
});

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/how-it-works.vtt`, vtt.join('\n'));
await writeFile(`${OUT}/how-it-works-transcript.txt`, txt.join('\n') + '\n');
console.log(`wrote ${OUT}/how-it-works.vtt and ${OUT}/how-it-works-transcript.txt`);
