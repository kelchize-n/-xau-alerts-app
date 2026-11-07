import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

const SERVER_URL = 'https://xau-alerts-app.onrender.com';
// 3m is chart-only (no order blocks). 5m, 15m, 1h show order block boxes.
const TIMEFRAMES = ['3m', '5m', '15m', '1h'];

const buildHtml = (tf, style) => `
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
html,body{margin:0;padding:0;height:100%;background:#0b0f1a;overflow:hidden;}
#wrap{position:relative;width:100%;height:100%;}
#chart{position:absolute;left:0;top:0;right:0;bottom:0;}
#overlay{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;overflow:hidden;}
.box{position:absolute;box-sizing:border-box;display:none;}
.bull{background:rgba(34,197,94,0.55);border:1px solid #22c55e;}
.bear{background:rgba(239,68,68,0.55);border:1px solid #ef4444;}
#msg{position:absolute;left:6px;top:4px;color:#9ca3af;font:12px sans-serif;display:none;}
</style>
</head>
<body>
<div id="wrap">
  <div id="chart"></div>
  <div id="overlay"></div>
  <div id="msg"></div>
</div>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<script>
(function () {
  var TF = "${tf}";
  var STYLE = "${style}";
  var BASE = "${SERVER_URL}";
  var chartEl = document.getElementById('chart');
  var overlay = document.getElementById('overlay');
  var msg = document.getElementById('msg');

  function showMsg(text) {
    msg.textContent = text;
    msg.style.display = text ? 'block' : 'none';
  }
  showMsg('Loading...');

  var chart = LightweightCharts.createChart(chartEl, {
    width: window.innerWidth,
    height: window.innerHeight,
    layout: { background: { color: '#0b0f1a' }, textColor: '#d1d5db' },
    grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
    timeScale: { timeVisible: true, borderColor: '#374151' },
    rightPriceScale: { borderColor: '#374151' },
  });

  var series;
  if (STYLE === '2') {
    series = chart.addLineSeries({ color: '#f5b301', lineWidth: 2 });
  } else {
    series = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });
  }

  var firstLoad = true;
  var lastTime = null;
  var times = [];
  var obs = [];
  var boxEls = [];

  // Server times are UTC strings like "2026-11-05 15:51:00"
  function toSec(t) {
    return Math.floor(Date.parse(String(t).replace(' ', 'T') + 'Z') / 1000);
  }

  // Screen x position for a time. If the exact time is not a candle time,
  // use the next candle at or after it.
  function timeToX(t) {
    var ts = chart.timeScale();
    var x = ts.timeToCoordinate(t);
    if (x !== null) return x;
    for (var i = 0; i < times.length; i++) {
      if (times[i] >= t) return ts.timeToCoordinate(times[i]);
    }
    return null;
  }

  // Draw each live order block as a solid box from its OB candle to the newest candle.
  // Boxes are reused and repositioned, not rebuilt, so the chart does not flicker.
  function drawBoxes() {
    var width = chartEl.clientWidth;
    var rightX = lastTime === null ? null : timeToX(lastTime);
    var used = 0;

    obs.forEach(function (ob) {
      var x1 = timeToX(toSec(ob.startTime));
      var y1 = series.priceToCoordinate(ob.top);
      var y2 = series.priceToCoordinate(ob.bottom);
      if (x1 === null || y1 === null || y2 === null) return;

      var x2 = rightX === null ? width : rightX;
      var left = Math.max(0, Math.min(x1, x2));
      var right = Math.min(width, Math.max(x1, x2));
      if (right <= left) return;

      var div = boxEls[used];
      if (!div) {
        div = document.createElement('div');
        overlay.appendChild(div);
        boxEls[used] = div;
      }
      used++;

      div.className = 'box ' + (ob.direction === 'bullish' ? 'bull' : 'bear');
      div.style.display = 'block';
      div.style.left = left + 'px';
      div.style.width = (right - left) + 'px';
      div.style.top = Math.min(y1, y2) + 'px';
      div.style.height = Math.max(2, Math.abs(y2 - y1)) + 'px';
    });

    // Hide any spare boxes left over from before
    for (var i = used; i < boxEls.length; i++) {
      boxEls[i].style.display = 'none';
    }
  }

  function load() {
    fetch(BASE + '/chart?tf=' + TF + '&t=' + Date.now())
      .then(function (r) {
        if (!r.ok) throw new Error('server ' + r.status);
        return r.json();
      })
      .then(function (json) {
        var candles = json.candles || [];
        if (STYLE === '2') {
          series.setData(candles.map(function (c) {
            return { time: toSec(c.time), value: c.close };
          }));
        } else {
          series.setData(candles.map(function (c) {
            return { time: toSec(c.time), open: c.open, high: c.high, low: c.low, close: c.close };
          }));
        }
        times = candles.map(function (c) { return toSec(c.time); });
        lastTime = candles.length ? toSec(candles[candles.length - 1].time) : null;
        obs = json.obs || [];
        if (firstLoad && candles.length) {
          chart.timeScale().fitContent();
          firstLoad = false;
        }
        showMsg('');
        drawBoxes();
        // Redraw once more after the chart has finished laying out
        setTimeout(drawBoxes, 300);
      })
      .catch(function (e) {
        showMsg('Chart not loaded: ' + e.message + '. Retrying...');
      });
  }

  // Redraw when the time or price range changes (zoom, scroll)
  chart.timeScale().subscribeVisibleLogicalRangeChange(drawBoxes);
  chart.timeScale().subscribeVisibleTimeRangeChange(drawBoxes);

  window.addEventListener('resize', function () {
    chart.resize(window.innerWidth, window.innerHeight);
    drawBoxes();
  });

  // Price-scale drags do not fire range events, so keep the boxes aligned on a short timer
  setInterval(drawBoxes, 150);

  load();
  setInterval(load, 15000);
})();
</script>
</body>
</html>
`;

export default function Chart() {
  const [tf, setTf] = useState('5m');
  // TradingView-style codes kept for the toggle: "1" = candles, "2" = line
  const [style, setStyle] = useState('1');

  return (
    <View style={styles.container}>
      <View style={styles.toggleRow}>
        {TIMEFRAMES.map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.toggle, tf === t && styles.toggleActive]}
            onPress={() => setTf(t)}
          >
            <Text style={[styles.toggleText, tf === t && styles.toggleTextActive]}>{t}</Text>
          </TouchableOpacity>
        ))}
        <View style={styles.spacer} />
        <TouchableOpacity
          style={[styles.toggle, style === '1' && styles.toggleActive]}
          onPress={() => setStyle('1')}
        >
          <Text style={[styles.toggleText, style === '1' && styles.toggleTextActive]}>Candles</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggle, style === '2' && styles.toggleActive]}
          onPress={() => setStyle('2')}
        >
          <Text style={[styles.toggleText, style === '2' && styles.toggleTextActive]}>Line</Text>
        </TouchableOpacity>
      </View>
      <WebView
        key={tf + style}
        originWhitelist={['*']}
        source={{ html: buildHtml(tf, style) }}
        style={styles.web}
        javaScriptEnabled
        domStorageEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0f1a' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', padding: 6 },
  toggle: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#1a2133',
    marginRight: 6,
  },
  toggleActive: { backgroundColor: '#f5b301' },
  toggleText: { color: '#ffffff', fontWeight: 'bold', fontSize: 12 },
  toggleTextActive: { color: '#111827' },
  spacer: { flex: 1 },
  web: { flex: 1, backgroundColor: '#0b0f1a' },
});
