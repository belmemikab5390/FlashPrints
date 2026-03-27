/**
 * fp-bridge.js — Shared navigation + session bridge
 * Include this in every screen HTML:
 *   <script src="../screens/fp-bridge.js"></script>
 *
 * Provides:
 *   fpNavigate(screen, data)  — go to another screen
 *   fpSession()               — get current session object
 *   fpBooth()                 — get booth config
 *   fpResetIdle()             — reset idle timer
 */

(function () {
  /* detect if running inside Electron (real kiosk) or browser (dev/demo) */
  const isElectron = typeof window !== 'undefined' && window.FP !== undefined;

  /* ── session store (fallback for browser dev) ── */
  function getLocal(key, def) {
    try { return JSON.parse(localStorage.getItem(key)) || def; } catch { return def; }
  }
  function setLocal(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  /* ── navigate ── */
  window.fpNavigate = async function (screenName, data = {}) {
    /* merge data into session */
    const current = getLocal('fp_session', {});
    const merged  = { ...current, ...data };
    setLocal('fp_session', merged);

    if (isElectron) {
      /* Real Electron navigation — loads the actual HTML file */
      await window.FP.navigate(screenName, merged);
    } else {
      /* Browser fallback — map screen names to file paths */
      const MAP = {
        welcome:  'welcome.html',
        packages: 'packages.html',
        payment:  'payment.html',
        mood:     'mood.html',
        camera:   'camera.html',
        preview:  'preview.html',
        printing: 'printing.html',
        receipt:  'receipt.html',
        done:     'done.html',
      };
      const file = MAP[screenName];
      if (file) {
        /* flash transition */
        const d = document.createElement('div');
        d.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:0;z-index:9999;pointer-events:none;transition:opacity 0.15s;';
        document.body.appendChild(d);
        requestAnimationFrame(() => { d.style.opacity = '0.7'; });
        setTimeout(() => { window.location.href = file; }, 200);
      }
    }
  };

  /* ── session ── */
  window.fpSession = async function () {
    if (isElectron) return window.FP.getSession();
    return getLocal('fp_session', {});
  };

  /* ── booth config ── */
  window.fpBooth = function () {
    if (isElectron && window.__FP__) return window.__FP__.booth;
    return { id: '001', location: 'SM City North EDSA', floor: 'Level 2' };
  };

  /* ── reset idle ── */
  window.fpResetIdle = function () {
    if (isElectron) window.FP.resetIdle();
    document.addEventListener('click',     fpResetIdle, { once: true });
    document.addEventListener('touchstart',fpResetIdle, { once: true });
  };

  /* ── GCash ── */
  window.fpGCash = {
    createQR: async (amount, sessionId) => {
      if (isElectron) return window.FP.gcash.createQR(amount, sessionId);
      /* browser simulation */
      const ref = `FP-001-${Date.now()}`;
      return { ok: true, referenceId: ref, amount, qrCodeData: `SIMULATED:${ref}`, expiresAt: Date.now()+600000, sandboxMode: true };
    },
    checkStatus: async (referenceId) => {
      if (isElectron) return window.FP.gcash.checkStatus(referenceId);
      return { ok: true, status: 'PENDING' };
    },
    onConfirmed: (callback) => {
      if (isElectron) window.FP.onPaymentConfirmed(callback);
    },
  };

  /* ── Camera ── */
  window.fpCamera = {
    capture: async () => {
      if (isElectron) return window.FP.camera.capture();
      return { ok: true, path: null, simulated: true };
    },
  };

  /* ── Printer ── */
  window.fpPrinter = {
    print: async (args) => {
      if (isElectron) return window.FP.printer.print(args);
      return { ok: true, simulated: true };
    },
    getStatus: async () => {
      if (isElectron) return window.FP.printer.getStatus();
      return { ok: true, ink: 80, paper: 75, simulated: true };
    },
  };

  /* ── Receipt ── */
  window.fpSendReceipt = async (type, contact) => {
    const sess = await window.fpSession();
    if (isElectron) return window.FP.sendReceipt(type, contact, sess);
    console.log(`[RECEIPT SIM] ${type} → ${contact}`);
    return { ok: true, simulated: true };
  };

  /* ── inject __FP__ from Electron if available ── */
  window.onFPData = function(data) {
    window.__FP__ = data;
    /* update local session from Electron state */
    if (data.session) setLocal('fp_session', data.session);
  };

  /* auto-call onFPData if already injected */
  if (window.__FP__) window.onFPData(window.__FP__);

  /* reset idle on any interaction */
  ['click','touchstart','mousemove','keydown'].forEach(ev => {
    document.addEventListener(ev, () => { if(isElectron) window.FP.resetIdle(); }, { passive: true });
  });

  console.log(`[FP Bridge] running in ${isElectron ? 'Electron' : 'browser'} mode`);
})();
