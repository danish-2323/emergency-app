/**
 * RoadSoS — screens/ServicesScreen.js
 *
 * Full filterable list of all nearby emergency services.
 * Sorted by distance (nearest first).
 *
 * Features:
 *  - Filter tab bar: All | Hospital | Police | Ambulance | Towing | Repair
 *  - ServiceCard: name, distance, address, phone, open/closed badge
 *  - Green CALL button on every card (direct dial)
 *  - Map icon → open in MapScreen focused on that pin
 *  - Pull-to-refresh live refetch
 *  - Skeleton loading cards while fetching
 *  - Empty state per filter type
 *  - Deep-link: filterType param from HomeScreen quick-action buttons
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Animated, RefreshControl, Linking, ScrollView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import COLORS from '../constants/colors';
import { SERVICE_TYPES, UI } from '../constants/config';
import { getFullLocation, getLocationLabel } from '../services/LocationService';
import { initCache, isOnline } from '../services/OfflineService';

// ─── Filter Tab Config ────────────────────────────────────────────────────────
const FILTERS = [
  { key: 'all',                        label: 'All',       icon: 'grid-outline',      lib: 'Ionicons' },
  { key: SERVICE_TYPES.HOSPITAL,       label: 'Hospital',  icon: 'medkit',            lib: 'Ionicons' },
  { key: SERVICE_TYPES.POLICE,         label: 'Police',    icon: 'shield-checkmark',  lib: 'Ionicons' },
  { key: SERVICE_TYPES.AMBULANCE,      label: 'Ambulance', icon: 'car-emergency',     lib: 'MaterialCommunityIcons' },
  { key: SERVICE_TYPES.TOWING,         label: 'Towing',    icon: 'car-wrench',        lib: 'MaterialCommunityIcons' },
  { key: SERVICE_TYPES.PUNCTURE,       label: 'Repair',    icon: 'construct-outline', lib: 'Ionicons' },
];

// ─── Type metadata ────────────────────────────────────────────────────────────
const TYPE_META = {
  [SERVICE_TYPES.HOSPITAL]:  { color: COLORS.serviceHospital,  bg: COLORS.serviceHospitalBg,  emoji: '🏥', label: 'Hospital'  },
  [SERVICE_TYPES.POLICE]:    { color: COLORS.servicePolice,    bg: COLORS.servicePoliceBg,    emoji: '👮', label: 'Police'    },
  [SERVICE_TYPES.AMBULANCE]: { color: COLORS.serviceAmbulance, bg: COLORS.serviceAmbulanceBg, emoji: '🚑', label: 'Ambulance' },
  [SERVICE_TYPES.TOWING]:    { color: COLORS.serviceTowing,    bg: COLORS.serviceTowingBg,    emoji: '🚗', label: 'Towing'    },
  [SERVICE_TYPES.PUNCTURE]:  { color: COLORS.servicePuncture,  bg: COLORS.servicePunctureBg,  emoji: '🔧', label: 'Repair'    },
};

// ─── ServiceCard Component ────────────────────────────────────────────────────
function ServiceCard({ service, index, onCall, onMap, onPress }) {
  const meta       = TYPE_META[service.type] || TYPE_META[SERVICE_TYPES.HOSPITAL];
  const enterAnim  = useRef(new Animated.Value(0)).current;
  const pressScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.delay(Math.min(index * 55, 500)),
      Animated.spring(enterAnim, {
        toValue: 1, tension: 75, friction: 9, useNativeDriver: true,
      }),
    ]).start();
  }, []);

  const handlePressIn  = () =>
    Animated.spring(pressScale, { toValue: 0.97, useNativeDriver: true, tension: 300 }).start();
  const handlePressOut = () =>
    Animated.spring(pressScale, { toValue: 1.0,  useNativeDriver: true, tension: 300 }).start();

  return (
    <Animated.View style={{
      opacity: enterAnim,
      transform: [
        { translateY: enterAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) },
        { scale: pressScale },
      ],
    }}>
      <TouchableOpacity
        style={[sc.card, { borderColor: meta.color + '25' }]}
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={1}
      >
        {/* Left accent bar */}
        <View style={[sc.accentBar, { backgroundColor: meta.color }]} />

        {/* Main content */}
        <View style={sc.body}>
          {/* Top row: type badge + distance */}
          <View style={sc.topRow}>
            <View style={[sc.typeBadge, { backgroundColor: meta.bg, borderColor: meta.color + '35' }]}>
              <Text style={sc.typeEmoji}>{meta.emoji}</Text>
              <Text style={[sc.typeLabel, { color: meta.color }]}>
                {meta.label.toUpperCase()}
              </Text>
            </View>

            <View style={sc.distRow}>
              <Ionicons name="location-outline" size={12} color={COLORS.textMuted} />
              <Text style={[sc.dist, { color: meta.color }]}>
                {service.distanceLabel}
              </Text>
            </View>
          </View>

          {/* Name */}
          <Text style={sc.name} numberOfLines={2}>{service.name}</Text>

          {/* Address */}
          {service.address ? (
            <Text style={sc.address} numberOfLines={1}>{service.address}</Text>
          ) : null}

          {/* Bottom row: status + phone */}
          <View style={sc.bottomRow}>
            {/* Open/Closed badge */}
            {service.openNow !== null && (
              <View style={[
                sc.openBadge,
                { backgroundColor: service.openNow ? COLORS.secondary + '18' : COLORS.primary + '15',
                  borderColor:      service.openNow ? COLORS.secondary + '40' : COLORS.primary + '35' },
              ]}>
                <View style={[sc.openDot, {
                  backgroundColor: service.openNow ? COLORS.secondary : COLORS.primary,
                }]} />
                <Text style={[sc.openText, {
                  color: service.openNow ? COLORS.secondary : COLORS.primary,
                }]}>
                  {service.openNow ? 'Open' : 'Closed'}
                </Text>
              </View>
            )}

            {service.is24hr && (
              <View style={sc.badge24}>
                <Text style={sc.badge24Text}>24/7</Text>
              </View>
            )}

            {/* Phone number */}
            {service.phone && (
              <Text style={sc.phone} numberOfLines={1}>{service.phone}</Text>
            )}
          </View>
        </View>

        {/* Right action column */}
        <View style={sc.actions}>
          {/* CALL button */}
          <TouchableOpacity
            style={[
              sc.callBtn,
              !service.phone && sc.callBtnDisabled,
              { backgroundColor: service.phone ? meta.color : COLORS.backgroundElevated },
            ]}
            onPress={() => service.phone && onCall(service)}
            disabled={!service.phone}
            accessibilityLabel={`Call ${service.name}`}
          >
            <Ionicons
              name="call"
              size={16}
              color={service.phone ? '#fff' : COLORS.textMuted}
            />
            <Text style={[
              sc.callBtnText,
              !service.phone && { color: COLORS.textMuted },
            ]}>
              {service.phone ? 'CALL' : '—'}
            </Text>
          </TouchableOpacity>

          {/* Map button */}
          <TouchableOpacity style={sc.mapBtn} onPress={() => onMap(service)}>
            <Ionicons name="map-outline" size={16} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Skeleton Loading Card ────────────────────────────────────────────────────
function SkeletonCard({ index }) {
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const opacity = shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.65] });

  return (
    <Animated.View style={[sk.card, { opacity }]}>
      <View style={sk.bar} />
      <View style={sk.body}>
        <View style={sk.badgeRow}>
          <View style={sk.badge} />
          <View style={sk.distBadge} />
        </View>
        <View style={sk.nameLine} />
        <View style={[sk.nameLine, { width: '55%' }]} />
        <View style={sk.addrLine} />
      </View>
      <View style={sk.callArea}>
        <View style={sk.callSkel} />
        <View style={sk.mapSkel} />
      </View>
    </Animated.View>
  );
}

// ─── Filter Tab Bar ───────────────────────────────────────────────────────────
function FilterTabBar({ active, onSelect, counts }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={ft.row}
    >
      {FILTERS.map(tab => {
        const isActive = active === tab.key;
        const meta     = TYPE_META[tab.key];
        const color    = meta?.color || COLORS.primary;
        const count    = tab.key === 'all'
          ? Object.values(counts).reduce((a, b) => a + b, 0)
          : (counts[tab.key] || 0);

        const IconComp = tab.lib === 'MaterialCommunityIcons'
          ? MaterialCommunityIcons : Ionicons;

        return (
          <TouchableOpacity
            key={tab.key}
            style={[
              ft.tab,
              isActive && { backgroundColor: color + '1E', borderColor: color + '55' },
            ]}
            onPress={() => onSelect(tab.key)}
          >
            <IconComp
              name={tab.icon}
              size={14}
              color={isActive ? color : COLORS.textMuted}
            />
            <Text style={[ft.label, isActive && { color }]}>
              {tab.label}
            </Text>
            {count > 0 && (
              <View style={[ft.count, isActive && { backgroundColor: color }]}>
                <Text style={[ft.countText, !isActive && { color: COLORS.textMuted }]}>
                  {count}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ─── Sort Control ─────────────────────────────────────────────────────────────
const SORT_OPTIONS = [
  { key: 'distance', label: 'Nearest' },
  { key: 'name',     label: 'Name'    },
  { key: 'open',     label: 'Open Now' },
];

function SortControl({ active, onSelect }) {
  return (
    <View style={so.row}>
      <Text style={so.label}>Sort:</Text>
      {SORT_OPTIONS.map(opt => (
        <TouchableOpacity
          key={opt.key}
          style={[so.chip, active === opt.key && so.chipActive]}
          onPress={() => onSelect(opt.key)}
        >
          <Text style={[so.chipText, active === opt.key && so.chipTextActive]}>
            {opt.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────────────
function EmptyState({ filter, offline, onRefresh }) {
  const meta = TYPE_META[filter];
  return (
    <View style={es.wrap}>
      <Text style={es.emoji}>{meta?.emoji || '🔍'}</Text>
      <Text style={es.title}>
        {offline ? 'Offline — no cached data' : `No ${meta?.label || 'service'}s found`}
      </Text>
      <Text style={es.sub}>
        {offline
          ? 'Connect to internet and pull to refresh.'
          : `No ${(meta?.label || 'services').toLowerCase()} within range. Try refreshing or widening search.`}
      </Text>
      <TouchableOpacity style={es.refreshBtn} onPress={onRefresh}>
        <Ionicons name="refresh" size={16} color={COLORS.primary} />
        <Text style={es.refreshText}>Pull to refresh</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function ServicesScreen({ navigation, route }) {
  const initFilter   = route?.params?.filterType || 'all';
  const routeServices = route?.params?.services  || null;
  const routeLocation = route?.params?.location  || null;

  const [location, setLocation]       = useState(routeLocation);
  const [address,  setAddress]        = useState(null);
  const [allServices, setAll]         = useState([]);
  const [activeFilter, setFilter]     = useState(initFilter);
  const [sortBy, setSortBy]           = useState('distance');
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);
  const [offline, setOffline]         = useState(false);

  // ── Init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    loadServices();
  }, []);

  // Update filter if navigated from HomeScreen quick-action
  useEffect(() => {
    if (route?.params?.filterType) {
      setFilter(route.params.filterType);
    }
  }, [route?.params?.filterType]);

  const loadServices = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    try {
      let loc = routeLocation;
      let addr = null;

      if (!loc) {
        const result = await getFullLocation();
        loc  = result.coords;
        addr = result.address;
        setAddress(addr);
      }
      if (!loc) { setLoading(false); return; }
      setLocation(loc);

      // Get from route params first (fast), then cache
      let data = routeServices;
      if (!data || forceRefresh) {
        const cacheResult = await initCache(loc.lat, loc.lon, { forceRefresh });
        data = cacheResult.data;
        setOffline(cacheResult.isOffline);
      }

      setAll(flatten(data));
    } catch (e) {
      console.error('[ServicesScreen] loadServices error:', e.message);
    } finally {
      setLoading(false);
    }
  }, [routeLocation, routeServices]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadServices(true);
    setRefreshing(false);
  }, [loadServices]);

  // ── Flatten + filter + sort ───────────────────────────────────────────
  function flatten(data) {
    if (!data) return [];
    return [
      ...(data.hospital  || []),
      ...(data.police    || []),
      ...(data.ambulance || []),
      ...(data.towing    || []),
      ...(data.puncture  || []),
    ];
  }

  const displayList = useMemo(() => {
    let list = activeFilter === 'all'
      ? allServices
      : allServices.filter(s => s.type === activeFilter);

    // Sort
    switch (sortBy) {
      case 'distance':
        list = [...list].sort((a, b) => a.distance - b.distance);
        break;
      case 'name':
        list = [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        break;
      case 'open':
        list = [...list].sort((a, b) => {
          if (a.openNow === true  && b.openNow !== true)  return -1;
          if (a.openNow !== true  && b.openNow === true)  return  1;
          return a.distance - b.distance;
        });
        break;
    }
    return list;
  }, [allServices, activeFilter, sortBy]);

  // Per-type counts for filter tabs
  const counts = useMemo(() => {
    const c = {};
    FILTERS.slice(1).forEach(f => {
      c[f.key] = allServices.filter(s => s.type === f.key).length;
    });
    return c;
  }, [allServices]);

  // ── Actions ───────────────────────────────────────────────────────────
  const handleCall = useCallback((service) => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); } catch {}
    Linking.openURL(`tel:${service.phone}`);
  }, []);

  const handleMap = useCallback((service) => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    navigation.navigate('Map', { focusService: service, location });
  }, [navigation, location]);

  const handleCardPress = useCallback((service) => {
    navigation.navigate('Map', { focusService: service, location });
  }, [navigation, location]);

  const handleFilterSelect = useCallback((key) => {
    try { Haptics.selectionAsync(); } catch {}
    setFilter(key);
  }, []);

  // ── Render item ───────────────────────────────────────────────────────
  const renderItem = useCallback(({ item, index }) => (
    <ServiceCard
      service={item}
      index={index}
      onCall={handleCall}
      onMap={handleMap}
      onPress={() => handleCardPress(item)}
    />
  ), [handleCall, handleMap, handleCardPress]);

  const keyExtractor = useCallback((item) => item.id, []);

  const ListHeader = useMemo(() => (
    <SortControl active={sortBy} onSelect={setSortBy} />
  ), [sortBy]);

  const ListEmpty = !loading ? (
    <EmptyState
      filter={activeFilter}
      offline={offline}
      onRefresh={onRefresh}
    />
  ) : null;

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe} edges={['top']}>

      {/* ── Header ── */}
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>Emergency Services</Text>
          <Text style={s.headerSub}>
            {address
              ? getLocationLabel(address)
              : location
              ? `${location.lat?.toFixed(3)}, ${location.lon?.toFixed(3)}`
              : 'Locating...'}
          </Text>
        </View>
        {offline && (
          <View style={s.offlinePill}>
            <Ionicons name="cloud-offline-outline" size={11} color={COLORS.primary} />
            <Text style={s.offlinePillText}>OFFLINE</Text>
          </View>
        )}
      </View>

      {/* ── Filter Tab Bar ── */}
      <View style={s.filterWrap}>
        <FilterTabBar
          active={activeFilter}
          onSelect={handleFilterSelect}
          counts={counts}
        />
      </View>

      {/* ── Results count ── */}
      {!loading && (
        <View style={s.resultsBar}>
          <Text style={s.resultsText}>
            {displayList.length} {activeFilter === 'all' ? 'services' : (TYPE_META[activeFilter]?.label || activeFilter) + 's'} found
          </Text>
          {offline && (
            <Text style={s.cacheNote}>Cached data</Text>
          )}
        </View>
      )}

      {/* ── List ── */}
      {loading && !refreshing ? (
        // Skeleton loading state
        <FlatList
          data={Array(5).fill(null)}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ index }) => <SkeletonCard index={index} />}
          contentContainerStyle={s.listContent}
          showsVerticalScrollIndicator={false}
        />
      ) : (
        <FlatList
          data={displayList}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={s.listContent}
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
          ListHeaderComponent={displayList.length > 0 ? ListHeader : null}
          ListEmptyComponent={ListEmpty}
          initialNumToRender={8}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews={Platform.OS === 'android'}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: COLORS.background },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: COLORS.navBorder,
  },
  headerTitle: { color: COLORS.textPrimary, fontSize: 18, fontWeight: '800' },
  headerSub:   { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },

  offlinePill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: COLORS.primary + '18',
    borderWidth: 1, borderColor: COLORS.primary + '40',
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5,
  },
  offlinePillText: { color: COLORS.primary, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },

  filterWrap: {
    backgroundColor: COLORS.navBackground,
    borderBottomWidth: 1, borderBottomColor: COLORS.navBorder,
    paddingVertical: 8,
  },

  resultsBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  resultsText: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },
  cacheNote:   { color: COLORS.textMuted, fontSize: 11, fontStyle: 'italic' },

  listContent: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
});

// ─── ServiceCard styles ───────────────────────────────────────────────────────
const sc = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: COLORS.backgroundCard,
    borderRadius: 14, borderWidth: 1,
    overflow: 'hidden',
    minHeight: 110,
  },
  accentBar: { width: 4 },
  body:      { flex: 1, padding: 14, gap: 5 },

  topRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
  },
  typeBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 4,
  },
  typeEmoji: { fontSize: 13 },
  typeLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },

  distRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  dist:    { fontSize: 13, fontWeight: '800' },

  name:    { color: COLORS.textPrimary, fontSize: 14, fontWeight: '700', lineHeight: 20 },
  address: { color: COLORS.textSecondary, fontSize: 11 },

  bottomRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },

  openBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 3,
  },
  openDot:  { width: 5, height: 5, borderRadius: 3 },
  openText: { fontSize: 10, fontWeight: '700' },

  badge24: {
    backgroundColor: COLORS.secondary + '20',
    borderRadius: 6, borderWidth: 1, borderColor: COLORS.secondary + '40',
    paddingHorizontal: 6, paddingVertical: 3,
  },
  badge24Text: { color: COLORS.secondary, fontSize: 9, fontWeight: '800' },

  phone: { color: COLORS.textMuted, fontSize: 11, flex: 1 },

  actions: {
    justifyContent: 'center', alignItems: 'center',
    gap: 8, paddingRight: 12, paddingVertical: 12,
  },
  callBtn: {
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 10, gap: 3,
    paddingHorizontal: 12, paddingVertical: 10,
    minWidth: 58, minHeight: 58,
  },
  callBtnDisabled: { opacity: 0.5 },
  callBtnText: {
    color: '#fff', fontSize: 9, fontWeight: '900', letterSpacing: 0.5,
  },
  mapBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: COLORS.backgroundElevated,
    borderWidth: 1, borderColor: COLORS.border,
    alignItems: 'center', justifyContent: 'center',
  },
});

// ─── Skeleton styles ──────────────────────────────────────────────────────────
const sk = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: COLORS.backgroundCard,
    borderRadius: 14, borderWidth: 1, borderColor: COLORS.border,
    overflow: 'hidden', height: 110, marginBottom: 10,
  },
  bar:  { width: 4, backgroundColor: COLORS.border },
  body: { flex: 1, padding: 14, gap: 8 },
  badgeRow: { flexDirection: 'row', justifyContent: 'space-between' },
  badge:    { width: 80, height: 22, borderRadius: 8, backgroundColor: COLORS.border },
  distBadge:{ width: 50, height: 22, borderRadius: 8, backgroundColor: COLORS.border },
  nameLine: { width: '80%', height: 14, borderRadius: 6, backgroundColor: COLORS.border },
  addrLine: { width: '60%', height: 11, borderRadius: 5, backgroundColor: COLORS.border },
  callArea: { justifyContent: 'center', alignItems: 'center', gap: 8, paddingRight: 12 },
  callSkel: { width: 56, height: 56, borderRadius: 10, backgroundColor: COLORS.border },
  mapSkel:  { width: 36, height: 36, borderRadius: 10, backgroundColor: COLORS.border },
});

// ─── Filter tab styles ────────────────────────────────────────────────────────
const ft = StyleSheet.create({
  row: { paddingHorizontal: 12, gap: 8, alignItems: 'center' },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 20, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.backgroundCard,
  },
  label:     { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },
  count: {
    minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: COLORS.backgroundElevated,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 4,
  },
  countText: { color: '#fff', fontSize: 9, fontWeight: '800' },
});

// ─── Sort control styles ──────────────────────────────────────────────────────
const so = StyleSheet.create({
  row:    { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
  label:  { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 14, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.backgroundCard,
  },
  chipActive: {
    backgroundColor: COLORS.primary + '1A',
    borderColor: COLORS.primary + '55',
  },
  chipText:       { color: COLORS.textMuted,    fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: COLORS.primary,       fontSize: 12, fontWeight: '700' },
});

// ─── Empty state styles ───────────────────────────────────────────────────────
const es = StyleSheet.create({
  wrap: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 40, paddingTop: 60, gap: 12,
  },
  emoji:      { fontSize: 52 },
  title:      { color: COLORS.textPrimary, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  sub:        { color: COLORS.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  refreshBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8,
    borderWidth: 1, borderColor: COLORS.primary + '44',
    borderRadius: 12, paddingHorizontal: 18, paddingVertical: 12,
  },
  refreshText: { color: COLORS.primary, fontSize: 13, fontWeight: '700' },
});
