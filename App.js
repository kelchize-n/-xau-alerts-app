import React, { useEffect, useState } from 'react';
import {
  StyleSheet, Text, View, FlatList, SafeAreaView, StatusBar, RefreshControl,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Chart from './Chart';

// Change this to your server address once the strategy server is built.
const SERVER_URL = '';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const DEMO_ALERTS = [
  {
    id: '1',
    direction: 'SELL',
    timeframe: '15m',
    orderBlock: '2652.40 - 2658.10',
    gap: '2649.80 - 2651.20',
    status: 'Waiting for retest',
    time: 'Demo alert',
  },
  {
    id: '2',
    direction: 'BUY',
    timeframe: '5m',
    orderBlock: '2631.00 - 2635.60',
    gap: '2636.20 - 2637.50',
    status: 'Invalidated',
    time: 'Demo alert',
  },
];

async function registerForPush() {
  if (!Device.isDevice) return null;
  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') return null;
  const token = await Notifications.getExpoPushTokenAsync();
  return token.data;
}

export default function App() {
  const [alerts, setAlerts] = useState(DEMO_ALERTS);
  const [price, setPrice] = useState('--');
  const [pushToken, setPushToken] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!SERVER_URL) return;
    try {
      const res = await fetch(SERVER_URL + '/alerts');
      const data = await res.json();
      setAlerts(data.alerts || []);
      setPrice(data.price ? String(data.price) : '--');
    } catch (e) {}
  };

  useEffect(() => {
    registerForPush().then(setPushToken);
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const renderAlert = ({ item }) => {
    const isSell = item.direction === 'SELL';
    return (
      <View style={[styles.card, { borderLeftColor: isSell ? '#ef4444' : '#22c55e' }]}>
        <View style={styles.row}>
          <Text style={[styles.direction, { color: isSell ? '#ef4444' : '#22c55e' }]}>
            {item.direction}
          </Text>
          <Text style={styles.tf}>{item.timeframe}</Text>
        </View>
        <Text style={styles.label}>Order block</Text>
        <Text style={styles.value}>{item.orderBlock}</Text>
        <Text style={styles.label}>Fair value gap</Text>
        <Text style={styles.value}>{item.gap}</Text>
        <Text style={styles.status}>{item.status}</Text>
        <Text style={styles.time}>{item.time}</Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.title}>XAUUSD</Text>
        <Text style={styles.price}>{price}</Text>
      </View>
      <View style={{ height: 380 }}>
        <Chart />
      </View>
      <FlatList
        data={alerts}
        keyExtractor={(i) => i.id}
        renderItem={renderAlert}
        contentContainerStyle={{ padding: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={<Text style={styles.empty}>No setups yet. Watching the market.</Text>}
      />
      <Text style={styles.token} selectable>
        {pushToken ? 'Push token: ' + pushToken : 'Push token not available'}
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0f14' },
  header: {
    paddingTop: 40, paddingBottom: 16, paddingHorizontal: 20,
    backgroundColor: '#111827', flexDirection: 'row',
    justifyContent: 'space-between', alignItems: 'center',
  },
  title: { color: '#fbbf24', fontSize: 24, fontWeight: 'bold' },
  price: { color: '#ffffff', fontSize: 24, fontWeight: '600' },
  card: {
    backgroundColor: '#111827', borderRadius: 12, padding: 16,
    marginBottom: 12, borderLeftWidth: 5,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  direction: { fontSize: 20, fontWeight: 'bold' },
  tf: { color: '#9ca3af', fontSize: 16 },
  label: { color: '#6b7280', fontSize: 12, marginTop: 6 },
  value: { color: '#ffffff', fontSize: 16 },
  status: { color: '#fbbf24', fontSize: 14, marginTop: 10 },
  time: { color: '#6b7280', fontSize: 12, marginTop: 4 },
  empty: { color: '#9ca3af', textAlign: 'center', marginTop: 40 },
  token: { color: '#6b7280', fontSize: 10, padding: 10 },
});
