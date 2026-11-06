import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

const buildHtml = (style) => `
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>html,body{margin:0;padding:0;height:100%;background:#0b0f1a;}</style>
</head>
<body>
<div class="tradingview-widget-container" style="height:100%;width:100%">
  <div id="tv_chart" style="height:100%;width:100%"></div>
</div>
<script src="https://s3.tradingview.com/tv.js"></script>
<script>
  new TradingView.widget({
    autosize: true,
    symbol: "OANDA:XAUUSD",
    interval: "15",
    timezone: "Etc/UTC",
    theme: "dark",
    style: "${style}",
    locale: "en",
    hide_top_toolbar: false,
    allow_symbol_change: false,
    container_id: "tv_chart"
  });
</script>
</body>
</html>
`;

export default function Chart() {
  // TradingView style codes: "1" = candlesticks, "2" = line
  const [style, setStyle] = useState('1');

  return (
    <View style={styles.container}>
      <View style={styles.toggleRow}>
        <TouchableOpacity
          style={[styles.toggle, style === '1' && styles.toggleActive]}
          onPress={() => setStyle('1')}
        >
          <Text style={styles.toggleText}>Candles</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggle, style === '2' && styles.toggleActive]}
          onPress={() => setStyle('2')}
        >
          <Text style={styles.toggleText}>Line</Text>
        </TouchableOpacity>
      </View>
      <WebView
        key={style}
        originWhitelist={['*']}
        source={{ html: buildHtml(style) }}
        style={styles.web}
        javaScriptEnabled
        domStorageEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0f1a' },
  toggleRow: { flexDirection: 'row', padding: 8 },
  toggle: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#1a2133',
    marginRight: 8,
  },
  toggleActive: { backgroundColor: '#f5b301' },
  toggleText: { color: '#ffffff', fontWeight: 'bold' },
  web: { flex: 1, backgroundColor: '#0b0f1a' },
});
