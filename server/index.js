const http = require('http');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_KEY;

// Each timeframe: Twelve Data interval name, candles to keep, refresh time in minutes
const TIMEFRAMES = [
  { name: '1m',  interval: '1min',  size: 150, every: 5 },
  { name: '3m',  interval: '3min',  size: 150, every: 15 },
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
  alerts: [],
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

async function updateTimeframe(tf) {
  try {
    if (!API_KEY) throw new Error('TWELVE_DATA_KEY is not set');
    const candles = await fetchCandles(tf.interval, tf.size);
    state.candles[tf.name] = candles;
    state.gaps[tf.name] = findGaps(candles);
    if (tf.name === '5m') {
      state.price = candles[candles.length - 1].close;
    }
    state.lastUpdate = new Date().toISOString();
    state.lastError = null;
    // Strategy detection will be added here in the next step
  } catch (e) {
    state.lastError = tf.name + ': ' + String(e.message || e);
  }
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
  if (req.url === '/alerts') {
    res.end(JSON.stringify({ price: state.price, alerts: state.alerts }));
  } else if (req.url === '/gaps') {
    const summary = {};
    Object.keys(state.gaps).forEach((name) => {
      const open = state.gaps[name].filter((g) => !g.filled);
      summary[name] = { total: state.gaps[name].length, open: open.length, gaps: open };
    });
    res.end(JSON.stringify({ price: state.price, lastUpdate: state.lastUpdate, timeframes: summary }));
  } else if (req.url === '/status') {
    const counts = {};
    Object.keys(state.candles).forEach((name) => { counts[name] = state.candles[name].length; });
    res.end(JSON.stringify({
      ok: true,
      price: state.price,
      candles: counts,
      lastUpdate: state.lastUpdate,
      lastError: state.lastError,
    }));
  } else {
    res.end(JSON.stringify({ ok: true, name: 'XAU Alert Server' }));
  }
});

server.listen(PORT, () => console.log('Server running on port ' + PORT));
