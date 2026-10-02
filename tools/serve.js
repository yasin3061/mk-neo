/*
 * Server for the mockup. The local preview and the live demo run this same file.
 *
 *   node tools/serve.js [port]      local preview (default 8347)
 *   npm start                       on a host: the port comes from PORT, which the platform injects (Railway)
 *
 * The app sits behind a sign-in. A login is checked against a file on the server, server/users.json: one record per
 * user, holding the username and a salted scrypt hash of the password. The password itself is written nowhere, and
 * the file is not in the repository. It is written at start-up from two variables,
 *
 *   LOGIN_USER=someone@example.com   LOGIN_PASSWORD=...        (on Railway: the service's Variables)
 *
 * and read back from disk on later starts when the variables are absent (a local run after the first one).
 * `node tools/serve.js --write-login` writes the file from the two variables and exits. With neither a file nor the
 * variables the server refuses to start, so the app is never served unprotected by accident; LOGIN=off is the
 * explicit way to run it open, for local work only. Optional: SESSION_SECRET signs the session cookie (without it
 * the key is derived from the credentials, so changing the password signs everybody out); LOGIN_FILE moves the file.
 *
 * What a signed-in browser gets: index.html and the css/, js/ and vendor/ folders - what the app loads, and nothing
 * else. Documents, tools, configuration and server/ are never served. GET and HEAD, plus POST for /login and
 * /logout; every file revalidates by ETag (no fingerprints, so a deploy must show at once); brotli or gzip for text;
 * /healthz for the platform's health check; search engines are told not to index. No dependencies.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(/^\d+$/.test(String(process.argv[2] || '')) ? process.argv[2] : (process.env.PORT || 8347));
const LOGIN_DIR = path.join(ROOT, 'login');
const USERS_FILE = process.env.LOGIN_FILE ? path.resolve(process.env.LOGIN_FILE) : path.join(ROOT, 'server', 'users.json');

const COOKIE = 'mk_session';
const SESSION_HOURS = 12;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_BYTES = 64;
const THROTTLE = { max: 8, windowMs: 10 * 60 * 1000, delayMs: 300 };   /* refused sign-ins per address before a pause */
const FORM_LIMIT = 4096;

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
const MESSAGES = {
  refused: ['error', 'That email or password is not right.'],
  paused: ['error', 'Too many attempts. Wait a few minutes, then try again.'],
  out: ['info', 'You are signed out.']
};

/* ------------------------------------------------------------------ the users file */

function usable(u) {
  return !!u && typeof u.username === 'string' && u.username.length > 0 && /^[0-9a-f]{16,}$/.test(String(u.salt)) && /^[0-9a-f]{32,}$/.test(String(u.hash)) &&
    Number.isInteger(u.N) && Number.isInteger(u.r) && Number.isInteger(u.p);
}

/* Variables in, file out; then the file is what every sign-in is checked against. */
function loadUsers() {
  const username = String(process.env.LOGIN_USER || '').trim(), password = process.env.LOGIN_PASSWORD;
  if (username && password) {
    const salt = crypto.randomBytes(16);
    const record = { username: username, algorithm: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('hex'),
      hash: crypto.scryptSync(String(password), salt, KEY_BYTES, SCRYPT).toString('hex'), writtenAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify({ about: 'Sign-in records of the preview. Written by tools/serve.js from LOGIN_USER and LOGIN_PASSWORD; the password is stored as a salted scrypt hash only. Not in the repository.', users: [record] }, null, 2) + '\n', { mode: 0o600 });
  }
  let users = [];
  try { users = (JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users || []).filter(usable); } catch (e) { users = []; }
  if (!users.length) {
    console.error('No login is configured, so the preview will not start.\n' +
      '  Set LOGIN_USER and LOGIN_PASSWORD (on Railway: the service\'s Variables) and start again;\n' +
      '  they are written to ' + path.relative(ROOT, USERS_FILE).replace(/\\/g, '/') + ' with the password as a salted hash.\n' +
      '  To run without a sign-in on your own machine: LOGIN=off node tools/serve.js');
    process.exit(1);
  }
  return users;
}

const OPEN = String(process.env.LOGIN || '').toLowerCase() === 'off';
const USERS = OPEN ? null : loadUsers();
if (process.argv.indexOf('--write-login') !== -1) {
  console.log(USERS ? 'Sign-in file ready: ' + path.relative(ROOT, USERS_FILE).replace(/\\/g, '/') + ' (' + USERS.map((u) => u.username).join(', ') + ')' : 'LOGIN=off: nothing written');
  process.exit(0);
}
/* the cookie key: a secret of its own if given, else the password, else the stored hashes - never anything a visitor can read */
const KEY = USERS ? crypto.createHmac('sha256', 'mk-neo session key v1')
  .update(String(process.env.SESSION_SECRET || process.env.LOGIN_PASSWORD || USERS.map((u) => u.salt + u.hash).join('|'))).digest() : null;

/* every record is hashed whatever the username, so the time taken says nothing about which usernames exist */
function verify(username, password) {
  const name = String(username || '').trim().toLowerCase();
  let found = null;
  USERS.forEach((u) => {
    const want = Buffer.from(u.hash, 'hex');
    const got = crypto.scryptSync(String(password || ''), Buffer.from(u.salt, 'hex'), want.length, { N: u.N, r: u.r, p: u.p });
    if (crypto.timingSafeEqual(got, want) && u.username.toLowerCase() === name) found = u.username;
  });
  return found;
}

/* ------------------------------------------------------------------ the session cookie */

function sign(text) { return crypto.createHmac('sha256', KEY).update(text).digest('base64url'); }
function newSession(username) {
  const body = (Date.now() + SESSION_HOURS * 3600 * 1000) + '.' + Buffer.from(username, 'utf8').toString('base64url');
  return body + '.' + sign(body);
}
function sessionUser(req) {
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)').exec(String(req.headers.cookie || ''));
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 3) return null;
  const want = Buffer.from(sign(parts[0] + '.' + parts[1])), got = Buffer.from(parts[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  if (!(Number(parts[0]) > Date.now())) return null;
  const name = Buffer.from(parts[1], 'base64url').toString('utf8');
  return USERS.some((u) => u.username === name) ? name : null;
}
function cookie(req, value, maxAgeSeconds) {
  const secure = /https/i.test(String(req.headers['x-forwarded-proto'] || '')) ? '; Secure' : '';
  return COOKIE + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSeconds + secure;
}

/* ------------------------------------------------------------------ refused sign-ins, by address */

const attempts = new Map();   /* address -> { count, until } */
function clientAddress(req) {
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real;
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : String(req.socket.remoteAddress || 'unknown');
}
function paused(address) {
  const a = attempts.get(address);
  if (!a) return false;
  if (Date.now() > a.until) { attempts.delete(address); return false; }
  return a.count >= THROTTLE.max;
}
function refused(address) {
  const now = Date.now(), a = attempts.get(address);
  if (!a || now > a.until) attempts.set(address, { count: 1, until: now + THROTTLE.windowMs }); else a.count += 1;
}
setInterval(() => { const now = Date.now(); attempts.forEach((a, address) => { if (now > a.until) attempts.delete(address); }); }, 60 * 1000).unref();

/* ------------------------------------------------------------------ responses */

function send(res, status, headers, body, headOnly) {
  res.writeHead(status, Object.assign({}, BASE_HEADERS, headers));
  res.end(headOnly ? undefined : body);
}
function plain(res, status, message, headOnly, extra) {
  send(res, status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, extra), message + '\n', headOnly);
}
function redirect(res, location, extra) {
  send(res, 303, Object.assign({ Location: location, 'Cache-Control': 'no-store' }, extra), '', true);
}

/* path -> { mtimeMs, size, mtime, etag, raw, br, gz }: the whole site is about 3 MB, so it lives in memory once read */
const cache = new Map();
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

function sendFile(req, res, file, headOnly, cacheControl) {
  load(file, (err, entry) => {
    if (err) { plain(res, 404, 'Not found', headOnly); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': cacheControl, ETag: entry.etag, 'Last-Modified': entry.mtime, Vary: 'Accept-Encoding' };
    if (String(req.headers['if-none-match'] || '').split(',').some((tag) => tag.trim() === entry.etag)) { send(res, 304, headers, '', true); return; }
    const out = COMPRESSIBLE.test(type) ? encoded(entry, String(req.headers['accept-encoding'] || '')) : { encoding: null, body: entry.raw };
    if (out.encoding) headers['Content-Encoding'] = out.encoding;
    headers['Content-Length'] = out.body.length;
    send(res, 200, headers, out.body, headOnly);
  });
}

/* ------------------------------------------------------------------ sign in, sign out */

function loginPage(res, query, headOnly) {
  load(path.join(LOGIN_DIR, 'login.html'), (err, entry) => {
    if (err) { plain(res, 500, 'The sign-in page is missing', headOnly); return; }
    const which = /(?:^|&)e=2(?:&|$)/.test(query) ? 'paused' : /(?:^|&)e=1(?:&|$)/.test(query) ? 'refused' : /(?:^|&)out=1(?:&|$)/.test(query) ? 'out' : null;
    const note = which ? '<p class="lg-msg lg-msg--' + MESSAGES[which][0] + '" role="' + (MESSAGES[which][0] === 'error' ? 'alert' : 'status') + '">' + MESSAGES[which][1] + '</p>' : '';
    send(res, 200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' }, entry.raw.toString('utf8').replace('<!--message-->', note), headOnly);
  });
}

function readForm(req, done) {
  const chunks = [];
  let size = 0, settled = false;
  function finish(err, form) { if (settled) return; settled = true; done(err, form); }
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > FORM_LIMIT) { finish(new Error('too large')); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    const form = {};
    new URLSearchParams(Buffer.concat(chunks).toString('utf8')).forEach((value, key) => { form[key] = value; });
    finish(null, form);
  });
  req.on('error', (err) => finish(err));
}

/*
 * A form posted from another site is not a sign-in. The browser itself says where a request comes from
 * (Sec-Fetch-Site), which holds behind any proxy; comparing Origin with Host does not, because a proxy may rewrite
 * the Host - the local preview pane does, and a strict comparison locked the sign-in out there.
 */
function sameSite(req) {
  return String(req.headers['sec-fetch-site'] || '').toLowerCase() !== 'cross-site';
}

function signIn(req, res) {
  const address = clientAddress(req);
  if (paused(address)) { req.resume(); redirect(res, '/login?e=2'); return; }
  if (!/^application\/x-www-form-urlencoded/i.test(String(req.headers['content-type'] || ''))) { req.resume(); plain(res, 415, 'Unsupported form', false); return; }
  readForm(req, (err, form) => {
    if (err) { plain(res, 413, 'Request too large', false, { Connection: 'close' }); return; }
    const username = verify(form.username, form.password);
    if (!username) {
      refused(address);
      console.warn('sign-in refused from ' + address);
      setTimeout(() => redirect(res, paused(address) ? '/login?e=2' : '/login?e=1'), THROTTLE.delayMs);
      return;
    }
    attempts.delete(address);
    console.log('signed in: ' + username + ' from ' + address);
    redirect(res, '/', { 'Set-Cookie': cookie(req, newSession(username), SESSION_HOURS * 3600) });
  });
}

/* ------------------------------------------------------------------ the server */

const server = http.createServer((req, res) => {
  const headOnly = req.method === 'HEAD';
  let urlPath, query;
  try {
    const raw = String(req.url).split('#')[0], q = raw.indexOf('?');
    query = q === -1 ? '' : raw.slice(q + 1);
    urlPath = decodeURIComponent(q === -1 ? raw : raw.slice(0, q));
  } catch (e) { plain(res, 400, 'Bad request', headOnly); return; }

  if (req.method === 'POST') {
    if (!USERS || (urlPath !== '/login' && urlPath !== '/logout')) { req.resume(); plain(res, 405, 'Method not allowed', false, { Allow: 'GET, HEAD' }); return; }
    if (!sameSite(req)) { req.resume(); plain(res, 403, 'Forbidden', false); return; }
    if (urlPath === '/logout') { req.resume(); redirect(res, '/login?out=1', { 'Set-Cookie': cookie(req, '', 0) }); return; }
    signIn(req, res);
    return;
  }
  if (req.method !== 'GET' && !headOnly) { plain(res, 405, 'Method not allowed', false, { Allow: 'GET, HEAD' }); return; }

  /* open to everyone: the platform's health check and the robots file */
  if (urlPath === '/healthz') { plain(res, 200, 'ok', headOnly); return; }
  if (urlPath === '/robots.txt') { plain(res, 200, 'User-agent: *\nDisallow: /', headOnly, { 'Cache-Control': 'no-cache' }); return; }

  if (USERS) {
    const user = sessionUser(req);
    if (urlPath === '/login') { if (user) redirect(res, '/'); else loginPage(res, query, headOnly); return; }
    if (urlPath === '/login/login.css' || urlPath === '/login/login.js') { sendFile(req, res, path.join(LOGIN_DIR, path.basename(urlPath)), headOnly, 'no-cache'); return; }
    if (urlPath === '/auth/session') {
      if (user) send(res, 200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' }, JSON.stringify({ user: user }), headOnly);
      else plain(res, 401, 'Sign in required', headOnly);
      return;
    }
    /* everything else is the app: nothing of it leaves without a session, and the check comes before any cached answer */
    if (!user) { if (urlPath === '/' || urlPath === '/index.html') redirect(res, '/login'); else plain(res, 401, 'Sign in required', headOnly); return; }
  } else {
    if (urlPath === '/login') { redirect(res, '/'); return; }
    if (urlPath === '/auth/session') { send(res, 204, { 'Cache-Control': 'no-store' }, '', true); return; }   /* no sign-in in force: nothing to sign out of */
  }

  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.indexOf('\0') !== -1 || urlPath.indexOf('..') !== -1 || !PUBLIC.some((re) => re.test(urlPath))) { plain(res, 404, 'Not found', headOnly); return; }
  const file = path.join(ROOT, urlPath);
  if (!file.startsWith(ROOT + path.sep)) { plain(res, 404, 'Not found', headOnly); return; }
  sendFile(req, res, file, headOnly, USERS ? 'private, no-cache' : 'no-cache');
});

server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
server.listen(PORT, () => console.log('Miya Kebabs preview listening on port ' + PORT + ' (http://localhost:' + PORT + ') - ' +
  (USERS ? 'sign-in required, ' + USERS.length + (USERS.length === 1 ? ' user' : ' users') + ' on file' : 'OPEN: no sign-in (LOGIN=off)')));

/* a platform stops a container with SIGTERM: finish what is in flight, then leave */
['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}));
