/**
 * server/gcash-api.js
 *
 * Exposes two things to the payment screen:
 *   GET  /api/gcash/status?ref=FP-xxx   — one-shot poll
 *   GET  /api/gcash/stream?ref=FP-xxx   — SSE push (instant unlock on webhook hit)
 *
 * The webhook in index.js calls paymentEventBus.emit('paid', referenceId)
 * which immediately pushes 'PAID' to any connected SSE client watching that ref.
 */
const express  = require('express');
const EventEmitter = require('events');
const { checkPaymentStatus } = require('./gcash');

const router = express.Router();

/* ── shared event bus (imported by index.js too) ── */
const paymentEventBus = new EventEmitter();
paymentEventBus.setMaxListeners(50); // one per active booth screen

/* ─────────────────────────────────────────
   GET /api/gcash/status?ref=FP-001-1234
   Returns: { status: 'PENDING'|'PAID'|'FAILED'|'EXPIRED' }
───────────────────────────────────────── */
router.get('/status', async (req, res) => {
  const { ref } = req.query;
  if (!ref) return res.status(400).json({ error: 'Missing ref' });
  try {
    const result = await checkPaymentStatus(ref);
    res.json({ ok: true, status: result.status });
  } catch (e) {
    res.status(500).json({ ok: false, status: 'ERROR', message: e.message });
  }
});

/* ─────────────────────────────────────────
   GET /api/gcash/stream?ref=FP-001-1234
   SSE stream — sends 'PAID' the instant webhook fires.
   Screen connects once; server pushes within milliseconds of real payment.
   Falls back gracefully if connection drops (screen re-polls /status).
───────────────────────────────────────── */
router.get('/stream', async (req, res) => {
  const { ref } = req.query;
  if (!ref) return res.status(400).json({ error: 'Missing ref' });

  /* SSE headers */
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  /* helper: send one SSE event */
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  /* check if already paid (screen reconnected after brief drop) */
  try {
    const current = await checkPaymentStatus(ref);
    if (current.status === 'PAID') {
      send('payment', { status: 'PAID', ref });
      return res.end();
    }
  } catch (_) {}

  /* send a heartbeat every 20s so proxies don't drop idle connections */
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 20000);

  /* listen for webhook-triggered payment */
  const onPaid = (paidRef) => {
    if (paidRef === ref) {
      send('payment', { status: 'PAID', ref });
      cleanup();
      res.end();
    }
  };

  const onFailed = (paidRef) => {
    if (paidRef === ref) {
      send('payment', { status: 'FAILED', ref });
      cleanup();
      res.end();
    }
  };

  const cleanup = () => {
    clearInterval(heartbeat);
    paymentEventBus.off('paid',   onPaid);
    paymentEventBus.off('failed', onFailed);
  };

  paymentEventBus.on('paid',   onPaid);
  paymentEventBus.on('failed', onFailed);

  /* clean up when client disconnects */
  req.on('close', cleanup);
});

module.exports = { router, paymentEventBus };
