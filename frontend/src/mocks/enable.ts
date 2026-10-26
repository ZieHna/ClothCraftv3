import { API_MODE } from '../api/client';

/**
 * Starts the MSW service worker in mock mode. In odoo mode this is a no-op and MSW is never loaded (dynamic import). In a build made with
 * VITE_API=odoo the condition below is a constant, so the whole mock server (the catalogue, the demo accounts) is not even part of the build.
 */
const MOCK_BUILD = import.meta.env.VITE_API !== 'odoo';
export async function enableMocking(): Promise<void> {
  if (!MOCK_BUILD || API_MODE !== 'mock') return;
  const { worker } = await import('./browser');
  await worker.start({
    // msw 3 name (msw 2 called it onUnhandledRequest). Only /api is the mock's business: page navigations, images and
    // fonts pass straight through (msw 3 otherwise warns about every full page load). An /api call with no handler is a bug.
    onUnhandledFrame({ frame, defaults }) {
      const request = (frame.data as { request?: Request }).request;
      if (request && new URL(request.url).pathname.startsWith('/api/')) defaults.error();
    },
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
  });
}
