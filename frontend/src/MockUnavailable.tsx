/**
 * In mock mode the catalogue is answered by a service worker, and browsers only allow service workers on https and on
 * localhost. Opened by a LAN address over http (a phone on the same wi-fi, say) the worker cannot start, and without this
 * the page would simply stay blank. So say what is wrong and what to do.
 */
export function MockUnavailable({ why }: { why: string }) {
  return (
    <main style={{ maxWidth: '36rem', margin: '4rem auto', padding: '0 1rem', color: 'var(--color-text)' }}>
      <h1 style={{ fontSize: '2.25rem' }}>The demo data cannot start on this address</h1>
      <p style={{ marginTop: '1rem' }}>
        This build gets its catalogue from a mock API that runs inside the browser (a service worker). Browsers only allow that on https, or on
        localhost.{' '}
        {window.isSecureContext ? 'This browser did not allow it to start.' : <>You opened <strong>{location.origin}</strong>, which is neither.</>}
      </p>
      <p style={{ marginTop: '1rem' }}>
        Open it through https (a tunnel such as ngrok or Cloudflare), or on an Android phone connected by USB use http://localhost:5173 with port
        forwarding. The steps are in frontend/README.md.
      </p>
      <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: 'var(--color-muted)' }}>What the browser said: {why}</p>
    </main>
  );
}

