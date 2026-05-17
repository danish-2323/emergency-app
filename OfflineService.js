/**
 * RoadSoS — services/OfflineService.js
 *
 * Manages offline-first data strategy for the app.
 * On first load, fetches all nearby services and stores them locally.
 * When internet is unavailable, serves data from cache transparently.
 *
 * Strategy:
 *   1. Check if valid cache exists for current location
 *   2. If yes → return cache immediately (fast)
 *   3. If no  → fetch live from SearchService → save → return
 *   4. If offline → load nearest valid cache → show banner
 *   5. When internet returns → auto-refresh cache in background
 *
 * Exported functions:
 *   initCache(lat, lon)             → pre-load all service data on app start
 *   getCachedServices(lat, lon, type) → get one service type from cache
 *   getAllCachedServices(lat, lon)   → get all types from cache
 *   saveCache(lat, lon, data)        → persist a full searchAll result
 *   clearCache()                     → wipe all roadsos cache keys
 *   isOnline()                       → Promise<boolean>
 *   getCacheStatus(lat, lon)         → { exists, ageMinutes, expired }
 *   onConnectivityChange(callback)   → subscribe to online/offline changes
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

import { CACHE, SERVICE_TYPES } from '../constants/config';
import { roundCoord } from './LocationService';
import { searchAll } from './SearchService';

// ─── Cache Key Helpers ────────────────────────────────────────────────────────

/**
 * Generate a deterministic cache key for a lat/lon pair.
 * Coordinates are rounded to 2 decimal places (~1.1km grid),
 * so nearby locations reuse the same cache bucket.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {string}  e.g. "roadsos_cache_13.08_80.27"
 */
function buildCacheKey(lat, lon) {
  const rLat = roundCoord(lat, CACHE.LOCATION_ROUND_DIGITS);
  const rLon = roundCoord(lon, CACHE.LOCATION_ROUND_DIGITS);
  return `${CACHE.KEY_PREFIX}${rLat}_${rLon}`;
}

/**
 * List all RoadSoS cache keys currently in AsyncStorage.
 * @returns {Promise<string[]>}
 */
async function getAllCacheKeys() {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    return allKeys.filter(k => k.startsWith(CACHE.KEY_PREFIX));
  } catch {
    return [];
  }
}

// ─── Online / Offline Detection ───────────────────────────────────────────────

/**
 * Check if the device currently has internet access.
 * Uses NetInfo for a real connectivity check (not just Wi-Fi association).
 *
 * @returns {Promise<boolean>}
 */
export async function isOnline() {
  try {
    const state = await NetInfo.fetch();
    // isConnected: L2 connected | isInternetReachable: L3 reachable
    // isInternetReachable can be null when unknown — treat null as online
    if (state.isConnected === false) return false;
    if (state.isInternetReachable === false) return false;
    return true;
  } catch {
    // NetInfo failed — assume online to avoid blocking the user
    return true;
  }
}

/**
 * Subscribe to connectivity changes.
 * Callback receives true (online) or false (offline).
 *
 * @param {(online: boolean) => void} callback
 * @returns {() => void}  unsubscribe function
 */
export function onConnectivityChange(callback) {
  const unsubscribe = NetInfo.addEventListener(state => {
    const online = state.isConnected !== false && state.isInternetReachable !== false;
    callback(online);
  });
  return unsubscribe;
}

// ─── Cache Read / Write ───────────────────────────────────────────────────────

/**
 * Persist a full searchAll() result to AsyncStorage.
 *
 * Stored structure:
 * {
 *   timestamp: number,
 *   lat: number,
 *   lon: number,
 *   data: { hospital[], police[], ambulance[], towing[], puncture[], all[] }
 * }
 *
 * @param {number} lat
 * @param {number} lon
 * @param {object} data  Result from searchAll()
 */
export async function saveCache(lat, lon, data) {
  const key = buildCacheKey(lat, lon);
  const payload = {
    timestamp: Date.now(),
    lat,
    lon,
    data,
  };
  try {
    await AsyncStorage.setItem(key, JSON.stringify(payload));
    console.info(`[OfflineService] Saved cache: ${key}`);
  } catch (error) {
    console.warn('[OfflineService] saveCache failed:', error.message);
    // Cache save failure is non-fatal — app continues with live data
  }
}

/**
 * Load cached service data for a location.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {{ timestamp, lat, lon, data } | null}  null if no valid cache
 */
export async function loadCache(lat, lon) {
  const key = buildCacheKey(lat, lon);
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    console.warn('[OfflineService] loadCache failed:', error.message);
    return null;
  }
}

/**
 * Check the age and validity of a cached entry.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {{ exists: boolean, ageMinutes: number, expired: boolean, timestamp: number|null }}
 */
export async function getCacheStatus(lat, lon) {
  const cached = await loadCache(lat, lon);

  if (!cached) {
    return { exists: false, ageMinutes: null, expired: true, timestamp: null };
  }

  const ageMs = Date.now() - cached.timestamp;
  const ageMinutes = Math.floor(ageMs / 60000);
  const expired = ageMs > CACHE.EXPIRY_MS;

  return { exists: true, ageMinutes, expired, timestamp: cached.timestamp };
}

// ─── High-Level Data Getters ─────────────────────────────────────────────────

/**
 * Get all cached services for a location.
 * Returns cache if fresh, null if expired or missing.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<object|null>}  { hospital, police, ambulance, towing, puncture, all }
 */
export async function getAllCachedServices(lat, lon) {
  const cached = await loadCache(lat, lon);
  if (!cached) return null;

  const expired = Date.now() - cached.timestamp > CACHE.EXPIRY_MS;
  if (expired) {
    console.info('[OfflineService] Cache expired — will re-fetch');
    return null;
  }

  return cached.data;
}

/**
 * Get cached services for a single service type.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} type  SERVICE_TYPES constant
 * @returns {Promise<object[]>}  Empty array if not cached
 */
export async function getCachedServices(lat, lon, type) {
  const all = await getAllCachedServices(lat, lon);
  if (!all) return [];
  return all[type] || [];
}

// ─── Main Init Function ───────────────────────────────────────────────────────

/**
 * Initialize the cache for the user's current location.
 * Called once on app startup (SplashScreen) and whenever location changes significantly.
 *
 * Flow:
 *  1. Check if valid cache exists → return it immediately
 *  2. If online → fetch live → save → return
 *  3. If offline → try nearby cache buckets → return best available
 *  4. Return { data, source: 'live'|'cache'|'nearby_cache'|'empty', isOffline }
 *
 * @param {number} lat
 * @param {number} lon
 * @param {{ forceRefresh?: boolean, radiusKm?: number }} options
 * @returns {Promise<{
 *   data: object,
 *   source: string,
 *   isOffline: boolean,
 *   cacheAge: number|null
 * }>}
 */
export async function initCache(lat, lon, options = {}) {
  const { forceRefresh = false, radiusKm = 10 } = options;

  const online = await isOnline();

  // ── Step 1: Check existing cache ──
  if (!forceRefresh) {
    const status = await getCacheStatus(lat, lon);

    if (status.exists && !status.expired) {
      // Cache is fresh — serve immediately
      const cached = await loadCache(lat, lon);
      console.info(`[OfflineService] Serving fresh cache (age: ${status.ageMinutes} min)`);

      // Trigger background refresh if cache is > 12 hours old (still valid but stale)
      if (status.ageMinutes > 720 && online) {
        refreshCacheBackground(lat, lon, radiusKm);
      }

      return {
        data: cached.data,
        source: 'cache',
        isOffline: !online,
        cacheAge: status.ageMinutes,
      };
    }
  }

  // ── Step 2: Fetch live if online ──
  if (online) {
    try {
      console.info('[OfflineService] Fetching live data from Overpass...');
      const liveData = await searchAll(lat, lon, radiusKm);
      await saveCache(lat, lon, liveData);

      return {
        data: liveData,
        source: 'live',
        isOffline: false,
        cacheAge: 0,
      };
    } catch (fetchError) {
      console.warn('[OfflineService] Live fetch failed:', fetchError.message);
      // Fall through to cache fallback
    }
  }

  // ── Step 3: Offline or live fetch failed — try any nearby cache ──
  const nearbyData = await findNearestCache(lat, lon);
  if (nearbyData) {
    const ageMinutes = Math.floor((Date.now() - nearbyData.timestamp) / 60000);
    console.info(`[OfflineService] Using nearby cache (age: ${ageMinutes} min, dist: ~${nearbyData.dist}km)`);
    return {
      data: nearbyData.data,
      source: 'nearby_cache',
      isOffline: true,
      cacheAge: ageMinutes,
    };
  }

  // ── Step 4: Truly nothing available ──
  console.warn('[OfflineService] No data available — returning empty');
  return {
    data: emptyServiceData(),
    source: 'empty',
    isOffline: !online,
    cacheAge: null,
  };
}

// ─── Background Refresh ───────────────────────────────────────────────────────

/**
 * Silently refresh cache in the background without blocking the UI.
 * Called when cache exists but is getting stale (> 12 hours).
 */
async function refreshCacheBackground(lat, lon, radiusKm) {
  try {
    console.info('[OfflineService] Background cache refresh started...');
    const liveData = await searchAll(lat, lon, radiusKm);
    await saveCache(lat, lon, liveData);
    console.info('[OfflineService] Background cache refresh complete');
  } catch (error) {
    console.warn('[OfflineService] Background refresh failed (non-fatal):', error.message);
  }
}

// ─── Nearby Cache Lookup ──────────────────────────────────────────────────────

/**
 * When offline, scan all stored cache keys and find the closest one
 * to the user's current location.
 *
 * Cache keys encode lat/lon (e.g. "roadsos_cache_13.08_80.27"),
 * so we can parse them and compute distance.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{ data, timestamp, dist }|null>}
 */
async function findNearestCache(lat, lon) {
  const keys = await getAllCacheKeys();
  if (keys.length === 0) return null;

  let nearest = null;
  let nearestDist = Infinity;

  for (const key of keys) {
    // Parse lat/lon from key: "roadsos_cache_13.08_80.27"
    const match = key.match(/roadsos_cache_([-\d.]+)_([-\d.]+)/);
    if (!match) continue;

    const cacheLat = parseFloat(match[1]);
    const cacheLon = parseFloat(match[2]);

    // Simple Euclidean distance on degrees (good enough for proximity ranking)
    const dist = Math.sqrt(
      Math.pow(lat - cacheLat, 2) + Math.pow(lon - cacheLon, 2)
    ) * 111; // ~111km per degree

    if (dist < nearestDist) {
      try {
        const raw = await AsyncStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          nearestDist = dist;
          nearest = { ...parsed, dist: dist.toFixed(1) };
        }
      } catch {}
    }
  }

  // Only use nearby cache if within 50km (otherwise data is irrelevant)
  return nearestDist <= 50 ? nearest : null;
}

// ─── Cache Management ─────────────────────────────────────────────────────────

/**
 * Clear all RoadSoS cache entries from AsyncStorage.
 * Called from SettingsScreen → "Clear Cache" button.
 *
 * @returns {Promise<number>}  Number of keys cleared
 */
export async function clearCache() {
  const keys = await getAllCacheKeys();
  if (keys.length === 0) return 0;

  try {
    await AsyncStorage.multiRemove(keys);
    console.info(`[OfflineService] Cleared ${keys.length} cache entries`);
    return keys.length;
  } catch (error) {
    console.warn('[OfflineService] clearCache failed:', error.message);
    return 0;
  }
}

/**
 * Get cache storage stats for SettingsScreen display.
 *
 * @returns {Promise<{ count: number, sizeKB: number, oldestAge: string }>}
 */
export async function getCacheStats() {
  const keys = await getAllCacheKeys();
  let totalBytes = 0;
  let oldestTimestamp = Date.now();

  for (const key of keys) {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        totalBytes += raw.length * 2; // UTF-16 estimate
        const parsed = JSON.parse(raw);
        if (parsed.timestamp < oldestTimestamp) {
          oldestTimestamp = parsed.timestamp;
        }
      }
    } catch {}
  }

  const ageHours = ((Date.now() - oldestTimestamp) / 3600000).toFixed(1);

  return {
    count: keys.length,
    sizeKB: Math.round(totalBytes / 1024),
    oldestAge: keys.length > 0 ? `${ageHours} hours ago` : 'No cache',
  };
}

/**
 * Evict cache entries older than EXPIRY_MS to free storage.
 * Safe to call periodically (e.g. on app resume).
 *
 * @returns {Promise<number>}  Number of expired entries removed
 */
export async function evictExpiredCache() {
  const keys = await getAllCacheKeys();
  const toRemove = [];

  for (const key of keys) {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.timestamp > CACHE.EXPIRY_MS) {
          toRemove.push(key);
        }
      }
    } catch {
      toRemove.push(key); // Remove corrupted entries
    }
  }

  if (toRemove.length > 0) {
    await AsyncStorage.multiRemove(toRemove);
    console.info(`[OfflineService] Evicted ${toRemove.length} expired cache entries`);
  }

  return toRemove.length;
}

// ─── Settings Persistence ─────────────────────────────────────────────────────

/**
 * Save user settings to AsyncStorage.
 * @param {object} settings
 */
export async function saveSettings(settings) {
  try {
    await AsyncStorage.setItem(CACHE.SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('[OfflineService] saveSettings failed:', e.message);
  }
}

/**
 * Load user settings from AsyncStorage.
 * @returns {Promise<object>}  Defaults returned if nothing saved
 */
export async function loadSettings() {
  const defaults = {
    language: 'en',
    country: 'IN',
    voiceEnabled: true,
    crashDetectionEnabled: true,
    guardians: [],
  };
  try {
    const raw = await AsyncStorage.getItem(CACHE.SETTINGS_KEY);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

/**
 * Save guardian contacts to AsyncStorage.
 * @param {Array<{ name, phone }>} guardians  Up to 3 contacts
 */
export async function saveGuardians(guardians) {
  try {
    await AsyncStorage.setItem(CACHE.GUARDIANS_KEY, JSON.stringify(guardians.slice(0, 3)));
  } catch (e) {
    console.warn('[OfflineService] saveGuardians failed:', e.message);
  }
}

/**
 * Load guardian contacts from AsyncStorage.
 * @returns {Promise<Array<{ name, phone }>>}
 */
export async function loadGuardians() {
  try {
    const raw = await AsyncStorage.getItem(CACHE.GUARDIANS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Empty service data structure — returned when no data is available at all */
function emptyServiceData() {
  return {
    hospital: [],
    police: [],
    ambulance: [],
    towing: [],
    puncture: [],
    all: [],
    errors: {},
  };
}

/**
 * Human-readable cache age label for UI display.
 * e.g., "2 minutes ago" | "3 hours ago" | "Just now"
 *
 * @param {number} timestamp  Unix ms
 * @returns {string}
 */
export function formatCacheAge(timestamp) {
  if (!timestamp) return 'Never';
  const ageMs = Date.now() - timestamp;
  const mins = Math.floor(ageMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)} days ago`;
}

// ─── Default Export ───────────────────────────────────────────────────────────
export default {
  initCache,
  saveCache,
  loadCache,
  getAllCachedServices,
  getCachedServices,
  getCacheStatus,
  clearCache,
  getCacheStats,
  evictExpiredCache,
  isOnline,
  onConnectivityChange,
  saveSettings,
  loadSettings,
  saveGuardians,
  loadGuardians,
  formatCacheAge,
};
