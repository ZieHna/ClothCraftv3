/**
 * The four steps of "How it works". These are the same words as the on-screen text of the video (video-src/timeline.js,
 * COPY) and of public/video/how-it-works-transcript.txt. The app never imports from video-src/, so they are repeated here;
 * keep the three in step.
 */
export interface Step {
  tag: string;
  headline: [string, string];
  support: string;
}

export const STEPS: Step[] = [
  { tag: 'Choose', headline: ['Pick your', 'piece.'], support: 'Pick a garment, color and size.' },
  { tag: 'Design', headline: ['Make it', 'yours.'], support: 'Add text, an image or a shape.' },
  { tag: 'Order', headline: ['Place your', 'order.'], support: 'Cash on delivery or bank transfer.' },
  { tag: 'Receive', headline: ['Delivered', 'to you.'], support: 'It arrives. You check it off.' },
];

export const VIDEO = {
  poster: '/video/how-it-works-poster.webp',
  webm: '/video/how-it-works.webm',
  mp4: '/video/how-it-works.mp4',
  transcript: '/video/how-it-works-transcript.txt',
  descriptions: '/video/how-it-works.vtt',
  width: 1280,
  height: 720,
};
