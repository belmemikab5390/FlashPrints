/**
 * booth-reporter.js
 * Include in every screen HTML (after network-monitor.js, after fp-bridge.js):
 *   <script src="network-monitor.js"></script>
 *   <script src="fp-bridge.js"></script>
 *   <script src="booth-reporter.js"></script>
 *
 * Handles:
 *   - Reports current screen on every page load
 *   - Polls for remote commands every 3s (reliable ACK loop)
 *   - Executes: reboot, unlock, maintenance, resume, clearErrors,
 *               ping, setMessage, resetIdle, printTest
 *   - Reports session start/end and supply levels
 *   - Records transactions after session completion
 *   - Shows/clears a network-status banner when server is unreachable
 *   - Queues failed POSTs via FP_NET.queue() for offline delivery
 */
(function() {
  const SERVER = (window.__FP__?.serverUrl) || 'http://localhost:3000';
  const screenName = location.pathname.split('/').pop().replace('.html','') || 'welcome';
  let pollActive = true;

  /* ── network banner (subtle — not alarming to customers) ── */
  function showNetworkBanner(msg) {
    let b = document.getElementById('__fp_net_banner__');
    if (!b) {
      b = document.createElement('div');
      b.id = '__fp_net_banner__';
      b.style.cssText = [
        'position:fixed;bottom:0;left:0;right:0;z-index:99998;',
        'background:rgba(200,75,110,0.12);border-top:1px solid rgba(200,75,110,0.25);',
        'padding:8px 24px;display:flex;align-items:center;justify-content:space-between;',
        'font-family:"DM Sans",sans-serif;font-size:12px;color:rgba(200,75,110,0.8);',
        'transition:opacity 0.4s;',
      ].join('');
      document.body.appendChild(b);
    }
    const qSize = (window.FP_NET?.queueSize?.() || 0);
    b.innerHTML = `
      <span>⚡ server offline — data queuing locally${qSize > 0 ? ' (' + qSize + ' pending)' : ''}</span>
      <span style="opacity:0.5;font-family:'Space Mono',monospace;font-size:10px;letter-spacing:1px;">BOOTH #${window.__FP__?.booth?.id || '001'}</span>`;
  }

  function clearNetworkBanner() {
    const b = document.getElementById('__fp_net_banner__');
    if (b) {
      b.style.opacity = '0';
      setTimeout(() => b.remove(), 400);
    }
  }

  /* hook into network-monitor events if available */
  if (window.FP_NET) {
    document.addEventListener('fp:offline', () => showNetworkBanner());
    document.addEventListener('fp:online',  () => clearNetworkBanner());
    if (!window.FP_NET.isOnline()) showNetworkBanner();
  }

  /* ── report screen on load ── */
  async function reportScreen() {
    const url  = `${SERVER}/api/booth/screen`;
    const opts = { method:'POST', headers:{'Content-Type':'application/json'},
                   body: JSON.stringify({ screen: screenName }) };
    try {
      await fetch(url, opts);
    } catch(_) {
      /* queue with key so only the latest screen state is kept */
      if (window.FP_NET) window.FP_NET.queue('booth:screen', url, opts);
    }
  }

  /* ════════════════════════════════
     COMMAND POLL LOOP
     Polls /api/commands/pending every 3s.
     On receiving a command: execute it, then ACK.
  ════════════════════════════════ */
  async function pollCommands() {
    if (!pollActive) return;
    try {
      const res  = await fetch(`${SERVER}/api/commands/pending`);
      const data = await res.json();
      if (data.command) {
        console.log(`[BOOTH CMD] Received: ${data.command.command} (${data.command.id})`);
        await executeCommand(data.command);
      }
    } catch(_) { /* server offline — keep trying */ }
    setTimeout(pollCommands, 3000);
  }

  /* ── execute command and send ACK ── */
  async function executeCommand(cmd) {
    let success = true;
    let result  = '';

    try {
      switch(cmd.command) {

        case 'reboot':
          result = 'rebooting via watchdog...';
          await sendAck(cmd.id, true, result);
          setTimeout(async () => {
            pollActive = false;
            if (window.FP?.reboot) await window.FP.reboot();
            else if (window.FP?.navigate) window.FP.navigate('welcome');
            else window.location.href = 'welcome.html';
          }, 800);
          return;

        case 'unlock':
          result = `navigating to packages from ${screenName}`;
          if (typeof fpNavigate === 'function') fpNavigate('packages');
          else window.location.href = 'packages.html';
          break;

        case 'maintenance':
          showOverlay('maintenance', cmd.payload?.message || 'This booth is temporarily under maintenance. Please check back soon.', cmd.payload?.color || 'warning');
          result = 'maintenance mode activated';
          break;

        case 'resume':
          removeOverlay();
          if (screenName !== 'welcome') {
            if (typeof fpNavigate === 'function') fpNavigate('welcome');
            else window.location.href = 'welcome.html';
          }
          result = 'normal mode resumed';
          break;

        case 'clearErrors':
          removeOverlay();
          result = 'errors cleared';
          break;

        case 'ping':
          result = `alive · screen=${screenName} · ${new Date().toLocaleTimeString()}`;
          break;

        case 'setMessage':
          if (cmd.payload?.message) {
            showBanner(cmd.payload.message, cmd.payload.type || 'info');
            result = `message shown: "${cmd.payload.message}"`;
          }
          break;

        case 'resetIdle':
          if (window.FP?.resetIdle) window.FP.resetIdle();
          result = 'idle timer reset';
          break;

        case 'printTest':
          if (window.FP?.printer?.print) {
            await window.FP.printer.print({ imagePath: null, filter: 'Original', session: {} });
            result = 'test print sent to printer';
          } else {
            result = 'printer not available in browser mode';
          }
          break;

        default:
          result  = `unknown command: ${cmd.command}`;
          success = false;
      }
    } catch(e) {
      success = false;
      result  = `error: ${e.message}`;
      console.error('[BOOTH CMD] Execution error:', e);
    }

    await sendAck(cmd.id, success, result);
  }

  async function sendAck(commandId, success, result) {
    try {
      await fetch(`${SERVER}/api/commands/ack/${commandId}`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ success, result }),
      });
      console.log(`[BOOTH CMD] ACK sent: ${commandId} → ${success ? 'ok' : 'failed'} — ${result}`);
    } catch(e) {
      console.error('[BOOTH CMD] ACK failed:', e.message);
    }
  }

  /* ════════════════════════════════
     OVERLAY — maintenance / error
  ════════════════════════════════ */
  function showOverlay(type, message, style = 'warning') {
    removeOverlay();
    const colors = {
      warning: { bg:'rgba(232,197,71,0.97)', text:'#1A1200',   icon:'⚠️' },
      error:   { bg:'rgba(200,75,110,0.97)', text:'#fff',      icon:'🔴' },
      info:    { bg:'rgba(26,26,38,0.97)',   text:'#fff',      icon:'ℹ️' },
    };
    const c = colors[style] || colors.warning;
    const overlay = document.createElement('div');
    overlay.id = '__fp_overlay__';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:99999;
      background:${c.bg};
      display:flex;flex-direction:column;
      align-items:center;justify-content:center;
      text-align:center;padding:60px 80px;
      font-family:'DM Sans',sans-serif;
    `;
    overlay.innerHTML = `
      <div style="font-size:64px;margin-bottom:24px;">${c.icon}</div>
      <div style="font-size:36px;font-weight:700;color:${c.text};margin-bottom:12px;font-family:'Playfair Display',serif;">
        ${type === 'maintenance' ? 'Under Maintenance' : 'Booth Unavailable'}
      </div>
      <div style="font-size:18px;color:${c.text};opacity:0.7;max-width:600px;line-height:1.6;">${message}</div>
      <div style="font-size:13px;color:${c.text};opacity:0.4;margin-top:32px;font-family:'Space Mono',monospace;">
        BOOTH #${window.__FP__?.booth?.id || '001'} · ${new Date().toLocaleTimeString()}
      </div>`;
    document.body.appendChild(overlay);
  }

  function removeOverlay() {
    const el = document.getElementById('__fp_overlay__');
    if (el) el.remove();
  }

  function showBanner(message, type = 'info') {
    const existing = document.getElementById('__fp_banner__');
    if (existing) existing.remove();
    const colors = {
      info:    { bg:'rgba(55,138,221,0.12)',  border:'rgba(55,138,221,0.3)',  text:'#85B7EB' },
      warning: { bg:'rgba(232,197,71,0.12)', border:'rgba(232,197,71,0.3)',  text:'#E8C547' },
      success: { bg:'rgba(61,170,108,0.12)', border:'rgba(61,170,108,0.3)',  text:'#3DAA6C' },
      error:   { bg:'rgba(200,75,110,0.12)', border:'rgba(200,75,110,0.3)',  text:'#C84B6E' },
    };
    const c = colors[type] || colors.info;
    const banner = document.createElement('div');
    banner.id = '__fp_banner__';
    banner.style.cssText = `
      position:fixed;top:0;left:0;right:0;z-index:9999;
      background:${c.bg};border-bottom:2px solid ${c.border};
      padding:12px 24px;display:flex;align-items:center;
      justify-content:space-between;font-family:'DM Sans',sans-serif;
    `;
    banner.innerHTML = `
      <span style="font-size:14px;font-weight:500;color:${c.text};">${message}</span>
      <span onclick="this.parentElement.remove()" style="cursor:pointer;font-size:18px;color:${c.text};opacity:0.6;padding:0 8px;">×</span>`;
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 30000);
  }

  /* ════════════════════════════════
     SESSION + SUPPLY REPORTERS
     All use FP_NET.queue() as fallback so data survives offline.
  ════════════════════════════════ */
  window.reportSessionStart = async function(sessionData) {
    const url  = `${SERVER}/api/booth/session/start`;
    const opts = { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(sessionData) };
    try { await fetch(url, opts); }
    catch(_) { if (window.FP_NET) window.FP_NET.queue('session:start', url, opts); }
  };

  window.reportSessionEnd = async function(sessionData, success = true) {
    const url  = `${SERVER}/api/booth/session/end`;
    const opts = { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ...sessionData, success }) };
    try { await fetch(url, opts); }
    catch(_) { if (window.FP_NET) window.FP_NET.queue('session:end', url, opts); }
  };

  window.reportSupplies = async function(inkPercent, paperSheets) {
    const url  = `${SERVER}/api/booth/supplies`;
    const opts = { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ inkPercent, paperSheets }) };
    try { await fetch(url, opts); }
    catch(_) { if (window.FP_NET) window.FP_NET.queue('booth:supplies', url, opts); }
  };

  window.reportBoothError = async function(code, message) {
    const url  = `${SERVER}/api/booth/error`;
    const opts = { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code, message }) };
    try { await fetch(url, opts); }
    catch(_) { if (window.FP_NET) window.FP_NET.queue(null, url, opts); } /* no dedup — every error matters */
  };

  window.recordTransaction = async function(sessionData) {
    const sess = sessionData || JSON.parse(localStorage.getItem('fp_session') || '{}');
    const body = {
      packageName: sess.package?.name || sess.packageName,
      photos:      sess.package?.photos || 4,
      filter:      sess.filter || 'Original',
      amount:      sess.package?.amount || sess.amount || 0,
      refId:       sess.refId   || '',
      orNumber:    sess.orNumber || '',
    };
    const url  = `${SERVER}/api/transactions`;
    const opts = { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) };
    try { await fetch(url, opts); }
    catch(_) {
      /* transactions must never be lost — queue without dedup key */
      if (window.FP_NET) window.FP_NET.queue(null, url, opts);
      else {
        /* FP_NET not loaded — persist directly as fallback */
        try {
          const q = JSON.parse(localStorage.getItem('fp_offline_queue') || '[]');
          q.push({ id: Date.now(), url, opts, ts: Date.now() });
          localStorage.setItem('fp_offline_queue', JSON.stringify(q));
        } catch(_2) {}
      }
    }
  };

  /* ── init ── */
  reportScreen();
  setTimeout(pollCommands, 1500);

  console.log(`[BOOTH REPORTER] screen=${screenName} server=${SERVER}`);
})();