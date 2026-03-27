/**
 * network-monitor.js
 * Include on every screen BEFORE booth-reporter.js:
 *   <script src="network-monitor.js"></script>
 *
 * Provides:
 *   FP_NET.isOnline()            → boolean
 *   FP_NET.fetch(url, opts)      → like fetch(), retries on network error
 *   FP_NET.queue(key, url, opts) → queues a POST for offline delivery
 *   FP_NET.onStatusChange(fn)    → fn(true/false) called on change
 *
 * Offline queue is persisted in localStorage as fp_offline_queue.
 * When connection restores the queue drains automatically in order.
 *
 * Network state is determined by TWO signals combined:
 *   1. navigator.onLine  (instant, but unreliable on its own)
 *   2. Heartbeat fetch to /health every 15s (ground truth)
 *
 * Events fired on document:
 *   fp:online   — connection restored
 *   fp:offline  — connection lost
 */
(function () {
  'use strict';

  const SERVER       = (window.__FP__?.serverUrl) || 'http://localhost:3000';
  const HEARTBEAT_MS = 15000;   /* ping /health every 15s         */
  const DRAIN_MS     = 5000;    /* retry queue drain every 5s      */
  const MAX_QUEUE    = 50;      /* max queued items (ring buffer)  */
  const FETCH_TIMEOUT= 8000;    /* per-request timeout             */

  /* ── internal state ── */
  let _online        = navigator.onLine;
  let _heartbeatTimer= null;
  let _drainTimer    = null;
  let _listeners     = [];
  let _draining      = false;

  /* ── helpers ── */
  function readQueue() {
    try { return JSON.parse(localStorage.getItem('fp_offline_queue') || '[]'); }
    catch(_) { return []; }
  }
  function writeQueue(q) {
    try { localStorage.setItem('fp_offline_queue', JSON.stringify(q)); }
    catch(_) {}
  }
  function emit(online) {
    document.dispatchEvent(new CustomEvent(online ? 'fp:online' : 'fp:offline'));
    _listeners.forEach(fn => { try { fn(online); } catch(_) {} });
  }

  /* ── fetch with timeout ── */
  function fetchWithTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || FETCH_TIMEOUT);
    return fetch(url, { ...opts, signal: ctrl.signal })
      .finally(() => clearTimeout(timer));
  }

  /* ─────────────────────────────────────────
     HEARTBEAT — ground-truth network check
  ───────────────────────────────────────── */
  async function heartbeat() {
    try {
      await fetchWithTimeout(`${SERVER}/health`, { method: 'GET' }, 5000);
      setOnline(true);
    } catch(_) {
      setOnline(false);
    }
    _heartbeatTimer = setTimeout(heartbeat, HEARTBEAT_MS);
  }

  function setOnline(nowOnline) {
    if (nowOnline === _online) return;
    _online = nowOnline;
    console.log(`[FP_NET] ${nowOnline ? '🟢 online' : '🔴 offline'}`);
    emit(nowOnline);
    if (nowOnline) drainQueue();
  }

  /* browser online/offline events as fast-path */
  window.addEventListener('online',  () => heartbeat());
  window.addEventListener('offline', () => setOnline(false));

  /* ─────────────────────────────────────────
     OFFLINE QUEUE
  ───────────────────────────────────────── */

  /**
   * queue(key, url, opts)
   * Persists a fetch call for delivery when server is reachable.
   * key: unique string — if same key already queued, overwrites it
   *      (prevents duplicate reportScreen entries etc.)
   *      Pass null/undefined for non-deduplicating items (e.g. transactions).
   */
  function queue(key, url, opts) {
    const q = readQueue();

    /* deduplicate by key if provided */
    const entry = { id: Date.now() + '_' + Math.random().toString(36).slice(2), key, url, opts, ts: Date.now() };
    if (key) {
      const idx = q.findIndex(e => e.key === key);
      if (idx !== -1) { q[idx] = entry; writeQueue(q); return; }
    }

    /* ring buffer — drop oldest if full */
    if (q.length >= MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE + 1);
    q.push(entry);
    writeQueue(q);
  }

  /* drain: send all queued items in order */
  async function drainQueue() {
    if (_draining || !_online) return;
    _draining = true;
    let q = readQueue();
    if (q.length === 0) { _draining = false; return; }

    console.log(`[FP_NET] Draining ${q.length} queued item(s)…`);
    const failed = [];

    for (const entry of q) {
      try {
        const res = await fetchWithTimeout(entry.url, entry.opts, FETCH_TIMEOUT);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`[FP_NET] ✓ drained: ${entry.url}`);
      } catch(e) {
        console.warn(`[FP_NET] ✗ drain failed: ${entry.url} — ${e.message}`);
        failed.push(entry);
        _online = false; /* stop draining, wait for next heartbeat */
        break;
      }
    }

    writeQueue(failed);
    _draining = false;
  }

  /* periodic drain attempt when online */
  function startDrainLoop() {
    _drainTimer = setInterval(() => { if (_online) drainQueue(); }, DRAIN_MS);
  }

  /* ─────────────────────────────────────────
     RESILIENT FETCH
     Wraps fetch with:
       - timeout
       - 1 automatic retry after 2s on network error (not 4xx/5xx)
       - queues the call if still failing and queueOnFail=true
  ───────────────────────────────────────── */
  async function resilientFetch(url, opts = {}, { queueKey = null, queueOnFail = false, retries = 1 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchWithTimeout(url, opts, FETCH_TIMEOUT);
        return res; /* success */
      } catch(e) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 2000));
        } else {
          /* all retries exhausted */
          setOnline(false);
          if (queueOnFail) {
            queue(queueKey, url, opts);
            console.log(`[FP_NET] Queued for later: ${url}`);
          }
          throw e;
        }
      }
    }
  }

  /* ─────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────── */
  window.FP_NET = {
    isOnline:      ()       => _online,
    fetch:         resilientFetch,
    queue:         queue,
    drainQueue:    drainQueue,
    onStatusChange: (fn)    => { _listeners.push(fn); },
    queueSize:     ()       => readQueue().length,
  };

  /* ── boot ── */
  heartbeat();         /* first check immediately */
  startDrainLoop();    /* periodic drain */

  console.log(`[FP_NET] started · server=${SERVER} · online=${_online}`);
})();
