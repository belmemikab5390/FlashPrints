/**
 * server.js — Flash & Prints local backend
 *
 * Runs as a child process alongside the Electron app.
 * Handles:
 *  - GCash QR generation
 *  - GCash payment webhook (POST from GCash servers)
 *  - Payment status polling endpoint
 *  - Session management
 *  - Dashboard data API
 *  - Remote reboot endpoint (owner dashboard)
 */

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const axios      = require('axios');
const QRCode     = require('qrcode');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');

const app  = express();
const PORT = 3001;
const BOOTH_ID = process.env.BOOTH_ID || '001';

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ── In-memory session store (use Redis in prod for multi-booth) ────
const sessions   = new Map(); // ref → { status, amount, pkg, createdAt }
const txHistory  = [];        // recent transactions

// ── GCash credentials (set in .env) ───────────────────────────────
const GCASH_CONFIG = {
  merchantId:    process.env.GCASH_MERCHANT_ID    || 'YOUR_MERCHANT_ID',
  clientId:      process.env.GCASH_CLIENT_ID      || 'YOUR_CLIENT_ID',
  clientSecret:  process.env.GCASH_CLIENT_SECRET  || 'YOUR_CLIENT_SECRET',
  apiBase:       process.env.GCASH_API_BASE        || 'https://api.gcash.com.ph',
  webhookSecret: process.env.GCASH_WEBHOOK_SECRET  || 'YOUR_WEBHOOK_SECRET',
};

// ─────────────────────────────────────────────────────────────────
// ROUTE: Generate GCash QR for a session
// POST /api/gcash/create
// Body: { amount, package, filter, boothId }
// ─────────────────────────────────────────────────────────────────
app.post('/api/gcash/create', async (req, res) => {
  try {
    const { amount, pkg, filter } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid amount' });
    }

    // Generate unique reference
    const ref = `FP-${BOOTH_ID}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const orNum = `OR-${Date.now().toString().slice(-8)}`;

    // Store pending session
    sessions.set(ref, {
      ref, orNum,
      status: 'PENDING',
      amount: parseFloat(amount),
      pkg, filter,
      boothId: BOOTH_ID,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min
    });

    // ── PRODUCTION: Call real GCash QR PH API ──────────────────
    /*
    const token = await getGCashToken();
    const gcashRes = await axios.post(
      `${GCASH_CONFIG.apiBase}/v1/payments/qr`,
      {
        merchantId: GCASH_CONFIG.merchantId,
        amount: { value: amount * 100, currency: 'PHP' },
        referenceNumber: ref,
        description: `Flash & Prints - ${pkg}`,
        expiryDate: sessions.get(ref).expiresAt,
        notifyUrl: `${process.env.PUBLIC_URL}/api/gcash/webhook`,
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const qrString = gcashRes.data.qrCodeData;
    */

    // ── DEMO: Generate a placeholder QR string ─────────────────
    const qrString = `00020101021229370016ph.ppmi.merchant${GCASH_CONFIG.merchantId}5204000053036085406${(amount * 100).toFixed(0).padStart(12,'0')}5802PH5920Flash and Prints PH6013Quezon City62${ref.length.toString().padStart(2,'0')}${ref}6304`;

    // Generate QR as base64 image
    const qrDataURL = await QRCode.toDataURL(qrString, {
      width: 400,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });

    return res.json({ ok: true, ref, orNum, qrDataURL, qrString, expiresIn: 600 });

  } catch (err) {
    console.error('[GCash Create]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE: Poll payment status
// GET /api/gcash/status/:ref
// ─────────────────────────────────────────────────────────────────
app.get('/api/gcash/status/:ref', async (req, res) => {
  const session = sessions.get(req.params.ref);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

  // Check expiry
  if (new Date() > new Date(session.expiresAt) && session.status === 'PENDING') {
    session.status = 'EXPIRED';
    sessions.set(req.params.ref, session);
  }

  return res.json({ ok: true, status: session.status, session });
});

// ─────────────────────────────────────────────────────────────────
// ROUTE: GCash webhook — called by GCash servers on payment
// POST /api/gcash/webhook
// ─────────────────────────────────────────────────────────────────
app.post('/api/gcash/webhook', (req, res) => {
  try {
    // ── Verify webhook signature ───────────────────────────────
    const signature  = req.headers['x-gcash-signature'];
    const bodyStr    = JSON.stringify(req.body);
    const expected   = crypto
      .createHmac('sha256', GCASH_CONFIG.webhookSecret)
      .update(bodyStr)
      .digest('hex');

    if (signature !== expected) {
      console.warn('[Webhook] Invalid signature');
      return res.status(401).json({ ok: false });
    }

    const { referenceNumber, status, amount } = req.body;
    const session = sessions.get(referenceNumber);

    if (!session) {
      return res.status(404).json({ ok: false, error: 'Unknown reference' });
    }

    if (status === 'SUCCESS' || status === 'PAID') {
      session.status    = 'PAID';
      session.paidAt    = new Date().toISOString();
      session.gcashTxId = req.body.transactionId;
      sessions.set(referenceNumber, session);

      // Add to transaction history
      txHistory.unshift({ ...session, type: 'completed' });
      if (txHistory.length > 200) txHistory.pop();

      console.log(`[Payment] PAID — ${referenceNumber} — ₱${amount}`);

      // Notify Electron renderer via polling (or use WebSocket in prod)
    } else if (status === 'FAILED' || status === 'CANCELLED') {
      session.status = 'FAILED';
      sessions.set(referenceNumber, session);
    }

    return res.json({ ok: true });

  } catch (err) {
    console.error('[Webhook]', err);
    return res.status(500).json({ ok: false });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE: Dashboard data
// GET /api/dashboard
// ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  const today = new Date().toDateString();

  const todayTx   = txHistory.filter(t => new Date(t.paidAt).toDateString() === today);
  const todayRev  = todayTx.reduce((sum, t) => sum + (t.amount || 0), 0);
  const totalSess = txHistory.length;

  return res.json({
    ok: true,
    boothId:        BOOTH_ID,
    todayRevenue:   todayRev,
    todaySessions:  todayTx.length,
    totalSessions:  totalSess,
    recentTx:       txHistory.slice(0, 20),
    uptime:         process.uptime(),
  });
});

// ─────────────────────────────────────────────────────────────────
// ROUTE: Remote reboot (from owner dashboard)
// POST /api/kiosk/reboot
// ─────────────────────────────────────────────────────────────────
app.post('/api/kiosk/reboot', (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true, message: 'Rebooting kiosk...' });
  setTimeout(() => process.exit(0), 500); // Electron watchdog will restart
});

// ─────────────────────────────────────────────────────────────────
// ROUTE: Manual unlock (owner override)
// POST /api/kiosk/unlock
// ─────────────────────────────────────────────────────────────────
app.post('/api/kiosk/unlock', (req, res) => {
  const { adminKey, ref } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ ok: false });

  if (ref && sessions.has(ref)) {
    const session = sessions.get(ref);
    session.status      = 'PAID';
    session.manualUnlock = true;
    sessions.set(ref, session);
    return res.json({ ok: true, message: `Session ${ref} unlocked` });
  }
  return res.status(404).json({ ok: false, error: 'Session not found' });
});

// ─────────────────────────────────────────────────────────────────
// Helper: Get GCash OAuth token
// ─────────────────────────────────────────────────────────────────
async function getGCashToken() {
  const credentials = Buffer.from(
    `${GCASH_CONFIG.clientId}:${GCASH_CONFIG.clientSecret}`
  ).toString('base64');

  const res = await axios.post(
    `${GCASH_CONFIG.apiBase}/v1/oauth/token`,
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    }
  );
  return res.data.access_token;
}

// ── Start server ──────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[Server] Flash & Prints backend running on port ${PORT} — Booth #${BOOTH_ID}`);
});

module.exports = app;
