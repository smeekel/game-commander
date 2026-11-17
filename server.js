'use strict';

const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const THUMB_DIR = path.join(PUBLIC_DIR, 'thumbnails');
const PACKAGE_DIR = path.join(PUBLIC_DIR, 'packages');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'shelf.db');
const CERT_DIR = path.join(ROOT, 'certs');

const PORT = Number(process.env.PORT) || 8443;
const SESSION_COOKIE = 'shelf_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const FAILED_LOGIN_DELAY_MS = 1000;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_THUMB_BYTES = 10 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024 * 1024;
const THUMB_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);

const LIMITS = { name: 100, description: 2000, href: 2000, tag: 32, tags: 20 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "script-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Thumbnails may be user-uploaded SVG; opening one directly must not run script.
const THUMB_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- database

const SAMPLE_GAMES = [
  {
    id: 'vector-run',
    name: 'Vector Run',
    description: 'Thread a wireframe ship through a tunnel of rotating gates. Plays in the browser; click the card to launch it.',
    thumbnail: 'vector-run.svg',
    tags: ['arcade', 'web', 'vector'],
    kind: 'web',
    href: 'https://example.com/vector-run',
    package: null,
  },
  {
    id: 'copper-quest',
    name: 'Copper Quest',
    description: 'A turn-based dungeon crawl lit by copper bars. Download the package, unzip it, and run it on your own machine.',
    thumbnail: 'copper-quest.svg',
    tags: ['rpg', 'offline', 'dungeon'],
    kind: 'install',
    href: null,
    package: 'copper-quest.txt',
  },
];

function openDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const isNew = !fs.existsSync(DB_PATH);
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin (
      id       INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      salt     TEXT NOT NULL,
      hash     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS games (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      thumbnail   TEXT,
      tags        TEXT NOT NULL DEFAULT '[]',
      kind        TEXT NOT NULL CHECK (kind IN ('web', 'install')),
      href        TEXT,
      package     TEXT,
      position    INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);

  if (isNew) {
    transaction(db, () => {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('title', 'The Rack');
      const insert = db.prepare(`
        INSERT INTO games (id, name, description, thumbnail, tags, kind, href, package, position, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      SAMPLE_GAMES.forEach((g, i) => {
        insert.run(g.id, g.name, g.description, g.thumbnail, JSON.stringify(g.tags), g.kind, g.href, g.package, i + 1, Date.now());
      });
    });
    console.log(`Created ${path.relative(ROOT, DB_PATH)} with ${SAMPLE_GAMES.length} sample games.`);
  }

  return db;
}

async function ensureAdmin(db) {
  const existing = db.prepare('SELECT username FROM admin WHERE id = 1').get();
  if (existing) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'change-me';
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  db.prepare('INSERT INTO admin (id, username, salt, hash) VALUES (1, ?, ?, ?)')
    .run(username, salt.toString('hex'), hash.toString('hex'));
  if (process.env.ADMIN_PASSWORD) {
    console.log(`Created admin account "${username}" from ADMIN_USERNAME / ADMIN_PASSWORD.`);
  } else {
    console.warn(`Created admin account "${username}" with the default password "change-me". See README.md to change it.`);
  }
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function rowToGame(row) {
  let tags = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === 'string');
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    thumbnail: row.thumbnail,
    tags,
    kind: row.kind,
    href: row.href,
    package: row.package,
    updated: row.updated_at,
  };
}

// ---------------------------------------------------------------- validation

function isSafeBasename(name) {
  return typeof name === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name)
    && !name.includes('..')
    && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name);
}

function sanitizeFilename(raw) {
  if (typeof raw !== 'string') return null;
  let name = path.win32.basename(path.posix.basename(raw.trim()));
  name = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[^A-Za-z0-9]+/, '');
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 12);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = `file-${name}`;
  return isSafeBasename(name) ? name : null;
}

function cleanText(value, max, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text.`);
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text.length > max) throw new HttpError(400, `${field} is longer than ${max} characters.`);
  return text;
}

function cleanTags(value) {
  let list;
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'string') list = value.split(',');
  else if (value === undefined || value === null) list = [];
  else throw new HttpError(400, 'Tags must be a list.');

  const seen = new Set();
  const tags = [];
  for (const item of list) {
    if (typeof item !== 'string') throw new HttpError(400, 'Each tag must be text.');
    const tag = item.trim().replace(/\s+/g, ' ');
    if (!tag) continue;
    if (tag.length > LIMITS.tag) throw new HttpError(400, `Tag "${tag}" is longer than ${LIMITS.tag} characters.`);
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > LIMITS.tags) throw new HttpError(400, `Use at most ${LIMITS.tags} tags.`);
  return tags;
}

function cleanHref(value) {
  const href = cleanText(value, LIMITS.href, 'Game link');
  if (!href) return '';
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  let url;
  try {
    url = new URL(href);
  } catch {
    throw new HttpError(400, 'Game link must be a full http(s) address or a path starting with /.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'Game link must use http or https.');
  }
  return url.href;
}

function cleanFileReference(value, dir, label, allowedExts) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !isSafeBasename(value.trim())) {
    throw new HttpError(400, `${label} must be a plain file name (letters, digits, dot, dash, underscore).`);
  }
  const name = value.trim();
  if (allowedExts && !allowedExts.has(path.extname(name).toLowerCase())) {
    throw new HttpError(400, `${label} must be one of: ${[...allowedExts].join(', ')}.`);
  }
  if (!fs.existsSync(path.join(dir, name))) {
    throw new HttpError(400, `There is no file named "${name}" in the ${path.relative(ROOT, dir).replace(/\\/g, '/')} folder.`);
  }
  return name;
}

// Turns a request body into column values. Keys absent from the body keep `current`.
function validateGame(body, current) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a game object.');
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const pick = (key, fallback) => (has(key) ? body[key] : fallback);

  const name = cleanText(pick('name', current?.name), LIMITS.name, 'Name');
  if (!name) throw new HttpError(400, 'Name is required.');

  const description = cleanText(pick('description', current?.description), LIMITS.description, 'Description');
  const tags = cleanTags(pick('tags', current?.tags));

  const kind = pick('kind', current?.kind ?? 'web');
  if (kind !== 'web' && kind !== 'install') throw new HttpError(400, 'Type must be "web" or "install".');

  const href = cleanHref(pick('href', current?.href));
  if (kind === 'web' && !href) throw new HttpError(400, 'A web game needs a link.');

  const thumbnail = has('thumbnail')
    ? cleanFileReference(body.thumbnail, THUMB_DIR, 'Thumbnail', THUMB_EXTS)
    : (current?.thumbnail ?? null);
  const pkg = has('package')
    ? cleanFileReference(body.package, PACKAGE_DIR, 'Package')
    : (current?.package ?? null);

  return { name, description, tags, kind, href: href || null, thumbnail, package: pkg };
}

function slugify(name) {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'game';
}

// ---------------------------------------------------------------- sessions

const sessions = new Map();

function parseCookies(header) {
  const cookies = {};
  for (const part of (header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expires < now) sessions.delete(token);
}, 60 * 60 * 1000).unref();

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}

async function verifyLogin(db, username, password) {
  const admin = db.prepare('SELECT username, salt, hash FROM admin WHERE id = 1').get();
  if (!admin) return null;
  const hash = await scrypt(password, Buffer.from(admin.salt, 'hex'), 64);
  const passwordOk = crypto.timingSafeEqual(hash, Buffer.from(admin.hash, 'hex'));
  const usernameOk = crypto.timingSafeEqual(sha256(username), sha256(admin.username));
  return passwordOk && usernameOk ? admin.username : null;
}

// ---------------------------------------------------------------- http helpers

function baseHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, baseHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  }));
  res.end(body);
}

function sendError(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, status, { error: message });
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Expected a JSON request body.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

function requireSession(req) {
  const session = getSession(req);
  if (!session) throw new HttpError(401, 'Sign in to make changes.');
  return session;
}

// Blocks cross-site writes even if a browser ignores SameSite.
function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Bad origin.');
  }
  if (host !== req.headers.host) throw new HttpError(403, 'Cross-site requests are not allowed.');
}

async function serveFile(req, res, filePath, extraHeaders = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw new HttpError(404, 'Not found.');
  }
  if (!stat.isFile()) throw new HttpError(404, 'Not found.');

  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = baseHeaders({
    ETag: etag,
    'Cache-Control': 'no-cache',
    ...extraHeaders,
  });
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    ...headers,
    'Content-Length': stat.size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(filePath), res).catch(() => {});
}

function resolveInside(dir, relative) {
  const resolved = path.resolve(dir, '.' + path.posix.normalize('/' + relative));
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}

// ---------------------------------------------------------------- uploads

async function receiveUpload(req, dir, filename, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
  const tmp = path.join(dir, `.upload-${crypto.randomBytes(8).toString('hex')}`);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(new HttpError(413, `File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(tmp));
    if (size === 0) throw new HttpError(400, 'The uploaded file is empty.');
    await fsp.rename(tmp, path.join(dir, filename));
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

async function removeIfUnreferenced(db, column, dir, filename) {
  if (!filename) return;
  const stillUsed = db.prepare(`SELECT 1 FROM games WHERE ${column} = ? LIMIT 1`).get(filename);
  if (stillUsed) return;
  await fsp.rm(path.join(dir, filename), { force: true }).catch((err) => {
    console.warn(`Could not remove ${filename}: ${err.message}`);
  });
}

// ---------------------------------------------------------------- routes

function createApp(db) {
  const q = {
    title: db.prepare("SELECT value FROM settings WHERE key = 'title'"),
    games: db.prepare('SELECT * FROM games ORDER BY position, name'),
    game: db.prepare('SELECT * FROM games WHERE id = ?'),
    idExists: db.prepare('SELECT 1 FROM games WHERE id = ?'),
    maxPosition: db.prepare('SELECT COALESCE(MAX(position), 0) AS max FROM games'),
    insert: db.prepare(`
      INSERT INTO games (id, name, description, thumbnail, tags, kind, href, package, position, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare(`
      UPDATE games SET name = ?, description = ?, thumbnail = ?, tags = ?, kind = ?, href = ?, package = ?, updated_at = ?
      WHERE id = ?
    `),
    remove: db.prepare('DELETE FROM games WHERE id = ?'),
  };

  function findGame(id) {
    const row = q.game.get(id);
    if (!row) throw new HttpError(404, 'That game no longer exists.');
    return row;
  }

  function uniqueId(name) {
    const base = slugify(name);
    let id = base;
    for (let n = 2; q.idExists.get(id); n++) id = `${base}-${n}`;
    return id;
  }

  async function listGames(req, res) {
    sendJson(res, 200, {
      title: q.title.get()?.value || 'The Rack',
      games: q.games.all().map(rowToGame),
    });
  }

  async function session(req, res) {
    const s = getSession(req);
    sendJson(res, 200, s ? { signedIn: true, username: s.username } : { signedIn: false });
  }

  async function login(req, res) {
    const body = await readJson(req);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const who = username && password ? await verifyLogin(db, username, password) : null;
    if (!who) {
      await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
      throw new HttpError(401, 'Wrong username or password.');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { username: who, expires: Date.now() + SESSION_TTL_MS });
    sendJson(res, 200, { signedIn: true, username: who }, {
      'Set-Cookie': sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)),
    });
  }

  async function logout(req, res) {
    const s = getSession(req);
    if (s) sessions.delete(s.token);
    sendJson(res, 200, { signedIn: false }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  async function createGame(req, res) {
    const game = validateGame(await readJson(req), null);
    const id = transaction(db, () => {
      const newId = uniqueId(game.name);
      q.insert.run(newId, game.name, game.description, game.thumbnail, JSON.stringify(game.tags),
        game.kind, game.href, game.package, q.maxPosition.get().max + 1, Date.now());
      return newId;
    });
    sendJson(res, 201, rowToGame(q.game.get(id)));
  }

  async function updateGame(req, res, id) {
    const body = await readJson(req);
    const row = transaction(db, () => {
      const current = rowToGame(findGame(id));
      const game = validateGame(body, current);
      q.update.run(game.name, game.description, game.thumbnail, JSON.stringify(game.tags),
        game.kind, game.href, game.package, Date.now(), id);
      return q.game.get(id);
    });
    sendJson(res, 200, rowToGame(row));
  }

  async function deleteGame(req, res, id) {
    const row = transaction(db, () => {
      const current = findGame(id);
      q.remove.run(id);
      return current;
    });
    await removeIfUnreferenced(db, 'thumbnail', THUMB_DIR, row.thumbnail);
    await removeIfUnreferenced(db, 'package', PACKAGE_DIR, row.package);
    sendJson(res, 200, { deleted: id });
  }

  async function uploadFile(req, res, id, field, searchParams) {
    if (!/^application\/octet-stream\b/i.test(req.headers['content-type'] || '')) {
      throw new HttpError(415, 'Upload the file as application/octet-stream.');
    }
    const isThumb = field === 'thumbnail';
    const dir = isThumb ? THUMB_DIR : PACKAGE_DIR;
    const filename = sanitizeFilename(searchParams.get('filename'));
    if (!filename) throw new HttpError(400, 'That file name cannot be used. Rename the file and try again.');
    if (isThumb && !THUMB_EXTS.has(path.extname(filename).toLowerCase())) {
      throw new HttpError(400, `Thumbnails must be one of: ${[...THUMB_EXTS].join(', ')}.`);
    }

    const before = findGame(id);
    const owner = db.prepare(`SELECT name FROM games WHERE ${field} = ? AND id <> ? LIMIT 1`).get(filename, id);
    if (owner) {
      throw new HttpError(409, `"${filename}" already belongs to ${owner.name}. Rename the file and upload again.`);
    }

    await receiveUpload(req, dir, filename, isThumb ? MAX_THUMB_BYTES : MAX_PACKAGE_BYTES);

    const row = transaction(db, () => {
      findGame(id);
      db.prepare(`UPDATE games SET ${field} = ?, updated_at = ? WHERE id = ?`).run(filename, Date.now(), id);
      return q.game.get(id);
    });
    if (before[field] && before[field] !== filename) {
      await removeIfUnreferenced(db, field, dir, before[field]);
    }
    sendJson(res, 200, rowToGame(row));
  }

  async function servePackage(req, res, name) {
    if (!isSafeBasename(name)) throw new HttpError(404, 'Not found.');
    await serveFile(req, res, path.join(PACKAGE_DIR, name), {
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Type': 'application/octet-stream',
    });
  }

  async function serveThumbnail(req, res, name) {
    if (!isSafeBasename(name) || !THUMB_EXTS.has(path.extname(name).toLowerCase())) {
      throw new HttpError(404, 'Not found.');
    }
    await serveFile(req, res, path.join(THUMB_DIR, name), { 'Content-Security-Policy': THUMB_CSP });
  }

  async function serveStatic(req, res, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (relative.split('/').some((part) => part.startsWith('.'))) throw new HttpError(404, 'Not found.');
    const filePath = resolveInside(PUBLIC_DIR, relative);
    if (!filePath) throw new HttpError(404, 'Not found.');
    const extra = path.extname(filePath) === '.html' ? { 'Content-Security-Policy': PAGE_CSP } : {};
    await serveFile(req, res, filePath, extra);
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'https://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Bad path.');
    }
    const method = req.method;
    const read = method === 'GET' || method === 'HEAD';

    if (pathname === '/api/games' && read) return listGames(req, res);
    if (pathname === '/api/session' && read) return session(req, res);

    if (pathname.startsWith('/api/')) {
      if (read) throw new HttpError(404, 'Not found.');
      requireSameOrigin(req);
      if (pathname === '/api/login' && method === 'POST') return login(req, res);
      if (pathname === '/api/logout' && method === 'POST') return logout(req, res);

      requireSession(req);
      if (pathname === '/api/games' && method === 'POST') return createGame(req, res);
      const match = /^\/api\/games\/([^/]+)(?:\/(thumbnail|package))?$/.exec(pathname);
      if (match) {
        const [, id, field] = match;
        if (field && method === 'PUT') return uploadFile(req, res, id, field, url.searchParams);
        if (!field && method === 'PUT') return updateGame(req, res, id);
        if (!field && method === 'DELETE') return deleteGame(req, res, id);
      }
      throw new HttpError(405, 'Method not allowed.');
    }

    if (!read) throw new HttpError(405, 'Method not allowed.');
    if (pathname.startsWith('/packages/')) return servePackage(req, res, pathname.slice('/packages/'.length));
    if (pathname.startsWith('/thumbnails/')) return serveThumbnail(req, res, pathname.slice('/thumbnails/'.length));
    return serveStatic(req, res, pathname);
  };
}

// ---------------------------------------------------------------- tls

function loadTlsOptions() {
  const certPem = path.join(CERT_DIR, 'cert.pem');
  const keyPem = path.join(CERT_DIR, 'key.pem');
  if (fs.existsSync(certPem) && fs.existsSync(keyPem)) {
    return { options: { cert: fs.readFileSync(certPem), key: fs.readFileSync(keyPem) }, source: 'certs/cert.pem' };
  }

  const pfxPath = path.join(CERT_DIR, 'localhost.pfx');
  const passPath = path.join(CERT_DIR, 'localhost.pfx.pass');
  if (!fs.existsSync(pfxPath) || !fs.existsSync(passPath)) {
    generateSelfSigned(pfxPath, passPath);
  }
  return {
    options: { pfx: fs.readFileSync(pfxPath), passphrase: fs.readFileSync(passPath, 'utf8').trim() },
    source: 'certs/localhost.pfx (self-signed)',
  };
}

function generateSelfSigned(pfxPath, passPath) {
  if (process.platform !== 'win32') {
    throw new Error('No certificate found. Put cert.pem and key.pem in the certs folder (see README.md).');
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const passphrase = crypto.randomBytes(24).toString('base64url');
  const script = `
    $ErrorActionPreference = 'Stop'
    $cert = New-SelfSignedCertificate -Subject 'CN=localhost' \`
      -TextExtension @('2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1&IPAddress=::1') \`
      -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyExportPolicy Exportable \`
      -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 \`
      -NotAfter (Get-Date).AddYears(2) -FriendlyName 'Demoscene game shelf (local)'
    try {
      $pw = ConvertTo-SecureString -String $env:SHELF_PFX_PASS -Force -AsPlainText
      Export-PfxCertificate -Cert $cert -FilePath $env:SHELF_PFX_PATH -Password $pw -CryptoAlgorithmOption AES256_SHA256 | Out-Null
    } finally {
      Remove-Item -Path ('Cert:\\CurrentUser\\My\\' + $cert.Thumbprint) -DeleteKey
    }
  `;
  console.log('No certificate found. Generating a self-signed certificate for localhost...');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, SHELF_PFX_PASS: passphrase, SHELF_PFX_PATH: pfxPath },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  fs.writeFileSync(passPath, passphrase, { mode: 0o600 });
}

// ---------------------------------------------------------------- start

async function main() {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  fs.mkdirSync(PACKAGE_DIR, { recursive: true });

  const db = openDatabase();
  await ensureAdmin(db);
  const handle = createApp(db);
  const tls = loadTlsOptions();

  const server = https.createServer(tls.options, (req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.message);
      } else {
        console.error(err);
        sendError(res, 500, 'Something went wrong on the server.');
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`Game shelf running at https://localhost:${PORT}  (certificate: ${tls.source})`);
  });

  const shutdown = () => {
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
