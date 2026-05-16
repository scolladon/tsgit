// Static file server used by Playwright as `webServer`. Zero deps, lives on
// node:http + node:fs. Serves the project root so requests for
// /dist/esm/index.browser.js and /test/browser/index.html resolve relative to
// the repo layout.

import { readFile, stat } from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.TSGIT_BROWSER_PORT ?? 5181);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

const send = (res, status, headers, body) => {
  res.writeHead(status, headers);
  res.end(body);
};

const resolveSafe = (urlPath) => {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const target = decoded === '/' ? '/test/browser/index.html' : decoded;
  const absolute = path.resolve(ROOT, `.${target}`);
  if (!absolute.startsWith(ROOT + path.sep) && absolute !== ROOT) return null;
  return absolute;
};

const handler = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { 'content-type': 'text/plain' }, 'Method Not Allowed');
    return;
  }
  const filePath = resolveSafe(req.url ?? '/');
  if (filePath === null) {
    send(res, 403, { 'content-type': 'text/plain' }, 'Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      send(res, 404, { 'content-type': 'text/plain' }, 'Not Found');
      return;
    }
    const ext = path.extname(filePath);
    const type = MIME[ext] ?? 'application/octet-stream';
    const headers = {
      'content-type': type,
      'cache-control': 'no-store',
      // Required for OPFS in cross-origin-isolated contexts. Playwright pages
      // don't strictly need this since they're same-origin, but it costs us
      // nothing and keeps the harness honest.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    };
    if (req.method === 'HEAD') {
      send(res, 200, headers, '');
      return;
    }
    const body = await readFile(filePath);
    send(res, 200, headers, body);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      send(res, 404, { 'content-type': 'text/plain' }, 'Not Found');
      return;
    }
    // Never leak the raw error to the response — paths and syscall names land
    // in CI logs and any wider exposure (a misconfigured tunnel, a future
    // reuse of this server outside CI) would dribble repo layout.
    process.stderr.write(`serve.mjs 500: ${err instanceof Error ? err.message : String(err)}\n`);
    send(res, 500, { 'content-type': 'text/plain' }, 'Internal Server Error');
  }
};

const server = http.createServer(handler);
// Loopback only — Playwright is same-host; refusing non-loopback connections
// avoids exposing the repo root on shared CI runners or self-hosted containers.
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`tsgit browser harness listening on http://127.0.0.1:${PORT}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
