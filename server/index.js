/**
 * server/index.js — Flash & Prints Express server
 */
const express = require('express');
const cors    = require('cors');
const path    = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app  = express();
const PORT = parseInt(process.env.SERVER_PORT) || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* serve screen HTML files and shared JS from same origin as the API
   so EventSource / fetch from screens works without cross-origin issues */
app.use('/screens', require('express').static(require('path').join(__dirname, '../screens')));
app.use('/assets',  require('express').static(require('path').join(__dirname, '../assets')));

/* ── health check ── */
app.get('/health', (req, res) => {
  res.json({ ok: true, booth: process.env.BOOTH_ID, time: new Date().toISOString() });
});

/* ── booth status API ── */
app.use('/api/booth', require('./booth-api'));

/* ── strip renderer API ── */
app.use('/api/strip', require('./strip-api'));

/* ── supply tracker API ── */
app.use('/api/supply', require('./supply-api'));

/* ── transaction history API ── */
app.use('/api/transactions', require('./transaction-api'));

/* ── command center API ── */
app.use('/api/commands', require('./command-center'));

/* ── dashboard aggregation API ── */
app.use('/api/dashboard', require('./dashboard-api'));

/* ── Session management API ── */
app.use('/api/sessions', require('./sessions'));

/* ── GCash payment status + SSE push ── */
const { router: gcashRouter, paymentEventBus } = require('./gcash-api');
app.use('/api/gcash', gcashRouter);

/* ══════════════════════════════════════
   GCASH WEBHOOK
   Set in GCash portal: POST http://YOUR_IP:3000/gcash/webhook
   Expose via:          ngrok http 3000
══════════════════════════════════════ */
app.post('/gcash/webhook', (req, res) => {
  console.log('[WEBHOOK] GCash payload:', req.body);
  const { referenceId, status, amount, transactionDate } = req.body;
  if (!referenceId) return res.status(400).json({ error: 'Missing referenceId' });

  const paid = ['CAPTURED', 'PAID', 'SUCCESS'].includes(status);

  if (paid) {
    /* 1. update in-memory store */
    try { require('./gcash').confirmPayment(referenceId, { amount, transactionDate }); } catch(e){}

    /* 2. push to SSE stream — payment screen unlocks instantly */
    paymentEventBus.emit('paid', referenceId);

    /* 3. forward to Electron main process if running inside Electron */
    try {
      const { ipcMain } = require('electron');
      ipcMain.emit('gcash-payment-confirmed', null, { referenceId, amount, status: 'PAID' });
    } catch(e){}

    console.log(`[WEBHOOK] CONFIRMED: ${referenceId} · PHP ${amount}`);
  } else {
    paymentEventBus.emit('failed', referenceId);
  }

  res.json({ ok: true });
});

app.get('/gcash/callback', (req, res) => {
  res.send('<h2>Payment received. Return to the kiosk screen.</h2>');
});

/* ── sandbox: manually trigger payment (dev only) ── */
app.post('/gcash/simulate-payment', (req, res) => {
  if (process.env.GCASH_ENV === 'production') return res.status(403).json({ error: 'Production mode' });
  const { referenceId, fail } = req.body;
  if (!referenceId) return res.status(400).json({ error: 'Missing referenceId' });

  if (fail) {
    paymentEventBus.emit('failed', referenceId);
    return res.json({ ok: true, message: `Failure simulated for ${referenceId}` });
  }

  try { require('./gcash').confirmPayment(referenceId, { amount: 89, transactionDate: new Date().toISOString() }); } catch(e){}
  paymentEventBus.emit('paid', referenceId);
  try { require('electron').ipcMain.emit('gcash-payment-confirmed', null, { referenceId, status: 'PAID' }); } catch(e){}
  res.json({ ok: true, message: `Payment simulated for ${referenceId}` });
});

/* ── start supply polling ── */
try { require('./printer').startSupplyPolling(60000); } catch(e) {
  console.warn('[SERVER] Printer polling unavailable:', e.message);
}

app.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
  console.log(`[SERVER] GCash webhook:  POST http://localhost:${PORT}/gcash/webhook`);
  console.log(`[SERVER] Payment status: GET  http://localhost:${PORT}/api/gcash/status?ref=REF`);
  console.log(`[SERVER] Payment stream: GET  http://localhost:${PORT}/api/gcash/stream?ref=REF`);
  console.log(`[SERVER] Booth status:   GET  http://localhost:${PORT}/api/booth/status`);
  if (process.env.GCASH_ENV !== 'production') {
    console.log(`[SERVER] Simulate pay:   POST http://localhost:${PORT}/gcash/simulate-payment`);
  }
});

module.exports = app;

/* ── Camera preview SSE stream ── */
const camera = require('./camera');

/* GET /api/camera/preview/stream
   SSE — pushes JPEG frames as base64 data URIs at ~15fps.
   Screen connects on mount, disconnects on navigate-away. */
app.get('/api/camera/preview/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  /* heartbeat every 20s so proxies don't drop idle connections */
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch(_) {} }, 20000);

  const remove = camera.addSseClient(res);
  req.on('close', () => { clearInterval(hb); remove(); });
});

/* GET /api/camera/preview/frame
   Returns latest JPEG frame — proxies from digiCamControl if no cached frame */
app.get('/api/camera/preview/frame', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const frame = camera.getLatestFrame();
  if (frame) {
    res.setHeader('Content-Type', 'image/jpeg');
    return res.send(frame);
  }

  /* no cached frame yet — proxy directly from digiCamControl */
  const DIGICAM = process.env.DIGICAM_URL || 'http://127.0.0.1:5513';
  const http    = require('http');
  const parsed  = new URL(`${DIGICAM}/liveview.jpg`);
  const proxyReq = http.request({
    hostname: parsed.hostname, port: parsed.port || 80,
    path: '/liveview.jpg', method: 'GET',
    timeout: 2000, insecureHTTPParser: true,
  }, (proxyRes) => {
    const chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length > 500) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.send(buf);
      } else {
        res.status(503).send('No frame');
      }
    });
  });
  proxyReq.on('error', () => res.status(503).send('Camera offline'));
  proxyReq.on('timeout', () => { proxyReq.destroy(); res.status(503).send('Timeout'); });
  proxyReq.end();
});

/* POST /api/camera/preview/start — start liveview (also called from Electron IPC) */
app.post('/api/camera/preview/start', async (req, res) => {
  try { res.json(await camera.startPreview()); }
  catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* POST /api/camera/preview/stop */
app.post('/api/camera/preview/stop', (req, res) => {
  res.json(camera.stopPreview());
});

/* POST /api/camera/capture-webcam
   Accepts a base64 JPEG frame from the renderer webcam and saves it to disk.
   Body: { sessionId, photoIndex, frameData: "data:image/jpeg;base64,..." }
   Used when a laptop/USB webcam is the active camera (no DSLR connected). */
app.post('/api/camera/capture-webcam', async (req, res) => {
  const { sessionId = null, photoIndex = 1, frameData = null } = req.body;
  if (!frameData) return res.status(400).json({ ok: false, error: 'frameData is required' });
  try {
    const result = await camera.captureWebcamFrame({ sessionId, photoIndex, frameData });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});