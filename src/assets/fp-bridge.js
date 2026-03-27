/**
 * fp-bridge.js
 *
 * Injected into every kiosk screen via a <script> tag.
 * Provides a unified navigation API that works in:
 *   - Electron (uses window.fp from preload.js)
 *   - Browser preview (uses localStorage + window.location)
 *
 * Usage in any screen:
 *   FP.goto('packages')
 *   FP.session.set('selectedPackage', { name:'Classic Strip', price:89 })
 *   FP.session.get('selectedPackage')
 *   FP.gcash.pollUntilPaid(ref, onPaid, onFailed)
 */

window.FP = (() => {

  const SCREENS = {
    welcome:  'welcome.html',
    packages: 'packages.html',
    payment:  'payment.html',
    camera:   'camera.html',
    preview:  'preview.html',
    printing: 'printing.html',
    receipt:  'receipt.html',
    done:     'done.html',
  };

  const isElectron = typeof window.fp !== 'undefined';

  // ── Navigation ─────────────────────────────────────────────────
  function goto(screen) {
    if (!SCREENS[screen]) {
      console.error('[FP] Unknown screen:', screen);
      return;
    }
    flashWhite(() => {
      if (isElectron) {
        window.fp.navigate(screen);
      } else {
        window.location.href = SCREENS[screen];
      }
    });
  }

  // ── White flash transition ─────────────────────────────────────
  function flashWhite(callback, delay = 280) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'inset:0', 'background:#fff',
      'opacity:0', 'z-index:9999', 'pointer-events:none',
      'transition:opacity 0.2s',
    ].join(';');
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '0.65'; });
    setTimeout(() => {
      callback();
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, delay);
  }

  // ── Session store ──────────────────────────────────────────────
  const session = {
    set(key, value) {
      try { localStorage.setItem(`fp_${key}`, JSON.stringify(value)); } catch {}
      if (isElectron) window.fp.store.set(key, JSON.stringify(value));
    },
    get(key) {
      try {
        const raw = localStorage.getItem(`fp_${key}`);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
    clear() {
      Object.keys(localStorage)
        .filter(k => k.startsWith('fp_'))
        .forEach(k => localStorage.removeItem(k));
    },
    // Convenience: save full session object
    saveOrder(pkg, filter) {
      this.set('package', pkg);
      this.set('filter', filter);
      this.set('sessionId', `${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`);
      this.set('sessionStart', new Date().toISOString());
    },
    getOrder() {
      return {
        package:   this.get('package'),
        filter:    this.get('filter'),
        sessionId: this.get('sessionId'),
        sessionStart: this.get('sessionStart'),
      };
    },
  };

  // ── GCash polling ──────────────────────────────────────────────
  const gcash = {
    _pollTimer: null,

    /**
     * Poll /api/gcash/status/:ref every 2 seconds.
     * Calls onPaid() when PAID, onFailed() on FAILED/EXPIRED.
     */
    pollUntilPaid(ref, onPaid, onFailed, timeoutMs = 600_000) {
      let elapsed = 0;
      const INTERVAL = 2000;

      this._pollTimer = setInterval(async () => {
        elapsed += INTERVAL;

        try {
          let status;
          if (isElectron) {
            status = await window.fp.gcash.checkStatus(ref);
          } else {
            const res = await fetch(`http://127.0.0.1:3001/api/gcash/status/${ref}`);
            const data = await res.json();
            status = data.status;
          }

          if (status === 'PAID') {
            this.stopPolling();
            onPaid();
          } else if (status === 'FAILED' || status === 'EXPIRED') {
            this.stopPolling();
            onFailed(status);
          }
        } catch (e) {
          console.warn('[GCash Poll] Error:', e.message);
        }

        if (elapsed >= timeoutMs) {
          this.stopPolling();
          onFailed('TIMEOUT');
        }
      }, INTERVAL);
    },

    stopPolling() {
      if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
    },

    /**
     * Create a new GCash session and return QR data.
     */
    async createQR({ amount, pkg, filter }) {
      const res = await fetch('http://127.0.0.1:3001/api/gcash/create', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ amount, pkg, filter }),
      });
      return res.json(); // { ok, ref, orNum, qrDataURL, expiresIn }
    },
  };

  // ── Booth config ───────────────────────────────────────────────
  async function getBoothConfig() {
    if (isElectron) return window.fp.boothConfig();
    return { boothId: '001', boothName: 'SM City North EDSA', boothFloor: 'Level 2' };
  }

  // ── Stats ──────────────────────────────────────────────────────
  async function recordSale(amount) {
    if (isElectron) return window.fp.stats.increment(amount);
  }

  // ── Idle reset helper ──────────────────────────────────────────
  function startIdleReset(seconds = 180, onReset) {
    let remaining = seconds;
    const t = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(t);
        session.clear();
        onReset ? onReset() : goto('welcome');
      }
    }, 1000);

    // Reset timer on any interaction
    const resetTimer = () => { remaining = seconds; };
    ['click', 'touchstart', 'mousemove', 'keydown'].forEach(ev => {
      document.addEventListener(ev, resetTimer, { passive: true });
    });

    return {
      stop: () => {
        clearInterval(t);
        ['click', 'touchstart', 'mousemove', 'keydown'].forEach(ev => {
          document.removeEventListener(ev, resetTimer);
        });
      },
      getRemaining: () => remaining,
    };
  }

  // ── Public API ─────────────────────────────────────────────────
  return { goto, session, gcash, getBoothConfig, recordSale, startIdleReset, flashWhite };
})();
