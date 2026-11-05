import React, { useEffect, useRef, useState } from 'react';
import {
  StyleSheet, Text, View, FlatList, SafeAreaView, StatusBar, RefreshControl,
  TouchableOpacity, useWindowDimensions,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Chart from './Chart';

const SERVER_URL = 'https://xau-alerts-app.onrender.com';
const PROJECT_ID = '7fcdc767-aebd-48a2-b9d8-3e0d99ad2132';
const POLL_MS = 15000;
const TF_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h'];
const MAX_PER_TF = 5;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function registerForPush() {
  try {
    if (!Device.isDevice) return { error: 'Not a real device' };
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') return { error: 'Permission not granted: ' + finalStatus };
    const token = await Notifications.getExpoPushTokenAsync({ projectId: PROJECT_ID });
    return { token: token.data };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

const fmt = (n) => (typeof n === 'number' ? n.toFixed(2) : '-');

// Flatten order blocks into rows: one header per timeframe, then its boxes
function buildRows(timeframes, showInvalid) {
  const rows = [];
  TF_ORDER.forEach((tf) => {
    const all = timeframes ? timeframes[tf] : null;
    if (!all) return;
    const shown = (showInvalid ? all : all.filter((o) => o.status !== 'invalidated'))
      .slice(0, MAX_PER_TF);
    rows.push({ id: 'h-' + tf, type: 'header', tf, shownCount: shown.length, total: all.length });
    if (shown.length === 0) rows.push({ id: 'none-' + tf, type: 'none' });
    shown.forEach((ob) => {
      rows.push({ id: tf + '-' + ob.startTime + '-' + ob.bosTime, type: 'ob', ob });
    });
  });
  return rows;
}

function renderRow({ item }) {
  if (item.type === 'header') {
    return (
      <Text style={styles.tfTitle}>
        {item.tf}: {item.shownCount} shown, {item.total} total
      </Text>
    );
  }
  if (item.type === 'none') {
    return <Text style={styles.muted}>None</Text>;
  }
  return <ObCard ob={item.ob} />;
}

function ObCard({ ob }) {
  const bull = ob.direction === 'bullish';
  const color = bull ? '#22c55e' : '#ef4444';
  return (
    <View style={[styles.card, { borderLeftColor: color }]}>
      <View style={styles.row}>
        <Text style={[styles.direction, { color }]}>{bull ? 'BULLISH OB' : 'BEARISH OB'}</Text>
        <Text style={styles.statusTag}>{ob.status}</Text>
      </View>
      <Text style={styles.small}>Range {fmt(ob.bottom)} - {fmt(ob.top)}</Text>
      <Text style={styles.muted}>Start {ob.startTime}</Text>
      <Text style={styles.muted}>
        BOS {ob.bosTime}  ·  Swept {fmt(ob.sweptLevel)} at {ob.sweptTime}
      </Text>
    </View>
  );
}

export default function App() {
  const { height } = useWindowDimensions();
  const [timeframes, setTimeframes] = useState({});
  const [price, setPrice] = useState(null);
  const [change, setChange] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [serverError, setServerError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [showInvalid, setShowInvalid] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pushToken, setPushToken] = useState(null);
  const [pushError, setPushError] = useState(null);
  const lastPrice = useRef(null);

  const load = async () => {
    try {
      const res = await fetch(SERVER_URL + '/obs?t=' + Date.now());
      if (!res.ok) throw new Error('server returned ' + res.status);
      const json = await res.json();
      if (typeof json.price === 'number') {
        if (lastPrice.current !== null) setChange(json.price - lastPrice.current);
        lastPrice.current = json.price;
        setPrice(json.price);
      }
      setTimeframes(json.timeframes || {});
      setLastUpdate(json.lastUpdate || null);
      setServerError(null);
      setLoaded(true);
    } catch (e) {
      setServerError(String(e && e.message ? e.message : e));
    }
  };

  useEffect(() => {
    registerForPush().then((result) => {
      if (result.token) setPushToken(result.token);
      if (result.error) setPushError(result.error);
    });
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const rows = buildRows(timeframes, showInvalid);
  const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '•';
  const changeColor = change > 0 ? '#22c55e' : change < 0 ? '#ef4444' : '#9ca3af';

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.title}>XAUUSD</Text>
        <View style={styles.priceBox}>
          <Text style={styles.price}>{price != null ? price.toFixed(2) : '--'}</Text>
          {change != null ? (
            <Text style={[styles.change, { color: changeColor }]}>
              {arrow} {Math.abs(change).toFixed(2)}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={{ height: Math.round(height * 0.62) }}>
        <Chart />
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={renderRow}
        contentContainerStyle={{ padding: 10, paddingBottom: 20 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={
          <View>
            <Text style={styles.small}>
              Last update: {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : '--'}
            </Text>
            {serverError ? (
              <Text style={styles.error}>
                Server not reachable ({serverError}). Retrying every 15 s.
              </Text>
            ) : null}
            {!loaded && !serverError ? (
              <Text style={styles.muted}>
                Loading... the server can take up to a minute to wake up.
              </Text>
            ) : null}
            <View style={styles.toggleRow}>
              <Text style={styles.sectionTitle}>Order blocks</Text>
              <TouchableOpacity
                onPress={() => setShowInvalid(!showInvalid)}
                style={styles.toggle}
              >
                <Text style={styles.toggleText}>
                  {showInvalid ? 'Hide invalidated' : 'Show invalidated'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        }
        ListEmptyComponent={
          loaded ? <Text style={styles.empty}>No order block data yet.</Text> : null
        }
      />

      <Text style={styles.token} selectable>
        {pushToken
          ? 'Push token: ' + pushToken
          : 'Push token not available' + (pushError ? ' - ' + pushError : ' - still loading')}
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0f14' },
  header: {
    paddingTop: 24, paddingBottom: 8, paddingHorizontal: 16,
    backgroundColor: '#111827', flexDirection: 'row',
    justifyContent: 'space-between', alignItems: 'center',
  },
  title: { color: '#fbbf24', fontSize: 20, fontWeight: 'bold' },
  priceBox: { flexDirection: 'row', alignItems: 'baseline' },
  price: { color: '#ffffff', fontSize: 22, fontWeight: '600', marginRight: 8 },
  change: { fontSize: 14, fontWeight: '600' },
  small: { color: '#ffffff', fontSize: 12, marginTop: 4 },
  muted: { color: '#9ca3af', fontSize: 12, marginTop: 2 },
  error: { color: '#ef4444', fontSize: 12, marginTop: 6 },
  toggleRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginTop: 12, marginBottom: 6,
  },
  sectionTitle: { color: '#ffffff', fontSize: 16, fontWeight: 'bold' },
  toggle: { backgroundColor: '#1f2937', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  toggleText: { color: '#e5e7eb', fontSize: 12 },
  tfTitle: { color: '#fbbf24', fontSize: 14, fontWeight: '600', marginTop: 10, marginBottom: 4 },
  card: {
    backgroundColor: '#111827', borderRadius: 8, padding: 8,
    marginBottom: 6, borderLeftWidth: 4,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  direction: { fontSize: 14, fontWeight: 'bold' },
  statusTag: { color: '#fbbf24', fontSize: 11, textTransform: 'uppercase' },
  empty: { color: '#9ca3af', textAlign: 'center', marginTop: 20, fontSize: 12 },
  token: { color: '#6b7280', fontSize: 9, padding: 6 },
});
