import { useCallback, useEffect, useRef, useState } from 'react';
import { VIDEO } from '../../content/steps';
import { useReducedMotion } from '../../hooks/useReducedMotion';

const VISIBLE_RATIO = 0.4;

// The sound choice lives in memory on purpose, not in storage: it survives moving between pages of the site (the session),
// but a reload or a new tab always starts silent. Browsers keep the click permission across a reload, so storing the choice
// would bring sound back with no click on the new page, which this component must never do.
let soundChoice = false;

/**
 * The "How it works" loop. Rules (all in sync() below, so they cannot disagree):
 *  - it plays only while at least 40% of it is on screen AND the tab is visible AND the viewer has not paused it;
 *  - it always starts muted. Sound is switched on only by a click on the sound button;
 *  - leaving the screen or hiding the tab pauses it, which also stops the sound;
 *  - the sound choice is remembered while the visitor moves around the site (module memory, see soundChoice), and is
 *    forgotten on reload, so the video never starts with sound on a fresh page;
 *  - with prefers-reduced-motion it never starts by itself: it shows the poster until the viewer presses Play;
 *  - nothing of the video is downloaded until it is within 600px of the screen (preload "none", then "metadata").
 */
export function HowItWorksVideo() {
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const flags = useRef({ inView: false, userPaused: false, userStarted: false, wantSound: false, reduced });

  const sync = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const f = flags.current;
    const allowed = f.inView && document.visibilityState === 'visible' && !f.userPaused && (!f.reduced || f.userStarted);
    if (allowed) {
      video.muted = !f.wantSound;
      void video.play().catch(() => {
        // the browser refused (for instance sound with no recent click): carry on silently
        f.wantSound = false;
        setSoundOn(false);
        video.muted = true;
        void video.play().catch(() => {});
      });
    } else {
      video.pause();
      video.muted = true;
    }
  }, []);

  useEffect(() => {
    flags.current.reduced = reduced;
    sync();
  }, [reduced, sync]);

  useEffect(() => {
    const box = boxRef.current;
    const video = videoRef.current;
    if (!box || !video) return;
    video.muted = true;
    const f = flags.current;
    // honour the remembered choice only if this document has had a click or tap
    const activated = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive === true;
    f.wantSound = soundChoice && activated;
    setSoundOn(f.wantSound);

    const observer = new IntersectionObserver(
      ([entry]) => {
        f.inView = entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO;
        sync();
      },
      { threshold: [0, VISIBLE_RATIO, 1] },
    );
    observer.observe(box);

    // Nothing is downloaded until the video is about to be needed: preload is "none", and it becomes "metadata" once the
    // video is within 600px of the screen. (With reduced motion it stays "none" until the viewer presses Play.)
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        near.disconnect();
        if (flags.current.reduced || video.preload !== 'none') return;
        video.preload = 'metadata';
        if (video.networkState === HTMLMediaElement.NETWORK_EMPTY) video.load();
      },
      { rootMargin: '600px 0px' },
    );
    near.observe(box);
    document.addEventListener('visibilitychange', sync);
    return () => {
      observer.disconnect();
      near.disconnect();
      document.removeEventListener('visibilitychange', sync);
      video.pause();
    };
  }, [sync]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    const f = flags.current;
    if (video.paused) {
      f.userPaused = false;
      f.userStarted = true;
      video.muted = !f.wantSound;
      void video.play().catch(() => {
        f.wantSound = false;
        setSoundOn(false);
        video.muted = true;
        void video.play().catch(() => {});
      });
    } else {
      f.userPaused = true;
      video.pause();
      video.muted = true;
    }
  };

  const toggleSound = () => {
    const video = videoRef.current;
    const f = flags.current;
    f.wantSound = !f.wantSound;
    setSoundOn(f.wantSound);
    soundChoice = f.wantSound;
    // this runs inside the click, so the browser allows unmuting. While paused it stays muted until it plays again.
    if (video) video.muted = !f.wantSound || video.paused;
  };

  return (
    // max-w: never displayed wider than the 1280x720 source. The frame is 16:9 (aspect-video) and the <video> has explicit
    // width/height, so nothing shifts while it loads. The controls below share this figure's width, so they stay aligned.
    <figure className="m-0 w-full max-w-[1280px]">
      <div ref={boxRef} className="relative aspect-video w-full overflow-hidden border border-brown-dark bg-ink shadow-[6px_6px_0_0_var(--color-tan)]">
        <video
          ref={videoRef}
          className="absolute inset-0 size-full object-cover"
          width={VIDEO.width}
          height={VIDEO.height}
          poster={VIDEO.poster}
          muted
          playsInline
          loop
          preload="none"
          aria-label="How ClothCraft works: pick your piece, make it yours, place your order, delivered to you. A silent looping animation with soft sound effects; the same steps are written next to it."
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        >
          <source src={VIDEO.webm} type="video/webm" />
          <source src={VIDEO.mp4} type="video/mp4" />
          <track kind="descriptions" src={VIDEO.descriptions} srcLang="en" label="Words on screen and sounds" />
          Your browser cannot play this video. The steps are written out next to it, and there is a{' '}
          <a href={VIDEO.transcript}>transcript</a>.
        </video>
      </div>
      <figcaption className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="button" onClick={togglePlay} className="btn btn-secondary btn-small">
          {playing ? (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 1.5h3.5v13H3zM9.5 1.5H13v13H9.5z" fill="currentColor" /></svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 1.5v13l11-6.5z" fill="currentColor" /></svg>
          )}
          {playing ? 'Pause video' : 'Play video'}
        </button>
        <button type="button" onClick={toggleSound} className="btn btn-secondary btn-small">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M2 6h3l4-3.5v11L5 10H2z" fill="currentColor" />
            {soundOn ? <path d="M11 5.2a4 4 0 0 1 0 5.6M12.8 3.4a6.6 6.6 0 0 1 0 9.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /> : <path d="M11.5 5.5l3.5 5M15 5.5l-3.5 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
          </svg>
          {soundOn ? 'Turn sound off' : 'Turn sound on'}
        </button>
        <a href={VIDEO.transcript} target="_blank" rel="noopener" className="text-sm font-medium text-sage-dark underline underline-offset-4">
          Read the transcript
        </a>
      </figcaption>
    </figure>
  );
}
