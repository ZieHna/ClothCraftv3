// Mix, encode, poster.
//   node encode.mjs audio     -> .tmp/final.wav        (compress + normalise to about -16 LUFS, loop-safe)
//   node encode.mjs video     -> ../public/video/how-it-works.mp4 / .webm   (needs .tmp/lossless.mkv and .tmp/final.wav)
//   node encode.mjs poster    -> ../public/video/how-it-works-poster.webp   (needs .tmp/still-5.9.png)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';
import { DURATION } from './timeline.js';

const OUT = '../public/video';
const run = (args) => spawnSync(ffmpeg, ['-hide_banner', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
const must = (r, what) => { if (r.status !== 0) { console.error(r.stderr); throw new Error(what + ' failed'); } return r; };
const mode = process.argv[2];
await mkdir('.tmp', { recursive: true }); await mkdir(OUT, { recursive: true });

if (mode === 'audio') {
  // process three copies back to back and keep the middle one, so the compressor/limiter see the loop as continuous
  const chain = 'acompressor=threshold=0.07:ratio=3.5:attack=4:release=140:makeup=1.5,alimiter=limit=0.84:attack=2:release=40:level=disabled';
  must(run(['-stream_loop', '2', '-i', '.tmp/sfx.wav', '-af', `${chain},atrim=start=${DURATION}:end=${2 * DURATION},asetpts=PTS-STARTPTS`, '-ar', '48000', '-c:a', 'pcm_f32le', '.tmp/comp.wav']), 'compress');
  const measure = must(run(['-i', '.tmp/comp.wav', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']), 'measure');
  const json = JSON.parse(measure.stderr.slice(measure.stderr.lastIndexOf('{'), measure.stderr.lastIndexOf('}') + 1));
  console.log('measured before gain:', json.input_i, 'LUFS, true peak', json.input_tp, 'dBTP, LRA', json.input_lra);
  // pure gain, then a true-peak guard (limiter at -3 dBFS leaves room for inter-sample peaks); iterate the gain until the
  // loudness *after* the limiter is -16 LUFS
  const TARGET = -15.6;   // aims the *files* at about -16 LUFS: AAC and Opus encoding costs roughly 0.4-0.8 LU
  let gain = TARGET - parseFloat(json.input_i), summary = '';
  for (let i = 0; i < 4; i++) {
    must(run(['-i', '.tmp/comp.wav', '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.708:attack=1:release=25:level=disabled`, '-c:a', 'pcm_s16le', '.tmp/final.wav']), 'apply gain');
    const check = must(run(['-i', '.tmp/final.wav', '-af', 'ebur128=peak=true', '-f', 'null', '-']), 'verify');
    summary = check.stderr.slice(check.stderr.lastIndexOf('Summary:'));
    const integrated = parseFloat(/I:\s+(-?[\d.]+) LUFS/.exec(summary)[1]);
    if (Math.abs(integrated - TARGET) < 0.15) break;
    gain += TARGET - integrated;
  }
  console.log('gain', gain.toFixed(2), 'dB |', summary.split('\n').filter((l) => /I:|LRA:|Peak:/.test(l)).map((l) => l.trim()).join(' | '));
} else if (mode === 'video') {
  const mp4 = `${OUT}/how-it-works.mp4`, webm = `${OUT}/how-it-works.webm`;
  must(run(['-i', '.tmp/lossless.mkv', '-i', '.tmp/final.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
    '-crf', process.env.MP4_CRF ?? '27', '-maxrate', '1300k', '-bufsize', '2600k', '-g', '60', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-t', String(DURATION), mp4]), 'mp4');
  const pass = (n) => ['-i', '.tmp/lossless.mkv', ...(n === 2 ? ['-i', '.tmp/final.wav'] : []), '-c:v', 'libvpx-vp9', '-b:v', process.env.WEBM_KBPS ?? '1000k', '-maxrate', '1500k', '-minrate', '300k', '-pix_fmt', 'yuv420p', '-g', '60',
    '-row-mt', '1', '-deadline', 'good', '-cpu-used', '1', '-pass', String(n), '-passlogfile', '.tmp/vp9', '-t', String(DURATION)];
  must(run([...pass(1), '-an', '-f', 'null', '-']), 'webm pass 1');
  must(run([...pass(2), '-map', '0:v', '-map', '1:a', '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', webm]), 'webm pass 2');
  for (const f of [mp4, webm]) console.log(f, ((await stat(f)).size / 1048576).toFixed(2), 'MB');
} else if (mode === 'poster') {
  const out = `${OUT}/how-it-works-poster.webp`;
  await sharp('.tmp/still-5.9.png').resize(1280, 720).webp({ quality: 82, effort: 6 }).toFile(out);
  console.log(out, ((await stat(out)).size / 1024).toFixed(0), 'KB');
} else console.log('usage: node encode.mjs audio|video|poster');
