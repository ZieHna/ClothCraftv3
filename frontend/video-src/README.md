# How-it-works video: source

A 15 s looping motion graphic (four scenes: choose, design, order, receive) built as one standalone page that is a pure
function of time, then rendered frame by frame and encoded with ffmpeg. The app never loads anything from this folder; it
uses the three small files in `../public/video/`.

```
npm install              # exact versions are pinned in package.json
# ffmpeg-static downloads its binary in an install script that npm blocks by default:
node node_modules/ffmpeg-static/install.js

node serve.mjs           # preview: http://127.0.0.1:5179/?play=1   (or ?t=5.9 for one exact frame)
node audio.mjs           # synthesise the sound   -> .tmp/sfx.wav
node encode.mjs audio    # compress + normalise   -> .tmp/final.wav
node render.mjs full     # 450 frames at 30 fps   -> .tmp/lossless.mkv   (about 4 min)
node render.mjs still 5.9
node encode.mjs video    # ../public/video/how-it-works.mp4 + .webm
node encode.mjs poster   # ../public/video/how-it-works-poster.webp
node captions.mjs        # ../public/video/how-it-works.vtt + how-it-works-transcript.txt
```

- `timeline.js` is the one place for timing and words: the picture (`scene.js`), the sound (`audio.mjs`) and the captions
  (`captions.mjs`) all read it. `HOOK` marks the first 2 s: the tee lands on the seam (`BEATS.land`), the headline starts
  on the first frame (`BEATS.headline1 = 0`) and three colour flips follow.
- Small text (under 24 px) is checked at 4.5:1 or better on the rendered frames, so the step tags and the "ORDER PLACED"
  stamp use the text colour; sageDark and brown measured 4.26-4.43:1 there.
- `scene.js` draws frame `t` from scratch (no CSS animation, no clock); `render(0)` is built to match `render(15)` so the loop is seamless.
- `.tmp/` (frames, lossless video, wav files) and `node_modules/` are git-ignored. Only source and the three small outputs are committed.
- Rendering uses the Microsoft Edge that is installed on the machine (`playwright-core`, no browser download).

## Measured on the finished files (ffmpeg ebur128, numbers can differ slightly per tool)

| File | Size | Integrated loudness | Notes |
|---|---|---|---|
| `how-it-works.mp4` | 2.11 MB | -16.4 LUFS | H.264 High, AAC 96 kb/s, 1280x720, 30 fps, 15.00 s; true peak -2.4 dBFS |
| `how-it-works.webm` | 1.92 MB | -15.9 LUFS | VP9 + Opus 64 kb/s, 15.01 s; true peak -1.5 dBFS |
| `how-it-works-poster.webp` | 42 KB | | frame at 5.9 s |
| `how-it-works.vtt` / `-transcript.txt` | 1 KB | | one cue per scene: on-screen words plus sound notes |

Not verified here: how the sound actually *sounds* (no one listened: only measured), and gapless looping in each browser
(AAC/Opus encoder delay can leave a tiny gap at the seam in some players; the audio itself loops cleanly).
