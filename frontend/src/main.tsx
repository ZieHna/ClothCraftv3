import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
// self-hosted fonts (fontsource, latin subset only): no requests to Google Fonts. Same faces as the video.
import '@fontsource/cormorant-garamond/latin-700.css';
import '@fontsource/cormorant-garamond/latin-700-italic.css';
import '@fontsource/jost/latin-400.css';
import '@fontsource/jost/latin-500.css';
import '@fontsource/jost/latin-600.css';
import './index.css';
import { router } from './router';
import { enableMocking } from './mocks/enable';

// Nothing is on screen until React renders, so wait for the fonts first (at most 2.5 s, then render anyway). Without this the
// first paint uses a fallback font, and when Cormorant Garamond and Jost arrive headings re-wrap and the page jumps.
const FACES = ['700 1em "Cormorant Garamond"', 'italic 700 1em "Cormorant Garamond"', '400 1em Jost', '500 1em Jost', '600 1em Jost'];
const fontsReady = Promise.race([
  Promise.all(FACES.map((face) => document.fonts.load(face))).catch(() => undefined),
  new Promise((resolve) => setTimeout(resolve, 2500)),
]);

// In mock mode the service worker must be running before the first request, so render after it has started.
const root = () => createRoot(document.getElementById('root')!);
Promise.all([enableMocking(), fontsReady]).then(
  () => {
    root().render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
  },
  (error: unknown) => {
    // loaded only when it is needed: the explanation costs the normal page nothing
    const why = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 220) : 'unknown error';
    void import('./MockUnavailable').then(({ MockUnavailable }) => root().render(<MockUnavailable why={why} />));
  },
);
