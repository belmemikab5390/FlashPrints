/**
 * error-overlay.js
 * Shared full-screen error overlay for Flash & Prints kiosk screens.
 * Include on every screen AFTER network-monitor.js and booth-reporter.js:
 *   <script src="error-overlay.js"></script>
 *
 * Usage:
 *   FP_ERROR.show(type, opts)   — display a full-screen error
 *   FP_ERROR.hide()             — dismiss (if dismissable)
 *   FP_ERROR.check()            — poll server for active errors right now
 *
 * Error types:
 *   'printer_offline'   — printer USB/power issue
 *   'printer_jam'       — paper jam detected
 *   'paper_empty'       — paper critically low / out
 *   'ink_empty'         — ink critically low / out
 *   'camera_fail'       — camera not found or capture failed
 *   'server_offline'    — local Express server unreachable
 *   'generic'           — catch-all with custom title/message
 *
 * Each error config defines:
 *   icon        SVG markup
 *   color       theme color (rose for hardware, gold for supply, blue for network)
 *   title       headline
 *   sub         customer-facing explanation (calm, non-technical)
 *   staffNote   staff-facing detail shown in small text
 *   canDismiss  whether customer can tap past it (default false)
 *   autoRetry   seconds between auto-recheck; 0 = no auto-retry
 *   showStaff   show "please see a staff member" footer
 *   goHome      show "return to start" button (for non-blocking errors)
 */
(function () {
  'use strict';

  const SERVER = (window.__FP__?.serverUrl) || 'http://localhost:3000';

  /* ── error type definitions ── */
  const ERROR_TYPES = {

    printer_offline: {
      color:      '#C84B6E',
      colorBg:    'rgba(200,75,110,0.08)',
      colorBorder:'rgba(200,75,110,0.25)',
      icon: `<svg width="56" height="56" viewBox="0 0 56 56" fill="none">
        <rect x="8" y="16" width="40" height="28" rx="6" stroke="rgba(200,75,110,0.7)" stroke-width="2.5"/>
        <rect x="16" y="24" width="24" height="12" rx="3" stroke="rgba(200,75,110,0.4)" stroke-width="1.5"/>
        <path d="M20 40 L20 48 L36 48 L36 40" stroke="rgba(200,75,110,0.5)" stroke-width="2" stroke-linejoin="round"/>
        <path d="M8 8 L48 48" stroke="rgba(200,75,110,0.6)" stroke-width="2.5" stroke-linecap="round"/>
      </svg>`,
      title:      'Printer unavailable',
      sub:        'The printer is not responding. We\'re working on it — please hold on for a moment.',
      staffNote:  'Check printer USB cable, power switch, and Windows printer driver. Restart printer if needed.',
      showStaff:  true,
      autoRetry:  15,
      canDismiss: false,
    },

    printer_jam: {
      color:      '#C84B6E',
      colorBg:    'rgba(200,75,110,0.08)',
      colorBorder:'rgba(200,75,110,0.25)',
      icon: `<svg width="56" height="56" viewBox="0 0 56 56" fill="none">
        <rect x="8" y="16" width="40" height="28" rx="6" stroke="rgba(200,75,110,0.7)" stroke-width="2.5"/>
        <path d="M20 44 L28 36 L36 44" stroke="rgba(200,75,110,0.6)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="22" y="36" width="12" height="8" rx="2" fill="rgba(200,75,110,0.15)" stroke="rgba(200,75,110,0.4)" stroke-width="1.5"/>
        <path d="M28 22 L28 30" stroke="rgba(200,75,110,0.8)" stroke-width="2.5" stroke-linecap="round"/>
        <circle cx="28" cy="34" r="1.5" fill="rgba(200,75,110,0.8)"/>
      </svg>`,
      title:      'Paper jam detected',
      sub:        'The printer has a paper jam. Please do not touch the machine — a staff member will fix this shortly.',
      staffNote:  'Open printer cover, gently remove jammed paper, close cover and press Resume. Do not force paper.',
      showStaff:  true,
      autoRetry:  20,
      canDismiss: false,
    },

    paper_empty: {
      color:      '#E8C547',
      colorBg:    'rgba(232,197,71,0.07)',
      colorBorder:'rgba(232,197,71,0.25)',
      icon: `<svg width="56" height="56" viewBox="0 0 56 56" fill="none">
        <rect x="14" y="8" width="28" height="38" rx="4" stroke="rgba(232,197,71,0.6)" stroke-width="2.5"/>
        <path d="M20 18 L36 18" stroke="rgba(232,197,71,0.3)" stroke-width="2" stroke-linecap="round"/>
        <path d="M20 24 L36 24" stroke="rgba(232,197,71,0.3)" stroke-width="2" stroke-linecap="round"/>
        <path d="M20 30 L28 30" stroke="rgba(232,197,71,0.3)" stroke-width="2" stroke-linecap="round"/>
        <path d="M12 50 L44 50" stroke="rgba(232,197,71,0.6)" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M28 38 L28 50" stroke="rgba(232,197,71,0.5)" stroke-width="2" stroke-linecap="round"/>
      </svg>`,
      title:      'Paper needs refilling',
      sub:        'The printer has run out of photo paper. A staff member has been notified and will refill it shortly.',
      staffNote:  'Load new paper roll into DNP DS620A. Align correctly before closing cover. Estimated wait: 2–3 min.',
      showStaff:  true,
      autoRetry:  30,
      canDismiss: false,
    },

    ink_empty: {
      color:      '#E8C547',
      colorBg:    'rgba(232,197,71,0.07)',
      colorBorder:'rgba(232,197,71,0.25)',
      icon: `<svg width="56" height="56" viewBox="0 0 56 56" fill="none">
        <path d="M28 10 C28 10 16 24 16 33 C16 39.6 21.4 45 28 45 C34.6 45 40 39.6 40 33 C40 24 28 10 28 10Z" stroke="rgba(232,197,71,0.6)" stroke-width="2.5" fill="none"/>
        <path d="M22 38 C22 38 24 33 28 33" stroke="rgba(232,197,71,0.4)" stroke-width="2" stroke-linecap="round"/>
        <path d="M12 6 L44 50" stroke="rgba(232,197,71,0.5)" stroke-width="2" stroke-linecap="round"/>
      </svg>`,
      title:      'Ink ribbon low',
      sub:        'The ink ribbon needs to be replaced. A staff member has been notified and will replace it shortly.',
      staffNote:  'Replace DNP DS620A ink ribbon cassette. Install new ribbon before next print job. Estimated wait: 5 min.',
      showStaff:  true,
      autoRetry:  30,
      canDismiss: false,
    },

    camera_fail: {
      color:      '#C84B6E',
      colorBg:    'rgba(200,75,110,0.08)',
      colorBorder:'rgba(200,75,110,0.25)',
      icon: `<svg width="56" height="56" viewBox="0 0 56 56" fill="none">
        <rect x="6" y="16" width="44" height="30" rx="6" stroke="rgba(200,75,110,0.6)" stroke-width="2.5"/>
        <circle cx="28" cy="31" r="9" stroke="rgba(200,75,110,0.4)" stroke-width="2"/>
        <path d="M20 16 L23 10 L33 10 L36 16" stroke="rgba(200,75,110,0.4)" stroke-width="2" stroke-linejoin="round"/>
        <path d="M19 22 L37 40" stroke="rgba(200,75,110,0.6)" stroke-width="2.5" stroke-linecap="round"/>
      </svg>`,
      title:      'Camera not responding',
      sub:        'We\'re having trouble connecting to the camera. Please wait while we try to reconnect automatically.',
      staffNote:  'Check DSLR USB/tether cable and DSLR Remote Pro connection. Restart camera and try again.',
      showStaff:  true,
      autoRetry:  10,
      canDismiss: false,
    },

    server_offline: {
      color:      '#3D7AAA',
      colorBg:    'rgba(61,122,170,0.08)',
      colorBorder:'rgba(61,122,170,0.25)',
      icon: `<svg width="56" height="56" viewBox="0 0 56 56" fill="none">
        <rect x="8" y="18" width="40" height="22" rx="5" stroke="rgba(61,122,170,0.6)" stroke-width="2.5"/>
        <circle cx="16" cy="29" r="2.5" fill="rgba(61,122,170,0.5)"/>
        <circle cx="24" cy="29" r="2.5" fill="rgba(61,122,170,0.3)"/>
        <path d="M32 29 L44 29" stroke="rgba(61,122,170,0.3)" stroke-width="2" stroke-linecap="round"/>
        <path d="M28 40 L28 48 M20 48 L36 48" stroke="rgba(61,122,170,0.4)" stroke-width="2" stroke-linecap="round"/>
        <path d="M10 10 L46 46" stroke="rgba(61,122,170,0.5)" stroke-width="2" stroke-linecap="round"/>
      </svg>`,
      title:      'Connection issue',
      sub:        'The kiosk is temporarily having trouble connecting. Your session is safe. We\'re reconnecting now.',
      staffNote:  'Check local network / router. Verify Express server is running (npm run server). Check firewall.',
      showStaff:  false,  /* handled by network-monitor.js banner instead */
      autoRetry:  10,
      canDismiss: true,
    },

    generic: {
      color:      '#C84B6E',
      colorBg:    'rgba(200,75,110,0.08)',
      colorBorder:'rgba(200,75,110,0.25)',
      icon: `<svg width="56" height="56" viewBox="0 0 56 56" fill="none">
        <path d="M28 8 L50 46 L6 46 Z" stroke="rgba(200,75,110,0.6)" stroke-width="2.5" fill="none" stroke-linejoin="round"/>
        <path d="M28 22 L28 33" stroke="rgba(200,75,110,0.8)" stroke-width="2.5" stroke-linecap="round"/>
        <circle cx="28" cy="39" r="2" fill="rgba(200,75,110,0.8)"/>
      </svg>`,
      title:      'Something went wrong',
      sub:        'An unexpected issue occurred. Please wait while we sort it out.',
      staffNote:  'Check server logs for details.',
      showStaff:  true,
      autoRetry:  0,
      canDismiss: false,
    },
  };

  /* ── active error state ── */
  let _activeType     = null;
  let _retryTimer     = null;
  let _retryCountdown = null;
  let _onResolve      = null;   /* callback when error clears */

  /* ─────────────────────────────────────────
     SHOW — render the full-screen error
  ───────────────────────────────────────── */
  function show(type, opts = {}) {
    const cfg = { ...(ERROR_TYPES[type] || ERROR_TYPES.generic) };

    /* allow overrides from caller */
    if (opts.title)     cfg.title     = opts.title;
    if (opts.sub)       cfg.sub       = opts.sub;
    if (opts.staffNote) cfg.staffNote = opts.staffNote;
    if (opts.onResolve) _onResolve    = opts.onResolve;

    /* don't re-render same error that's already showing */
    if (_activeType === type) return;
    _activeType = type;

    /* report to dashboard */
    try {
      if (typeof reportBoothError === 'function') reportBoothError(type, cfg.title);
    } catch(_) {}

    /* remove any existing overlay */
    _removeEl();
    clearInterval(_retryTimer);
    clearInterval(_retryCountdown);

    /* inject overlay */
    const el = document.createElement('div');
    el.id = '__fp_error_overlay__';
    el.style.cssText = [
      'position:fixed;inset:0;z-index:99990;',
      'background:rgba(10,10,18,0.97);',
      'display:flex;flex-direction:column;align-items:center;justify-content:center;',
      'font-family:"DM Sans",sans-serif;padding:60px 80px;text-align:center;',
      'animation:fpErrIn 0.4s cubic-bezier(0.34,1.2,0.64,1) both;',
    ].join('');

    const retryIn = cfg.autoRetry > 0 ? cfg.autoRetry : 0;

    el.innerHTML = `
      <style>
        @keyframes fpErrIn { from{opacity:0;transform:scale(0.95)} to{opacity:1;transform:scale(1)} }
        @keyframes fpSpinSlow { to{transform:rotate(360deg)} }
        @keyframes fpErrPulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
        .__fp_err_icon_wrap {
          width:120px; height:120px; border-radius:50%;
          background:${cfg.colorBg};
          border:2px solid ${cfg.colorBorder};
          display:flex; align-items:center; justify-content:center;
          margin-bottom:28px;
          animation:fpErrPulse 2.5s ease-in-out infinite;
        }
        .__fp_err_title {
          font-family:'Playfair Display',serif;
          font-size:44px; font-weight:900; color:#fff;
          margin-bottom:16px; line-height:1.1;
        }
        .__fp_err_sub {
          font-size:20px; color:rgba(255,255,255,0.45);
          line-height:1.6; max-width:640px; margin-bottom:28px;
        }
        .__fp_err_staff {
          background:${cfg.colorBg};
          border:1px solid ${cfg.colorBorder};
          border-radius:14px; padding:16px 24px;
          max-width:600px; width:100%; margin-bottom:28px;
          text-align:left;
        }
        .__fp_err_staff_label {
          font-family:'Space Mono',monospace; font-size:9px;
          letter-spacing:3px; color:${cfg.color}; opacity:0.7;
          text-transform:uppercase; margin-bottom:6px;
        }
        .__fp_err_staff_msg {
          font-size:13px; color:rgba(255,255,255,0.5); line-height:1.5;
        }
        .__fp_err_retry_row {
          display:flex; align-items:center; gap:10px;
          color:rgba(255,255,255,0.25);
          font-family:'Space Mono',monospace; font-size:11px;
          letter-spacing:1px; margin-top:8px;
        }
        .__fp_err_spinner {
          width:14px; height:14px; border-radius:50%;
          border:2px solid rgba(255,255,255,0.1);
          border-top-color:${cfg.color};
          animation:fpSpinSlow 1s linear infinite;
        }
        .__fp_err_dismiss_btn {
          margin-top:24px; padding:16px 40px; border-radius:14px;
          background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12);
          color:rgba(255,255,255,0.4); font-family:'DM Sans',sans-serif;
          font-size:15px; cursor:pointer; transition:all 0.15s;
        }
        .__fp_err_dismiss_btn:active { background:rgba(255,255,255,0.1); transform:scale(0.97); }
        .__fp_err_home_btn {
          margin-top:16px; padding:18px 48px; border-radius:16px;
          background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1);
          color:rgba(255,255,255,0.35); font-family:'DM Sans',sans-serif;
          font-size:16px; cursor:pointer; transition:all 0.15s;
        }
        .__fp_err_home_btn:active { transform:scale(0.97); }
        .__fp_err_please_staff {
          margin-top:24px; padding:14px 32px;
          border-radius:30px;
          background:${cfg.colorBg};
          border:1px solid ${cfg.colorBorder};
          display:inline-flex; align-items:center; gap:10px;
          font-size:14px; color:${cfg.color}; opacity:0.85;
        }
        .__fp_err_booth {
          position:fixed; bottom:24px; left:0; right:0; text-align:center;
          font-family:'Space Mono',monospace; font-size:10px;
          color:rgba(255,255,255,0.12); letter-spacing:2px;
        }
      </style>

      <div class="__fp_err_icon_wrap">${cfg.icon}</div>
      <div class="__fp_err_title">${cfg.title}</div>
      <div class="__fp_err_sub">${cfg.sub}</div>

      ${cfg.staffNote ? `
        <div class="__fp_err_staff">
          <div class="__fp_err_staff_label">staff note</div>
          <div class="__fp_err_staff_msg">${cfg.staffNote}</div>
        </div>
      ` : ''}

      ${retryIn > 0 ? `
        <div class="__fp_err_retry_row">
          <div class="__fp_err_spinner"></div>
          <span>checking automatically in <span id="__fp_err_cd__">${retryIn}</span>s</span>
        </div>
      ` : ''}

      ${cfg.showStaff ? `
        <div class="__fp_err_please_staff">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="5" r="3" stroke="${cfg.color}" stroke-width="1.5"/>
            <path d="M2 14C2 11.2 4.7 9 8 9s6 2.2 6 5" stroke="${cfg.color}" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          please see a staff member for assistance
        </div>
      ` : ''}

      ${cfg.canDismiss ? `<button class="__fp_err_dismiss_btn" onclick="window.FP_ERROR.hide()">continue anyway</button>` : ''}

      ${opts.goHome ? `<button class="__fp_err_home_btn" onclick="window.FP_ERROR._goHome()">← return to start</button>` : ''}

      <div class="__fp_err_booth">BOOTH #${window.__FP__?.booth?.id || '001'} · ${new Date().toLocaleTimeString()}</div>
    `;

    document.body.appendChild(el);

    /* ── auto-retry countdown ── */
    if (retryIn > 0) {
      let remaining = retryIn;
      _retryCountdown = setInterval(() => {
        remaining--;
        const cd = document.getElementById('__fp_err_cd__');
        if (cd) cd.textContent = remaining;
        if (remaining <= 0) {
          clearInterval(_retryCountdown);
          /* recheck — if cleared, hide overlay */
          check().then(errors => {
            if (!errors.includes(type)) {
              hide();
              if (_onResolve) { _onResolve(); _onResolve = null; }
            } else {
              /* still broken — reset countdown */
              _activeType = null;
              show(type, opts);
            }
          });
        }
      }, 1000);
    }
  }

  /* ─────────────────────────────────────────
     HIDE
  ───────────────────────────────────────── */
  function hide() {
    _activeType = null;
    clearInterval(_retryTimer);
    clearInterval(_retryCountdown);
    _removeEl();
  }

  function _removeEl() {
    const el = document.getElementById('__fp_error_overlay__');
    if (el) {
      el.style.animation = 'none';
      el.style.opacity   = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 300);
    }
  }

  function _goHome() {
    hide();
    if (typeof fpNavigate === 'function') fpNavigate('welcome');
    else window.location.href = 'welcome.html';
  }

  /* ─────────────────────────────────────────
     CHECK — poll server for active errors
     Returns array of active error type strings.
  ───────────────────────────────────────── */
  async function check() {
    const active = [];
    try {
      const res  = await fetch(`${SERVER}/api/supply/status`);
      const data = await res.json();

      if (!data.ok) {
        active.push('server_offline');
        return active;
      }

      const printer = data.printer || {};

      /* printer offline */
      if (printer.offline) active.push('printer_offline');

      /* paper jam */
      if (printer.printerStatus === 'jammed' ||
          (printer.errorState && printer.errorState > 0)) {
        active.push('printer_jam');
      }

      /* supply alerts */
      const alerts = data.alerts || [];
      for (const a of alerts) {
        if (a.type === 'critical' && a.supply === 'paper') active.push('paper_empty');
        if (a.type === 'critical' && a.supply === 'ink')   active.push('ink_empty');
      }

    } catch(_) {
      /* server unreachable — network-monitor handles the banner */
    }
    return active;
  }

  /* ─────────────────────────────────────────
     CHECK BEFORE PRINT — call this on printing
     screen before starting the print job.
     Returns true if safe to print, false if blocked.
  ───────────────────────────────────────── */
  async function checkBeforePrint(onClear) {
    const errors = await check();

    /* priority order: jam → offline → paper → ink */
    if (errors.includes('printer_jam')) {
      show('printer_jam', { onResolve: onClear });
      return false;
    }
    if (errors.includes('printer_offline')) {
      show('printer_offline', { onResolve: onClear });
      return false;
    }
    if (errors.includes('paper_empty')) {
      show('paper_empty', { onResolve: onClear });
      return false;
    }
    if (errors.includes('ink_empty')) {
      show('ink_empty', { onResolve: onClear });
      return false;
    }
    return true;
  }

  /* ─────────────────────────────────────────
     CAMERA FAIL helper — call from camera screen
  ───────────────────────────────────────── */
  function showCameraFail(opts = {}) {
    show('camera_fail', {
      ...opts,
      goHome: true,
    });
  }

  /* ─────────────────────────────────────────
     LISTEN to network-monitor events
     Show/hide server_offline overlay in response.
     (Only on screens where it's relevant — not payment which has its own UI)
  ───────────────────────────────────────── */
  const screenName = location.pathname.split('/').pop().replace('.html', '');
  const SKIP_SERVER_OVERLAY = ['payment']; /* payment has its own offline UI */

  if (!SKIP_SERVER_OVERLAY.includes(screenName)) {
    document.addEventListener('fp:offline', () => {
      /* don't stomp an already-showing hardware error */
      if (_activeType && _activeType !== 'server_offline') return;
      /* only show server offline overlay on printing screen
         (most critical place), banner elsewhere */
      if (screenName === 'printing') {
        show('server_offline', { canDismiss: true });
      }
    });
    document.addEventListener('fp:online', () => {
      if (_activeType === 'server_offline') hide();
    });
  }

  /* ─────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────── */
  window.FP_ERROR = {
    show,
    hide,
    check,
    checkBeforePrint,
    showCameraFail,
    _goHome,
    isShowing: () => !!_activeType,
    activeType: () => _activeType,
  };

  console.log(`[FP_ERROR] loaded · screen=${screenName}`);
})();
