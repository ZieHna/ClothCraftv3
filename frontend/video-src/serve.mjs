// Tiny static server for the video page: serves this folder, and maps /fonts/<file> to the pinned @fontsource packages.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  if (clean.startsWith('/fonts/')) {
    const name = clean.slice('/fonts/'.length);
    const pkg = name.startsWith('cormorant') ? 'cormorant-garamond' : 'jost';
    return join(root, 'node_modules', '@fontsource', pkg, 'files', name.replace(/[^a-z0-9.\-]/gi, ''));
  }
  const file = normalize(join(root, clean === '/' ? 'index.html' : clean));
  return file.startsWith(root) ? file : null;
}

export function serve(port = 5179) {
  const server = createServer(async (req, res) => {
    const file = resolve(req.url);
    try {
      if (!file) throw new Error('outside root');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await serve();
  console.log('http://127.0.0.1:5179/?t=2.5   (add &play=1 to preview in real time)');
}
