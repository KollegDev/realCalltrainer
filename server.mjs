// Minimal static server for the built app (dist/) plus a tiny stats API for
// votes and anonymous usage tracking. Zero dependencies.
//
// Path containment uses path.relative, never string prefixes — string
// comparison against root + '/' is always false on Windows (lesson from
// the main callTrainer repo).
//
// The stats file lives in DATA_DIR (default ./data). On Railway that
// directory is EPHEMERAL: counters reset on redeploy. That is acceptable —
// every vote and event is ALSO written as a structured log line, and Railway
// keeps the logs, so nothing is truly lost for market research.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'dist');
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(HERE, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/* ── stats ──────────────────────────────────────────────────────────────── */

const EVENTS = ['visit', 'call_started', 'call_ended'];
let stats = { up: 0, down: 0, events: {} };

async function loadStats() {
  try {
    const raw = JSON.parse(await fs.readFile(STATS_FILE, 'utf8'));
    if (typeof raw.up === 'number') stats = { up: raw.up, down: raw.down || 0, events: raw.events || {} };
  } catch {}
}
let saving = false;
async function saveStats() {
  if (saving) return; // low traffic; last write wins is fine
  saving = true;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STATS_FILE, JSON.stringify(stats));
  } catch (e) {
    console.error('[stats] save failed', e.message);
  } finally {
    saving = false;
  }
}

function readBody(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

// sid is a random id the client made up; keep only a short safe slug for logs.
const slug = (v) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'anon';

async function handleApi(req, res, pathname) {
  // Never cached: the service worker skips /api/ and we say no-store too.
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && pathname === '/api/votes') {
    return json(200, { up: stats.up, down: stats.down });
  }

  if (req.method === 'POST' && pathname === '/api/vote') {
    let body;
    try { body = await readBody(req); } catch { return json(400, { error: 'bad request' }); }
    const dir = body.dir === 'down' ? 'down' : body.dir === 'up' ? 'up' : null;
    if (!dir) return json(400, { error: 'dir must be up|down' });
    stats[dir]++;
    console.log(`[vote] ${dir} sid=${slug(body.sid)} up=${stats.up} down=${stats.down}`);
    saveStats();
    return json(200, { up: stats.up, down: stats.down });
  }

  if (req.method === 'POST' && pathname === '/api/track') {
    let body;
    try { body = await readBody(req); } catch { return json(400, { error: 'bad request' }); }
    const event = EVENTS.includes(body.event) ? body.event : null;
    if (!event) return json(400, { error: 'unknown event' });
    stats.events[event] = (stats.events[event] || 0) + 1;
    console.log(`[track] ${event} sid=${slug(body.sid)} lang=${slug(body.lang)}`);
    saveStats();
    return json(200, { ok: true });
  }

  return json(404, { error: 'not found' });
}

/* ── server ─────────────────────────────────────────────────────────────── */

http.createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

    if (urlPath.startsWith('/api/')) return await handleApi(req, res, urlPath);

    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.join(ROOT, urlPath);
    const rel = path.relative(ROOT, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': urlPath === '/index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, async () => {
  await loadStats();
  console.log(`realCalltrainer serving dist/ on :${PORT} (votes: up=${stats.up} down=${stats.down})`);
});
