/**
 * server/transaction-api.js
 * Express router — /api/transactions/*
 *
 *   GET  /api/transactions            → paginated list with filters
 *   GET  /api/transactions/stats      → summary stats + charts data
 *   GET  /api/transactions/export     → download CSV
 *   POST /api/transactions            → record new transaction (called by kiosk)
 *   GET  /api/transactions/:id        → single transaction detail
 */
const router = require('express').Router();
const store  = require('./transaction-store');
const state  = require('./booth-state');

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/transactions
   Query params:
     limit=50 offset=0 date=YYYY-MM-DD boothId=001 package=Classic+Strip search=FP-001
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/', (req, res) => {
  const { limit = 50, offset = 0, date, boothId, package: pkg, search } = req.query;
  const result = store.query({
    limit:       Math.min(parseInt(limit), 200),
    offset:      parseInt(offset),
    date,
    boothId,
    packageName: pkg,
    search,
  });
  res.json({ ok: true, ...result });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/transactions/stats
   Query: ?date=YYYY-MM-DD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/stats', (req, res) => {
  const { date } = req.query;
  const stats = store.getStats({ date });
  res.json({ ok: true, ...stats });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/transactions/export
   Downloads a CSV file.
   Query: ?date=YYYY-MM-DD &boothId=001 &package=Classic+Strip &filename=custom
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/export', (req, res) => {
  const { date, boothId, package: pkg, filename } = req.query;
  const csv = store.toCSV({ date, boothId, packageName: pkg });

  const today     = new Date().toISOString().split('T')[0];
  const safeName  = (filename || `flash-prints-transactions-${date || today}`).replace(/[^a-z0-9-_]/gi, '-');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
  res.send(csv);
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/transactions
   Called by kiosk after each completed session.
   Body: { packageName, photos, filter, amount, refId, orNumber }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.post('/', (req, res) => {
  const { packageName, photos, filter, amount, refId, orNumber } = req.body;
  if (!packageName || !amount) return res.status(400).json({ error: 'Missing packageName or amount' });

  const tx = store.addTransaction({
    boothId:  state.state.boothId,
    location: state.state.location,
    packageName, photos, filter, amount, refId, orNumber,
  });

  /* also update booth-state session stats */
  state.completeSession(parseFloat(amount));

  res.json({ ok: true, transaction: tx });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/transactions/:id
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/:id', (req, res) => {
  const { data } = store.query({ limit:1000 });
  const tx = data.find(t => t.id === req.params.id);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  res.json({ ok: true, transaction: tx });
});

module.exports = router;
