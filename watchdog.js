/**
 * watchdog.js — Flash & Prints Kiosk Auto-Restart Watchdog
 *
 * Run this INSTEAD of running Electron directly.
 * It launches the kiosk app as a child process and:
 *   - Restarts it within 10s if it crashes
 *   - Restarts it if it becomes unresponsive (no heartbeat in 60s)
 *   - Logs all crashes with timestamp to assets/crash.log
 *   - Sends push notification to owner phone on repeated crashes
 *   - Respects a max restart limit to prevent infinite crash loops
 *   - Schedules a daily restart at 4:00 AM (off-peak hours)
 *
 * Usage:
 *   node watchdog.js              ← production
 *   node watchdog.js --dev        ← dev mode (no kiosk flag)
 *
 * To run on Windows startup:
 *   Add a shortcut to this in: shell:startup
 *   Or use: pm2 start watchdog.js --name "flash-prints"
 */

require('dotenv').config();
const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const http       = require('http');

/* ── config ── */
const ELECTRON_PATH = (() => {
  /* When running as a packaged exe, process.execPath IS the electron binary */
  if (!process.execPath.toLowerCase().includes('node')) return process.execPath;
  /* Dev mode — find electron in node_modules/.bin */
  const win = path.join(__dirname, 'node_modules', '.bin', 'electron.cmd');
  const nix = path.join(__dirname, 'node_modules', '.bin', 'electron');
  if (fs.existsSync(win)) return win;
  if (fs.existsSync(nix)) return nix;
  /* last resort: rely on PATH */
  return 'electron';
})();
const APP_PATH         = __dirname;
const LOG_FILE         = path.join(__dirname, 'assets/crash.log');
const HEARTBEAT_FILE   = path.join(__dirname, 'assets/.heartbeat');
const RESTART_DELAY_MS = 8000;        /* wait 8s before restarting */
const MAX_CRASHES      = 10;          /* stop after 10 crashes in a row */
const CRASH_RESET_MS   = 300000;      /* reset crash counter after 5 min */
const HEARTBEAT_TIMEOUT= 60000;       /* restart if no heartbeat in 60s */
const DAILY_RESTART_H  = 4;           /* restart at 4:00 AM daily */
const isDev            = process.argv.includes('--dev');

/* ── state ── */
let child         = null;
let crashCount    = 0;
let lastCrashAt   = 0;
let watchdogAlive = true;
let heartbeatTimer= null;
let dailyTimer    = null;

/* ── ensure assets dir ── */
fs.mkdirSync(path.join(__dirname, 'assets'), { recursive: true });

/* ── logging ── */
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
}

function trimLog() {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
    if (lines.length > 2000) {
      fs.writeFileSync(LOG_FILE, lines.slice(-1000).join('\n'));
    }
  } catch(e) {}
}

/* ── notify owner (push via server endpoint) ── */
async function notifyOwner(message) {
  const port = process.env.SERVER_PORT || 3000;
  try {
    const body = JSON.stringify({ message, boothId: process.env.BOOTH_ID || '001', severity: 'critical' });
    const req  = http.request({
      hostname: 'localhost', port, path: '/api/booth/error',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.write(body);
    req.end();
  } catch(e) { /* server might be down too */ }
}

/* ── launch kiosk ── */
function launch() {
  if (!watchdogAlive) return;

  /* reset crash counter if enough time has passed */
  if (Date.now() - lastCrashAt > CRASH_RESET_MS) crashCount = 0;

  if (crashCount >= MAX_CRASHES) {
    log(`FATAL: ${crashCount} crashes — stopping restarts to prevent crash loop`);
    notifyOwner(`Booth ${process.env.BOOTH_ID||'001'} crashed ${crashCount} times — manual intervention needed`);
    return;
  }

  const args = isDev ? ['.', '--dev'] : ['.'];
  log(`Launching kiosk (attempt ${crashCount + 1})... ${ELECTRON_PATH} ${args.join(' ')}`);

  child = spawn(ELECTRON_PATH, args, {
    cwd:   APP_PATH,
    stdio: ['ignore', 'pipe', 'pipe'],
    env:   { ...process.env, ELECTRON_WATCHDOG: '1' },
    shell: ELECTRON_PATH.endsWith('.cmd'),  /* required for .cmd files on Windows */
  });

  child.stdout.on('data', d => process.stdout.write(`[KIOSK] ${d}`));
  child.stderr.on('data', d => {
    const msg = d.toString();
    /* filter out common Electron noise */
    if (!msg.includes('Gtk-Message') && !msg.includes('libpng warning')) {
      process.stderr.write(`[KIOSK ERR] ${msg}`);
    }
  });

  child.on('exit', (code, signal) => {
    log(`Kiosk exited — code=${code} signal=${signal}`);
    stopHeartbeatMonitor();

    if (!watchdogAlive) return; /* clean shutdown */

    if (code === 0) {
      /* clean exit (e.g. reboot command) — restart immediately */
      log('Clean exit detected — restarting now');
      setTimeout(launch, 1000);
      return;
    }

    /* crash */
    crashCount++;
    lastCrashAt = Date.now();
    log(`CRASH #${crashCount} — restarting in ${RESTART_DELAY_MS/1000}s`);
    trimLog();

    if (crashCount >= 3) {
      notifyOwner(`Booth ${process.env.BOOTH_ID||'001'} crashed ${crashCount} times — latest: code=${code}`);
    }

    setTimeout(launch, RESTART_DELAY_MS);
  });

  child.on('error', err => {
    log(`Failed to spawn Electron: ${err.message}`);
    log(`Make sure you ran: npm install`);
    setTimeout(launch, RESTART_DELAY_MS * 2);
  });

  startHeartbeatMonitor();
  log(`Kiosk started — PID ${child.pid}`);
}

/* ── heartbeat monitor ── */
/* The Electron app writes a timestamp to .heartbeat every 30s.
   If we don't see an update in 60s, we assume it's frozen and kill it. */
function startHeartbeatMonitor() {
  stopHeartbeatMonitor();
  /* write initial heartbeat */
  writeHeartbeat();
  heartbeatTimer = setInterval(checkHeartbeat, 15000);
}

function stopHeartbeatMonitor() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function writeHeartbeat() {
  try { fs.writeFileSync(HEARTBEAT_FILE, Date.now().toString()); } catch(e) {}
}

function checkHeartbeat() {
  try {
    const ts   = parseInt(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
    const age  = Date.now() - ts;
    if (age > HEARTBEAT_TIMEOUT && child) {
      log(`Heartbeat timeout (${Math.round(age/1000)}s) — killing frozen kiosk`);
      notifyOwner(`Booth ${process.env.BOOTH_ID||'001'} became unresponsive — force restarting`);
      child.kill('SIGKILL');
    }
  } catch(e) { /* heartbeat file missing — kiosk just started */ }
}

/* ── daily restart at 4 AM ── */
function scheduleDailyRestart() {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(DAILY_RESTART_H, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next - now;
  log(`Daily restart scheduled at ${next.toLocaleString()} (in ${Math.round(ms/3600000)}h)`);
  dailyTimer = setTimeout(() => {
    log('Daily restart triggered');
    if (child) {
      child.kill('SIGTERM');  /* triggers exit → watchdog restarts it */
    }
    scheduleDailyRestart(); /* schedule next one */
  }, ms);
}

/* ── graceful shutdown ── */
function shutdown() {
  log('Watchdog shutting down...');
  watchdogAlive = false;
  stopHeartbeatMonitor();
  if (dailyTimer) clearTimeout(dailyTimer);
  if (child) {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child) child.kill('SIGKILL');
      process.exit(0);
    }, 3000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', err => {
  log(`Watchdog uncaught error: ${err.message}`);
});

/* ── start ── */
log(`=== Flash & Prints Watchdog starting ===`);
log(`Booth: #${process.env.BOOTH_ID||'001'} @ ${process.env.BOOTH_LOCATION||'Unknown'}`);
log(`Mode: ${isDev ? 'development' : 'production'}`);
log(`Max crashes before halt: ${MAX_CRASHES}`);

scheduleDailyRestart();
launch();