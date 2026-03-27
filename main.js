require('dotenv').config();
const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path  = require('path');
const isDev = process.argv.includes('--dev');

/* ── Chromium flags — must be set before app is ready ──────────────────────
   These ensure getUserMedia (webcam) works on Windows without OS-level blocks.
   'disable-features=CrossOriginOpenerPolicy' prevents COOP from blocking media.
── */
app.commandLine.appendSwitch('enable-features', 'WebRTC');
app.commandLine.appendSwitch('disable-features', 'BlockInsecurePrivateNetworkRequests');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const BOOTH = {
  id:       process.env.BOOTH_ID       || '001',
  location: process.env.BOOTH_LOCATION || 'SM City North EDSA',
  floor:    process.env.BOOTH_FLOOR    || 'Level 2',
  tin:      process.env.BOOTH_TIN      || '123-456-789-000',
};

const SCREENS = {
  welcome:  'screens/welcome.html',
  packages: 'screens/packages.html',
  payment:  'screens/payment.html',
  mood:     'screens/mood.html',
  camera:   'screens/camera.html',
  preview:  'screens/preview.html',
  printing: 'screens/printing.html',
  receipt:  'screens/receipt.html',
  done:     'screens/done.html',
};

let mainWindow    = null;
let currentScreen = 'welcome';
let sessionData   = {};
let idleTimer     = null;
const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT_MS) || 180000;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1080,
    height:          1920,
    fullscreen:      !isDev,
    kiosk:           !isDev,
    resizable:       isDev,
    frame:           isDev,
    autoHideMenuBar: true,
    backgroundColor: '#FDF8F0',   /* warm cream — matches light welcome theme */
    webPreferences: {
      nodeIntegration:          false,
      contextIsolation:         true,
      preload:                  path.join(__dirname, 'preload.js'),
      webSecurity:              false,   /* allow file:// pages to fetch localhost:3000 */
      allowRunningInsecureContent: true,
    },
  });

  /* ── Camera / microphone permissions ──────────────────────────────────────
     All three handlers are required for getUserMedia to work in Electron 28.
     • setPermissionRequestHandler : handles the async permission prompt
     • setPermissionCheckHandler   : synchronous gate (Electron 15+)
     The page loads from http://localhost so it is a secure context — required
     for getUserMedia to be available at all.
  ── */
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'camera', 'microphone', 'display-capture'];
    callback(allowed.includes(permission));
  });

  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    const allowed = ['media', 'camera', 'microphone', 'display-capture'];
    return allowed.includes(permission);
  });

  /* setDevicePermissionHandler covers WebHID/USB/Serial — wrap in try/catch
     because older Electron builds may not have this method */
  try {
    mainWindow.webContents.session.setDevicePermissionHandler(() => true);
  } catch(_) {}

  if (!isDev) {
    mainWindow.webContents.on('context-menu', e => e.preventDefault());
    Menu.setApplicationMenu(null);
  }

  loadScreen('welcome');
  /* small delay on first welcome load — gives Express server time to start */
  setTimeout(() => { if (currentScreen === 'welcome') loadScreen('welcome'); }, 1500);
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
}

function loadScreen(name, extra = {}) {
  if (!SCREENS[name]) return;
  currentScreen = name;
  const PORT    = process.env.SERVER_PORT || 3000;
  const payload = { booth: BOOTH, session: sessionData, dev: isDev, serverUrl: `http://localhost:${PORT}`, digicamUrl: process.env.DIGICAM_URL || 'http://127.0.0.1:5513', cameraSimulate: process.env.CAMERA_SIMULATE === 'true', ...extra };
  /* load via HTTP so EventSource/fetch to localhost:PORT work same-origin */
  const url = `http://localhost:${PORT}/screens/${path.basename(SCREENS[name])}`;
  mainWindow.loadURL(url).then(() => {
    mainWindow.webContents.executeJavaScript(
      `window.__FP__ = ${JSON.stringify(payload)};
       if(typeof window.onFPData==='function') window.onFPData(window.__FP__);`
    );
    if (name !== 'welcome') resetIdleTimer();
    else clearIdleTimer();
  }).catch(err => {
    /* server not ready yet — fall back to file:// */
    console.warn(`[SCREEN] HTTP load failed, falling back to file://: ${err.message}`);
    mainWindow.loadFile(path.join(__dirname, SCREENS[name])).then(() => {
      mainWindow.webContents.executeJavaScript(
        `window.__FP__ = ${JSON.stringify(payload)};
         if(typeof window.onFPData==='function') window.onFPData(window.__FP__);`
      );
      if (name !== 'welcome') resetIdleTimer();
      else clearIdleTimer();
    });
  });
}

function resetIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => { sessionData = {}; loadScreen('welcome'); }, IDLE_TIMEOUT);
}
function clearIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

/* ── IPC ── */
ipcMain.handle('navigate', async (_, { screen: s, data }) => {
  if (data) sessionData = { ...sessionData, ...data };
  loadScreen(s);
  return { ok: true };
});

ipcMain.handle('get-session', async () => sessionData);
ipcMain.handle('reset-idle',  async () => { if (currentScreen !== 'welcome') resetIdleTimer(); });

ipcMain.handle('gcash-create-qr', async (_, { amount, sessionId }) => {
  try { return await require('./server/gcash').createPaymentQR({ amount, sessionId, booth: BOOTH }); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('gcash-check-status', async (_, { referenceId }) => {
  try { return await require('./server/gcash').checkPaymentStatus(referenceId); }
  catch (e) { return { ok: false, status: 'ERROR' }; }
});

ipcMain.handle('print-strip', async (_, args) => {
  try { return await require('./server/printer').printStrip(args); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('camera-capture', async (_, args = {}) => {
  try { return await require('./server/camera').capturePhoto(args); }
  catch (e) { return { ok: false, error: e.message }; }
});

/* Webcam frame save — renderer sends base64 JPEG, we save it to disk */
ipcMain.handle('camera-capture-webcam', async (_, args = {}) => {
  try { return await require('./server/camera').captureWebcamFrame(args); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('camera-preview-start', async () => {
  try { return await require('./server/camera').startPreview(); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('camera-preview-stop', async () => {
  try { return require('./server/camera').stopPreview(); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('printer-status', async () => {
  try { return await require('./server/printer').getStatus(); }
  catch (e) { return { ok: false, ink: 0, paper: 0 }; }
});

ipcMain.handle('send-receipt', async (_, { type, contact, session: sess }) => {
  console.log(`[RECEIPT] ${type} → ${contact}`);
  return { ok: true };
});

ipcMain.on('log-error', (_, msg) => console.error('[RENDERER]', msg));

/* ── watchdog reboot: exit cleanly so watchdog restarts us ── */
ipcMain.handle('reboot-app', async () => {
  console.log('[WATCHDOG] Reboot requested — exiting cleanly');
  setTimeout(() => app.exit(0), 500);
  return { ok: true };
});

/* notify renderer when GCash payment is confirmed (called from webhook) */
ipcMain.on('gcash-payment-confirmed', (_, data) => {
  if (mainWindow && currentScreen === 'payment') {
    mainWindow.webContents.send('payment-confirmed', data);
  }
});

/* ── App lifecycle ── */
app.whenReady().then(() => {
  createWindow();

  /* ── watchdog heartbeat — write timestamp every 30s ── */
  const heartbeatFile = path.join(__dirname, 'assets/.heartbeat');
  function writeHeartbeat() {
    try { require('fs').writeFileSync(heartbeatFile, Date.now().toString()); } catch(e) {}
  }
  writeHeartbeat();
  setInterval(writeHeartbeat, 30000);
  console.log('[WATCHDOG] Heartbeat started');

  try { require('./server/index'); } catch(e) { console.error('[SERVER]', e.message); }
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else { app.on('second-instance', () => { if (mainWindow) { mainWindow.restore(); mainWindow.focus(); } }); }

module.exports = { loadScreen };