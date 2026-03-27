/**
 * server/strip-renderer.js
 * Composes captured photos into a print-ready 2×6 inch strip image.
 *
 * Output spec (DNP DS620A standard):
 *   - Size:       2 × 6 inches
 *   - Resolution: 300 DPI  →  600 × 1800 px
 *   - Format:     JPEG, quality 95
 *   - Layout:     4 photo cells + branding footer
 *
 * Filters applied via CSS-equivalent pixel manipulation:
 *   original, vintage, b&w, pastel, neon
 *
 * Dependencies:
 *   npm install sharp
 *   (sharp is the fastest Node.js image processing library — uses libvips)
 *
 * Fallback:
 *   If sharp is unavailable (e.g. dev machine missing native build),
 *   falls back to a canvas-based renderer using the 'canvas' package,
 *   and finally to a plain placeholder if neither is available.
 */

const path = require('path');
const fs   = require('fs');
require('dotenv').config();

/* ── output dimensions (300 DPI, 2×6 inch) ── */
const STRIP_W   = 600;   /* px — 2 inches × 300 dpi */
const STRIP_H   = 1800;  /* px — 6 inches × 300 dpi */
const MARGIN    = 18;    /* px — outer margin */
const FOOTER_H  = 90;    /* px — branding footer height */
const GAP       = 10;    /* px — gap between photos */

/* photo cell dimensions — 4 equal cells stacked */
const CELL_W    = STRIP_W - MARGIN * 2;
const CELL_H    = Math.floor((STRIP_H - FOOTER_H - MARGIN * 2 - GAP * 3) / 4);

/* brand colors */
const BRAND_BG     = '#1A1200';   /* dark gold-black */
const BRAND_GOLD   = '#E8C547';
const BRAND_WHITE  = '#FFFFFF';

/* output dir */
const OUT_DIR = path.join(__dirname, '../assets/strips');
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   FILTER DEFINITIONS
   Each filter is a sharp pipeline transform
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const FILTERS = {
  original: s => s,

  vintage:  s => s
    .modulate({ saturation: 0.6, brightness: 0.95 })
    .tint({ r: 220, g: 190, b: 140 }),

  bw:       s => s
    .grayscale()
    .modulate({ brightness: 1.05, contrast: 1.1 }),

  pastel:   s => s
    .modulate({ saturation: 0.35, brightness: 1.2 })
    .tint({ r: 245, g: 235, b: 250 }),

  neon:     s => s
    .modulate({ saturation: 2.0, brightness: 1.05 })
    .tint({ r: 220, g: 255, b: 230 }),
};

/* normalise filter key */
function normaliseFilter(f) {
  if (!f) return 'original';
  const k = f.toLowerCase().replace(/[^a-z]/g, '');
  if (k === 'bw' || k === 'blackandwhite' || k === 'blackwhite') return 'bw';
  return FILTERS[k] ? k : 'original';
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MAIN RENDERER  (uses sharp)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
async function renderWithSharp(photoPaths, filter, outputPath, session) {
  const sharp = require('sharp');

  /* ── process each photo cell ── */
  const applyFilter = FILTERS[normaliseFilter(filter)] || FILTERS.original;

  const cellBuffers = await Promise.all(
    photoPaths.map(async (p, i) => {
      let img;
      if (p && fs.existsSync(p)) {
        img = sharp(p);
      } else {
        /* placeholder — solid colour with photo number */
        img = sharp({
          create: {
            width:      CELL_W,
            height:     CELL_H,
            channels:   3,
            background: { r: 40, g: 40, b: 50 },
          },
        });
      }

      const processed = applyFilter(
        img.resize(CELL_W, CELL_H, { fit: 'cover', position: 'centre' })
      );

      return processed.jpeg({ quality: 92 }).toBuffer();
    })
  );

  /* ── build composite layout ── */
  const compositeOps = [];

  cellBuffers.forEach((buf, i) => {
    const y = MARGIN + i * (CELL_H + GAP);
    compositeOps.push({ input: buf, left: MARGIN, top: y });
  });

  /* ── branding footer SVG ── */
  const now         = new Date();
  const dateStr     = now.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
  const boothId     = process.env.BOOTH_ID       || '001';
  const boothLoc    = process.env.BOOTH_LOCATION || 'SM City North EDSA';
  const filterLabel = normaliseFilter(filter).toUpperCase();
  const pkgLabel    = (session?.package?.name || 'Classic Strip').toUpperCase();

  const footerSVG = Buffer.from(`
    <svg width="${STRIP_W}" height="${FOOTER_H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${STRIP_W}" height="${FOOTER_H}" fill="${BRAND_BG}"/>
      <!-- gold top line -->
      <rect width="${STRIP_W}" height="3" fill="${BRAND_GOLD}"/>
      <!-- brand name -->
      <text x="${STRIP_W / 2}" y="38"
        font-family="Georgia, serif" font-size="22" font-weight="bold"
        fill="${BRAND_GOLD}" text-anchor="middle" letter-spacing="1">
        Flash &amp; Prints
      </text>
      <!-- sub info -->
      <text x="${STRIP_W / 2}" y="58"
        font-family="monospace" font-size="11"
        fill="rgba(255,255,255,0.5)" text-anchor="middle" letter-spacing="2">
        ${dateStr}  ·  BOOTH #${boothId}
      </text>
      <!-- package + filter tags -->
      <text x="${MARGIN}" y="78"
        font-family="monospace" font-size="10"
        fill="rgba(255,255,255,0.3)" letter-spacing="1">
        ${pkgLabel}
      </text>
      <text x="${STRIP_W - MARGIN}" y="78"
        font-family="monospace" font-size="10"
        fill="${BRAND_GOLD}" text-anchor="end" letter-spacing="1">
        ${filterLabel} FILTER
      </text>
    </svg>`);

  const footerY = STRIP_H - FOOTER_H;
  compositeOps.push({ input: footerSVG, left: 0, top: footerY });

  /* ── compose final strip ── */
  await sharp({
    create: {
      width:    STRIP_W,
      height:   STRIP_H,
      channels: 3,
      background: { r: 20, g: 18, b: 12 },  /* dark background */
    },
  })
  .composite(compositeOps)
  .jpeg({ quality: 95, mozjpeg: true })
  .toFile(outputPath);

  return outputPath;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CANVAS FALLBACK  (if sharp unavailable)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
async function renderWithCanvas(photoPaths, filter, outputPath, session) {
  const { createCanvas, loadImage } = require('canvas');
  const canvas = createCanvas(STRIP_W, STRIP_H);
  const ctx    = canvas.getContext('2d');

  /* background */
  ctx.fillStyle = '#14120C';
  ctx.fillRect(0, 0, STRIP_W, STRIP_H);

  const fk = normaliseFilter(filter);

  for (let i = 0; i < 4; i++) {
    const x = MARGIN;
    const y = MARGIN + i * (CELL_H + GAP);
    const p = photoPaths[i];

    /* apply filter via globalCompositeOperation tricks */
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, CELL_W, CELL_H);
    ctx.clip();

    if (p && fs.existsSync(p)) {
      const img = await loadImage(p);
      ctx.drawImage(img, x, y, CELL_W, CELL_H);
    } else {
      /* placeholder gradient */
      const grad = ctx.createLinearGradient(x, y, x + CELL_W, y + CELL_H);
      grad.addColorStop(0, '#2A3A2A');
      grad.addColorStop(1, '#1A1A2A');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, CELL_W, CELL_H);
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.font      = 'bold 32px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`PHOTO ${i + 1}`, x + CELL_W / 2, y + CELL_H / 2);
    }

    /* apply filter overlay */
    applyCanvasFilter(ctx, fk, x, y, CELL_W, CELL_H);
    ctx.restore();
  }

  /* branding footer */
  const fy       = STRIP_H - FOOTER_H;
  const now      = new Date();
  const dateStr  = now.toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' }).toUpperCase();
  const boothId  = process.env.BOOTH_ID || '001';

  ctx.fillStyle  = '#1A1200';
  ctx.fillRect(0, fy, STRIP_W, FOOTER_H);
  ctx.fillStyle  = '#E8C547';
  ctx.fillRect(0, fy, STRIP_W, 3);

  ctx.font      = 'bold 22px Georgia, serif';
  ctx.fillStyle = '#E8C547';
  ctx.textAlign = 'center';
  ctx.fillText('Flash & Prints', STRIP_W / 2, fy + 38);

  ctx.font      = '11px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText(`${dateStr}  ·  BOOTH #${boothId}`, STRIP_W / 2, fy + 58);

  ctx.font      = '10px monospace';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#E8C547';
  ctx.fillText(fk.toUpperCase() + ' FILTER', STRIP_W - MARGIN, fy + 78);

  /* write JPEG */
  const buf  = canvas.toBuffer('image/jpeg', { quality: 0.95 });
  fs.writeFileSync(outputPath, buf);
  return outputPath;
}

function applyCanvasFilter(ctx, filter, x, y, w, h) {
  ctx.globalCompositeOperation = 'source-atop';
  switch(filter) {
    case 'vintage':
      ctx.fillStyle = 'rgba(180,130,50,0.25)';
      ctx.fillRect(x, y, w, h);
      break;
    case 'bw':
      /* grayscale via luminance blend */
      ctx.filter    = 'grayscale(100%) contrast(110%)';
      break;
    case 'pastel':
      ctx.fillStyle = 'rgba(240,220,255,0.3)';
      ctx.fillRect(x, y, w, h);
      break;
    case 'neon':
      ctx.fillStyle = 'rgba(0,255,120,0.1)';
      ctx.fillRect(x, y, w, h);
      break;
    default:
      break;
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PLACEHOLDER FALLBACK
   No image libraries — creates a minimal valid JPEG
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
async function renderPlaceholder(outputPath) {
  /* copy test strip asset if it exists */
  const testStrip = path.join(__dirname, '../assets/test-strip.jpg');
  if (fs.existsSync(testStrip)) {
    fs.copyFileSync(testStrip, outputPath);
    return outputPath;
  }
  /* write a 1×1 black JPEG as absolute minimum */
  const minJPEG = Buffer.from([
    0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01,
    0x01,0x00,0x00,0x01,0x00,0x01,0x00,0x00,0xFF,0xDB,0x00,0x43,
    0x00,0x08,0x06,0x06,0x07,0x06,0x05,0x08,0x07,0x07,0x07,0x09,
    0x09,0x08,0x0A,0x0C,0x14,0x0D,0x0C,0x0B,0x0B,0x0C,0x19,0x12,
    0x13,0x0F,0x14,0x1D,0x1A,0x1F,0x1E,0x1D,0x1A,0x1C,0x1C,0x20,
    0x24,0x2E,0x27,0x20,0x22,0x2C,0x23,0x1C,0x1C,0x28,0x37,0x29,
    0x2C,0x30,0x31,0x34,0x34,0x34,0x1F,0x27,0x39,0x3D,0x38,0x32,
    0x3C,0x2E,0x33,0x34,0x32,0xFF,0xC0,0x00,0x0B,0x08,0x00,0x01,
    0x00,0x01,0x01,0x01,0x11,0x00,0xFF,0xC4,0x00,0x1F,0x00,0x00,
    0x01,0x05,0x01,0x01,0x01,0x01,0x01,0x01,0x00,0x00,0x00,0x00,
    0x00,0x00,0x00,0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,
    0x09,0x0A,0x0B,0xFF,0xDA,0x00,0x08,0x01,0x01,0x00,0x00,0x3F,
    0x00,0xFB,0xD2,0x8A,0xFF,0xD9,
  ]);
  fs.writeFileSync(outputPath, minJPEG);
  return outputPath;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PUBLIC API
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * renderStrip(photoPaths, filter, session) → { ok, path, method, width, height }
 *
 * photoPaths: array of up to 6 absolute file paths (missing ones = placeholder cell)
 * filter:     'original' | 'vintage' | 'bw' | 'pastel' | 'neon'
 * session:    session object from localStorage (for branding metadata)
 */
async function renderStrip(photoPaths = [], filter = 'original', session = {}) {
  const sessionId  = session?.id || `strip-${Date.now()}`;
  const outputPath = path.join(OUT_DIR, `${sessionId}.jpg`);
  const photos     = Array.isArray(photoPaths) ? photoPaths.slice(0, 4) : [];

  /* pad to 4 entries */
  while (photos.length < 4) photos.push(null);

  console.log(`[STRIP] Rendering: session=${sessionId} filter=${filter} photos=${photos.filter(Boolean).length}/4`);

  let result;

  /* try sharp first, then canvas, then placeholder */
  try {
    require('sharp');
    await renderWithSharp(photos, filter, outputPath, session);
    console.log(`[STRIP] Rendered with sharp → ${outputPath}`);
    result = { ok: true, path: outputPath, method: 'sharp', width: STRIP_W, height: STRIP_H };
  } catch(sharpErr) {
    if (!sharpErr.message.includes('Cannot find module')) {
      console.error('[STRIP] Sharp error:', sharpErr.message);
    } else {
      console.warn('[STRIP] sharp not installed — trying canvas');
    }
  }

  if (!result) {
    try {
      require('canvas');
      await renderWithCanvas(photos, filter, outputPath, session);
      console.log(`[STRIP] Rendered with canvas → ${outputPath}`);
      result = { ok: true, path: outputPath, method: 'canvas', width: STRIP_W, height: STRIP_H };
    } catch(canvasErr) {
      if (!canvasErr.message.includes('Cannot find module')) {
        console.error('[STRIP] Canvas error:', canvasErr.message);
      } else {
        console.warn('[STRIP] canvas not installed — using placeholder');
      }
    }
  }

  if (!result) {
    await renderPlaceholder(outputPath);
    console.warn(`[STRIP] Used placeholder → ${outputPath}`);
    result = { ok: true, path: outputPath, method: 'placeholder', width: STRIP_W, height: STRIP_H };
  }

  /* copy strip into session folder so all session assets are co-located */
  if (session?.id) {
    try {
      const sessions    = require('./sessions');
      const sessionDir  = path.join(sessions.SESSIONS_DIR, session.id);
      const stripInSess = path.join(sessionDir, 'strip.jpg');
      if (fs.existsSync(sessionDir) && !fs.existsSync(stripInSess)) {
        fs.copyFileSync(outputPath, stripInSess);
        console.log(`[STRIP] Copied to session folder → ${stripInSess}`);
      }
    } catch(_) {}
  }

  return result;
}

/**
 * renderPreview(photoPaths, filter) → base64 JPEG data URL
 * Used by the kiosk preview screen to show a live filter preview.
 * Lower resolution (300×900) for speed.
 */
async function renderPreview(photoPaths = [], filter = 'original') {
  const PREV_W = 300;
  const PREV_H = 900;
  const tmpPath = path.join(OUT_DIR, `preview-${Date.now()}.jpg`);

  try {
    const sharp = require('sharp');
    const fk    = normaliseFilter(filter);
    const applyF = FILTERS[fk] || FILTERS.original;

    const cellH  = Math.floor((PREV_H - 40 - 10 * 3) / 4);
    const cellW  = PREV_W - 12;
    const photos = [...photoPaths].slice(0,4);
    while(photos.length < 4) photos.push(null);

    const cellBufs = await Promise.all(photos.map(async p => {
      let img;
      if (p && fs.existsSync(p)) {
        img = sharp(p);
      } else {
        img = sharp({ create:{ width:cellW, height:cellH, channels:3, background:{r:30,g:30,b:40} } });
      }
      return applyF(img.resize(cellW, cellH, { fit:'cover' })).jpeg({ quality:70 }).toBuffer();
    }));

    const ops = cellBufs.map((buf,i) => ({ input: buf, left: 6, top: 6 + i*(cellH+10) }));

    const outBuf = await sharp({
      create: { width:PREV_W, height:PREV_H, channels:3, background:{r:20,g:18,b:12} },
    }).composite(ops).jpeg({ quality:70 }).toBuffer();

    fs.unlinkSync(tmpPath); /* cleanup */
    return `data:image/jpeg;base64,${outBuf.toString('base64')}`;
  } catch(e) {
    return null; /* preview unavailable */
  }
}

module.exports = {
  renderStrip,
  renderPreview,
  STRIP_W,
  STRIP_H,
  FILTERS: Object.keys(FILTERS),
};