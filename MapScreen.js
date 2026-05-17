/**
 * RoadSoS — screens/MapScreen.js
 *
 * OpenStreetMap map rendered via WebView (Leaflet.js).
 * No paid API key required — 100% free tile server.
 *
 * Features:
 *  - Blue dot for user location (pulsing CSS animation)
 *  - Colour-coded pins per service type
 *      🔴 Hospital  🔵 Police  🟠 Ambulance  ⚫ Towing  🟣 Puncture
 *  - Tap a pin → slide-up detail panel with CALL + Directions buttons
 *  - Filter tab bar: All / Hospital / Police / Ambulance / Towing
 *  - Recenter button (snaps back to user location)
 *  - Offline fallback message when WebView can't load tiles
 *  - focusService param: deep-link from ChatScreen to open a specific pin
 */

import React, {
  useEffect, useRef, useState, useCallback, useMemo,
} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated,
  Linking, ScrollView, Platform, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import COLORS from '../constants/colors';
import { SERVICE_TYPES, UI } from '../constants/config';
import { getFullLocation, getLocationLabel } from '../services/LocationService';
import { initCache } from '../services/OfflineService';

const { height: SCREEN_H } = Dimensions.get('window');

// ─── Service type metadata ────────────────────────────────────────────────────
const TYPE_META = {
  [SERVICE_TYPES.HOSPITAL]:  { color: '#FF2D2D', label: 'Hospital',  icon: '🏥' },
  [SERVICE_TYPES.POLICE]:    { color: '#2979FF', label: 'Police',    icon: '👮' },
  [SERVICE_TYPES.AMBULANCE]: { color: '#FF6D00', label: 'Ambulance', icon: '🚑' },
  [SERVICE_TYPES.TOWING]:    { color: '#78909C', label: 'Towing',    icon: '🚗' },
  [SERVICE_TYPES.PUNCTURE]:  { color: '#AB47BC', label: 'Repair',    icon: '🔧' },
};

const FILTER_TABS = [
  { key: 'all',                        label: 'All' },
  { key: SERVICE_TYPES.HOSPITAL,       label: 'Hospital' },
  { key: SERVICE_TYPES.POLICE,         label: 'Police' },
  { key: SERVICE_TYPES.AMBULANCE,      label: 'Ambulance' },
  { key: SERVICE_TYPES.TOWING,         label: 'Towing' },
];

// ─── Build the full HTML page (Leaflet map) ───────────────────────────────────
function buildMapHTML(userLat, userLon, services) {
  // Serialise services to JSON for injection into HTML
  const servicesJSON = JSON.stringify(services || []);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, #map { width: 100%; height: 100%; background: #0A0A0A; }

    /* User location pulsing dot */
    .user-dot-outer {
      width: 20px; height: 20px;
      border-radius: 50%;
      background: rgba(41,121,255,0.25);
      display: flex; align-items: center; justify-content: center;
      animation: userPulse 2s infinite;
    }
    .user-dot-inner {
      width: 12px; height: 12px;
      border-radius: 50%;
      background: #2979FF;
      border: 2px solid white;
      box-shadow: 0 0 8px rgba(41,121,255,0.8);
    }
    @keyframes userPulse {
      0%   { transform: scale(1);   opacity: 1; }
      50%  { transform: scale(1.6); opacity: 0.5; }
      100% { transform: scale(1);   opacity: 1; }
    }

    /* Service pin */
    .service-pin {
      display: flex; align-items: center; justify-content: center;
      width: 36px; height: 36px;
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      border: 2px solid rgba(255,255,255,0.3);
      box-shadow: 0 2px 8px rgba(0,0,0,0.5);
      cursor: pointer;
      transition: transform 0.15s;
    }
    .service-pin:active { transform: rotate(-45deg) scale(0.9); }
    .service-pin span {
      transform: rotate(45deg);
      font-size: 16px;
      line-height: 1;
    }

    /* Leaflet dark tiles override */
    .leaflet-tile-container img { filter: brightness(0.85) saturate(0.9); }

    /* Leaflet popups hidden (we handle in RN) */
    .leaflet-popup { display: none !important; }
  </style>
</head>
<body>
<div id="map"></div>
<script>
  // ── Init map ──────────────────────────────────────────────────────────
  var map = L.map('map', {
    center: [${userLat}, ${userLon}],
    zoom: 14,
    zoomControl: false,
    attributionControl: true,
  });

  // OpenStreetMap free tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
    subdomains: 'abc',
  }).addTo(map);

  // ── User location marker ──────────────────────────────────────────────
  var userIcon = L.divIcon({
    html: '<div class="user-dot-outer"><div class="user-dot-inner"></div></div>',
    className: '',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
  L.marker([${userLat}, ${userLon}], { icon: userIcon, zIndexOffset: 1000 })
   .addTo(map);

  // Accuracy circle
  L.circle([${userLat}, ${userLon}], {
    radius: 80,
    color: '#2979FF',
    fillColor: '#2979FF',
    fillOpacity: 0.08,
    weight: 1,
  }).addTo(map);

  // ── Service markers ───────────────────────────────────────────────────
  var services = ${servicesJSON};
  var colorMap = {
    hospital:  '#FF2D2D',
    police:    '#2979FF',
    ambulance: '#FF6D00',
    towing:    '#78909C',
    puncture:  '#AB47BC',
  };
  var iconMap = {
    hospital: '🏥', police: '👮', ambulance: '🚑',
    towing: '🚗', puncture: '🔧',
  };
  var markers = [];

  services.forEach(function(svc) {
    if (!svc.lat || !svc.lon) return;
    var color = colorMap[svc.type] || '#888';
    var icon  = iconMap[svc.type]  || '📍';

    var pinIcon = L.divIcon({
      html: '<div class="service-pin" style="background:' + color + '"><span>' + icon + '</span></div>',
      className: '',
      iconSize:   [36, 36],
      iconAnchor: [9, 36],
      popupAnchor:[9, -36],
    });

    var marker = L.marker([svc.lat, svc.lon], { icon: pinIcon })
      .addTo(map);

    // On tap: send service data up to React Native
    marker.on('click', function() {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'SERVICE_TAP',
        service: svc,
      }));
    });

    markers.push({ marker: marker, service: svc });
  });

  // ── Recenter function (called from RN) ───────────────────────────────
  function recenter() {
    map.setView([${userLat}, ${userLon}], 14, { animate: true });
  }

  // ── Focus a specific service (called from RN) ────────────────────────
  function focusService(id) {
    var found = markers.find(function(m) { return m.service.id === id; });
    if (found) {
      map.setView([found.service.lat, found.service.lon], 16, { animate: true });
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'SERVICE_TAP',
        service: found.service,
      }));
    }
  }

  // ── Filter markers by type ───────────────────────────────────────────
  function filterMarkers(type) {
    markers.forEach(function(m) {
      if (type === 'all' || m.service.type === type) {
        map.addLayer(m.marker);
      } else {
        map.removeLayer(m.marker);
      }
    });
  }

  // ── Map ready signal ─────────────────────────────────────────────────
  map.whenReady(function() {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'MAP_READY' }));
  });
</script>
</body>
</html>`;
}

// ─── Detail Panel (slides up when a pin is tapped) ───────────────────────────
function DetailPanel({ service, onClose, onCall, onDirections }) {
  const slideY = useRef(new Animated.Value(300)).current;

  useEffect(() => {
    Animated.spring(slideY, {
      toValue: 0, tension: 80, friction: 11, useNativeDriver: true,
    }).start();
  }, [service]);

  if (!service) return null;
  const meta  = TYPE_META[service.type] || TYPE_META[SERVICE_TYPES.HOSPITAL];
  const color = meta.color;

  return (
    <Animated.View style={[dp.panel, { transform: [{ translateY: slideY }] }]}>
      {/* Handle bar */}
      <View style={dp.handle} />

      {/* Close */}
      <TouchableOpacity style={dp.closeBtn} onPress={onClose}>
        <Ionicons name="close" size={20} color={COLORS.textSecondary} />
      </TouchableOpacity>

      {/* Type badge */}
      <View style={[dp.typeBadge, { backgroundColor: color + '22', borderColor: color + '44' }]}>
        <Text style={dp.typeIcon}>{meta.icon}</Text>
        <Text style={[dp.typeLabel, { color }]}>{meta.label.toUpperCase()}</Text>
        {service.is24hr && (
          <View style={[dp.badge24, { backgroundColor: color }]}>
            <Text style={dp.badge24Text}>24/7</Text>
          </View>
        )}
      </View>

      {/* Name */}
      <Text style={dp.name}>{service.name}</Text>

      {/* Meta row */}
      <View style={dp.metaRow}>
        <View style={dp.metaItem}>
          <Ionicons name="location-outline" size={14} color={COLORS.textMuted} />
          <Text style={[dp.metaDist, { color }]}>{service.distanceLabel}</Text>
        </View>
        {service.openNow !== null && (
          <View style={dp.metaItem}>
            <View style={[dp.openDot, {
              backgroundColor: service.openNow ? COLORS.secondary : COLORS.primary,
            }]} />
            <Text style={[dp.openText, {
              color: service.openNow ? COLORS.secondary : COLORS.primary,
            }]}>
              {service.openNow ? 'Open Now' : 'Closed'}
            </Text>
          </View>
        )}
      </View>

      {/* Address */}
      {service.address && (
        <View style={dp.addressRow}>
          <Ionicons name="map-outline" size={13} color={COLORS.textMuted} />
          <Text style={dp.addressText}>{service.address}</Text>
        </View>
      )}

      {/* Action buttons */}
      <View style={dp.actions}>
        <TouchableOpacity
          style={[dp.callBtn, { backgroundColor: color }]}
          onPress={onCall}
          disabled={!service.phone}
        >
          <Ionicons name="call" size={18} color="#fff" />
          <Text style={dp.callBtnText}>
            {service.phone ? 'CALL NOW' : 'No number listed'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={dp.dirBtn} onPress={onDirections}>
          <Ionicons name="navigate-outline" size={18} color={COLORS.textSecondary} />
          <Text style={dp.dirBtnText}>Directions</Text>
        </TouchableOpacity>
      </View>

      {/* Phone number display */}
      {service.phone && (
        <Text style={dp.phoneText}>{service.phone}</Text>
      )}
    </Animated.View>
  );
}

// ─── Filter Tab Bar ───────────────────────────────────────────────────────────
function FilterTabs({ active, onSelect, counts }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={ft.row}
    >
      {FILTER_TABS.map(tab => {
        const isActive = active === tab.key;
        const count    = tab.key === 'all'
          ? Object.values(counts).reduce((a, b) => a + b, 0)
          : (counts[tab.key] || 0);
        const meta     = TYPE_META[tab.key];
        const color    = meta?.color || COLORS.primary;

        return (
          <TouchableOpacity
            key={tab.key}
            style={[
              ft.tab,
              isActive && { backgroundColor: color + '22', borderColor: color + '55' },
            ]}
            onPress={() => onSelect(tab.key)}
          >
            <Text style={[ft.tabText, isActive && { color }]}>
              {tab.label}
            </Text>
            {count > 0 && (
              <View style={[ft.tabCount, isActive && { backgroundColor: color }]}>
                <Text style={[ft.tabCountText, !isActive && { color: COLORS.textMuted }]}>
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

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function MapScreen({ navigation, route }) {
  const focusServiceParam = route?.params?.focusService || null;
  const routeLocation     = route?.params?.location     || null;
  const routeServices     = route?.params?.services     || null;

  const [userLocation, setUserLocation]     = useState(routeLocation);
  const [address, setAddress]               = useState(null);
  const [allServices, setAllServices]       = useState([]);
  const [filteredServices, setFiltered]     = useState([]);
  const [activeFilter, setActiveFilter]     = useState('all');
  const [selectedService, setSelected]      = useState(null);
  const [mapReady, setMapReady]             = useState(false);
  const [loading, setLoading]               = useState(true);
  const [mapHTML, setMapHTML]               = useState('');

  const webViewRef = useRef(null);

  // ── On mount ─────────────────────────────────────────────────────────
  useEffect(() => {
    initMap();
  }, []);

  async function initMap() {
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
      setUserLocation(loc);

      // Get services (from route params or fetch fresh)
      let svcData = routeServices;
      if (!svcData) {
        const cache = await initCache(loc.lat, loc.lon);
        svcData = cache.data;
      }

      const flat = buildFlatList(svcData);
      setAllServices(flat);
      setFiltered(flat);

      // Build the Leaflet HTML with all markers
      const html = buildMapHTML(loc.lat, loc.lon, flat);
      setMapHTML(html);

    } catch (e) {
      console.error('[MapScreen] initMap error:', e.message);
    } finally {
      setLoading(false);
    }
  }

  // Flatten { hospital[], police[], ... } → single sorted array
  function buildFlatList(data) {
    if (!data) return [];
    return [
      ...(data.hospital  || []),
      ...(data.police    || []),
      ...(data.ambulance || []),
      ...(data.towing    || []),
      ...(data.puncture  || []),
    ].sort((a, b) => a.distance - b.distance);
  }

  // ── Map message handler (from Leaflet → RN) ──────────────────────────
  const handleWebViewMessage = useCallback((event) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'MAP_READY') {
        setMapReady(true);
        // If deep-linked to a service, focus it
        if (focusServiceParam) {
          setTimeout(() => focusOnService(focusServiceParam), 400);
        }
      }
      if (msg.type === 'SERVICE_TAP') {
        try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
        setSelected(msg.service);
      }
    } catch {}
  }, [focusServiceParam]);

  // ── Focus a specific service on the map ──────────────────────────────
  function focusOnService(service) {
    setSelected(service);
    webViewRef.current?.injectJavaScript(
      `focusService('${service.id}'); true;`
    );
  }

  // ── Filter handler ────────────────────────────────────────────────────
  const handleFilter = useCallback((type) => {
    setActiveFilter(type);
    setSelected(null);

    const filtered = type === 'all'
      ? allServices
      : allServices.filter(s => s.type === type);
    setFiltered(filtered);

    // Tell the map to hide/show markers
    webViewRef.current?.injectJavaScript(
      `filterMarkers('${type}'); true;`
    );
  }, [allServices]);

  // ── Recenter ──────────────────────────────────────────────────────────
  const handleRecenter = useCallback(() => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch {}
    webViewRef.current?.injectJavaScript(`recenter(); true;`);
    setSelected(null);
  }, []);

  // ── Call ──────────────────────────────────────────────────────────────
  const handleCall = useCallback(() => {
    if (selectedService?.phone) {
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); } catch {}
      Linking.openURL(`tel:${selectedService.phone}`);
    }
  }, [selectedService]);

  // ── Directions (Google Maps / Apple Maps) ─────────────────────────────
  const handleDirections = useCallback(() => {
    if (!selectedService) return;
    const { lat, lon, name } = selectedService;
    const url = Platform.OS === 'ios'
      ? `maps://maps.apple.com/?daddr=${lat},${lon}&q=${encodeURIComponent(name)}`
      : `geo:${lat},${lon}?q=${encodeURIComponent(name)}`;
    Linking.openURL(url).catch(() =>
      Linking.openURL(`https://maps.google.com/?q=${lat},${lon}`)
    );
  }, [selectedService]);

  // ── Count per type (for filter tabs) ─────────────────────────────────
  const counts = useMemo(() => {
    const c = {};
    FILTER_TABS.slice(1).forEach(tab => {
      c[tab.key] = allServices.filter(s => s.type === tab.key).length;
    });
    return c;
  }, [allServices]);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe} edges={['top']}>

      {/* ── Header ── */}
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>Nearby Services</Text>
          <Text style={s.headerSub}>
            {userLocation
              ? address ? getLocationLabel(address) : `${userLocation.lat.toFixed(4)}, ${userLocation.lon.toFixed(4)}`
              : 'Locating...'}
          </Text>
        </View>
        <View style={s.headerRight}>
          <Text style={s.countText}>{filteredServices.length} found</Text>
        </View>
      </View>

      {/* ── Filter Tabs ── */}
      <View style={s.filterBar}>
        <FilterTabs
          active={activeFilter}
          onSelect={handleFilter}
          counts={counts}
        />
      </View>

      {/* ── Map (WebView) ── */}
      <View style={s.mapContainer}>
        {mapHTML ? (
          <WebView
            ref={webViewRef}
            source={{ html: mapHTML }}
            style={s.webview}
            onMessage={handleWebViewMessage}
            javaScriptEnabled
            domStorageEnabled
            startInLoadingState
            renderLoading={() => (
              <View style={s.mapLoading}>
                <Ionicons name="map" size={32} color={COLORS.textMuted} />
                <Text style={s.mapLoadingText}>Loading map...</Text>
              </View>
            )}
            onError={() => {
              // Tile load errors are non-fatal (offline)
            }}
          />
        ) : (
          <View style={s.mapLoading}>
            <Ionicons name="map" size={40} color={COLORS.textMuted} />
            <Text style={s.mapLoadingText}>
              {loading ? 'Fetching location...' : 'Unable to load map'}
            </Text>
            {!loading && !userLocation && (
              <Text style={s.mapLoadingHint}>Enable GPS and pull to refresh</Text>
            )}
          </View>
        )}

        {/* ── Recenter FAB ── */}
        <TouchableOpacity style={s.recenterBtn} onPress={handleRecenter}>
          <Ionicons name="locate" size={22} color={COLORS.textPrimary} />
        </TouchableOpacity>

        {/* ── Service count overlay ── */}
        {mapReady && filteredServices.length > 0 && (
          <View style={s.mapCountOverlay}>
            <Text style={s.mapCountText}>
              {filteredServices.length} {activeFilter === 'all' ? 'services' : activeFilter + 's'} nearby
            </Text>
          </View>
        )}

        {/* ── Offline warning ── */}
        {mapReady === false && !loading && (
          <View style={s.offlineOverlay}>
            <Ionicons name="cloud-offline-outline" size={16} color={COLORS.primary} />
            <Text style={s.offlineOverlayText}>Map tiles need internet. Pins still shown.</Text>
          </View>
        )}
      </View>

      {/* ── Detail Panel (slides up on pin tap) ── */}
      {selectedService && (
        <>
          {/* Backdrop dismiss */}
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            onPress={() => setSelected(null)}
            activeOpacity={1}
          />
          <DetailPanel
            service={selectedService}
            onClose={() => setSelected(null)}
            onCall={handleCall}
            onDirections={handleDirections}
          />
        </>
      )}

    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: COLORS.background },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: COLORS.navBorder,
  },
  headerTitle: { color: COLORS.textPrimary, fontSize: 18, fontWeight: '800' },
  headerSub:   { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  headerRight: {},
  countText:   { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },

  filterBar: {
    backgroundColor: COLORS.navBackground,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.navBorder,
    paddingVertical: 8,
  },

  mapContainer: { flex: 1, position: 'relative' },
  webview:      { flex: 1, backgroundColor: COLORS.background },

  mapLoading: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12,
    backgroundColor: COLORS.background,
  },
  mapLoadingText: { color: COLORS.textSecondary, fontSize: 15, fontWeight: '600' },
  mapLoadingHint: { color: COLORS.textMuted, fontSize: 12 },

  recenterBtn: {
    position: 'absolute', bottom: 24, right: 16,
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: COLORS.backgroundCard,
    borderWidth: 1, borderColor: COLORS.border,
    alignItems: 'center', justifyContent: 'center',
    elevation: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4, shadowRadius: 6,
  },

  mapCountOverlay: {
    position: 'absolute', top: 12, left: 12,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 1, borderColor: COLORS.border,
  },
  mapCountText: { color: COLORS.textPrimary, fontSize: 12, fontWeight: '700' },

  offlineOverlay: {
    position: 'absolute', bottom: 80, left: 12, right: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(26,0,0,0.85)',
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1, borderColor: COLORS.primary + '33',
  },
  offlineOverlayText: { color: COLORS.textSecondary, fontSize: 12, flex: 1 },
});

// ─── Detail Panel styles ──────────────────────────────────────────────────────
const dp = StyleSheet.create({
  panel: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: COLORS.backgroundCard,
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingBottom: Platform.OS === 'ios' ? 36 : 24,
    paddingTop: 12,
    borderWidth: 1, borderColor: COLORS.border,
    elevation: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.5, shadowRadius: 12,
  },
  handle: {
    alignSelf: 'center',
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: COLORS.border,
    marginBottom: 14,
  },
  closeBtn: {
    position: 'absolute', top: 16, right: 16,
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: COLORS.backgroundElevated,
    alignItems: 'center', justifyContent: 'center',
  },
  typeBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 6,
    alignSelf: 'flex-start', marginBottom: 12,
  },
  typeIcon:  { fontSize: 16 },
  typeLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  badge24: {
    borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2,
  },
  badge24Text: { color: '#fff', fontSize: 9, fontWeight: '800' },

  name: {
    color: COLORS.textPrimary, fontSize: 18, fontWeight: '800',
    marginBottom: 10, lineHeight: 24,
  },

  metaRow: { flexDirection: 'row', gap: 16, marginBottom: 10 },
  metaItem:{ flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaDist:{ fontSize: 14, fontWeight: '700' },
  openDot: { width: 7, height: 7, borderRadius: 4 },
  openText:{ fontSize: 13, fontWeight: '600' },

  addressRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    marginBottom: 16,
  },
  addressText: {
    color: COLORS.textSecondary, fontSize: 12,
    flex: 1, lineHeight: 18,
  },

  actions: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  callBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 8,
    borderRadius: 12, paddingVertical: 14, minHeight: 52,
  },
  callBtnText: { color: '#fff', fontSize: 14, fontWeight: '900', letterSpacing: 0.5 },
  dirBtn: {
    width: 56, height: 52, borderRadius: 12,
    backgroundColor: COLORS.backgroundElevated,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: COLORS.border,
    gap: 2,
  },
  dirBtnText: { color: COLORS.textMuted, fontSize: 9, fontWeight: '600' },

  phoneText: {
    color: COLORS.textMuted, fontSize: 12,
    textAlign: 'center', letterSpacing: 0.5,
  },
});

// ─── Filter Tab styles ────────────────────────────────────────────────────────
const ft = StyleSheet.create({
  row: { paddingHorizontal: 12, gap: 8, alignItems: 'center' },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.backgroundCard,
  },
  tabText:      { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  tabCount: {
    minWidth: 20, height: 20, borderRadius: 10,
    backgroundColor: COLORS.backgroundElevated,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 5,
  },
  tabCountText: { color: '#fff', fontSize: 10, fontWeight: '800' },
});
