/**
 * server/booth-api.js
 * Express router — all /api/booth/* endpoints.
 *
 * Endpoints:
 *   GET  /api/booth/status          → full state snapshot (polling fallback)
 *   GET  /api/booth/stream          → SSE stream of live state changes
 *   POST /api/booth/screen          → kiosk reports screen change
 *   POST /api/booth/session/start   → kiosk reports session started
 *   POST /api/booth/session/end     → kiosk reports session completed
 *   POST /api/booth/supplies        → kiosk reports supply levels
 *   POST /api/booth/error           → kiosk reports an error
 *   POST /api/booth/command         → dashboard sends command to kiosk
 *   GET  /api/booth/history         → last N session records
 */
const router  = require('express').Router();
const state   = require('./booth-state');

/* ── session history (in-memory ring buffer, 500 entries) ── */
const MAX_HISTORY = 500;
const history = [];
function pushHistory(record) {
  history.unshift({ ...record, at: Date.now() });
  if (history.length > MAX_HISTORY) history.pop();
}

/* pending commands queue — consumed by kiosk via polling */
const commandQueue = [];

/* ── SSE helpers ── */
const sseClients = new Set();

function sendSSE(client, data) {
  try { client.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) { sseClients.delete(client); }
}

function broadcastSSE(data) {
  sseClients.forEach(c => sendSSE(c, data));
}

/* broadcast every state change */
state.on('change', snapshot => broadcastSSE({ type: 'state', payload: snapshot }));

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/booth/status
   Full snapshot — for initial load or polling fallback
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/status', (req, res) => {
  res.json({ ok: true, booth: state.snapshot() });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/booth/stream
   Server-Sent Events — dashboard subscribes here for live updates.
   Each event is: data: { type, payload }\n\n
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); /* nginx: disable buffering */
  res.flushHeaders();

  /* send initial state immediately */
  sendSSE(res, { type: 'state', payload: state.snapshot() });

  /* heartbeat every 15s to keep connection alive */
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 15000);

  sseClients.add(res);
  console.log(`[SSE] Client connected — ${sseClients.size} active`);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
    console.log(`[SSE] Client disconnected — ${sseClients.size} active`);
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/booth/screen
   Body: { screen: 'camera' }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.post('/screen', (req, res) => {
  const { screen } = req.body;
  if (!screen) return res.status(400).json({ error: 'Missing screen' });
  state.setScreen(screen);
  res.json({ ok: true, status: state.state.status });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/booth/session/start
   Body: { package, filter, amount }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.post('/session/start', (req, res) => {
  const { package: pkg, filter, amount } = req.body;
  state.startSession({ package: pkg, filter, amount });
  res.json({ ok: true, sessionId: state.state.session?.id });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/booth/session/end
   Body: { amount, package, filter, success: true/false }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.post('/session/end', (req, res) => {
  const { amount, package: pkg, filter, success = true } = req.body;
  if (success) {
    state.completeSession(amount);
    pushHistory({ package: pkg, filter, amount, status: 'completed', boothId: state.state.boothId });
  }
  res.json({ ok: true });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/booth/supplies
   Body: { inkPercent, paperSheets }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.post('/supplies', (req, res) => {
  const { inkPercent, paperSheets } = req.body;
  state.updateSupplies({ inkPercent, paperSheets });
  res.json({ ok: true, supplies: state.state.supplies });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/booth/error
   Body: { code, message }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.post('/error', (req, res) => {
  const { code = 'UNKNOWN', message = 'Unknown error' } = req.body;
  state.addError(code, message);
  res.json({ ok: true });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/booth/command
   Dashboard → booth commands.
   Body: { command: 'reboot' | 'unlock' | 'maintenance' | 'clearErrors' }
   Booth polls GET /api/booth/commands to consume them.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.post('/command', (req, res) => {
  const { command, payload = {} } = req.body;
  const VALID = ['reboot', 'unlock', 'maintenance', 'clearErrors', 'ping', 'setMessage'];
  if (!VALID.includes(command)) return res.status(400).json({ error: 'Unknown command' });

  const cmd = { command, payload, id: `CMD-${Date.now()}`, sentAt: Date.now() };
  commandQueue.push(cmd);

  /* also broadcast via SSE so dashboard gets confirmation */
  broadcastSSE({ type: 'command_sent', payload: cmd });

  console.log(`[CMD] Queued: ${command}`);
  res.json({ ok: true, commandId: cmd.id });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/booth/commands
   Kiosk polls this to consume pending commands (max 1 per poll)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/commands', (req, res) => {
  const cmd = commandQueue.shift() || null;
  if (cmd) console.log(`[CMD] Consumed by kiosk: ${cmd.command}`);
  res.json({ ok: true, command: cmd });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/booth/history
   Query: ?limit=50
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  res.json({ ok: true, sessions: history.slice(0, limit), total: history.length });
});

/* ── startup ── */
state.scheduleDailyReset();
console.log(`[BOOTH API] Ready — booth ${state.state.boothId} @ ${state.state.location}`);

module.exports = router;
