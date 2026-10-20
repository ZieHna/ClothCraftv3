// Sound design for the loop, synthesised offline in code (no samples, no recordings, nothing copied from anywhere).
// Writes .tmp/sfx.wav: 15.000 s, 48 kHz, stereo, 32-bit float. Every sound is placed on the same BEATS as the picture.
// The buffer is circular: tails that run past 15 s wrap to the start, and the quiet bed is periodic, so the loop seam is clean.
import { mkdir, writeFile } from 'node:fs/promises';
import { BEATS, DURATION } from './timeline.js';

const SR = 48000, N = DURATION * SR;
const L = new Float32Array(N), R = new Float32Array(N);

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(2026);
const white = () => rand() * 2 - 1;
const TAU = Math.PI * 2;
const lpCoef = (fc) => 1 - Math.exp((-TAU * fc) / SR);

// mix a mono voice into the circular stereo buffer at time t0 (seconds), constant-power pan -1..1
function put(t0, voice, gain = 1, pan = 0) {
  const a = ((pan + 1) * Math.PI) / 4, gl = Math.cos(a) * gain, gr = Math.sin(a) * gain;
  const start = ((Math.round(t0 * SR) % N) + N) % N;   // a beat just before 0 wraps to the end of the loop
  for (let i = 0; i < voice.length; i++) { const j = (start + i) % N; L[j] += voice[i] * gl; R[j] += voice[i] * gr; }
}
const make = (seconds, fn) => { const n = Math.round(seconds * SR), v = new Float32Array(n); for (let i = 0; i < n; i++) v[i] = fn(i / SR, i / n, i); return v; };

// ---- voices
function rustle(dur, bright = 1) {          // crumpling paper: band-limited noise with a crackly random envelope
  let lp1 = 0, lp2 = 0, mod = 0;
  const hp = lpCoef(1400 * bright), top = lpCoef(7500), slow = lpCoef(55);
  return make(dur, (t, x) => {
    const n = white(); lp1 += hp * (n - lp1); lp2 += top * (n - lp2);
    const band = lp2 - lp1; mod += slow * (white() - mod);
    const crackle = Math.min(1, Math.max(0, 0.25 + 5 * Math.abs(mod) * Math.abs(mod) * 8));
    const env = Math.pow(Math.sin(Math.PI * Math.min(1, x * 1.0)), 0.8) * Math.exp(-x * 1.2);
    return band * env * (0.3 + crackle) * 2.2;
  });
}
function whoosh(dur, f0, f1, q = 1.4) {      // air through paper: a band-pass sweeping from f0 to f1
  let low = 0, band = 0;
  return make(dur, (t, x) => {
    const fc = f0 * Math.pow(f1 / f0, x), f = 2 * Math.sin(Math.PI * fc / SR), damp = 1 / q;
    const n = white(); const high = n - low - damp * band; band += f * high; low += f * band;
    const env = Math.pow(Math.sin(Math.PI * Math.pow(x, 0.75)), 2);
    return band * env * 0.9;
  });
}
function tick(freq = 2800) {                  // a needle tick / stitch: tiny and dry
  return make(0.05, (t) => (Math.sin(TAU * freq * t) * Math.exp(-t / 0.0022) * 0.7 + white() * Math.exp(-t / 0.0011) * 0.4 + Math.sin(TAU * 820 * t) * Math.exp(-t / 0.011) * 0.35));
}
function snip(f = 520) {                      // a short paper "snap"
  let lp = 0; const c = lpCoef(5200);
  return make(0.08, (t) => { lp += c * (white() - lp); return white() * 0.55 * Math.exp(-t / 0.006) * (1 - 0.6 * (lp * lp)) + Math.sin(TAU * (f * 0.5 + f * 0.5 * Math.exp(-t / 0.02)) * t) * Math.exp(-t / 0.03) * 0.5; });
}
function pop(f = 900) { return make(0.09, (t) => Math.sin(TAU * (f * 0.55 + f * 0.45 * Math.exp(-t / 0.018)) * t) * Math.exp(-t / 0.022) * 0.7); }
function slap(low = 190) {                    // paper landing flat
  let lp = 0; const c = lpCoef(2100);
  return make(0.22, (t) => { lp += c * (white() - lp); return lp * Math.exp(-t / 0.022) * 1.6 + Math.sin(TAU * low * t) * Math.exp(-t / 0.035) * 0.55; });
}
function thump(f0 = 110, f1 = 46, decay = 0.17, dur = 0.7) {   // soft low thump
  let lp = 0; const c = lpCoef(260);
  return make(dur, (t) => { lp += c * (white() - lp); const f = f1 + (f0 - f1) * Math.exp(-t / 0.045); return Math.sin(TAU * f * t) * Math.exp(-t / decay) + lp * Math.exp(-t / 0.012) * 1.4; });
}
function ding(f = 880) {                      // soft bell: inharmonic partials with a short attack
  const partials = [[1, 1, 1.5], [2.76, 0.36, 0.8], [5.4, 0.16, 0.4], [8.93, 0.07, 0.22]];
  return make(2.2, (t) => partials.reduce((s, [r, a, d]) => s + a * Math.sin(TAU * f * r * t) * Math.exp(-t / d), 0) * Math.min(1, t / 0.004) * 0.5);
}

// ---- place everything (times come from the shared timeline, so sound and picture line up)
const B = BEATS;
const at = (t) => t;
// scene 1: choose. The hook opens on a downbeat: the tee lands (soft slap + low thump) as the headline rustles up.
// The tee-out whoosh from scene 4 runs into this landing across the seam, so no extra whoosh here.
put(B.land, slap(180), 0.6, 0.15); put(B.land, thump(115, 55, 0.08, 0.35), 0.32, 0.1);
put(B.headline1, rustle(0.55, 1.0), 0.55, -0.25);
B.flip.forEach((t, i) => { put(t, snip(480 + i * 70), 0.62, [-0.4, 0.3, 0.1, -0.2][i]); put(t + 0.02, rustle(0.22, 1.4), 0.3, 0.3); });
B.chips.forEach((t, i) => put(t, pop(760 + i * 140), 0.4, -0.5 + i * 0.35));
put(B.sizeTick, tick(3200), 0.85, 0.35); put(B.sizeTick + 0.1, tick(3600), 0.6, 0.35);
// scene 2: design
put(B.move2, whoosh(0.7, 350, 2600), 0.4, 0);
put(B.textLands, slap(210), 0.55, -0.1); put(B.textLands + 0.01, tick(3000), 0.5, 0);
[0, 1, 2, 3, 4].forEach((i) => put(B.textLands + 0.03 + i * 0.055, tick(2400 + i * 160), 0.35, -0.15 + i * 0.07));
put(B.imageLands, rustle(0.4, 0.9), 0.55, -0.3); put(B.imageLands + 0.18, slap(170), 0.75, -0.3);
put(B.shapeLands, whoosh(0.4, 600, 2200), 0.3, 0.4); put(B.shapeLands + 0.3, slap(240), 0.5, 0.4); put(B.shapeLands + 0.34, tick(3400), 0.55, 0.4);
put(B.handles, tick(3000), 0.7, -0.2); put(B.handles + 0.06, tick(3300), 0.6, 0.2); put(B.handles + 0.12, tick(3600), 0.5, 0.2);
// scene 3: order
put(B.move3, whoosh(0.8, 300, 2400), 0.42, 0.1);
put(B.boxPops, thump(130, 64, 0.1, 0.4), 0.42, 0.05); put(B.boxPops + 0.02, rustle(0.4, 0.8), 0.45, 0.1);
put(B.teeDrops, rustle(0.5, 0.9), 0.5, 0); put(B.teeDrops + 0.55, thump(95, 54, 0.09, 0.4), 0.3, 0);
put(B.flapClose, rustle(0.45, 0.7), 0.55, 0.1); put(B.flapClose + 0.5, slap(150), 0.6, 0.1);
[0, 0.07, 0.14, 0.21].forEach((d, i) => put(B.tape + d, tick(2600 + i * 120), 0.7, 0.05));
put(B.tabA, pop(820), 0.5, -0.45); put(B.tabA + 0.05, rustle(0.25, 1.3), 0.3, -0.45);
put(B.tabB, pop(980), 0.5, 0.45); put(B.tabB + 0.05, rustle(0.25, 1.3), 0.3, 0.45);
put(B.stamp, thump(120, 58, 0.09, 0.45), 0.55, 0); put(B.stamp, slap(130), 0.5, 0);
put(B.stamp + 0.025, ding(880), 0.5, 0.05);
// scene 4: receive
put(B.move4, whoosh(0.9, 280, 2000), 0.38, -0.1);
B.hops.forEach((t, i) => { put(t - 0.04, rustle(0.18, 1.2), 0.25, -0.2 + i * 0.2); put(t + 0.5, thump(150, 70, 0.07, 0.3), 0.32, -0.2 + i * 0.2); });
put(B.thump, thump(100, 40, 0.2, 0.9), 0.95, 0); put(B.thump, slap(110), 0.4, 0);
put(B.check, slap(260), 0.35, 0.3); put(B.check + 0.1, tick(3000), 0.6, 0.3); put(B.check + 0.2, tick(3500), 0.7, 0.3);
put(B.flapOpen, rustle(0.5, 0.8), 0.55, 0.1);
put(B.teeOut, whoosh(0.8, 380, 3000), 0.5, -0.1); put(B.teeOut + 0.05, rustle(0.6, 1.2), 0.45, 0);

// ---- very quiet bed: an open fifth pad. Frequencies are whole multiples of 1/15 Hz, so it is exactly periodic over the loop.
[[110, 0.012], [165, 0.008], [220, 0.007], [330, 0.004]].forEach(([f0, a], k) => {
  const f = Math.round(f0 * DURATION) / DURATION, f2 = f * 1.0006;
  for (let i = 0; i < N; i++) {
    const t = i / SR, trem = 0.6 + 0.4 * Math.cos(TAU * ((k % 3) + 1) * t / DURATION + k);
    const v = (Math.sin(TAU * f * t) + Math.sin(TAU * Math.round(f2 * DURATION) / DURATION * t + 0.7)) * a * trem;
    L[i] += v; R[i] += v * (k % 2 ? 0.8 : 1.1);
  }
});

// ---- a touch of room: a few short reflections (circular, so the seam stays clean)
function room(buf, taps) { const src = buf.slice(); taps.forEach(([ms, g]) => { const d = Math.round((ms / 1000) * SR); for (let i = 0; i < N; i++) buf[(i + d) % N] += src[i] * g; }); }
room(L, [[11, 0.16], [23, 0.1], [37, 0.06], [53, 0.035]]); room(R, [[13, 0.16], [29, 0.1], [41, 0.06], [59, 0.035]]);

// ---- write 32-bit float stereo WAV
let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const data = Buffer.alloc(N * 8);
for (let i = 0; i < N; i++) { data.writeFloatLE(L[i], i * 8); data.writeFloatLE(R[i], i * 8 + 4); }
const head = Buffer.alloc(44);
head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
head.writeUInt32LE(16, 16); head.writeUInt16LE(3, 20); head.writeUInt16LE(2, 22); head.writeUInt32LE(SR, 24);
head.writeUInt32LE(SR * 8, 28); head.writeUInt16LE(8, 32); head.writeUInt16LE(32, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
await mkdir('.tmp', { recursive: true });
await writeFile('.tmp/sfx.wav', Buffer.concat([head, data]));
console.log(`wrote .tmp/sfx.wav  ${DURATION}s  peak ${peak.toFixed(3)}`);
