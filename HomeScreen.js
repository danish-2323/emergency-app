/**
 * RoadSoS — screens/HomeScreen.js
 *
 * The command centre. Everything a panicking person needs first:
 *  - Current location (city + country)
 *  - Giant pulsing SOS button (200px circle, 3 radiating rings)
 *  - 4 quick-action service buttons with live counts
 *  - National emergency number chips (tap to call)
 *  - Voice listener active indicator
 *  - Offline mode banner
 *
 * Design: Industrial emergency console — near-black canvas,
 * emergency red as the only saturated colour. The SOS button
 * is the only thing that matters on this screen.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Easing,
  ScrollView,
  RefreshControl,
  Platform,
  Linking,
  Alert,
  Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import COLORS from '../constants/colors';
import { SERVICE_TYPES, UI } from '../constants/config';
import { getFullLocation, getLocationLabel } from '../services/LocationService';
import { initCache, isOnline, onConnectivityChange } from '../services/OfflineService';

// ─── Quick Action Config ──────────────────────────────────────────────────────
const QUICK_ACTIONS = [
  {
    id: SERVICE_TYPES.HOSPITAL,
    label: 'Hospital',
    icon: 'medkit',
    lib: 'Ionicons',
    color: COLORS.serviceHospital,
    bg: COLORS.serviceHospitalBg,
    emergency: '108',
  },
  {
    id: SERVICE_TYPES.POLICE,
    label: 'Police',
    icon: 'shield-checkmark',
    lib: 'Ionicons',
    color: COLORS.servicePolice,
    bg: COLORS.servicePoliceBg,
    emergency: '100',
  },
  {
    id: SERVICE_TYPES.AMBULANCE,
    label: 'Ambulance',
    icon: 'car-emergency',
    lib: 'MaterialCommunityIcons',
    color: COLORS.serviceAmbulance,
    bg: COLORS.serviceAmbulanceBg,
    emergency: '108',
  },
  {
    id: SERVICE_TYPES.TOWING,
    label: 'Towing',
    icon: 'car-wrench',
    lib: 'MaterialCommunityIcons',
    color: COLORS.serviceTowing,
    bg: COLORS.serviceTowingBg,
    emergency: null,
  },
];

// ─── Emergency Number Chips ───────────────────────────────────────────────────
const EMERGENCY_NUMBERS = [
  { number: '112', label: 'Unified' },
  { number: '108', label: 'Ambulance' },
  { number: '100', label: 'Police' },
  { number: '101', label: 'Fire' },
];

const SOS_SIZE = 200;

// ─── HomeScreen ───────────────────────────────────────────────────────────────
export default function HomeScreen({ navigation }) {
  const [location, setLocation]       = useState(null);
  const [address, setAddress]         = useState(null);
  const [services, setServices]       = useState(null);
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);
  const [offline, setOffline]         = useState(false);
  const [cacheAge, setCacheAge]       = useState(null);
  const [nearestHospital, setNearest] = useState(null);

  // ── Animation refs ──────────────────────────────────────────────────────
  // 3 pulse rings
  const ring1Scale   = useRef(new Animated.Value(1)).current;
  const ring1Opacity = useRef(new Animated.Value(0.55)).current;
  const ring2Scale   = useRef(new Animated.Value(1)).current;
  const ring2Opacity = useRef(new Animated.Value(0.35)).current;
  const ring3Scale   = useRef(new Animated.Value(1)).current;
  const ring3Opacity = useRef(new Animated.Value(0.18)).current;

  // SOS press feedback
  const sosScale     = useRef(new Animated.Value(1)).current;
  const sosGlow      = useRef(new Animated.Value(0)).current;

  // Entrance stagger
  const headerAnim   = useRef(new Animated.Value(0)).current;
  const sosAnim      = useRef(new Animated.Value(0)).current;
  const gridAnim     = useRef(new Animated.Value(0)).current;
  const chipsAnim    = useRef(new Animated.Value(0)).current;

  // Mic pulse
  const micPulse     = useRef(new Animated.Value(1)).current;

  // ── On mount ────────────────────────────────────────────────────────────
  useEffect(() => {
    startPulseRings();
    startMicPulse();
    runEntranceAnimation();

    const unsub = onConnectivityChange(online => setOffline(!online));
    loadData();

    return () => unsub();
  }, []);

  // ── Pulse rings animation ────────────────────────────────────────────────
  function makePulseLoop(scaleVal, opacityVal, delay, resetOpacity) {
    return Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.parallel([
          Animated.timing(scaleVal, {
            toValue: 2.4,
            duration: 1400,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(opacityVal, {
            toValue: 0,
            duration: 1400,
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(scaleVal, { toValue: 1, duration: 0, useNativeDriver: true }),
          Animated.timing(opacityVal, { toValue: resetOpacity, duration: 0, useNativeDriver: true }),
        ]),
      ])
    );
  }

  function startPulseRings() {
    makePulseLoop(ring1Scale, ring1Opacity, 0,   0.55).start();
    makePulseLoop(ring2Scale, ring2Opacity, 380, 0.35).start();
    makePulseLoop(ring3Scale, ring3Opacity, 760, 0.18).start();
  }

  // ── Mic breathe animation ────────────────────────────────────────────────
  function startMicPulse() {
    Animated.loop(
      Animated.sequence([
        Animated.timing(micPulse, { toValue: 1.18, duration: 900, useNativeDriver: true }),
        Animated.timing(micPulse, { toValue: 1.0,  duration: 900, useNativeDriver: true }),
      ])
    ).start();
  }

  // ── Entrance animation ───────────────────────────────────────────────────
  function runEntranceAnimation() {
    Animated.stagger(110, [
      Animated.timing(headerAnim, { toValue: 1, duration: 380, useNativeDriver: true }),
      Animated.timing(sosAnim,    { toValue: 1, duration: 420, useNativeDriver: true }),
      Animated.timing(gridAnim,   { toValue: 1, duration: 380, useNativeDriver: true }),
      Animated.timing(chipsAnim,  { toValue: 1, duration: 350, useNativeDriver: true }),
    ]).start();
  }

  function animStyle(val, fromY = 24) {
    return {
      opacity: val,
      transform: [{
        translateY: val.interpolate({ inputRange: [0, 1], outputRange: [fromY, 0] }),
      }],
    };
  }

  // ── Load location + services ─────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const { coords, address: addr, error } = await getFullLocation();

      if (!coords) {
        Alert.alert(
          'Location Unavailable',
          error || 'Please enable GPS to find nearby emergency services.',
          [{ text: 'OK' }]
        );
        setLoading(false);
        return;
      }

      setLocation(coords);
      setAddress(addr);

      const result = await initCache(coords.lat, coords.lon);
      setServices(result.data);
      setOffline(result.isOffline);
      if (result.cacheAge !== null) setCacheAge(result.cacheAge);

      if (result.data?.hospital?.length > 0) {
        setNearest(result.data.hospital[0]);
      }
    } catch (e) {
      console.error('[HomeScreen] loadData error:', e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  // ── SOS press ────────────────────────────────────────────────────────────
  const handleSOS = useCallback(async () => {
    try { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); } catch {}
    Vibration.vibrate([0, 200, 100, 200]);

    // Press-down spring
    Animated.sequence([
      Animated.timing(sosScale, { toValue: 0.91, duration: 90, useNativeDriver: true }),
      Animated.spring(sosScale, { toValue: 1, tension: 160, friction: 5, useNativeDriver: true }),
    ]).start();

    // Red glow flash
    Animated.sequence([
      Animated.timing(sosGlow, { toValue: 1, duration: 120, useNativeDriver: true }),
      Animated.timing(sosGlow, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();

    navigation.navigate('Severity', { location, address, services });
  }, [location, address, services, navigation]);

  // ── Quick action press ───────────────────────────────────────────────────
  const handleQuickAction = useCallback((action) => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch {}
    navigation.navigate('Services', { filterType: action.id, location, services });
  }, [location, services, navigation]);

  // ── Direct call ──────────────────────────────────────────────────────────
  const callNumber = (num) => {
    if (!num) return;
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); } catch {}
    Linking.openURL(`tel:${num}`);
  };

  // ── Service counts ───────────────────────────────────────────────────────
  const totalCount = services
    ? (services.hospital?.length  || 0)
    + (services.police?.length    || 0)
    + (services.ambulance?.length || 0)
    + (services.towing?.length    || 0)
    : 0;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={COLORS.primary}
            colors={[COLORS.primary]}
            progressBackgroundColor={COLORS.backgroundCard}
          />
        }
      >

        {/* ── HEADER ─────────────────────────────────────────────────── */}
        <Animated.View style={[s.header, animStyle(headerAnim, -16)]}>
          <View>
            <Text style={s.appName}>Road<Text style={s.appNameRed}>SoS</Text></Text>
            <View style={s.locationRow}>
              <Ionicons name="location-sharp" size={12} color={COLORS.primary} />
              <Text style={s.locationText} numberOfLines={1}>
                {loading
                  ? 'Locating you...'
                  : address
                  ? getLocationLabel(address)
                  : 'Location unavailable'}
              </Text>
            </View>
          </View>

          {/* Voice-always-on indicator */}
          <Animated.View style={[s.micBubble, { transform: [{ scale: micPulse }] }]}>
            <Ionicons name="mic" size={17} color={COLORS.primary} />
            <View style={s.micActiveDot} />
          </Animated.View>
        </Animated.View>

        {/* ── OFFLINE BANNER ─────────────────────────────────────────── */}
        {offline && (
          <View style={s.offlineBanner}>
            <Ionicons name="cloud-offline-outline" size={12} color={COLORS.primary} />
            <Text style={s.offlineBannerText}>
              OFFLINE{cacheAge !== null ? `  ·  Data from ${cacheAge} min ago` : ''}
            </Text>
          </View>
        )}

        {/* ── STATUS LINE ────────────────────────────────────────────── */}
        <Animated.View style={[s.statusRow, animStyle(sosAnim, 0)]}>
          <View style={[s.statusDot, {
            backgroundColor: loading
              ? COLORS.loading
              : totalCount > 0 ? COLORS.secondary : COLORS.textMuted,
          }]} />
          <Text style={s.statusText}>
            {loading
              ? 'Scanning nearby services...'
              : totalCount > 0
              ? `${totalCount} emergency services found nearby`
              : 'No services found — pull to refresh'}
          </Text>
        </Animated.View>

        {/* ── SOS BUTTON + PULSE RINGS ───────────────────────────────── */}
        <Animated.View style={[s.sosZone, animStyle(sosAnim, 10)]}>

          {/* Glow flash */}
          <Animated.View style={[s.sosGlowFlash, {
            opacity: sosGlow.interpolate({ inputRange: [0,1], outputRange: [0, 0.35] }),
          }]} />

          {/* Ring 1 */}
          <Animated.View style={[s.ring, {
            transform: [{ scale: ring1Scale }], opacity: ring1Opacity,
          }]} />
          {/* Ring 2 */}
          <Animated.View style={[s.ring, s.ring2, {
            transform: [{ scale: ring2Scale }], opacity: ring2Opacity,
          }]} />
          {/* Ring 3 */}
          <Animated.View style={[s.ring, s.ring3, {
            transform: [{ scale: ring3Scale }], opacity: ring3Opacity,
          }]} />

          {/* The button */}
          <Animated.View style={{ transform: [{ scale: sosScale }] }}>
            <TouchableOpacity
              style={s.sosButton}
              onPress={handleSOS}
              activeOpacity={0.88}
              accessibilityLabel="SOS Emergency Button"
              accessibilityRole="button"
            >
              <Text style={s.sosText}>SOS</Text>
              <Text style={s.sosSub}>PRESS FOR HELP</Text>
            </TouchableOpacity>
          </Animated.View>

        </Animated.View>

        {/* ── NEAREST HOSPITAL HINT ──────────────────────────────────── */}
        {nearestHospital && !loading && (
          <Animated.View style={animStyle(gridAnim, 0)}>
            <TouchableOpacity
              style={s.nearestRow}
              onPress={() => navigation.navigate('Services', {
                filterType: SERVICE_TYPES.HOSPITAL, location, services,
              })}
              activeOpacity={0.7}
            >
              <Ionicons name="medical" size={13} color={COLORS.serviceHospital} />
              <Text style={s.nearestText} numberOfLines={1}>
                {nearestHospital.name}
              </Text>
              <Text style={s.nearestDist}>{nearestHospital.distanceLabel}</Text>
              <Ionicons name="chevron-forward" size={13} color={COLORS.textMuted} />
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* ── QUICK ACTION GRID ──────────────────────────────────────── */}
        <Animated.View style={[s.section, animStyle(gridAnim, 20)]}>
          <Text style={s.sectionLabel}>QUICK RESPONSE</Text>
          <View style={s.grid}>
            {QUICK_ACTIONS.map((action, i) => (
              <QuickActionBtn
                key={action.id}
                action={action}
                count={services?.[action.id]?.length ?? null}
                loading={loading}
                onPress={() => handleQuickAction(action)}
                onLongPress={() => action.emergency && callNumber(action.emergency)}
                index={i}
              />
            ))}
          </View>
          <Text style={s.hint}>Long-press to call emergency number directly</Text>
        </Animated.View>

        {/* ── EMERGENCY NUMBERS STRIP ────────────────────────────────── */}
        <Animated.View style={[s.section, animStyle(chipsAnim, 20)]}>
          <Text style={s.sectionLabel}>NATIONAL EMERGENCY</Text>
          <View style={s.chipsRow}>
            {EMERGENCY_NUMBERS.map(({ number, label }) => (
              <TouchableOpacity
                key={number}
                style={s.chip}
                onPress={() => callNumber(number)}
                activeOpacity={0.65}
              >
                <Text style={s.chipNumber}>{number}</Text>
                <Text style={s.chipLabel}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Animated.View>

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── QuickActionBtn ───────────────────────────────────────────────────────────
function QuickActionBtn({ action, count, loading, onPress, onLongPress, index }) {
  const enter      = useRef(new Animated.Value(0)).current;
  const pressScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.delay(index * 70),
      Animated.spring(enter, { toValue: 1, tension: 90, friction: 7, useNativeDriver: true }),
    ]).start();
  }, []);

  const onPressIn  = () =>
    Animated.spring(pressScale, { toValue: 0.94, useNativeDriver: true, tension: 300 }).start();
  const onPressOut = () =>
    Animated.spring(pressScale, { toValue: 1,    useNativeDriver: true, tension: 300 }).start();

  const Icon = action.lib === 'MaterialCommunityIcons'
    ? MaterialCommunityIcons
    : Ionicons;

  return (
    <Animated.View style={{
      width: '47%',
      opacity: enter,
      transform: [
        { scale: Animated.multiply(
            enter.interpolate({ inputRange: [0,1], outputRange: [0.82, 1] }),
            pressScale
          )
        },
      ],
    }}>
      <TouchableOpacity
        style={[s.quickBtn, { borderColor: action.color + '30' }]}
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        activeOpacity={1}
        delayLongPress={600}
      >
        {/* Icon */}
        <View style={[s.quickIcon, { backgroundColor: action.bg }]}>
          <Icon name={action.icon} size={26} color={action.color} />
        </View>

        {/* Label */}
        <Text style={s.quickLabel}>{action.label}</Text>

        {/* Count badge */}
        {!loading && count !== null && (
          <View style={[s.badge, { backgroundColor: action.color + '1A', borderColor: action.color + '40' }]}>
            <Text style={[s.badgeText, { color: action.color }]}>
              {count > 0 ? count : '0'}
            </Text>
          </View>
        )}
        {loading && <Text style={s.badgeLoading}>·</Text>}
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLORS.background,
  },

  scroll: { flex: 1 },
  content: { paddingBottom: 16 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 10,
  },
  appName: {
    color: COLORS.textPrimary,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 1,
    marginBottom: 3,
  },
  appNameRed: {
    color: COLORS.primary,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  locationText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '500',
    maxWidth: 230,
  },
  micBubble: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.primaryGlow,
    borderWidth: 1,
    borderColor: COLORS.primary + '40',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micActiveDot: {
    position: 'absolute',
    top: 9,
    right: 9,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: COLORS.secondary,
    borderWidth: 1.5,
    borderColor: COLORS.background,
  },

  // Offline banner
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: 'rgba(255,45,45,0.07)',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.primary + '28',
    paddingVertical: 6,
  },
  offlineBannerText: {
    color: COLORS.primary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
  },

  // Status line
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 14,
    marginBottom: 4,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusText: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },

  // SOS zone
  sosZone: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    marginBottom: 8,
    height: SOS_SIZE + 130,
  },
  sosGlowFlash: {
    position: 'absolute',
    width: SOS_SIZE + 80,
    height: SOS_SIZE + 80,
    borderRadius: (SOS_SIZE + 80) / 2,
    backgroundColor: COLORS.primary,
  },
  ring: {
    position: 'absolute',
    width: SOS_SIZE,
    height: SOS_SIZE,
    borderRadius: SOS_SIZE / 2,
    borderWidth: 2,
    borderColor: COLORS.primary,
  },
  ring2: { borderWidth: 1.5 },
  ring3: { borderWidth: 1 },
  sosButton: {
    width: SOS_SIZE,
    height: SOS_SIZE,
    borderRadius: SOS_SIZE / 2,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.14)',
    elevation: 24,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.85,
    shadowRadius: 36,
  },
  sosText: {
    color: '#fff',
    fontSize: 54,
    fontWeight: '900',
    letterSpacing: 6,
    lineHeight: 58,
  },
  sosSub: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 3.5,
    marginTop: 3,
  },

  // Nearest hospital row
  nearestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: COLORS.backgroundCard,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginHorizontal: 20,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  nearestText: {
    flex: 1,
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '500',
  },
  nearestDist: {
    color: COLORS.serviceHospital,
    fontSize: 12,
    fontWeight: '700',
  },

  // Section
  section: {
    paddingHorizontal: 20,
    marginBottom: 24,
  },
  sectionLabel: {
    color: COLORS.textMuted,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 2.2,
    marginBottom: 12,
  },

  // Quick action grid
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  quickBtn: {
    backgroundColor: COLORS.backgroundCard,
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    gap: 10,
    minHeight: 110,
    position: 'relative',
  },
  quickIcon: {
    width: 50,
    height: 50,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickLabel: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  badge: {
    position: 'absolute',
    top: 11,
    right: 11,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '800',
  },
  badgeLoading: {
    position: 'absolute',
    top: 11,
    right: 14,
    color: COLORS.textMuted,
    fontSize: 18,
    fontWeight: '600',
  },
  hint: {
    color: COLORS.textMuted,
    fontSize: 10,
    textAlign: 'center',
    marginTop: 10,
    letterSpacing: 0.2,
  },

  // Emergency chips
  chipsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  chip: {
    flex: 1,
    backgroundColor: COLORS.backgroundCard,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    paddingVertical: 13,
    minHeight: 56,
  },
  chipNumber: {
    color: COLORS.primary,
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  chipLabel: {
    color: COLORS.textMuted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginTop: 2,
    textTransform: 'uppercase',
  },
});
