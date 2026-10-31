const http = require('http');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_KEY;

// Latest data held in memory
let state = {
  price: null,
  candles5m: [],
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

async function update() {
  try {
    if (!API_KEY) throw new Error('TWELVE_DATA_KEY is not set');
    const candles = await fetchCandles('5min', 100);
    state.candles5m = candles;
    state.price = candles[candles.length - 1].close;
    state.lastUpdate = new Date().toISOString();
    state.lastError = null;
    // Strategy detection will be added here in the next step
  } catch (e) {
    state.lastError = String(e.message || e);
  }
}

// Check every 3 minutes: about 480 calls a day, inside the free limit of 800
update();
setInterval(update, 3 * 60 * 1000);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/alerts') {
    res.end(JSON.stringify({ price: state.price, alerts: state.alerts }));
  } else if (req.url === '/status') {
    res.end(JSON.stringify({
      ok: true,
      price: state.price,
      candles: state.candles5m.length,
      lastUpdate: state.lastUpdate,
      lastError: state.lastError,
    }));
  } else {
    res.end(JSON.stringify({ ok: true, name: 'XAU Alert Server' }));
  }
});

server.listen(PORT, () => console.log('Server running on port ' + PORT));
