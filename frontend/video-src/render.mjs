// Frame renderer. Drives index.html with exact times (window.renderAt(t)), screenshots each frame, and pipes it to ffmpeg.
//   node render.mjs still 0 2.5 5.4        -> .tmp/still-<t>.png (to look at single frames)
//   node render.mjs full                   -> .tmp/lossless.mkv   (450 frames at 30 fps, lossless, never committed)
// Uses the Microsoft Edge that is already installed (playwright-core, no browser download).
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import ffmpegPath from 'ffmpeg-static';
import { serve } from './serve.mjs';
import { DURATION, FPS } from './timeline.js';

const [mode = 'still', ...rest] = process.argv.slice(2);
await mkdir('.tmp', { recursive: true });
const server = await serve();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
await page.goto('http://127.0.0.1:5179/?t=0');
await page.waitForFunction('window.__ready === true');
await page.evaluate(() => document.fonts.ready);

async function shot(t) {
  await page.evaluate((x) => window.renderAt(x), t);
  return page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1280, height: 720 } });
}

if (mode === 'still') {
  for (const t of rest.map(Number)) { await writeFile(`.tmp/still-${t}.png`, await shot(t)); console.log('wrote .tmp/still-' + t + '.png'); }
} else {
  const frames = DURATION * FPS;
  const ff = spawn(ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-c:v', 'ffv1', '-pix_fmt', 'yuv420p', '.tmp/lossless.mkv'], { stdio: ['pipe', 'inherit', 'inherit'] });
  const began = Date.now();
  for (let i = 0; i < frames; i++) {
    const png = await shot(i / FPS);
    if (!ff.stdin.write(png)) await new Promise((ok) => ff.stdin.once('drain', ok));
    if (i % 45 === 0) console.log(`frame ${i}/${frames}  ${((Date.now() - began) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise((ok) => ff.on('close', ok));
  console.log(`done: ${frames} frames in ${((Date.now() - began) / 1000).toFixed(0)}s`);
}
await browser.close();
server.close();
