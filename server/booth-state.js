/**
 * server/booth-state.js
 * In-memory booth state store — single source of truth for this kiosk.
 * Emits change events so SSE clients get instant pushes.
 */
const { EventEmitter } = require('events');
require('dotenv').config();

class BoothState extends EventEmitter {
  constructor() {
    super();
    this.state = {
      boothId:       process.env.BOOTH_ID       || '001',
      location:      process.env.BOOTH_LOCATION || 'SM City North EDSA',
      floor:         process.env.BOOTH_FLOOR    || 'Level 2',
      status:        'idle',        // idle | shooting | printing | payment | error | offline | maintenance
      currentScreen: 'welcome',     // which screen is showing right now
      session: null,                // active session object or null
      lastActivity:  Date.now(),
      startedAt:     Date.now(),
      supplies: {
        inkPercent:   parseInt(process.env.INK_START_PCT)   || 100,
        paperSheets:  parseInt(process.env.PAPER_START)     || 200,
        paperPercent: 100,
      },
      stats: {
        todaySessions:  0,
        todayRevenue:   0,
        totalSessions:  0,
        totalRevenue:   0,
        lastSessionAt:  null,
      },
      errors: [],       // last 10 errors
      version: '1.0.0',
    };
  }

  /* ── update any fields and broadcast ── */
  update(patch) {
    const prev = this.state.status;
    Object.assign(this.state, patch);
    this.state.lastActivity = Date.now();
    this.emit('change', this.snapshot());
    if (patch.status && patch.status !== prev) {
      console.log(`[BOOTH ${this.state.boothId}] ${prev} → ${patch.status}`);
    }
  }

  /* ── screen changed ── */
  setScreen(screenName) {
    const statusMap = {
      welcome:  'idle',
      packages: 'idle',
      payment:  'payment',
      camera:   'shooting',
      preview:  'shooting',
      printing: 'printing',
      receipt:  'idle',
      done:     'idle',
    };
    this.update({
      currentScreen: screenName,
      status: statusMap[screenName] || 'idle',
    });
  }

  /* ── session started ── */
  startSession(sessionData) {
    this.update({
      session: {
        ...sessionData,
        startedAt: Date.now(),
        id: `S${Date.now()}`,
      },
    });
  }

  /* ── session completed ── */
  completeSession(amount) {
    const s = this.state.stats;
    this.update({
      stats: {
        ...s,
        todaySessions:  s.todaySessions + 1,
        todayRevenue:   s.todayRevenue + (amount || 0),
        totalSessions:  s.totalSessions + 1,
        totalRevenue:   s.totalRevenue + (amount || 0),
        lastSessionAt:  Date.now(),
      },
      session: null,
    });
  }

  /* ── supply update ── */
  updateSupplies({ inkPercent, paperSheets }) {
    const maxPaper = parseInt(process.env.PAPER_START) || 200;
    this.update({
      supplies: {
        inkPercent:   inkPercent   ?? this.state.supplies.inkPercent,
        paperSheets:  paperSheets  ?? this.state.supplies.paperSheets,
        paperPercent: Math.round(((paperSheets ?? this.state.supplies.paperSheets) / maxPaper) * 100),
      },
    });
  }

  /* ── decrement paper after each print ── */
  usePaper(sheets = 1) {
    const current = Math.max(0, this.state.supplies.paperSheets - sheets);
    this.updateSupplies({ paperSheets: current });
    if (current <= 20) {
      this.addError('LOW_PAPER', `Only ${current} sheets remaining`);
    }
  }

  /* ── log error ── */
  addError(code, message) {
    const errors = [
      { code, message, at: Date.now() },
      ...this.state.errors,
    ].slice(0, 10);
    this.update({ errors, status: code === 'CRITICAL' ? 'error' : this.state.status });
    console.error(`[BOOTH ${this.state.boothId}] ERROR ${code}: ${message}`);
  }

  /* ── clear errors ── */
  clearErrors() {
    this.update({ errors: [] });
  }

  /* ── clean snapshot (safe to JSON.stringify and send over wire) ── */
  snapshot() {
    return {
      ...this.state,
      uptime:    Math.floor((Date.now() - this.state.startedAt) / 1000),
      timestamp: Date.now(),
      online:    true,
    };
  }

  /* ── reset stats at midnight ── */
  scheduleDailyReset() {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    const ms = next - now;
    setTimeout(() => {
      this.update({
        stats: {
          ...this.state.stats,
          todaySessions: 0,
          todayRevenue:  0,
        },
      });
      console.log(`[BOOTH] Daily stats reset`);
      this.scheduleDailyReset();
    }, ms);
  }
}

/* singleton */
module.exports = new BoothState();
