const http = require('http');
const { detectOrderBlocks } = require('./orderBlocks');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_KEY;
const PUSH_TOKEN = process.env.PUSH_TOKEN;

// Only these timeframes send push alerts. 1m and 3m show cards only.
const ALERT_TIMEFRAMES = ['5m', '15m', '1h'];
// A new box alerts only if its break is on one of the last this-many closed candles.
const ALERT_RECENT_BARS = 2;
// Each live order block sends at most this many pushes, then goes quiet.
const MAX_PUSHES = 2;
// Gap between the first push and the second push
const REPEAT_MS = 2 * 60 * 1000;
// Last time the app reported that it was opened (set by GET /seen)
let lastSeen = 0;

// Alert memory per order block id: { pushes: count sent, lastSent: timestamp }
const alertState = new Map();
// For the first 5 minutes after a restart we only record existing order
// blocks, so old ones do not fire a flood of alerts.
let firstRun = true;
setTimeout(() => { firstRun = false; }, 5 * 60 * 1000);

// Twelve Data intervals. 3m is built from 1m candles (no extra API calls).
// every = minutes between refreshes. size = candles requested per call.
const TIMEFRAMES = [
  { name: '1m',  interval: '1min',  size: 150,  every: 5 },
  { name: '5m',  interval: '5min',  size: 1000, every: 5 },
  { name: '15m', interval: '15min', size: 1000, every: 15 },
  { name: '30m', interval: '30min', size: 150,  every: 30 },
  { name: '1h',  interval: '1h',    size: 150,  every: 60 },
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
    '&timezone=UTC' +
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

// Store closed candles only and recalculate gaps from them
function setCandles(name, candles) {
  state.candles[name] = candles;
  state.gaps[name] = findGaps(candles);
}

// Send a high priority push to the tablet through Expo's push service.
// channelId must match the channel created in app/App.js (ALARM_CHANNEL = 'obalarm').
// No "sound" field: the sound comes from the channel setting on the phone.
async function sendPush(ob, tf, repeat) {
  if (!PUSH_TOKEN) return;
  const bull = ob.direction === 'bullish';
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: PUSH_TOKEN,
        title: (bull ? 'BULLISH' : 'BEARISH') + ' ORDER BLOCK ' + tf +
          (repeat ? ' (still live)' : ''),
        body: 'Range ' + ob.bottom.toFixed(2) + ' - ' + ob.top.toFixed(2) +
          (repeat ? '' : ' - break confirmed'),
        priority: 'high',
        channelId: 'obalarm',
      }),
    });
  } catch (e) {
    console.error('Push failed', e.message);
  }
}

// Records the alert in the list the app can read, then sends the push
function sendAlert(name, ob, repeat) {
  state.alerts.unshift({
    time: new Date().toISOString(),
    timeframe: name,
    direction: ob.direction,
    top: ob.top,
    bottom: ob.bottom,
    bosTime: ob.bosTime,
    startTime: ob.startTime,
    repeat: repeat,
  });
  state.alerts = state.alerts.slice(0, 50);
  sendPush(ob, name, repeat);
}

// New live box: alert once if its break is fresh (and not during startup).
// Then one repeat, at most MAX_PUSHES in total. No more pushes after that,
// or once the app has been opened since the last push.
function checkAlerts(name) {
  if (!ALERT_TIMEFRAMES.includes(name)) return;
  const n = (state.candles[name] || []).length;
  const now = Date.now();
  const live = (state.obs[name] || []).filter((ob) => ob.status !== 'invalidated');
  const liveIds = new Set();

  live.forEach((ob) => {
    const id = name + '-' + ob.startTime + '-' + ob.bosTime;
    liveIds.add(id);
    const entry = alertState.get(id);

    if (!entry) {
      const fresh = ob.status === 'confirmed' && ob.bosIndex >= n - ALERT_RECENT_BARS;
      const alertNow = fresh && !firstRun;
      alertState.set(id, { pushes: alertNow ? 1 : 0, lastSent: alertNow ? now : 0 });
      if (alertNow) sendAlert(name, ob, false);
      return;
    }

    // Stop after MAX_PUSHES, or if the app was opened after the last push
    if (entry.pushes === 0 || entry.pushes >= MAX_PUSHES) return;
    if (lastSeen > entry.lastSent) return;

    if (now - entry.lastSent >= REPEAT_MS) {
      entry.pushes += 1;
      entry.lastSent = now;
      sendAlert(name, ob, true);
    }
  });

  // Forget boxes that are no longer live so memory stays small
  [...alertState.keys()].forEach((id) => {
    if (id.startsWith(name + '-') && !liveIds.has(id)) alertState.delete(id);
  });
}

// Run order block detection for one timeframe. Errors are logged, not thrown,
// so a detection problem never stops the candle fetching.
function detectFor(name) {
  try {
    state.obs[name] = detectOrderBlocks(state.candles[name] || [], name);
    checkAlerts(name);
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
    if (!candles.length) throw new Error('no candles returned');

    // The newest candle is still forming. Drop it before detection.
    const closed = candles.slice(0, -1);

    // Live price: close of the newest 1m candle (even if still forming)
    if (tf.name === '1m') {
      state.price = candles[candles.length - 1].close;
    }

    setCandles(tf.name, closed);
    detectFor(tf.name);
    if (tf.name === '1m') {
      setCandles('3m', aggregate(closed, 3));
      detectFor('3m');
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

// Check repeats every minute using data already in memory (no API calls)
setInterval(() => ALERT_TIMEFRAMES.forEach(checkAlerts), 60 * 1000);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  // Ignore query strings like ?v=3 when matching routes
  const path = req.url.split('?')[0];
  if (path === '/seen') {
    // The app calls this when it is opened, so repeats stop
    lastSeen = Date.now();
    res.end(JSON.stringify({ ok: true, lastSeen: lastSeen }));
  } else if (path === '/alerts') {
    res.end(JSON.stringify({ price: state.price, alerts: state.alerts }));
  } else if (path === '/chart') {
    const tf = new URL(req.url, 'http://localhost').searchParams.get('tf') || '5m';
    res.end(JSON.stringify({
      tf: tf,
      candles: state.candles[tf] || [],
      obs: (state.obs[tf] || []).filter((ob) => ob.status !== 'invalidated'),
    }));
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
