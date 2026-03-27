/**
 * server/supply-api.js
 * Express router — all /api/supply/* endpoints.
 *
 *   GET  /api/supply/status          → full supply snapshot
 *   GET  /api/supply/stream          → SSE — live supply level changes
 *   GET  /api/supply/alerts          → active alerts only
 *   POST /api/supply/refill/paper    → owner confirms paper refill
 *   POST /api/supply/refill/ink      → owner confirms ink refill
 *   POST /api/supply/simulate        → dev: set arbitrary supply levels
 */
const router     = require('express').Router();
const printer    = require('./printer');
const boothState = require('./booth-state');

/* SSE clients subscribed to supply updates */
const supplyClients = new Set();

function broadcastSupply(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  supplyClients.forEach(c => { try { c.write(msg); } catch(e) { supplyClients.delete(c); } });
}

/* push to SSE whenever booth supply state changes */
boothState.on('change', snapshot => {
  broadcastSupply({ type: 'supply_update', supplies: snapshot.supplies, boothId: snapshot.boothId, alerts: snapshot.errors.filter(e => e.code.includes('_CRITICAL') || e.code.includes('LOW')) });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/supply/status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/status', async (req, res) => {
  try {
    const printerStatus = await printer.getStatus();
    const stateSupplies = boothState.state.supplies;
    res.json({
      ok: true,
      boothId:  boothState.state.boothId,
      location: boothState.state.location,
      printer:  printerStatus,
      state:    stateSupplies,
      alerts:   printerStatus.alerts || [],
      checkedAt: Date.now(),
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/supply/stream
   SSE — pushed on every supply change
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  /* send current state immediately */
  const snap = boothState.snapshot();
  res.write(`data: ${JSON.stringify({ type: 'supply_update', supplies: snap.supplies, boothId: snap.boothId })}\n\n`);

  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) { clearInterval(heartbeat); } }, 15000);
  supplyClients.add(res);

  req.on('close', () => { supplyClients.delete(res); clearInterval(heartbeat); });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/supply/alerts
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/alerts', async (req, res) => {
  const printerStatus = await printer.getStatus().catch(() => ({ alerts: [] }));
  const stateErrors   = boothState.state.errors.filter(e => e.code.includes('CRITICAL') || e.code.includes('LOW'));

  const allAlerts = [
    ...printerStatus.alerts || [],
    ...stateErrors.map(e => ({ type: 'error', supply: e.code.toLowerCase(), message: e.message, at: e.at })),
  ];

  res.json({
    ok:     true,
    alerts: allAlerts,
    count:  allAlerts.length,
    hasAlerts: allAlerts.length > 0,
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/supply/refill/paper
   Body: { sheets?: 200 }  — defaults to PAPER_START
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.post('/refill/paper', (req, res) => {
  const sheets = parseInt(req.body.sheets) || parseInt(process.env.PAPER_START) || 200;
  const result = printer.refillPaper(sheets);
  console.log(`[SUPPLY] Paper refilled: ${sheets} sheets`);
  res.json({ ok: true, ...result, message: `Paper refilled — ${sheets} sheets loaded` });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/supply/refill/ink
   Body: { percent?: 100 }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.post('/refill/ink', (req, res) => {
  const percent = parseInt(req.body.percent) || 100;
  const result  = printer.refillInk(percent);
  console.log(`[SUPPLY] Ink refilled: ${percent}%`);
  res.json({ ok: true, ...result, message: `Ink set to ${percent}%` });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/supply/simulate
   Dev only — set arbitrary levels to test alerts
   Body: { inkPercent: 15, paperSheets: 8 }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.post('/simulate', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'Not in production' });
  const { inkPercent, paperSheets } = req.body;
  boothState.updateSupplies({ inkPercent, paperSheets });
  if (paperSheets <= parseInt(process.env.SUPPLY_CRIT_PAPER || 10)) {
    boothState.addError('PAPER_CRITICAL', `Only ${paperSheets} sheets left — simulated`);
  }
  if (inkPercent <= parseInt(process.env.SUPPLY_CRIT_INK || 10)) {
    boothState.addError('INK_CRITICAL', `Ink at ${inkPercent}% — simulated`);
  }
  res.json({ ok: true, supplies: boothState.state.supplies });
});

module.exports = router;
