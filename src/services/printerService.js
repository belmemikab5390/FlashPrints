/**
 * src/services/printerService.js
 *
 * Handles printing to DNP DS620A / Mitsubishi CP-D90DW
 * dye-sublimation photo printers.
 *
 * Flow:
 *  1. Receive paths to captured photos + filter name
 *  2. Compose the strip layout (4-up or 6-up) using Jimp
 *  3. Add Flash & Prints branding at the bottom
 *  4. Send the composed image to the printer via Windows printer API
 */

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const Jimp   = require('jimp');

const OUTPUT_DIR  = path.join(os.homedir(), 'FlashAndPrints', 'prints');
const ASSETS_DIR  = path.join(__dirname, '..', 'assets');
const PRINTER_NAME = process.env.PRINTER_NAME || 'DNP DS620A';

// Dye-sub strip dimensions at 300dpi
// 2×6 inch strip = 600×1800 px at 300dpi
const STRIP_W  = 600;
const STRIP_H  = 1800;
const CELL_W   = 560;
const CELL_PAD = 20;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Print a photo strip.
 * @param {object} opts
 *   photos:  string[]  — absolute paths to captured JPEGs
 *   filter:  string    — 'original' | 'vintage' | 'bw' | 'pastel' | 'neon'
 *   copies:  number    — how many prints (1 or 2)
 *   sessionId: string
 */
async function printStrip({ photos, filter, copies = 1, sessionId }) {
  const outputPath = path.join(OUTPUT_DIR, `${sessionId}_strip.jpg`);

  // 1. Compose strip
  await composeStrip({ photos, filter, outputPath });

  // 2. Send to printer (copies times)
  for (let i = 0; i < copies; i++) {
    await sendToPrinter(outputPath);
  }

  return outputPath;
}

// ── Compose strip layout ───────────────────────────────────────────
async function composeStrip({ photos, filter, outputPath }) {
  const strip = new Jimp(STRIP_W, STRIP_H, 0xFFFFFFFF); // white canvas

  const photoCount = photos.length;
  const cellH      = Math.floor((STRIP_H - 120) / photoCount) - CELL_PAD;

  for (let i = 0; i < photoCount; i++) {
    let photo;
    try {
      photo = await Jimp.read(photos[i]);
    } catch {
      // Use placeholder if photo missing (shouldn't happen in prod)
      photo = new Jimp(CELL_W, cellH, 0xEEEEEEFF);
    }

    // Resize to cell
    photo.cover(CELL_W, cellH);

    // Apply filter
    applyFilter(photo, filter);

    const y = CELL_PAD + i * (cellH + CELL_PAD);
    strip.composite(photo, CELL_PAD, y);
  }

  // ── Branding footer ────────────────────────────────────────────
  // In production load a real font from assets
  // For now we use Jimp's built-in bitmap font
  try {
    const font = await Jimp.loadFont(Jimp.FONT_SANS_14_BLACK);
    const dateStr = new Date().toLocaleDateString('en-PH', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
    strip.print(font, CELL_PAD, STRIP_H - 100, 'Flash & Prints Photobooth', CELL_W);
    strip.print(font, CELL_PAD, STRIP_H - 80,  dateStr, CELL_W);
    strip.print(font, CELL_PAD, STRIP_H - 60,  'gcash.me/flashandprints', CELL_W);
  } catch (e) {
    // Font loading may fail in some environments — branding is optional
  }

  await strip.quality(95).writeAsync(outputPath);
  return outputPath;
}

// ── Apply CSS-equivalent filter using Jimp ─────────────────────────
function applyFilter(image, filter) {
  switch ((filter || '').toLowerCase()) {
    case 'vintage':
      image.sepia().contrast(0.1).brightness(-0.05);
      break;
    case 'bw':
    case 'b&w':
      image.greyscale().contrast(0.1);
      break;
    case 'pastel':
      image.color([
        { apply: 'saturate',  params: [-60] },
        { apply: 'brighten',  params: [20]  },
      ]).contrast(-0.1);
      break;
    case 'neon':
      image.color([{ apply: 'saturate', params: [80] }])
           .contrast(0.1);
      break;
    default:
      // original — no processing
      break;
  }
}

// ── Send to printer ────────────────────────────────────────────────
async function sendToPrinter(imagePath) {
  return new Promise((resolve, reject) => {
    // On Windows, use node-printer to send directly
    // On Linux/Mac (dev), just log
    if (process.platform === 'win32') {
      try {
        const printer = require('node-printer');
        printer.printFile({
          filename:    imagePath,
          printer:     PRINTER_NAME,
          type:        'JPEG',
          success:     resolve,
          error:       reject,
        });
      } catch (e) {
        reject(e);
      }
    } else {
      // Dev mode — simulate 12s print delay
      console.log(`[Printer DEV] Would print: ${imagePath}`);
      setTimeout(resolve, 12_000);
    }
  });
}

/**
 * Check printer status (ink + paper levels)
 * Returns: { ink: number (0-100), paper: number (0-100), status: string }
 */
async function getPrinterStatus() {
  try {
    if (process.platform === 'win32') {
      const printer = require('node-printer');
      const info    = printer.getPrinter(PRINTER_NAME);
      return {
        status: info.status,
        ink:    100, // DNP SDK provides this — integrate with DNP SDK for real values
        paper:  100,
      };
    }
    return { status: 'DEV_MODE', ink: 100, paper: 100 };
  } catch (e) {
    return { status: 'ERROR', ink: 0, paper: 0, error: e.message };
  }
}

module.exports = { printStrip, getPrinterStatus };
