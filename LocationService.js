/**
 * RoadSoS — services/LocationService.js
 *
 * Handles all location logic for the app:
 *  1. Request & check permissions (foreground + background)
 *  2. Get current GPS coordinates (high accuracy)
 *  3. Reverse geocode coordinates → human-readable address
 *  4. Fallback to IP-based location if GPS fails
 *  5. Watch position for live updates (crash detector, map tracking)
 *  6. Calculate distance between two coordinates (Haversine)
 *  7. Cache last known location for offline use
 *
 * Exports:
 *   getLocation()           → { lat, lon, accuracy, timestamp }
 *   getAddress(lat, lon)    → { street, city, state, country, countryCode, display }
 *   getFullLocation()       → { coords, address } combined
 *   watchLocation(callback) → subscription (call .remove() to stop)
 *   getLastKnown()          → cached coords or null
 *   haversineDistance(a, b) → distance in km
 *   requestPermissions()    → { foreground, background }
 */

import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';

import { OSM, CACHE } from '../constants/config';

// ─── Cache Keys ──────────────────────────────────────────────────────────────
const LAST_KNOWN_KEY = 'roadsos_last_known_location';
const LAST_ADDRESS_KEY = 'roadsos_last_known_address';

// ─── GPS Options ─────────────────────────────────────────────────────────────
const GPS_OPTIONS = {
  accuracy: Location.Accuracy.High,   // Best available (GPS chip)
  timeInterval: 5000,                 // Update every 5s when watching
  distanceInterval: 10,               // Or every 10m moved
  mayShowUserSettingsDialog: true,    // Prompt to enable GPS on Android
};

// Faster but less accurate fallback
const GPS_OPTIONS_BALANCED = {
  accuracy: Location.Accuracy.Balanced,
  timeInterval: 10000,
  distanceInterval: 20,
};

// ─── 1. Permission Request ────────────────────────────────────────────────────

/**
 * Request foreground (and optionally background) location permissions.
 * Background is needed for crash detection feature.
 *
 * @returns {{ foreground: boolean, background: boolean }}
 */
export async function requestPermissions() {
  const result = { foreground: false, background: false };

  try {
    // Always request foreground first — required before background
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    result.foreground = fgStatus === 'granted';

    if (result.foreground) {
      // Try background (may show second system prompt on iOS 13+)
      const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
      result.background = bgStatus === 'granted';
    }
  } catch (error) {
    console.warn('[LocationService] Permission request failed:', error.message);
  }

  return result;
}

/**
 * Check current permission status without prompting the user.
 * @returns {{ foreground: boolean, background: boolean }}
 */
export async function checkPermissions() {
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    const bg = await Location.getBackgroundPermissionsAsync();
    return {
      foreground: fg.status === 'granted',
      background: bg.status === 'granted',
    };
  } catch {
    return { foreground: false, background: false };
  }
}

// ─── 2. Get Current GPS Coordinates ──────────────────────────────────────────

/**
 * Get the device's current GPS coordinates.
 * Falls back to last cached location, then IP-based location.
 *
 * @param {{ timeout?: number, highAccuracy?: boolean }} options
 * @returns {{ lat: number, lon: number, accuracy: number, timestamp: number, source: string }}
 */
export async function getLocation(options = {}) {
  const { timeout = 15000, highAccuracy = true } = options;

  // ── Try GPS ──
  try {
    const { foreground } = await checkPermissions();

    if (!foreground) {
      // Permission not granted — request now
      const { foreground: granted } = await requestPermissions();
      if (!granted) {
        console.warn('[LocationService] Location permission denied. Trying IP fallback.');
        return await getIPLocation();
      }
    }

    // Race GPS against timeout so we don't block the SOS flow forever
    const locationPromise = Location.getCurrentPositionAsync(
      highAccuracy ? GPS_OPTIONS : GPS_OPTIONS_BALANCED
    );
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('GPS timeout')), timeout)
    );

    const position = await Promise.race([locationPromise, timeoutPromise]);

    const coords = {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      accuracy: position.coords.accuracy,       // meters
      altitude: position.coords.altitude,
      speed: position.coords.speed,
      heading: position.coords.heading,
      timestamp: position.timestamp,
      source: 'gps',
    };

    // Save to cache for offline fallback
    await cacheLocation(coords);
    return coords;

  } catch (gpsError) {
    console.warn('[LocationService] GPS failed:', gpsError.message);

    // ── Fallback 1: Last cached location ──
    const cached = await getLastKnown();
    if (cached) {
      const ageMinutes = (Date.now() - cached.timestamp) / 60000;
      if (ageMinutes < 30) {
        // Cache is fresh enough (< 30 mins old)
        console.info('[LocationService] Using cached location (age: ${ageMinutes.toFixed(1)} min)');
        return { ...cached, source: 'cache' };
      }
    }

    // ── Fallback 2: IP-based geolocation ──
    console.info('[LocationService] Trying IP-based location fallback...');
    return await getIPLocation();
  }
}

// ─── 3. IP-Based Location Fallback ───────────────────────────────────────────

/**
 * Get approximate location using IP geolocation (free, no key needed).
 * Accuracy: city-level (~5–50 km). Use only when GPS is unavailable.
 *
 * @returns {{ lat, lon, accuracy, timestamp, source: 'ip' }}
 */
async function getIPLocation() {
  // Try multiple free IP geolocation APIs in order
  const apis = [
    () => fetchIPAPI(),
    () => fetchIPWho(),
    () => fetchGeoJS(),
  ];

  for (const apiFn of apis) {
    try {
      const result = await apiFn();
      if (result) {
        await cacheLocation(result);
        return result;
      }
    } catch (e) {
      // Try next API
    }
  }

  // All IP APIs failed — return null so caller can show "location unavailable"
  console.error('[LocationService] All location fallbacks failed.');
  return null;
}

/** ip-api.com — free, 45 req/min, no key */
async function fetchIPAPI() {
  const response = await axios.get('http://ip-api.com/json/?fields=lat,lon,city,country,countryCode', {
    timeout: 5000,
  });
  const { lat, lon, city, country, countryCode } = response.data;
  return {
    lat, lon,
    accuracy: 50000,        // ~50km city-level accuracy
    timestamp: Date.now(),
    source: 'ip',
    ipCity: city,
    ipCountry: country,
    ipCountryCode: countryCode,
  };
}

/** ipwho.is — free, no key needed */
async function fetchIPWho() {
  const response = await axios.get('https://ipwho.is/', { timeout: 5000 });
  const { latitude, longitude, city, country, country_code } = response.data;
  return {
    lat: latitude,
    lon: longitude,
    accuracy: 50000,
    timestamp: Date.now(),
    source: 'ip',
    ipCity: city,
    ipCountry: country,
    ipCountryCode: country_code,
  };
}

/** get.geojs.io — free, no key needed */
async function fetchGeoJS() {
  const response = await axios.get('https://get.geojs.io/v1/ip/geo.json', { timeout: 5000 });
  const { latitude, longitude, country, country_code } = response.data;
  return {
    lat: parseFloat(latitude),
    lon: parseFloat(longitude),
    accuracy: 50000,
    timestamp: Date.now(),
    source: 'ip',
    ipCountry: country,
    ipCountryCode: country_code,
  };
}

// ─── 4. Reverse Geocoding ─────────────────────────────────────────────────────

/**
 * Convert coordinates to a human-readable address using OpenStreetMap Nominatim.
 * Falls back to expo-location's built-in reverse geocoder if Nominatim is slow.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {{ street, area, city, state, country, countryCode, postcode, display }}
 */
export async function getAddress(lat, lon) {
  if (!lat || !lon) return null;

  // ── Try Nominatim (OSM) first ──
  try {
    const nominatimResult = await reverseGeocodeNominatim(lat, lon);
    if (nominatimResult) return nominatimResult;
  } catch (e) {
    console.warn('[LocationService] Nominatim failed:', e.message);
  }

  // ── Fallback: expo-location reverse geocoder ──
  try {
    const expoResult = await reverseGeocodeExpo(lat, lon);
    if (expoResult) return expoResult;
  } catch (e) {
    console.warn('[LocationService] Expo reverse geocode failed:', e.message);
  }

  // ── Last resort: show raw coordinates ──
  return {
    street: null,
    area: null,
    city: 'Unknown City',
    state: null,
    country: null,
    countryCode: null,
    postcode: null,
    display: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    raw: null,
  };
}

/**
 * Reverse geocode using OSM Nominatim API.
 * Free, no API key required. Rate limit: 1 req/sec.
 */
async function reverseGeocodeNominatim(lat, lon) {
  const url = `${OSM.NOMINATIM_URL}/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;

  const response = await axios.get(url, {
    timeout: 6000,
    headers: {
      // Nominatim requires a User-Agent to identify your app
      'User-Agent': 'RoadSoS/1.0 (IIT Madras Road Safety Hackathon 2026; roadsos@example.com)',
    },
  });

  const data = response.data;
  if (!data || data.error) return null;

  const addr = data.address || {};

  return {
    street: addr.road || addr.pedestrian || addr.footway || null,
    area: addr.suburb || addr.neighbourhood || addr.quarter || null,
    city: addr.city || addr.town || addr.village || addr.county || 'Unknown',
    state: addr.state || addr.province || null,
    country: addr.country || null,
    countryCode: (addr.country_code || '').toUpperCase(),
    postcode: addr.postcode || null,
    display: data.display_name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    raw: data,
  };
}

/**
 * Reverse geocode using expo-location built-in (uses device's geocoder).
 * Works offline on some devices.
 */
async function reverseGeocodeExpo(lat, lon) {
  const results = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
  if (!results || results.length === 0) return null;

  const r = results[0];
  const parts = [r.name, r.street, r.district, r.city, r.region, r.country].filter(Boolean);

  return {
    street: r.street || r.name || null,
    area: r.district || r.subregion || null,
    city: r.city || r.subregion || 'Unknown',
    state: r.region || null,
    country: r.country || null,
    countryCode: r.isoCountryCode || null,
    postcode: r.postalCode || null,
    display: parts.join(', '),
    raw: r,
  };
}

// ─── 5. Combined: getFullLocation() ──────────────────────────────────────────

/**
 * Get coordinates AND address in one call.
 * Most screens should use this — it returns everything needed.
 *
 * @returns {{ coords, address, error? }}
 */
export async function getFullLocation() {
  try {
    const coords = await getLocation();
    if (!coords) {
      return {
        coords: null,
        address: null,
        error: 'Could not determine location. Please enable GPS.',
      };
    }

    const address = await getAddress(coords.lat, coords.lon);

    return { coords, address, error: null };
  } catch (error) {
    console.error('[LocationService] getFullLocation error:', error.message);
    return {
      coords: null,
      address: null,
      error: 'Location unavailable. Check GPS settings.',
    };
  }
}

// ─── 6. Watch Position (Live Tracking) ───────────────────────────────────────

/**
 * Subscribe to continuous location updates.
 * Used by: CrashDetector (background), MapScreen (live dot).
 *
 * @param {Function} callback - called with { lat, lon, accuracy, timestamp }
 * @param {{ highAccuracy?: boolean }} options
 * @returns {Promise<Location.LocationSubscription>} - call subscription.remove() to stop
 */
export async function watchLocation(callback, options = {}) {
  const { highAccuracy = false } = options;   // Default balanced for battery

  const { foreground } = await checkPermissions();
  if (!foreground) {
    console.warn('[LocationService] watchLocation: no permission');
    return null;
  }

  try {
    const subscription = await Location.watchPositionAsync(
      highAccuracy ? GPS_OPTIONS : GPS_OPTIONS_BALANCED,
      (position) => {
        const coords = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy,
          speed: position.coords.speed,
          heading: position.coords.heading,
          timestamp: position.timestamp,
        };
        cacheLocation(coords); // Always keep cache fresh
        callback(coords);
      }
    );
    return subscription;
  } catch (error) {
    console.error('[LocationService] watchLocation failed:', error.message);
    return null;
  }
}

// ─── 7. Haversine Distance ────────────────────────────────────────────────────

/**
 * Calculate distance between two coordinates using the Haversine formula.
 * Accurate to within ~0.5% for distances under 300km.
 *
 * @param {{ lat: number, lon: number }} pointA
 * @param {{ lat: number, lon: number }} pointB
 * @returns {number} Distance in kilometres (rounded to 2 decimal places)
 */
export function haversineDistance(pointA, pointB) {
  const R = 6371;  // Earth radius in km

  const dLat = toRad(pointB.lat - pointA.lat);
  const dLon = toRad(pointB.lon - pointA.lon);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(pointA.lat)) *
    Math.cos(toRad(pointB.lat)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return Math.round(distance * 100) / 100;  // 2 decimal places
}

/** Convert degrees to radians */
function toRad(deg) {
  return deg * (Math.PI / 180);
}

/**
 * Format a distance number into a human-readable string.
 * e.g., 0.35 → "350 m" | 1.2 → "1.2 km" | 12.5 → "12.5 km"
 *
 * @param {number} km
 * @returns {string}
 */
export function formatDistance(km) {
  if (km < 1) {
    return `${Math.round(km * 1000)} m`;
  }
  if (km < 10) {
    return `${km.toFixed(1)} km`;
  }
  return `${Math.round(km)} km`;
}

// ─── 8. Cache Helpers ─────────────────────────────────────────────────────────

/**
 * Save coordinates to AsyncStorage for offline/fallback use.
 * @param {{ lat, lon, timestamp, ... }} coords
 */
async function cacheLocation(coords) {
  try {
    await AsyncStorage.setItem(LAST_KNOWN_KEY, JSON.stringify(coords));
  } catch (e) {
    // Non-critical — don't throw
  }
}

/**
 * Load the last known location from AsyncStorage.
 * @returns {{ lat, lon, timestamp, source } | null}
 */
export async function getLastKnown() {
  try {
    const raw = await AsyncStorage.getItem(LAST_KNOWN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Cache an address object to AsyncStorage.
 * @param {object} address
 */
export async function cacheAddress(address) {
  try {
    await AsyncStorage.setItem(LAST_ADDRESS_KEY, JSON.stringify(address));
  } catch (e) {}
}

/**
 * Load the last known address from AsyncStorage.
 * @returns {object | null}
 */
export async function getLastKnownAddress() {
  try {
    const raw = await AsyncStorage.getItem(LAST_ADDRESS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ─── 9. Utility Helpers ───────────────────────────────────────────────────────

/**
 * Check if GPS hardware is enabled on the device (not just permissions).
 * Returns false if the user has GPS toggled off in system settings.
 *
 * @returns {Promise<boolean>}
 */
export async function isGPSEnabled() {
  try {
    const enabled = await Location.hasServicesEnabledAsync();
    return enabled;
  } catch {
    return false;
  }
}

/**
 * Get a short location label for UI display.
 * e.g., "Anna Nagar, Chennai" or "12.9716, 77.5946"
 *
 * @param {object} address - result from getAddress()
 * @returns {string}
 */
export function getLocationLabel(address) {
  if (!address) return 'Location unavailable';
  const parts = [address.area, address.city].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : address.display || 'Unknown location';
}

/**
 * Build a Google Maps URL for a coordinate pair.
 * Used in SMS sharing and WhatsApp alerts.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {string}
 */
export function buildMapsURL(lat, lon) {
  return `https://maps.google.com/?q=${lat},${lon}`;
}

/**
 * Round coordinates to N decimal places for cache key generation.
 * 2 decimal places ≈ 1.1 km resolution (good enough for service search cache).
 *
 * @param {number} coord
 * @param {number} digits
 * @returns {number}
 */
export function roundCoord(coord, digits = 2) {
  const factor = Math.pow(10, digits);
  return Math.round(coord * factor) / factor;
}

// ─── Default Export ───────────────────────────────────────────────────────────
export default {
  getLocation,
  getAddress,
  getFullLocation,
  watchLocation,
  getLastKnown,
  getLastKnownAddress,
  cacheAddress,
  haversineDistance,
  formatDistance,
  getLocationLabel,
  buildMapsURL,
  roundCoord,
  isGPSEnabled,
  requestPermissions,
  checkPermissions,
};
