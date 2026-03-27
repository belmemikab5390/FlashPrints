/**
 * watchdog-service.js — Windows Service installer
 *
 * Installs the watchdog as a Windows service that:
 *   - Starts automatically when Windows boots (even before login)
 *   - Restarts if the watchdog itself crashes
 *   - Runs as LocalSystem with access to display
 *
 * Usage:
 *   node watchdog-service.js install    ← run once as Administrator
 *   node watchdog-service.js uninstall  ← remove service
 *   node watchdog-service.js status     ← check if running
 *
 * Requires: npm install node-windows
 */

const path    = require('path');
const { exec } = require('child_process');

const SERVICE_NAME = 'FlashAndPrintsKiosk';
const SERVICE_DESC = 'Flash & Prints Photobooth Kiosk Auto-Start Service';
const NODE_PATH    = process.execPath;
const WATCHDOG     = path.join(__dirname, 'watchdog.js');

const action = process.argv[2] || 'help';

/* ── check if node-windows is available ── */
function checkDeps(cb) {
  try {
    require('node-windows');
    cb(true);
  } catch(e) {
    console.log('Installing node-windows...');
    exec('npm install node-windows --save', (err) => {
      if (err) { console.error('Failed to install node-windows:', err.message); process.exit(1); }
      cb(true);
    });
  }
}

if (action === 'install') {
  if (process.platform !== 'win32') {
    console.log('Windows service install is only needed on Windows.');
    console.log('On macOS/Linux, use PM2 instead:');
    console.log('  npm install -g pm2');
    console.log('  pm2 start watchdog.js --name flash-prints');
    console.log('  pm2 startup && pm2 save');
    process.exit(0);
  }

  checkDeps(() => {
    const { Service } = require('node-windows');
    const svc = new Service({
      name:        SERVICE_NAME,
      description: SERVICE_DESC,
      script:      WATCHDOG,
      nodeOptions: [],
      env: [
        { name: 'BOOTH_ID',       value: process.env.BOOTH_ID       || '001'               },
        { name: 'BOOTH_LOCATION', value: process.env.BOOTH_LOCATION || 'SM City North EDSA' },
        { name: 'NODE_ENV',       value: 'production'                                        },
      ],
    });

    svc.on('install',   () => { console.log('✓ Service installed'); svc.start(); });
    svc.on('start',     () => console.log('✓ Service started — kiosk will auto-start on boot'));
    svc.on('error',     e  => console.error('✗ Service error:', e));
    svc.on('alreadyinstalled', () => console.log('Service already installed — use "status" to check'));

    console.log(`Installing "${SERVICE_NAME}" Windows service...`);
    svc.install();
  });

} else if (action === 'uninstall') {
  checkDeps(() => {
    const { Service } = require('node-windows');
    const svc = new Service({ name: SERVICE_NAME, script: WATCHDOG });
    svc.on('uninstall', () => console.log('✓ Service uninstalled'));
    svc.uninstall();
  });

} else if (action === 'status') {
  exec(`sc query "${SERVICE_NAME}"`, (err, stdout) => {
    if (err) { console.log('Service not installed or not found'); return; }
    const running = stdout.includes('RUNNING');
    console.log(`Service "${SERVICE_NAME}": ${running ? '✓ RUNNING' : '✗ NOT RUNNING'}`);
    console.log(stdout);
  });

} else if (action === 'pm2') {
  /* cross-platform alternative using PM2 */
  console.log('Setting up with PM2 (cross-platform)...');
  exec('pm2 start watchdog.js --name flash-prints --restart-delay 8000 --max-restarts 10', (err, stdout) => {
    if (err) { console.error('PM2 error — is it installed? Run: npm install -g pm2'); return; }
    console.log(stdout);
    exec('pm2 save && pm2 startup', (err2, out2) => {
      console.log(out2 || 'PM2 startup configured');
    });
  });

} else {
  console.log(`
Flash & Prints — Watchdog Service Manager

Usage:
  node watchdog-service.js install    Install as Windows service (run as Admin)
  node watchdog-service.js uninstall  Remove Windows service
  node watchdog-service.js status     Check service status
  node watchdog-service.js pm2        Set up with PM2 (cross-platform)

Manual start (no service):
  node watchdog.js                    Start watchdog directly
  node watchdog.js --dev              Development mode
  `);
}
