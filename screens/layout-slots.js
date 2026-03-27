/* ─────────────────────────────────────────────────────────────────────────
   screens/layout-slots.js
   Shared layout-slot definitions, SVG generation, and localStorage helpers.
   Used by both layout.html (customer kiosk) and dashboard.html (owner).

   A "slot" represents one photo placeholder on the print canvas.
   All coordinates are in SVG-viewBox units (no physical units).
───────────────────────────────────────────────────────────────────────── */

/* ── Default slot definitions ─────────────────────────────────────────── */
const LAYOUT_SLOT_DEFAULTS = {

  /* Classic — 4 × 6 inch print */
  'classic-framed': {
    viewBox: '0 0 90 110', bgRect: {x:4,y:4,w:82,h:102,rx:4},
    slots: [{x:12,y:12,w:66,h:70,angle:0}],
  },
  'classic-fullbleed': {
    viewBox: '0 0 90 110', bgRect: {x:4,y:4,w:82,h:102,rx:4},
    slots: [{x:4,y:4,w:82,h:102,angle:0}],
  },
  'classic-caption': {
    viewBox: '0 0 90 110', bgRect: {x:4,y:4,w:82,h:102,rx:4},
    slots: [{x:10,y:10,w:70,h:72,angle:0}],
  },

  /* Strip — 2 × 6 inch print */
  'strip-4x1': {
    viewBox: '0 0 42 110', bgRect: {x:3,y:3,w:36,h:104,rx:3},
    slots: [
      {x:7,y:7, w:28,h:22,angle:0},
      {x:7,y:32,w:28,h:22,angle:0},
      {x:7,y:57,w:28,h:22,angle:0},
      {x:7,y:82,w:28,h:22,angle:0},
    ],
  },
  'strip-2x2': {
    viewBox: '0 0 90 90', bgRect: {x:3,y:3,w:84,h:84,rx:3},
    slots: [
      {x:8, y:8, w:36,h:36,angle:0},
      {x:48,y:8, w:36,h:36,angle:0},
      {x:8, y:48,w:36,h:36,angle:0},
      {x:48,y:48,w:36,h:36,angle:0},
    ],
  },
  'strip-featured': {
    viewBox: '0 0 90 110', bgRect: {x:3,y:3,w:84,h:104,rx:3},
    slots: [
      {x:8, y:8, w:74,h:60,angle:0},
      {x:8, y:72,w:22,h:32,angle:0},
      {x:34,y:72,w:22,h:32,angle:0},
      {x:60,y:72,w:22,h:32,angle:0},
    ],
  },

  /* Polaroid — 4 × 4 inch print */
  'polaroid-classic': {
    viewBox: '0 0 80 96', bgRect: {x:4,y:4,w:72,h:88,rx:3},
    slots: [{x:10,y:10,w:60,h:60,angle:0}],
  },
  'polaroid-minimal': {
    viewBox: '0 0 80 80', bgRect: {x:4,y:4,w:72,h:72,rx:3},
    slots: [{x:10,y:10,w:60,h:60,angle:0}],
  },
  'polaroid-dated': {
    viewBox: '0 0 80 96', bgRect: {x:4,y:4,w:72,h:88,rx:3},
    slots: [{x:10,y:10,w:60,h:60,angle:0}],
  },

  /* Party Mode — 2 × 6 dual strip */
  'party-2strip3': {
    viewBox: '0 0 64 110', bgRect: null,
    slots: [
      {x:6, y:7, w:19,h:27,angle:0},
      {x:6, y:37,w:19,h:27,angle:0},
      {x:6, y:67,w:19,h:27,angle:0},
      {x:39,y:7, w:19,h:27,angle:0},
      {x:39,y:37,w:19,h:27,angle:0},
      {x:39,y:67,w:19,h:27,angle:0},
    ],
  },
  'party-3x2grid': {
    viewBox: '0 0 96 70', bgRect: {x:3,y:3,w:90,h:64,rx:3},
    slots: [
      {x:8, y:8, w:25,h:25,angle:0},
      {x:36,y:8, w:25,h:25,angle:0},
      {x:64,y:8, w:25,h:25,angle:0},
      {x:8, y:36,w:25,h:25,angle:0},
      {x:36,y:36,w:25,h:25,angle:0},
      {x:64,y:36,w:25,h:25,angle:0},
    ],
  },
  'party-featured-strip': {
    viewBox: '0 0 96 110', bgRect: null,
    slots: [
      {x:8, y:8, w:47,h:94,angle:0},
      {x:67,y:7, w:22,h:18,angle:0},
      {x:67,y:28,w:22,h:18,angle:0},
      {x:67,y:49,w:22,h:18,angle:0},
      {x:67,y:70,w:22,h:18,angle:0},
      {x:67,y:91,w:22,h:14,angle:0},
    ],
  },

  /* GIF Booth — 5 frames */
  'gif-filmstrip-h': {
    viewBox: '0 0 110 38', bgRect: {x:2,y:2,w:106,h:34,rx:3},
    slots: [
      {x:6, y:8,w:18,h:22,angle:0},
      {x:27,y:8,w:18,h:22,angle:0},
      {x:48,y:8,w:18,h:22,angle:0},
      {x:69,y:8,w:18,h:22,angle:0},
      {x:90,y:8,w:18,h:22,angle:0},
    ],
  },
  'gif-strip-v': {
    viewBox: '0 0 36 110', bgRect: {x:3,y:3,w:30,h:104,rx:3},
    slots: [
      {x:10,y:7, w:17,h:18,angle:0},
      {x:10,y:28,w:17,h:18,angle:0},
      {x:10,y:49,w:17,h:18,angle:0},
      {x:10,y:70,w:17,h:18,angle:0},
      {x:10,y:91,w:17,h:16,angle:0},
    ],
  },
  'gif-2plus3': {
    viewBox: '0 0 90 96', bgRect: {x:3,y:3,w:84,h:90,rx:3},
    slots: [
      {x:8, y:8, w:36,h:40,angle:0},
      {x:48,y:8, w:36,h:40,angle:0},
      {x:8, y:52,w:22,h:34,angle:0},
      {x:34,y:52,w:22,h:34,angle:0},
      {x:60,y:52,w:22,h:34,angle:0},
    ],
  },
};

/* ── localStorage helpers ─────────────────────────────────────────────── */
const _LS_KEY = 'fp_layout_slots';

function _readOverrides() {
  try { return JSON.parse(localStorage.getItem(_LS_KEY) || '{}'); } catch(_) {
    /* localStorage corrupted or unavailable — return empty overrides */
    return {};
  }
}

/** Return slot definition for a layout, merged with any saved overrides. */
function getLayoutSlots(layoutId) {
  const def = LAYOUT_SLOT_DEFAULTS[layoutId];
  if (!def) return null;
  const ov = _readOverrides()[layoutId];
  return ov ? Object.assign({}, def, { slots: ov }) : def;
}

/** Persist edited slots for a layout. */
function saveLayoutSlots(layoutId, slots) {
  const ov = _readOverrides();
  ov[layoutId] = slots;
  try { localStorage.setItem(_LS_KEY, JSON.stringify(ov)); } catch(_) {
    /* Storage quota exceeded or unavailable — changes won't persist */
  }
}

/** Remove saved overrides for a layout (revert to defaults). */
function resetLayoutSlots(layoutId) {
  const ov = _readOverrides();
  delete ov[layoutId];
  try { localStorage.setItem(_LS_KEY, JSON.stringify(ov)); } catch(_) {
    /* Storage unavailable — reset will not persist */
  }
}

/* ── SVG generation ───────────────────────────────────────────────────── */

/**
 * Generate an SVG string representing the slot layout.
 *
 * @param {string} layoutId
 * @param {object} [opts]
 * @param {boolean} [opts.labels=true]   – render slot-number labels
 * @param {number}  [opts.highlight=-1] – index of highlighted slot
 */
function generateLayoutSVG(layoutId, opts) {
  const def = getLayoutSlots(layoutId);
  if (!def) return '<svg/>';
  opts = opts || {};
  const showLabels = opts.labels !== false;
  const hl = (opts.highlight != null) ? opts.highlight : -1;

  const parts = [`<svg viewBox="${def.viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg">`];

  if (def.bgRect) {
    const b = def.bgRect;
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.rx || 3}" fill="rgba(232,197,71,0.05)" stroke="rgba(232,197,71,0.35)" stroke-width="1.5"/>`);
  }

  def.slots.forEach((s, i) => {
    const isHL   = i === hl;
    const fill   = isHL ? 'rgba(232,197,71,0.22)' : 'rgba(232,197,71,0.10)';
    const stroke = isHL ? 'rgba(232,197,71,0.70)' : 'rgba(232,197,71,0.22)';
    const sw     = isHL ? '1.8' : '0.8';
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    const xf = s.angle ? ` transform="rotate(${s.angle},${cx},${cy})"` : '';
    parts.push(`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="1.5" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${xf}/>`);
    if (showLabels) {
      const fs = Math.max(4, Math.min(s.w, s.h) * 0.38);
      parts.push(`<text x="${cx}" y="${cy}" dominant-baseline="middle" text-anchor="middle" font-size="${fs}" fill="rgba(232,197,71,0.55)" font-family="monospace">${i + 1}</text>`);
    }
  });

  parts.push('</svg>');
  return parts.join('');
}

/* ── Node.js export (used by strip-renderer if ever needed) ──────────── */
if (typeof module !== 'undefined') {
  module.exports = { LAYOUT_SLOT_DEFAULTS, getLayoutSlots, saveLayoutSlots, resetLayoutSlots, generateLayoutSVG };
}
