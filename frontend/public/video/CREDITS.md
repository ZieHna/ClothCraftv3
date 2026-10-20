# Credits for the "How it works" video

Files: `how-it-works.mp4`, `how-it-works.webm`, `how-it-works-poster.webp`, and the text alternatives
`how-it-works.vtt` and `how-it-works-transcript.txt` (written by `captions.mjs`). Source and build steps:
`frontend/video-src/`.

## Sound

All sound is synthesised in code by `frontend/video-src/audio.mjs` (noise, sine and filter maths with a seeded random
generator). No recordings, samples, loops or music were used, so there is nothing to license; it is original work of the
project. Layers: paper rustles, whooshes, stitch ticks, snips and pops, soft slaps, an order "ding", a soft delivery
thump, and a very quiet pad (an open fifth).

Mix: about -16 LUFS integrated (measured on the finished files, see `frontend/video-src/README.md`), true peak below
-2 dBFS, no clipping. The loop seam is closed in the audio itself (tails wrap, the pad is exactly periodic).

## Picture

- The T-shirt is `assets-v1/Women/T-shirt.png` (trimmed copy `frontend/video-src/assets/tee.png`). It came with the v1
  project's assets. **Its original source and licence are not recorded anywhere in this repo and were not verified.**
  Confirm that it may be used publicly, or swap in a garment image you own, before launch.
- Everything else (paper shapes, box, house, stamps, thread, numerals) is drawn in code in `scene.js`.

## Fonts (SIL Open Font License 1.1, installed from npm and used only to render the frames)

| Font | Package |
|---|---|
| Cormorant Garamond (display) | `@fontsource/cormorant-garamond` 5.3.0 |
| Jost (sans) | `@fontsource/jost` 5.3.0 |

## Tools used to build (not shipped)

`playwright-core` 1.64.1 driving the Microsoft Edge already installed on this machine, `sharp` 0.35.5, and ffmpeg 6.1.1
(gyan.dev "essentials" build) from `ffmpeg-static` 5.3.0. ffmpeg is used only as a tool; the encoded files are ordinary
H.264/AAC and VP9/Opus.
