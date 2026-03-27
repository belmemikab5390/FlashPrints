/**
 * server/transaction-store.js
 * Persistent transaction log — survives server restarts.
 * Stores to: assets/transactions.json (JSON Lines format)
 *
 * Also keeps a fast in-memory index for queries.
 */
const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '../assets');
const TX_FILE   = path.join(DATA_DIR, 'transactions.json');
const MAX_MEM   = 1000; /* keep last 1000 in memory */

/* ensure assets dir exists */
fs.mkdirSync(DATA_DIR, { recursive: true });

/* in-memory store */
let transactions = [];

/* ── load from disk on startup ── */
function load() {
  try {
    if (!fs.existsSync(TX_FILE)) { fs.writeFileSync(TX_FILE, '[]'); return; }
    const raw = fs.readFileSync(TX_FILE, 'utf8').trim();
    transactions = raw ? JSON.parse(raw) : [];
    console.log(`[TX STORE] Loaded ${transactions.length} transactions from disk`);
  } catch(e) {
    console.error('[TX STORE] Load error:', e.message);
    transactions = [];
  }
}

/* ── save to disk (debounced) ── */
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(TX_FILE, JSON.stringify(transactions, null, 2));
    } catch(e) {
      console.error('[TX STORE] Save error:', e.message);
    }
  }, 1000);
}

/* ── add a transaction ── */
function addTransaction({ boothId, location, packageName, photos, filter, amount, refId, orNumber, paymentMethod = 'GCash' }) {
  const now = new Date();
  const tx = {
    id:            `TX-${boothId}-${Date.now()}`,
    boothId:       boothId       || '001',
    location:      location      || 'Unknown',
    packageName:   packageName   || 'Classic Strip',
    photos:        photos        || 4,
    filter:        filter        || 'Original',
    amount:        parseFloat(amount) || 0,
    vatAmount:     parseFloat((parseFloat(amount) - parseFloat(amount)/1.12).toFixed(2)) || 0,
    baseAmount:    parseFloat((parseFloat(amount)/1.12).toFixed(2)) || 0,
    paymentMethod,
    refId:         refId   || `FP-${boothId}-${Date.now()}`,
    orNumber:      orNumber || `OR-${String(Date.now()).slice(-8)}`,
    date:          now.toISOString().split('T')[0],           /* YYYY-MM-DD */
    time:          now.toTimeString().split(' ')[0],           /* HH:MM:SS */
    timestamp:     now.toISOString(),
    dayOfWeek:     now.toLocaleDateString('en-PH', { weekday:'long' }),
    hour:          now.getHours(),
  };

  transactions.unshift(tx);
  if (transactions.length > MAX_MEM) transactions = transactions.slice(0, MAX_MEM);
  scheduleSave();
  console.log(`[TX] Recorded: ${tx.id} · ${tx.packageName} · ₱${tx.amount}`);
  return tx;
}

/* ── query transactions ── */
function query({ limit = 50, offset = 0, date, boothId, packageName, search } = {}) {
  let results = [...transactions];

  if (date)        results = results.filter(t => t.date === date);
  if (boothId)     results = results.filter(t => t.boothId === boothId);
  if (packageName) results = results.filter(t => t.packageName === packageName);
  if (search) {
    const q = search.toLowerCase();
    results = results.filter(t =>
      t.id.toLowerCase().includes(q) ||
      t.refId.toLowerCase().includes(q) ||
      t.orNumber.toLowerCase().includes(q) ||
      t.packageName.toLowerCase().includes(q) ||
      t.filter.toLowerCase().includes(q)
    );
  }

  const total = results.length;
  const pages = Math.ceil(total / limit);
  const data  = results.slice(offset, offset + limit);

  return { data, total, pages, limit, offset };
}

/* ── get summary stats ── */
function getStats({ date } = {}) {
  const today = new Date().toISOString().split('T')[0];
  const target = date || today;

  const todayTx  = transactions.filter(t => t.date === target);
  const allTx    = transactions;

  const sum = arr => arr.reduce((s, t) => s + (t.amount || 0), 0);

  /* hourly breakdown */
  const hourly = Array(24).fill(0).map((_, h) => ({
    hour: h,
    sessions: todayTx.filter(t => t.hour === h).length,
    revenue:  todayTx.filter(t => t.hour === h).reduce((s,t) => s + t.amount, 0),
  }));

  /* by package */
  const byPackage = {};
  todayTx.forEach(t => {
    if (!byPackage[t.packageName]) byPackage[t.packageName] = { sessions:0, revenue:0 };
    byPackage[t.packageName].sessions++;
    byPackage[t.packageName].revenue += t.amount;
  });

  /* by filter */
  const byFilter = {};
  todayTx.forEach(t => {
    byFilter[t.filter] = (byFilter[t.filter] || 0) + 1;
  });

  return {
    date:           target,
    today:          { sessions: todayTx.length,  revenue: sum(todayTx)  },
    total:          { sessions: allTx.length,     revenue: sum(allTx)    },
    avgPerSession:  todayTx.length ? Math.round(sum(todayTx) / todayTx.length) : 0,
    peakHour:       hourly.reduce((a, b) => b.sessions > a.sessions ? b : a, hourly[0]),
    hourly,
    byPackage,
    byFilter,
  };
}

/* ── export to CSV string ── */
function toCSV({ date, boothId, packageName, limit = 1000 } = {}) {
  const { data } = query({ date, boothId, packageName, limit });

  const headers = [
    'Transaction ID','Date','Time','Day','Booth ID','Location',
    'Package','Photos','Filter','Amount (₱)','VAT (₱)','Base Amount (₱)',
    'Payment Method','GCash Ref','OR Number'
  ];

  const rows = data.map(t => [
    t.id, t.date, t.time, t.dayOfWeek, t.boothId, t.location,
    t.packageName, t.photos, t.filter,
    t.amount.toFixed(2), t.vatAmount.toFixed(2), t.baseAmount.toFixed(2),
    t.paymentMethod, t.refId, t.orNumber,
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

  return [headers.join(','), ...rows].join('\r\n');
}

/* ── seed demo data (dev mode only) ── */
function seedDemoData() {
  if (transactions.length > 0) return;
  if (process.env.NODE_ENV === 'production') return;

  const packages = [
    { name:'Classic Strip', photos:4, price:89 },
    { name:'Solo Frame',    photos:1, price:59 },
    { name:'Party Mode',    photos:6, price:149 },
    { name:'GIF Booth',     photos:5, price:99 },
  ];
  const filters  = ['Original','Vintage','B&W','Pastel','Neon'];
  const booths   = [
    { id:'001', location:'SM City North EDSA' },
    { id:'002', location:'Robinsons Galleria' },
    { id:'003', location:'SM Fairview' },
  ];

  const now   = new Date();
  let seeded  = 0;

  /* generate 40 transactions across last 7 days */
  for (let day = 6; day >= 0; day--) {
    const d     = new Date(now); d.setDate(d.getDate() - day);
    const count = 4 + Math.floor(Math.random() * 12);
    for (let i = 0; i < count; i++) {
      const pkg    = packages[Math.floor(Math.random() * packages.length)];
      const booth  = booths[Math.floor(Math.random() * booths.length)];
      const filter = filters[Math.floor(Math.random() * filters.length)];
      const hour   = 10 + Math.floor(Math.random() * 11);
      const dt     = new Date(d); dt.setHours(hour, Math.floor(Math.random()*60), 0);

      const tx = {
        id:           `TX-${booth.id}-${dt.getTime()}`,
        boothId:      booth.id,
        location:     booth.location,
        packageName:  pkg.name,
        photos:       pkg.photos,
        filter,
        amount:       pkg.price,
        vatAmount:    parseFloat((pkg.price - pkg.price/1.12).toFixed(2)),
        baseAmount:   parseFloat((pkg.price/1.12).toFixed(2)),
        paymentMethod:'GCash',
        refId:        `FP-${booth.id}-${dt.getTime()}`,
        orNumber:     `OR-${String(dt.getTime()).slice(-8)}`,
        date:         dt.toISOString().split('T')[0],
        time:         dt.toTimeString().split(' ')[0],
        timestamp:    dt.toISOString(),
        dayOfWeek:    dt.toLocaleDateString('en-PH', { weekday:'long' }),
        hour:         dt.getHours(),
      };
      transactions.push(tx);
      seeded++;
    }
  }

  /* sort newest first */
  transactions.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
  scheduleSave();
  console.log(`[TX STORE] Seeded ${seeded} demo transactions`);
}

/* init */
load();
seedDemoData();

module.exports = { addTransaction, query, getStats, toCSV };
