/**
 * server/command-center.js
 * Reliable command delivery with ACK, retry, and history log.
 *
 *   POST /api/commands/send/:boothId     → queue a command
 *   GET  /api/commands/pending           → kiosk polls for next command
 *   POST /api/commands/ack/:commandId    → kiosk acknowledges execution
 *   GET  /api/commands/history           → last 100 commands + status
 *   GET  /api/commands/stream            → SSE — live command status updates
 */
const router     = require('express').Router();
const boothState = require('./booth-state');
const { EventEmitter } = require('events');

const bus = new EventEmitter();

/* ── command store ── */
const MAX_HISTORY = 100;
const commands    = [];   /* full history */
const pending     = [];   /* unacknowledged queue */

const VALID_COMMANDS = {
  reboot:      { label: 'Reboot kiosk',         danger: true,  confirm: true  },
  unlock:      { label: 'Unlock session',        danger: false, confirm: false },
  maintenance: { label: 'Maintenance mode',      danger: false, confirm: false },
  resume:      { label: 'Resume normal mode',    danger: false, confirm: false },
  clearErrors: { label: 'Clear errors',          danger: false, confirm: false },
  ping:        { label: 'Ping booth',            danger: false, confirm: false },
  setMessage:  { label: 'Display message',       danger: false, confirm: false },
  resetIdle:   { label: 'Reset idle timer',      danger: false, confirm: false },
  printTest:   { label: 'Print test strip',      danger: false, confirm: true  },
};

/* ── SSE clients ── */
const cmdClients = new Set();
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  cmdClients.forEach(c => { try { c.write(msg); } catch(e) { cmdClients.delete(c); } });
}
bus.on('update', data => broadcast(data));

function createCommand(command, payload = {}, sentBy = 'dashboard') {
  const cmd = {
    id:        `CMD-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    command,
    label:     VALID_COMMANDS[command]?.label || command,
    payload,
    sentBy,
    boothId:   boothState.state.boothId,
    status:    'pending',   /* pending | delivered | ack | failed | expired */
    sentAt:    Date.now(),
    deliveredAt: null,
    ackedAt:   null,
    result:    null,
  };

  commands.unshift(cmd);
  if (commands.length > MAX_HISTORY) commands.pop();
  pending.push(cmd);

  /* expire after 60s if not acknowledged */
  setTimeout(() => {
    if (cmd.status === 'pending' || cmd.status === 'delivered') {
      cmd.status = 'expired';
      bus.emit('update', { type: 'command_expired', command: cmd });
      console.warn(`[CMD] Expired: ${cmd.id} (${cmd.command})`);
    }
  }, 60000);

  bus.emit('update', { type: 'command_queued', command: cmd });
  console.log(`[CMD] Queued: ${cmd.command} (${cmd.id})`);
  return cmd;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/commands/send/:boothId
   Body: { command, payload? }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.post('/send/:boothId', (req, res) => {
  const { command, payload = {} } = req.body;
  if (!VALID_COMMANDS[command]) {
    return res.status(400).json({ error: `Unknown command: ${command}. Valid: ${Object.keys(VALID_COMMANDS).join(', ')}` });
  }
  const cmd = createCommand(command, payload, req.ip || 'dashboard');
  res.json({ ok: true, command: cmd });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/commands/pending
   Kiosk polls every 3s to receive commands.
   Returns one command at a time, marks as delivered.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/pending', (req, res) => {
  /* find oldest pending command */
  const idx = pending.findIndex(c => c.status === 'pending');
  if (idx === -1) return res.json({ ok: true, command: null });

  const cmd = pending[idx];
  cmd.status      = 'delivered';
  cmd.deliveredAt = Date.now();

  /* remove from pending queue */
  pending.splice(idx, 1);

  bus.emit('update', { type: 'command_delivered', command: cmd });
  console.log(`[CMD] Delivered to kiosk: ${cmd.command} (${cmd.id})`);
  res.json({ ok: true, command: cmd });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/commands/ack/:commandId
   Kiosk calls this after executing the command.
   Body: { success: true, result?: 'rebooting...' }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.post('/ack/:commandId', (req, res) => {
  const cmd = commands.find(c => c.id === req.params.commandId);
  if (!cmd) return res.status(404).json({ error: 'Command not found' });

  const { success = true, result = '' } = req.body;
  cmd.status  = success ? 'ack' : 'failed';
  cmd.ackedAt = Date.now();
  cmd.result  = result;

  bus.emit('update', { type: 'command_acked', command: cmd });
  console.log(`[CMD] ACK from kiosk: ${cmd.command} → ${cmd.status} ${result ? '(' + result + ')' : ''}`);
  res.json({ ok: true });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/commands/history
   Query: ?limit=50
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  res.json({ ok: true, commands: commands.slice(0, limit), total: commands.length });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   GET /api/commands/stream
   SSE — live command status updates for dashboard
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  /* send current pending count immediately */
  res.write(`data: ${JSON.stringify({ type: 'init', pending: pending.length, history: commands.slice(0,10) })}\n\n`);

  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) { clearInterval(hb); } }, 15000);
  cmdClients.add(res);
  req.on('close', () => { cmdClients.delete(res); clearInterval(hb); });
});

/* expose createCommand for internal use */
module.exports = router;
module.exports.createCommand  = createCommand;
module.exports.VALID_COMMANDS = VALID_COMMANDS;
