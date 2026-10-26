import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// /docs/ is the static documentation page (public/docs/index.html, copied unchanged into dist/docs/). Vite's dev and preview servers answer a bare
// directory address with the app's index.html (the single-page fallback), so /docs and /docs/ are sent to the file itself. A static host serves
// the directory's index.html on its own, so a deployed build needs nothing here.
const docsPage = (): Plugin => {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/docs' || path === '/docs/') req.url = '/docs/index.html';
    next();
  };
  return { name: 'clothcraft-docs-page', configureServer: (server) => void server.middlewares.use(rewrite), configurePreviewServer: (server) => void server.middlewares.use(rewrite) };
};

// The browser only ever talks to one origin. Requests to /api are either answered in the browser by MSW (VITE_API=mock)
// or forwarded by this proxy to the API service (VITE_API=odoo). The target below is a PLACEHOLDER: no API service
// exists yet. Override it with VITE_PROXY_TARGET.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxy = { '/api': { target: env.VITE_PROXY_TARGET || 'http://127.0.0.1:8000', changeOrigin: true } };
  return {
    plugins: [react(), tailwindcss(), docsPage()],
    // video-src/ holds its own standalone index.html; scan only the app's entry for dependencies
    optimizeDeps: { entries: ['index.html'] },
    // hostnames of common tunnels, so a phone can reach the dev or preview server over https (see frontend/README.md)
    server: { proxy, allowedHosts: ['.ngrok-free.app', '.ngrok.app', '.ngrok.io', '.trycloudflare.com', '.loca.lt'] },
    preview: { proxy, allowedHosts: ['.ngrok-free.app', '.ngrok.app', '.ngrok.io', '.trycloudflare.com', '.loca.lt'] },
    test: {
      projects: [
        // jsdom: pure logic, the FakeEditor contract run, the chooser and dialogs
        {
          extends: true,
          test: {
            name: 'jsdom',
            // skeletons show and leave at once in the unit tests (src/lib/skeletonTiming.ts); the timing tests pass their own numbers
            env: { VITE_SKELETON_INSTANT: '1' },
            environment: 'jsdom',
            include: ['src/**/*.test.{ts,tsx}'],
            exclude: ['src/**/*.browser.test.{ts,tsx}'],
            setupFiles: ['./src/test/setup.ts'],
          },
        },
        // real browser: everything that touches Fabric. Uses the Microsoft Edge already installed on this machine
        // (Playwright channel "msedge"); no browser is downloaded.
        {
          extends: true,
          // pre-bundle up front: a dependency discovered mid-run is re-optimised, and two copies of React then break hooks
          optimizeDeps: {
            include: ['react', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-router', 'fabric', '@testing-library/react'],
          },
          test: {
            name: 'edge',
            env: { VITE_SKELETON_INSTANT: '1' },
            include: ['src/**/*.browser.test.{ts,tsx}'],
            browser: {
              enabled: true,
              headless: true,
              // precise memory + gc() let the history cost tests (SimpleEditor.perf.browser.test.ts) read a trustworthy JS heap
              provider: playwright({ launchOptions: { channel: 'msedge', args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] } }),
              // desktop size: the editor screen switches to its phone layout under 640 px (layouts are checked by scripts/check-editor-browser.mjs)
              viewport: { width: 1280, height: 900 },
              instances: [{ browser: 'chromium' }],
            },
          },
        },
      ],
    },
  };
});
