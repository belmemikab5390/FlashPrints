/**
 * server/sessions.js
 * Session lifecycle management for Flash & Prints.
 *
 * A "session" is one complete customer visit:
 *   package selection → payment → photos → strip → receipt
 *
 * Session ID format:  FP-{boothId}-{YYYYMMDD}-{HHMMSS}-{4randHex}
 * Example:            FP-001-20250323-143022-A4B7
 *
 * Folder structure:
 *   captures/
 *     sessions/
 *       FP-001-20250323-143022-A4B7/
 *         session.json          ← manifest (written on finalise)
 *         photo_1.jpg
 *         photo_2.jpg
 *         photo_3.jpg
 *         photo_4.jpg
 *         strip.jpg             ← rendered strip (copied here by strip-renderer)
 *
 * API (mounted at /api/sessions in index.js):
 *   POST /api/sessions/create         → { ok, session }
 *   POST /api/sessions/:id/finalise   → { ok }
 *   GET  /api/sessions                → { ok, sessions[] }
 *   GET  /api/sessions/:id            → { ok, session }
 *   DELETE /api/sessions/clean        → { ok, removed }
 */
const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const fsp    = fs.promises;
require('dotenv').config();

const SESSIONS_DIR = process.env.SESSIONS_DIR
  || path.join(__dirname, '../captures/sessions');

const SESSION_MAX_AGE_DAYS = parseInt(process.env.SESSION_MAX_AGE_DAYS) || 30;

/* ensure base dir exists */
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

/* ── ID generation ── */
function generateSessionId(boothId = '001') {
  const now     = new Date();
  const date    = now.toISOString().slice(0, 10).replace(/-/g, '');   /* YYYYMMDD */
  const time    = now.toTimeString().slice(0, 8).replace(/:/g, '');   /* HHMMSS   */
  const rand    = Math.floor(Math.random() * 0xFFFF)
                    .toString(16).toUpperCase().padStart(4, '0');
  return `FP-${boothId}-${date}-${time}-${rand}`;
}

/* ── OR number generation ── */
function generateOrNumber(boothId = '001') {
  const d   = new Date();
  const yy  = String(d.getFullYear()).slice(-2);
  const mm  = String(d.getMonth() + 1).padStart(2, '0');
  const dd  = String(d.getDate()).padStart(2, '0');
  const seq = String(Math.floor(Math.random() * 9000) + 1000);
  return `OR-${boothId}-${yy}${mm}${dd}-${seq}`;
}

/* ── create session ── */
function createSession({ boothId = '001', boothLocation = '', packageName = '', filter = 'original', amount = 0, refId = '' } = {}) {
  const id        = generateSessionId(boothId);
  const orNumber  = generateOrNumber(boothId);
  const folder    = path.join(SESSIONS_DIR, id);
  const createdAt = new Date().toISOString();

  fs.mkdirSync(folder, { recursive: true });

  const session = {
    id,
    boothId,
    boothLocation,
    packageName,
    filter,
    amount,
    refId,
    orNumber,
    createdAt,
    folder,
    status:     'active',   /* active | complete | abandoned */
    photoCount: 0,
    photos:     [],         /* filled as captures happen     */
    stripFile:  null,       /* set by finalise               */
  };

  /* write initial manifest */
  _writeManifest(folder, session);

  console.log(`[SESSION] Created: ${id} · booth=${boothId} · pkg=${packageName}`);
  return session;
}

/* ── record a captured photo into the session manifest ── */
function recordPhoto(sessionId, photoPath, photoIndex) {
  const folder = path.join(SESSIONS_DIR, sessionId);
  const mf     = path.join(folder, 'session.json');
  if (!fs.existsSync(mf)) return;

  try {
    const session     = JSON.parse(fs.readFileSync(mf, 'utf8'));
    session.photos[photoIndex - 1] = photoPath;
    session.photoCount = session.photos.filter(Boolean).length;
    _writeManifest(folder, session);
  } catch(e) {
    console.error('[SESSION] recordPhoto error:', e.message);
  }
}

/* ── finalise: mark complete, record strip path ── */
function finaliseSession(sessionId, { stripFile = null, status = 'complete' } = {}) {
  const folder = path.join(SESSIONS_DIR, sessionId);
  const mf     = path.join(folder, 'session.json');
  if (!fs.existsSync(mf)) return;

  try {
    const session       = JSON.parse(fs.readFileSync(mf, 'utf8'));
    session.status      = status;
    session.stripFile   = stripFile;
    session.finalisedAt = new Date().toISOString();
    _writeManifest(folder, session);
    console.log(`[SESSION] Finalised: ${sessionId} · status=${status}`);
  } catch(e) {
    console.error('[SESSION] finalise error:', e.message);
  }
}

/* ── get session by id ── */
function getSession(sessionId) {
  const mf = path.join(SESSIONS_DIR, sessionId, 'session.json');
  if (!fs.existsSync(mf)) return null;
  try { return JSON.parse(fs.readFileSync(mf, 'utf8')); }
  catch(_) { return null; }
}

/* ── list sessions (most recent first) ── */
function listSessions({ limit = 50, status } = {}) {
  try {
    const dirs = fs.readdirSync(SESSIONS_DIR)
      .filter(d => d.startsWith('FP-') && fs.statSync(path.join(SESSIONS_DIR, d)).isDirectory());

    const sessions = dirs
      .map(d => {
        try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, d, 'session.json'), 'utf8')); }
        catch(_) { return null; }
      })
      .filter(Boolean)
      .filter(s => !status || s.status === status)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);

    return sessions;
  } catch(_) { return []; }
}

/* ── clean old sessions ── */
function cleanOldSessions(maxAgeDays = SESSION_MAX_AGE_DAYS) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed  = 0;

  try {
    const dirs = fs.readdirSync(SESSIONS_DIR)
      .filter(d => d.startsWith('FP-'));

    for (const d of dirs) {
      const folder = path.join(SESSIONS_DIR, d);
      try {
        const stat = fs.statSync(folder);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(folder, { recursive: true, force: true });
          removed++;
          console.log(`[SESSION] Cleaned old session: ${d}`);
        }
      } catch(_) {}
    }
  } catch(_) {}

  return removed;
}

/* ── internal: write manifest ── */
function _writeManifest(folder, session) {
  /* don't serialise the folder path — it changes if app moves */
  const toWrite = { ...session };
  delete toWrite.folder;
  fs.writeFileSync(
    path.join(folder, 'session.json'),
    JSON.stringify(toWrite, null, 2),
    'utf8'
  );
}

/* ══════════════════════════════════════
   EXPRESS ROUTER
══════════════════════════════════════ */

/* POST /api/sessions/create */
router.post('/create', (req, res) => {
  try {
    const {
      boothId      = process.env.BOOTH_ID       || '001',
      boothLocation = process.env.BOOTH_LOCATION || '',
      packageName, filter, amount, refId,
    } = req.body;

    const session = createSession({ boothId, boothLocation, packageName, filter, amount, refId });
    res.json({ ok: true, session: { ...session, folder: undefined } });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* POST /api/sessions/:id/finalise */
router.post('/:id/finalise', (req, res) => {
  const { id } = req.params;
  const { stripFile, status } = req.body;
  finaliseSession(id, { stripFile, status });
  res.json({ ok: true });
});

/* GET /api/sessions */
router.get('/', (req, res) => {
  const { limit, status } = req.query;
  res.json({ ok: true, sessions: listSessions({ limit: parseInt(limit) || 50, status }) });
});

/* GET /api/sessions/:id */
router.get('/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
  res.json({ ok: true, session });
});

/* DELETE /api/sessions/clean */
router.delete('/clean', (req, res) => {
  const { maxAgeDays } = req.query;
  const removed = cleanOldSessions(parseInt(maxAgeDays) || SESSION_MAX_AGE_DAYS);
  res.json({ ok: true, removed });
});

module.exports = router;
module.exports.createSession    = createSession;
module.exports.recordPhoto      = recordPhoto;
module.exports.finaliseSession  = finaliseSession;
module.exports.getSession       = getSession;
module.exports.listSessions     = listSessions;
module.exports.cleanOldSessions = cleanOldSessions;
module.exports.SESSIONS_DIR     = SESSIONS_DIR;
