/**
 * server/camera.js
 * Live preview: digiCamControl MJPEG stream (http://127.0.0.1:5514/live)
 * Capture:      DSLR Remote Pro CLI via execFile
 */
const pathM = require('path');
const fs    = require('fs');
const { v4: uuidv4 } = require('uuid');

const DSLR_CLI          = process.env.DSLR_CLI_PATH   || 'C:\\Program Files\\Breeze Systems\\DSLR Remote Pro\\DSLRRemotePro.exe';
const CAPTURE_DIR       = process.env.CAPTURE_DIR     || pathM.join(__dirname, '../captures');
const PREVIEW_DIR       = process.env.PREVIEW_DIR     || pathM.join(__dirname, '../captures/preview');
const DIGICAM_URL       = process.env.DIGICAM_URL     || 'http://127.0.0.1:5513';
const DIGICAM_MJPEG     = process.env.DIGICAM_MJPEG   || 'http://127.0.0.1:5514/live';
const DIGICAM_LIVEVIEW  = `${DIGICAM_URL}/liveview.jpg`;
const DIGICAM_LV_START  = `${DIGICAM_URL}/?CMD=LiveViewWnd_Show`;

const PREVIEW_FPS      = parseInt(process.env.PREVIEW_FPS) || 15;
const PREVIEW_INTERVAL = Math.floor(1000 / PREVIEW_FPS);

for (const d of [CAPTURE_DIR, PREVIEW_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

let _previewTimer    = null;
let _previewActive   = false;
let _latestFrame     = null;
let _latestFrameTime = 0;
let _sseClients      = new Set();
let _simInterval     = null;
let _simFrameIndex   = 0;

/* ══════════════════════════════════════
   CAPTURE — uses digiCamControl HTTP API
   1. Set session folder to our captures dir
   2. Set filename template to photo_<index>
   3. Trigger capture via ?slc=capture
   4. Poll session.json to find the new filename
   5. Download the image file via /image/<name>
══════════════════════════════════════ */
async function capturePhoto({ sessionId = null, photoIndex = 1 } = {}) {
  let outDir, filename, outPath;

  if (sessionId) {
    const sessions = require('./sessions');
    outDir = pathM.join(sessions.SESSIONS_DIR, sessionId);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  } else {
    outDir = CAPTURE_DIR;
  }

  filename = `photo_${photoIndex}.jpg`;
  outPath  = pathM.join(outDir, filename);

  if (_isSimMode()) {
    console.log(`[CAMERA] Simulated capture → ${filename}`);
    const ph = pathM.join(__dirname, '../assets/placeholder-photo.jpg');
    if (fs.existsSync(ph)) fs.copyFileSync(ph, outPath);
    else fs.writeFileSync(outPath, await _tinyJpeg());
    if (sessionId) try { require('./sessions').recordPhoto(sessionId, outPath, photoIndex); } catch(_) {}
    return { ok: true, path: outPath, filename, simulated: true };
  }

  console.log(`[CAMERA] Triggering capture via digiCamControl → ${outPath}`);

  try {
    const http = require('http');

    /* Step 1: set session folder */
    await _httpGet(`${DIGICAM_URL}/?slc=set&param1=session.folder&param2=${encodeURIComponent(outDir)}`);

    /* Step 2: set filename template (no extension — digiCamControl adds it) */
    const baseName = `photo_${photoIndex}`;
    await _httpGet(`${DIGICAM_URL}/?slc=set&param1=session.filenametemplate&param2=${encodeURIComponent(baseName)}`);

    /* Step 3: get current session lastcaptured before trigger (to detect new file) */
    const beforeJson = await _httpGetText(`${DIGICAM_URL}/session.json`);
    const before     = JSON.parse(beforeJson);
    const beforeLast = before?.Files?.[before.Files.length - 1] || '';

    /* Step 4: trigger capture */
    await _httpGet(`${DIGICAM_URL}/?slc=capture`);

    /* Step 5: poll session.json until a new file appears (max 15s) */
    let capturedName = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const json = await _httpGetText(`${DIGICAM_URL}/session.json`);
        const sess = JSON.parse(json);
        const last = sess?.Files?.[sess.Files.length - 1];
        if (last && last !== beforeLast) { capturedName = last; break; }
      } catch(_) {}
    }

    if (!capturedName) throw new Error('Capture timed out — no new file detected in session.json');

    /* Step 6: download the image from digiCamControl */
    console.log(`[CAMERA] Downloading: ${capturedName}`);
    const imgBuf = await _httpGetBinary(`${DIGICAM_URL}/image/${encodeURIComponent(capturedName)}`);
    fs.writeFileSync(outPath, imgBuf);

    console.log(`[CAMERA] Captured → ${outPath} (${Math.round(imgBuf.length / 1024)}KB)`);
    if (sessionId) try { require('./sessions').recordPhoto(sessionId, outPath, photoIndex); } catch(_) {}
    return { ok: true, path: outPath, filename };

  } catch(e) {
    console.error('[CAMERA] Capture error:', e.message);
    throw e;
  }
}

/* ══════════════════════════════════════
   LIVE PREVIEW — START
══════════════════════════════════════ */
async function startPreview() {
  if (_previewActive) return { ok: true, already: true };
  _previewActive = true;
  console.log('[CAMERA] Starting live preview…');

  if (_isSimMode()) { _startSim(); return { ok: true, simulated: true }; }

  /* tell digiCamControl to open live view window */
  await _httpGet(DIGICAM_LV_START).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));

  /* try MJPEG stream first (port 5514) */
  console.log(`[CAMERA] Trying MJPEG: ${DIGICAM_MJPEG}`);
  const mjpegOk = await _startMjpegReader(DIGICAM_MJPEG);
  if (mjpegOk) { console.log('[CAMERA] MJPEG stream connected ✓'); return { ok: true }; }

  /* fall back to polling liveview.jpg (port 5513) */
  console.log(`[CAMERA] Trying liveview.jpg: ${DIGICAM_LIVEVIEW}`);
  const jpegOk = await _testUrl(DIGICAM_LIVEVIEW);
  if (jpegOk) { console.log('[CAMERA] liveview.jpg polling connected ✓'); _startJpegPoller(); return { ok: true }; }

  console.warn('[CAMERA] No live view — check digiCamControl is open with camera connected and Lv started');
  _startSim();
  return { ok: true, simulated: true };
}

/* ══════════════════════════════════════
   LIVE PREVIEW — STOP
══════════════════════════════════════ */
function stopPreview() {
  _previewActive = false;
  if (_previewTimer) { clearInterval(_previewTimer); _previewTimer = null; }
  if (_simInterval)  { clearInterval(_simInterval);  _simInterval  = null; }
  _sseClients.clear();
  _latestFrame = null;
  return { ok: true };
}

/* ══════════════════════════════════════
   MJPEG READER — reads continuous stream
   Extracts JPEGs by finding FF D8 ... FF D9 markers
══════════════════════════════════════ */
function _startMjpegReader(url) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) { res.destroy(); resolve(false); return; }
      console.log(`[CAMERA] MJPEG stream status: ${res.statusCode}, type: ${res.headers['content-type']}`);
      resolve(true);

      let buf = Buffer.alloc(0);
      const SOI = Buffer.from([0xFF, 0xD8]);
      const EOI = Buffer.from([0xFF, 0xD9]);

      res.on('data', (chunk) => {
        if (!_previewActive) { req.destroy(); return; }
        buf = Buffer.concat([buf, chunk]);

        while (true) {
          const s = _bufIndexOf(buf, SOI);
          if (s === -1) { buf = Buffer.alloc(0); break; }
          const e = _bufIndexOf(buf, EOI, s + 2);
          if (e === -1) {
            /* keep only from the SOI onward — trim leading garbage */
            if (s > 0) buf = buf.slice(s);
            break;
          }
          const frame = buf.slice(s, e + 2);
          buf = buf.slice(e + 2);
          if (frame.length > 1000) {
            _latestFrame = frame; _latestFrameTime = Date.now();
            _pushToClients(frame);
          }
        }

        if (buf.length > 4 * 1024 * 1024) buf = Buffer.alloc(0);
      });

      const reconnect = () => {
        if (!_previewActive) return;
        console.log('[CAMERA] MJPEG stream ended — reconnecting in 2s');
        setTimeout(() => { if (_previewActive) _startMjpegReader(url); }, 2000);
      };
      res.on('end',   reconnect);
      res.on('error', reconnect);
    });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function _bufIndexOf(buf, needle, from = 0) {
  for (let i = from; i <= buf.length - needle.length; i++) {
    if (buf[i] === needle[0] && buf[i + 1] === needle[1]) return i;
  }
  return -1;
}

/* ══════════════════════════════════════
   JPEG POLLER — polls liveview.jpg
══════════════════════════════════════ */
function _startJpegPoller() {
  if (_previewTimer) clearInterval(_previewTimer);
  const http   = require('http');
  const parsed = new URL(DIGICAM_LIVEVIEW);
  _previewTimer = setInterval(() => {
    if (!_previewActive) { clearInterval(_previewTimer); return; }
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port || 80,
      path: parsed.pathname, method: 'GET',
      timeout: 1500, insecureHTTPParser: true,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const b = Buffer.concat(chunks);
        if (b.length < 500) return;
        _latestFrame = b; _latestFrameTime = Date.now();
        _pushToClients(b);
      });
    });
    req.on('error', () => {}); req.on('timeout', () => req.destroy());
    req.end();
  }, PREVIEW_INTERVAL);
}

/* ══════════════════════════════════════
   SIMULATION
══════════════════════════════════════ */
function _startSim() {
  if (_simInterval) return;
  _buildSimFrames().then(frames => {
    if (!frames.length) return;
    _simInterval = setInterval(() => {
      if (!_previewActive) { clearInterval(_simInterval); _simInterval = null; return; }
      const f = frames[_simFrameIndex++ % frames.length];
      _latestFrame = f; _latestFrameTime = Date.now();
      _pushToClients(f);
    }, PREVIEW_INTERVAL);
  });
}

async function _buildSimFrames() {
  const frames = [];
  for (const n of ['placeholder-photo.jpg', 'test-strip.jpg']) {
    const fp = pathM.join(__dirname, '../assets', n);
    if (fs.existsSync(fp)) try { frames.push(fs.readFileSync(fp)); } catch(_) {}
  }
  if (!frames.length) { const t = await _tinyJpeg(); frames.push(t, t, t, t); }
  while (frames.length < 4) frames.push(frames[0]);
  return frames;
}

/* ══════════════════════════════════════
   SSE CLIENTS
══════════════════════════════════════ */
function addSseClient(res) {
  _sseClients.add(res);
  if (_latestFrame) _sendFrame(res, _latestFrame);
  return () => _sseClients.delete(res);
}

function _pushToClients(buf) {
  if (_sseClients.size === 0) return;
  const msg = `event: frame\ndata: ${JSON.stringify({ frame: buf.toString('base64'), ts: Date.now() })}\n\n`;
  const dead = [];
  _sseClients.forEach(c => { try { c.write(msg); } catch(_) { dead.push(c); } });
  dead.forEach(c => _sseClients.delete(c));
}

function _sendFrame(res, buf) {
  try { res.write(`event: frame\ndata: ${JSON.stringify({ frame: buf.toString('base64'), ts: Date.now() })}\n\n`); } catch(_) {}
}

/* ══════════════════════════════════════
   HELPERS
══════════════════════════════════════ */
function _isSimMode() { return process.env.CAMERA_SIMULATE === 'true' || process.platform !== 'win32'; }

async function _testUrl(url) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => { res.destroy(); resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function _httpGet(url) {
  const http = require('http');
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: 'GET', timeout: 3000,
      insecureHTTPParser: true,
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function _httpGetText(url) {
  /* insecureHTTPParser handles digiCamControl's duplicate Content-Length header */
  const http = require('http');
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: 'GET', timeout: 5000,
      insecureHTTPParser: true,  /* tolerate non-standard headers */
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function _httpGetBinary(url) {
  const http = require('http');
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: 'GET', timeout: 30000,
      insecureHTTPParser: true,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function _tinyJpeg() {
  return Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMCwsKCwsNCxAQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJgAB/9k=', 'base64');
}

function getLatestFrame()  { return _latestFrame; }
function isPreviewActive() { return _previewActive; }

/* ══════════════════════════════════════
   WEBCAM FRAME SAVE
   Accepts a base64 JPEG from the renderer (laptop webcam),
   saves it to the session directory, and returns the file path.
   This is the capture path when no DSLR is connected.
══════════════════════════════════════ */
async function captureWebcamFrame({ sessionId = null, photoIndex = 1, frameData = null } = {}) {
  let outDir, filename, outPath;

  if (sessionId) {
    const sessions = require('./sessions');
    outDir = pathM.join(sessions.SESSIONS_DIR, sessionId);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  } else {
    outDir = CAPTURE_DIR;
  }

  filename = `photo_${photoIndex}.jpg`;
  outPath  = pathM.join(outDir, filename);

  if (!frameData) {
    console.error('[CAMERA] captureWebcamFrame: no frame data received');
    return { ok: false, error: 'No frame data provided' };
  }

  try {
    /* strip data URI prefix if present: "data:image/jpeg;base64,..." */
    const base64 = frameData.replace(/^data:image\/\w+;base64,/, '');
    const buf    = Buffer.from(base64, 'base64');

    if (buf.length < 1000) {
      return { ok: false, error: 'Frame data too small — canvas may be blank' };
    }

    fs.writeFileSync(outPath, buf);
    console.log(`[CAMERA] Webcam frame saved → ${outPath} (${Math.round(buf.length / 1024)}KB)`);

    if (sessionId) {
      try { require('./sessions').recordPhoto(sessionId, outPath, photoIndex); } catch(_) {}
    }

    return { ok: true, path: outPath, filename, webcam: true };
  } catch (e) {
    console.error('[CAMERA] captureWebcamFrame error:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { capturePhoto, captureWebcamFrame, startPreview, stopPreview, addSseClient, getLatestFrame, isPreviewActive };