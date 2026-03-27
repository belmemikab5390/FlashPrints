/**
 * src/services/cameraService.js
 *
 * Controls the DSLR camera.
 *
 * Two backends supported:
 *   1. DSLR Remote Pro (Windows) — via HTTP API on localhost:8080
 *      Best for Canon / Nikon on Windows kiosk machines.
 *   2. gphoto2 (Linux/Mac fallback) — via child_process exec
 *
 * Set CAMERA_BACKEND=dslrremote or CAMERA_BACKEND=gphoto2 in .env
 */

const axios = require('axios');
const { exec } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');

const BACKEND       = process.env.CAMERA_BACKEND || 'dslrremote';
const DSLR_REMOTE   = process.env.DSLR_REMOTE_URL || 'http://127.0.0.1:8080';
const CAPTURE_DIR   = process.env.CAPTURE_DIR     || path.join(os.homedir(), 'FlashAndPrints', 'captures');

// Ensure capture directory exists
fs.mkdirSync(CAPTURE_DIR, { recursive: true });

/**
 * Capture a single photo.
 * Returns: absolute path to the captured image file.
 */
async function capture({ sessionId, photoIndex }) {
  const filename = `${sessionId}_photo${photoIndex}_${Date.now()}.jpg`;
  const destPath = path.join(CAPTURE_DIR, filename);

  if (BACKEND === 'dslrremote') {
    return captureViaDSLRRemote(destPath);
  } else {
    return captureViaGphoto2(destPath);
  }
}

// ── DSLR Remote Pro backend ────────────────────────────────────────
// Docs: https://www.breezesys.com/DSLRRemotePro/
async function captureViaDSLRRemote(destPath) {
  // Trigger shutter
  await axios.get(`${DSLR_REMOTE}/capture`, { timeout: 10_000 });

  // Wait for file to appear (DSLR Remote auto-downloads)
  // Poll the "last captured" endpoint
  let attempts = 0;
  while (attempts < 20) {
    await sleep(500);
    try {
      const res = await axios.get(`${DSLR_REMOTE}/lastcaptured`, { responseType: 'arraybuffer', timeout: 5000 });
      fs.writeFileSync(destPath, res.data);
      return destPath;
    } catch (e) {
      attempts++;
    }
  }
  throw new Error('Camera capture timed out');
}

// ── gphoto2 backend ────────────────────────────────────────────────
function captureViaGphoto2(destPath) {
  return new Promise((resolve, reject) => {
    const cmd = `gphoto2 --capture-image-and-download --filename="${destPath}" --force-overwrite`;
    exec(cmd, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`gphoto2: ${stderr || err.message}`));
      if (!fs.existsSync(destPath)) return reject(new Error('Photo file not created'));
      resolve(destPath);
    });
  });
}

/**
 * Get live preview frame (JPEG buffer) for the camera preview screen.
 * Called every ~100ms to simulate live view.
 */
async function getLivePreview() {
  if (BACKEND === 'dslrremote') {
    const res = await axios.get(`${DSLR_REMOTE}/liveview`, {
      responseType: 'arraybuffer', timeout: 2000,
    });
    return Buffer.from(res.data).toString('base64');
  }
  return null; // webcam handles preview in gphoto2 mode
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { capture, getLivePreview };
