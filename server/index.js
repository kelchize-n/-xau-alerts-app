const http = require('http');
const { detectOrderBlocks } = require('./orderBlocks');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_KEY;

// Twelve Data intervals. 3m is built from 1m candles (no extra API calls).
const TIMEFRAMES = [
  { name: '1m',  interval: '1min',  size: 150, every: 5 },
  { name: '5m',  interval: '5min',  size: 150, every: 10 },
  { name: '15m', interval: '15min', size: 150, every: 15 },
  { name: '30m', interval: '30min', size: 150, every: 30 },
  { name: '1h',  interval: '1h',    size: 150, every: 60 },
];

// Latest data held in memory
let state = {
  price: null,
  candles: {},
  gaps: {},
  obs: {},
  alerts: [],
  errors: {},
  lastUpdate: null,
  lastError: null,
};

async function fetchCandles(interval, size) {
  const url =
    'https://api.twelvedata.com/time_series?symbol=XAU/USD' +
    '&interval=' + interval +
    '&outputsize=' + size +
    '&apikey=' + API_KEY;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'error') throw new Error(data.message);
  // Twelve Data returns newest first, so reverse to oldest first
  return data.values.reverse().map((c) => ({
    time: c.datetime,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
  }));
}

// Combine consecutive 1m candles into larger candles (e.g. 3 x 1m = 3m).
// Only complete, aligned groups are kept, so the forming candle is dropped.
function aggregate(candles, minutes) {
  const groups = new Map();
  candles.forEach((c) => {
    const ms = Date.parse(c.time.replace(' ', 'T') + 'Z');
    const key = Math.floor(ms / (minutes * 60000));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  });
  return [...groups.values()]
    .filter((g) => g.length === minutes)
    .map((g) => ({
      time: g[0].time,
      open: g[0].open,
      high: Math.max(...g.map((c) => c.high)),
      low: Math.min(...g.map((c) => c.low)),
      close: g[g.length - 1].close,
    }));
}

// Fair value gap: candle 1 and candle 3 do not overlap.
// Bullish: low of candle 3 is above high of candle 1.
// Bearish: high of candle 3 is below low of candle 1.
// A gap is marked filled once price later trades back into it.
function findGaps(candles) {
  const gaps = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c3 = candles[i];
    let gap = null;
    if (c3.low > c1.high) {
      gap = { type: 'bullish', low: c1.high, high: c3.low };
    } else if (c3.high < c1.low) {
      gap = { type: 'bearish', low: c3.high, high: c1.low };
    }
    if (!gap) continue;
    let filled = false;
    for (let j = i + 1; j < candles.length; j++) {
      const c = candles[j];
      if (gap.type === 'bullish' && c.low <= gap.low) { filled = true; break; }
      if (gap.type === 'bearish' && c.high >= gap.high) { filled = true; break; }
    }
    gaps.push({
      type: gap.type,
      low: gap.low,
      high: gap.high,
      time: candles[i - 1].time,
      filled: filled,
    });
  }
  return gaps;
}

function setCandles(name, candles) {
  state.candles[name] = candles;
  state.gaps[name] = findGaps(candles);
}

// Run order block detection for one timeframe. Errors are logged, not thrown,
// so a detection problem never stops the candle fetching.
function detectFor(name) {
  try {
    state.obs[name] = detectOrderBlocks(state.candles[name] || [], name);
  } catch (e) {
    console.error('OB detection failed', name, e.message);
  }
}

function refreshLastError() {
  const keys = Object.keys(state.errors);
  state.lastError = keys.length
    ? keys.map((k) => k + ': ' + state.errors[k]).join(' | ')
    : null;
}

async function updateTimeframe(tf) {
  try {
    if (!API_KEY) throw new Error('TWELVE_DATA_KEY is not set');
    const candles = await fetchCandles(tf.interval, tf.size);
    setCandles(tf.name, candles);
    detectFor(tf.name);
    if (tf.name === '1m') {
      setCandles('3m', aggregate(candles, 3));
      detectFor('3m');
    }
    if (tf.name === '5m') {
      state.price = candles[candles.length - 1].close;
    }
    state.lastUpdate = new Date().toISOString();
    delete state.errors[tf.name];
  } catch (e) {
    state.errors[tf.name] = String(e.message || e);
  }
  refreshLastError();
}

// Start each timeframe a few seconds apart so calls do not bunch up
TIMEFRAMES.forEach((tf, index) => {
  setTimeout(() => {
    updateTimeframe(tf);
    setInterval(() => updateTimeframe(tf), tf.every * 60 * 1000);
  }, index * 8000);
});

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  // Ignore query strings like ?v=3 when matching routes
  const path = req.url.split('?')[0];
  if (path === '/alerts') {
    res.end(JSON.stringify({ price: state.price, alerts: state.alerts }));
  } else if (path === '/gaps') {
    const summary = {};
    Object.keys(state.gaps).forEach((name) => {
      const open = state.gaps[name].filter((g) => !g.filled);
      summary[name] = { total: state.gaps[name].length, open: open.length, gaps: open };
    });
    res.end(JSON.stringify({ price: state.price, lastUpdate: state.lastUpdate, timeframes: summary }));
  } else if (path === '/obs') {
    res.end(JSON.stringify({ price: state.price, lastUpdate: state.lastUpdate, timeframes: state.obs }));
  } else if (path === '/status') {
    const counts = {};
    Object.keys(state.candles).forEach((name) => { counts[name] = state.candles[name].length; });
    res.end(JSON.stringify({
      ok: true,
      price: state.price,
      candles: counts,
      lastUpdate: state.lastUpdate,
      lastError: state.lastError,
      errors: state.errors,
    }));
  } else {
    res.end(JSON.stringify({ ok: true, name: 'XAU Alert Server' }));
  }
});

server.listen(PORT, () => console.log('Server running on port ' + PORT));
