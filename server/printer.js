/**
 * server/printer.js
 * DNP DS620A / Mitsubishi CP-D90DW dye-sublimation printer bridge.
 *
 * Real supply data comes from:
 *   - Windows: WMI query via PowerShell (ink %) + sheet counter tracking
 *   - macOS/Linux dev: simulated values
 *
 * Supply thresholds (set in .env):
 *   SUPPLY_WARN_PAPER=30    sheets remaining → yellow warning
 *   SUPPLY_CRIT_PAPER=10    sheets remaining → red critical
 *   SUPPLY_WARN_INK=25      ink % → yellow warning
 *   SUPPLY_CRIT_INK=10      ink % → red critical
 */
const { exec }  = require('child_process');
const path      = require('path');
const fs        = require('fs');
const boothState = require('./booth-state');
require('dotenv').config();

const PRINTER_NAME  = process.env.PRINTER_NAME  || 'DNP DS620A';
const PAPER_START   = parseInt(process.env.PAPER_START)       || 200;
const WARN_PAPER    = parseInt(process.env.SUPPLY_WARN_PAPER) || 30;
const CRIT_PAPER    = parseInt(process.env.SUPPLY_CRIT_PAPER) || 10;
const WARN_INK      = parseInt(process.env.SUPPLY_WARN_INK)   || 25;
const CRIT_INK      = parseInt(process.env.SUPPLY_CRIT_INK)   || 10;

/* ── supply alert levels ── */
function getSupplyLevel(value, warnThreshold, critThreshold) {
  if (value <= critThreshold) return 'critical';
  if (value <= warnThreshold) return 'warning';
  return 'ok';
}

/* ── real DNP ink query via WMI (Windows only) ── */
async function queryDNPInk() {
  return new Promise(resolve => {
    /* DNP DS620A exposes supply info via WMI Win32_Printer */
    const cmd = `powershell -NoProfile -Command "
      $p = Get-WmiObject Win32_Printer -Filter \\"Name='${PRINTER_NAME}'\\" 2>$null;
      if($p) {
        @{
          Status        = $p.PrinterStatus;
          ExtendedStatus = $p.ExtendedPrinterStatus;
          DetectedErrors = $p.DetectedErrorState;
          WorkOffline    = $p.WorkOffline;
          Jobs           = $p.Jobs;
        } | ConvertTo-Json
      } else { 'NOT_FOUND' }
    "`;

    exec(cmd, { timeout: 8000 }, (err, stdout) => {
      if (err || stdout.includes('NOT_FOUND') || !stdout.trim()) {
        return resolve(null);
      }
      try {
        const data = JSON.parse(stdout.trim());
        /* WMI PrinterStatus: 3=Idle, 4=Printing, 5=Warming up */
        const statusMap = { 3:'READY', 4:'PRINTING', 5:'WARMING', 1:'OTHER', 2:'UNKNOWN' };
        resolve({
          printerStatus: statusMap[data.Status] || 'UNKNOWN',
          offline:       data.WorkOffline === true,
          activeJobs:    data.Jobs || 0,
          errorState:    data.DetectedErrors || 0,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

/* ── read persisted sheet counter (survives restarts) ── */
const COUNTER_FILE = path.join(__dirname, '../assets/.sheet-counter.json');

function readSheetCounter() {
  try {
    return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
  } catch {
    const init = { sheets: PAPER_START, lastReset: Date.now() };
    writeSheetCounter(init);
    return init;
  }
}

function writeSheetCounter(data) {
  try {
    fs.mkdirSync(path.dirname(COUNTER_FILE), { recursive: true });
    fs.writeFileSync(COUNTER_FILE, JSON.stringify(data, null, 2));
  } catch(e) {
    console.error('[PRINTER] Could not write sheet counter:', e.message);
  }
}

/* ── get full printer status ── */
async function getStatus() {
  const counter = readSheetCounter();
  const sheetsRemaining = Math.max(0, counter.sheets);
  const paperPct  = Math.round((sheetsRemaining / PAPER_START) * 100);

  /* dev simulation */
  if (process.platform !== 'win32' || process.env.PRINTER_SIMULATE === 'true') {
    const ink = boothState.state.supplies.inkPercent ?? 100;
    return buildStatusResponse({
      printerStatus: 'READY',
      offline:       false,
      simulated:     true,
      inkPercent:    ink,
      sheetsRemaining,
      paperPercent:  paperPct,
    });
  }

  /* real Windows query */
  const wmi = await queryDNPInk();
  if (!wmi) {
    return buildStatusResponse({
      printerStatus: 'OFFLINE',
      offline:       true,
      simulated:     false,
      inkPercent:    0,
      sheetsRemaining,
      paperPercent:  paperPct,
      error:         'Printer not found — check USB connection and driver',
    });
  }

  /* DNP ink % — approximate from ribbon roll usage
     Real DNP SDK (if licensed) provides exact ink remaining.
     Without SDK: we track by sheets printed. */
  const inkEstimate = Math.max(0, Math.round((sheetsRemaining / PAPER_START) * 100));

  return buildStatusResponse({
    printerStatus:  wmi.printerStatus,
    offline:        wmi.offline,
    activeJobs:     wmi.activeJobs,
    simulated:      false,
    inkPercent:     inkEstimate,
    sheetsRemaining,
    paperPercent:   paperPct,
  });
}

function buildStatusResponse({ printerStatus, offline, simulated, inkPercent, sheetsRemaining, paperPercent, activeJobs = 0, error = null }) {
  const paperLevel = getSupplyLevel(sheetsRemaining, WARN_PAPER, CRIT_PAPER);
  const inkLevel   = getSupplyLevel(inkPercent,      WARN_INK,   CRIT_INK);

  const alerts = [];
  if (paperLevel === 'critical') alerts.push({ type: 'critical', supply: 'paper', message: `Only ${sheetsRemaining} sheets left — refill immediately!` });
  else if (paperLevel === 'warning') alerts.push({ type: 'warning', supply: 'paper', message: `${sheetsRemaining} sheets remaining — refill soon` });
  if (inkLevel === 'critical') alerts.push({ type: 'critical', supply: 'ink', message: `Ink critically low (${inkPercent}%) — replace ribbon` });
  else if (inkLevel === 'warning') alerts.push({ type: 'warning', supply: 'ink', message: `Ink low (${inkPercent}%) — order replacement` });
  if (offline) alerts.push({ type: 'error', supply: 'printer', message: 'Printer is offline — check USB and power' });

  return {
    ok:           !offline,
    printer:      PRINTER_NAME,
    status:       printerStatus,
    offline,
    simulated:    simulated || false,
    activeJobs,
    error,
    supplies: {
      ink: {
        percent: inkPercent,
        level:   inkLevel,
      },
      paper: {
        sheets:  sheetsRemaining,
        percent: paperPercent,
        level:   paperLevel,
      },
    },
    thresholds: {
      paper: { warn: WARN_PAPER, critical: CRIT_PAPER },
      ink:   { warn: WARN_INK,   critical: CRIT_INK   },
    },
    alerts,
    checkedAt: Date.now(),
  };
}

/* ── print a strip and decrement counter ── */
async function printStrip({ photoPaths, imagePath, filter, session }) {
  const renderer = require('./strip-renderer');

  /* ── step 1: render the strip image ── */
  let printPath = imagePath;
  if (!printPath || !fs.existsSync(printPath)) {
    console.log('[PRINTER] Rendering strip layout...');
    try {
      const result = await renderer.renderStrip(photoPaths || [], filter, session);
      printPath    = result.path;
      console.log(`[PRINTER] Strip rendered (${result.method}) → ${printPath}`);
    } catch(renderErr) {
      console.error('[PRINTER] Render error:', renderErr.message);
      printPath = path.join(__dirname, '../assets/test-strip.jpg');
    }
  }

  if (!fs.existsSync(printPath)) {
    console.warn('[PRINTER] No print file available — skipping');
    return { ok: false, error: 'No print file' };
  }

  console.log(`[PRINTER] Printing: ${printPath} · filter: ${filter}`);

  /* ── step 2: send to printer ── */
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32' || process.env.PRINTER_SIMULATE === 'true') {
      decrementSheets(1);
      console.log('[PRINTER] Simulated print complete');
      return resolve({ ok: true, simulated: true, path: printPath, sheetsRemaining: readSheetCounter().sheets });
    }

    const cmd = `powershell -NoProfile -Command "Start-Process -FilePath '${printPath.replace(/'/g,"\'")}' -Verb PrintTo -ArgumentList '${PRINTER_NAME}'"`;
    exec(cmd, { timeout: 30000 }, (err) => {
      if (err) {
        console.error('[PRINTER] Print error:', err.message);
        return reject(err);
      }
      decrementSheets(1);
      const remaining = readSheetCounter().sheets;
      console.log(`[PRINTER] Print sent · ${remaining} sheets remaining`);
      resolve({ ok: true, printer: PRINTER_NAME, path: printPath, sheetsRemaining: remaining });
    });
  });
}

/* ── decrement sheet counter + sync to booth state ── */
function decrementSheets(count = 1) {
  const counter = readSheetCounter();
  counter.sheets = Math.max(0, counter.sheets - count);
  writeSheetCounter(counter);

  /* push updated supplies to booth state → triggers SSE broadcast */
  const ink = boothState.state.supplies.inkPercent;
  boothState.updateSupplies({ inkPercent: ink, paperSheets: counter.sheets });
  boothState.usePaper(0); /* trigger alert check without double-decrementing */
}

/* ── refill paper (called when owner loads new roll) ── */
function refillPaper(sheets = PAPER_START) {
  writeSheetCounter({ sheets, lastReset: Date.now() });
  boothState.updateSupplies({ paperSheets: sheets });
  boothState.clearErrors();
  console.log(`[PRINTER] Paper refilled — ${sheets} sheets loaded`);
  return { ok: true, sheets };
}

/* ── refill ink ── */
function refillInk(percent = 100) {
  boothState.updateSupplies({ inkPercent: percent });
  boothState.clearErrors();
  console.log(`[PRINTER] Ink refilled — ${percent}%`);
  return { ok: true, inkPercent: percent };
}

/* ── auto-poll printer status every 60s and sync to booth state ── */
async function startSupplyPolling(intervalMs = 60000) {
  async function poll() {
    try {
      const status = await getStatus();
      boothState.updateSupplies({
        inkPercent:  status.supplies.ink.percent,
        paperSheets: status.supplies.paper.sheets,
      });
      /* add errors for critical alerts */
      status.alerts
        .filter(a => a.type === 'critical')
        .forEach(a => boothState.addError(`${a.supply.toUpperCase()}_CRITICAL`, a.message));
    } catch(e) {
      console.error('[PRINTER] Poll error:', e.message);
    }
    setTimeout(poll, intervalMs);
  }
  setTimeout(poll, 5000); /* first poll after 5s startup */
  console.log(`[PRINTER] Supply polling started — every ${intervalMs/1000}s`);
}

module.exports = { printStrip, getStatus, refillPaper, refillInk, startSupplyPolling, decrementSheets };