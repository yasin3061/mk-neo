/*
 * Static server for the mockup. The local preview and the live demo run this same file.
 *
 *   node tools/serve.js [port]      local preview (default 8347)
 *   npm start                       on a host: the port comes from PORT, which the platform injects (Railway)
 *
 * The mockup itself needs no server: double-click index.html. A server is needed only where file:// is blocked,
 * and to put the preview on the internet.
 *
 * What it serves: index.html and the css/, js/ and vendor/ folders - what the app loads, and nothing else. The
 * documents, the tools and the checks belong to the repository, not to the site.
 * How: GET and HEAD only; every file revalidates by ETag (the files carry no fingerprint, so a deploy must show
 * at once); brotli or gzip for text; /healthz for the platform's health check; search engines are told not to
 * index the preview. No dependencies.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8347);

/* the site: the page and its three asset folders */
const PUBLIC = [/^\/index\.html$/, /^\/(css|js|vendor)\/[A-Za-z0-9._\/-]+$/];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive'   /* a client preview on sample data: not something to find through a search engine */
};

/* path -> { mtimeMs, size, mtime, etag, raw, br, gz }: the whole site is about 2 MB, so it lives in memory once read */
const cache = new Map();

function send(res, status, headers, body, headOnly) {
  res.writeHead(status, Object.assign({}, BASE_HEADERS, headers));
  res.end(headOnly ? undefined : body);
}
function plain(res, status, message, headOnly, extra) {
  send(res, status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, extra), message + '\n', headOnly);
}

function load(file, done) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { done(err || new Error('not a file')); return; }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { done(null, hit); return; }
    fs.readFile(file, (readErr, raw) => {
      if (readErr) { done(readErr); return; }
      const entry = { mtimeMs: st.mtimeMs, size: st.size, mtime: st.mtime.toUTCString(),
        etag: 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"', raw: raw, br: null, gz: null };
      cache.set(file, entry);
      done(null, entry);
    });
  });
}

/* compressed once per file and kept: brotli where the browser takes it, gzip otherwise */
function encoded(entry, accept) {
  if (/\bbr\b/.test(accept)) {
    if (!entry.br) entry.br = zlib.brotliCompressSync(entry.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
    return { encoding: 'br', body: entry.br };
  }
  if (/\bgzip\b/.test(accept)) {
    if (!entry.gz) entry.gz = zlib.gzipSync(entry.raw, { level: 6 });
    return { encoding: 'gzip', body: entry.gz };
  }
  return { encoding: null, body: entry.raw };
}

function matches(header, etag) {
  return String(header || '').split(',').some((tag) => tag.trim() === etag);
}

const server = http.createServer((req, res) => {
  const headOnly = req.method === 'HEAD';
  if (req.method !== 'GET' && !headOnly) { plain(res, 405, 'Method not allowed', false, { Allow: 'GET, HEAD' }); return; }

  let urlPath;
  try { urlPath = decodeURIComponent(String(req.url).split('?')[0].split('#')[0]); }
  catch (e) { plain(res, 400, 'Bad request', headOnly); return; }

  if (urlPath === '/healthz') { plain(res, 200, 'ok', headOnly); return; }
  if (urlPath === '/robots.txt') { plain(res, 200, 'User-agent: *\nDisallow: /', headOnly, { 'Cache-Control': 'no-cache' }); return; }
  if (urlPath === '/') urlPath = '/index.html';

  if (urlPath.indexOf('\0') !== -1 || urlPath.indexOf('..') !== -1 || !PUBLIC.some((re) => re.test(urlPath))) { plain(res, 404, 'Not found', headOnly); return; }
  const file = path.join(ROOT, urlPath);
  if (!file.startsWith(ROOT + path.sep)) { plain(res, 404, 'Not found', headOnly); return; }

  load(file, (err, entry) => {
    if (err) { plain(res, 404, 'Not found', headOnly); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: entry.etag, 'Last-Modified': entry.mtime, Vary: 'Accept-Encoding' };
    if (matches(req.headers['if-none-match'], entry.etag)) { send(res, 304, headers, '', true); return; }
    const out = COMPRESSIBLE.test(type) ? encoded(entry, String(req.headers['accept-encoding'] || '')) : { encoding: null, body: entry.raw };
    if (out.encoding) headers['Content-Encoding'] = out.encoding;
    headers['Content-Length'] = out.body.length;
    send(res, 200, headers, out.body, headOnly);
  });
});

server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
server.listen(PORT, () => console.log('Miya Kebabs preview listening on port ' + PORT + ' (http://localhost:' + PORT + ')'));

/* a platform stops a container with SIGTERM: finish what is in flight, then leave */
['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}));
