/**
 * server/strip-api.js
 * REST endpoints for strip rendering.
 *
 *   POST /api/strip/render     → render strip from photo paths
 *   GET  /api/strip/preview    → base64 preview for kiosk screen
 *   GET  /api/strip/filters    → list available filters
 *   GET  /api/strip/:filename  → serve rendered strip file
 */
const router   = require('express').Router();
const path     = require('path');
const fs       = require('fs');
const renderer = require('./strip-renderer');

const OUT_DIR  = path.join(__dirname, '../assets/strips');
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ── POST /api/strip/render ── */
router.post('/render', async (req, res) => {
  const { photoPaths = [], filter = 'original', session = {}, overlay = null } = req.body;
  try {
    const result = await renderer.renderStrip(photoPaths, filter, session, overlay);
    /* return filename only (not full path) for security */
    res.json({ ok: true, filename: path.basename(result.path), method: result.method, width: result.width, height: result.height });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── GET /api/strip/preview ── */
router.get('/preview', async (req, res) => {
  const { photos, filter } = req.query;
  const photoPaths = photos ? JSON.parse(photos) : [];
  try {
    const dataUrl = await renderer.renderPreview(photoPaths, filter || 'original');
    res.json({ ok: true, dataUrl });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── GET /api/strip/filters ── */
router.get('/filters', (req, res) => {
  res.json({ ok: true, filters: renderer.FILTERS, dimensions: { width: renderer.STRIP_W, height: renderer.STRIP_H, dpi: 300 } });
});

/* ── GET /api/strip/:filename — serve rendered file ── */
router.get('/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); /* sanitise */
  const filePath = path.join(OUT_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

module.exports = router;
