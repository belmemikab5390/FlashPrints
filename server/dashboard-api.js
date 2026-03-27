/**
 * server/dashboard-api.js
 * Multi-booth aggregation API for the owner dashboard.
 *
 * In a single-booth setup: just proxies booth-api data.
 * In multi-booth setup: each booth has its own server running,
 * and the dashboard polls all of them.
 *
 * Endpoints:
 *   GET /api/dashboard/booths         → all booth snapshots
 *   GET /api/dashboard/stream         → SSE — aggregated live feed
 *   GET /api/dashboard/stats          → today's totals across all booths
 *   POST /api/dashboard/command/:id   → send command to specific booth
 */
const router = require('express').Router();
const state  = require('./booth-state');

/* ── booth registry — add more booths here ── */
/* In production each booth runs its own server.
   Set BOOTH_PEERS=http://10.0.0.2:3000,http://10.0.0.3:3000 in .env
   to aggregate multiple booths. */
function getBoothUrls() {
  const self  = `http://localhost:${process.env.SERVER_PORT || 3000}`;
  const peers = (process.env.BOOTH_PEERS || '').split(',').filter(Boolean);
  return [self, ...peers];
}

/* ── fetch snapshot from a booth URL ── */
async function fetchBoothSnapshot(url) {
  try {
    const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
    const res   = await Promise.race([
      fetch(`${url}/api/booth/status`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]);
    const data = await res.json();
    return { ...data.booth, online: true, url };
  } catch (e) {
    return {
      boothId:   url.split(':').pop() || '???',
      url,
      online:    false,
      status:    'offline',
      error:     e.message,
      timestamp: Date.now(),
    };
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/dashboard/booths
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/booths', async (req, res) => {
  const urls     = getBoothUrls();
  const snapshots = await Promise.all(urls.map(fetchBoothSnapshot));

  /* merge with this booth's local state (always accurate) */
  const selfSnap = state.snapshot();
  const merged   = snapshots.map(s =>
    s.boothId === selfSnap.boothId ? { ...s, ...selfSnap, online: true } : s
  );

  res.json({ ok: true, booths: merged, count: merged.length });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/dashboard/stream
   SSE — sends updates whenever this booth's state changes.
   For multi-booth: set up a separate aggregator service.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const dashClients = new Set();

router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  /* initial state burst */
  const snap = state.snapshot();
  res.write(`data: ${JSON.stringify({ type: 'booth_update', booth: snap })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch(e) { clearInterval(heartbeat); }
  }, 15000);

  dashClients.add(res);

  req.on('close', () => {
    dashClients.delete(res);
    clearInterval(heartbeat);
  });
});

/* push booth updates to dashboard SSE clients */
state.on('change', snapshot => {
  const msg = `data: ${JSON.stringify({ type: 'booth_update', booth: snapshot })}\n\n`;
  dashClients.forEach(c => { try { c.write(msg); } catch(e) { dashClients.delete(c); } });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/dashboard/stats
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/stats', async (req, res) => {
  const snap = state.snapshot();
  res.json({
    ok: true,
    today: {
      revenue:  snap.stats.todayRevenue,
      sessions: snap.stats.todaySessions,
    },
    total: {
      revenue:  snap.stats.totalRevenue,
      sessions: snap.stats.totalSessions,
    },
    supplies:  snap.supplies,
    lastSession: snap.stats.lastSessionAt,
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/dashboard/command/:boothId
   Body: { command, payload }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.post('/command/:boothId', async (req, res) => {
  const { boothId } = req.params;
  const { command, payload } = req.body;

  /* if targeting this booth — queue directly */
  if (boothId === state.state.boothId || boothId === 'all') {
    const boothApi = require('./booth-api');
    req.body = { command, payload };
    /* forward to booth command queue via internal fetch */
    try {
      const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
      await fetch(`http://localhost:${process.env.SERVER_PORT || 3000}/api/booth/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, payload }),
      });
    } catch(e) {}
  }

  res.json({ ok: true, targeted: boothId, command });
});

module.exports = router;
