/**
 * RoadSoS — services/SearchService.js
 *
 * Queries OpenStreetMap Overpass API to find nearby emergency services.
 * All data is free, open, and works globally — no API key required.
 *
 * Exported functions:
 *   searchNearby(lat, lon, type, radiusKm)  → array of services sorted by distance
 *   searchHospitals(lat, lon, radiusKm)     → hospitals + trauma centres
 *   searchPolice(lat, lon, radiusKm)        → police stations
 *   searchAmbulance(lat, lon, radiusKm)     → ambulance depots
 *   searchTowing(lat, lon, radiusKm)        → towing + car repair
 *   searchPuncture(lat, lon, radiusKm)      → tyre shops + repair stations
 *   searchAll(lat, lon, radiusKm)           → all 5 types in parallel
 *
 * Each result object shape:
 * {
 *   id, name, type, lat, lon,
 *   distance,        ← km from user (Haversine)
 *   distanceLabel,   ← "1.2 km" or "350 m"
 *   phone, address, website,
 *   openNow,         ← true / false / null (unknown)
 *   hours,           ← raw opening_hours string
 *   is24hr,          ← boolean
 *   osmType,         ← 'node' | 'way' | 'relation'
 *   osmId,
 * }
 */

import axios from 'axios';
import { OSM, SERVICE_TYPES } from '../constants/config';
import { haversineDistance, formatDistance } from './LocationService';

// ─── Overpass API mirrors (try in order on failure) ───────────────────────────
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// ─── Overpass Query Builder ───────────────────────────────────────────────────

/**
 * Build an Overpass QL query string for a given bounding circle.
 * Uses `around` filter: searches within radiusMeters of (lat, lon).
 *
 * @param {string[]} tagFilters   e.g. ['amenity=hospital', 'healthcare=hospital']
 * @param {number}   lat
 * @param {number}   lon
 * @param {number}   radiusMeters
 * @returns {string} Overpass QL query
 */
function buildOverpassQuery(tagFilters, lat, lon, radiusMeters) {
  // Build union of node + way + relation for each tag filter
  const unionBlocks = tagFilters.map(tag => {
    const [key, value] = tag.split('=');
    return `
  node["${key}"="${value}"](around:${radiusMeters},${lat},${lon});
  way["${key}"="${value}"](around:${radiusMeters},${lat},${lon});
  relation["${key}"="${value}"](around:${radiusMeters},${lat},${lon});`;
  }).join('');

  // out center: for ways/relations, returns the geometric center as a point
  return `[out:json][timeout:25];
(${unionBlocks}
);
out center tags;`;
}

// ─── Raw Overpass Fetch (with mirror fallback) ────────────────────────────────

/**
 * Execute an Overpass query, trying mirrors if the primary fails.
 *
 * @param {string} query  Overpass QL string
 * @returns {object[]}    Raw OSM elements array
 */
async function fetchOverpass(query) {
  let lastError = null;

  for (const mirror of MIRRORS) {
    try {
      const response = await axios.post(mirror, query, {
        headers: { 'Content-Type': 'text/plain' },
        timeout: OSM.TIMEOUT_MS || 20000,
      });

      const elements = response.data?.elements;
      if (Array.isArray(elements)) return elements;

    } catch (err) {
      console.warn(`[SearchService] Mirror ${mirror} failed:`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error('All Overpass mirrors failed');
}

// ─── OSM Element → RoadSoS Service Object ────────────────────────────────────

/**
 * Normalise a raw OSM element into a clean RoadSoS service object.
 *
 * @param {object} el       Raw OSM element
 * @param {string} type     SERVICE_TYPES constant
 * @param {number} userLat  User latitude (for distance calc)
 * @param {number} userLon  User longitude
 * @returns {object}        Normalised service object
 */
function normaliseElement(el, type, userLat, userLon) {
  const tags = el.tags || {};

  // Coordinates: nodes have lat/lon directly; ways/relations use center
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;

  if (!lat || !lon) return null; // Skip elements without coordinates

  // Distance from user
  const distance = haversineDistance(
    { lat: userLat, lon: userLon },
    { lat, lon }
  );

  // Phone number — try multiple OSM tags
  const phone =
    tags['contact:phone'] ||
    tags['phone'] ||
    tags['contact:mobile'] ||
    tags['mobile'] ||
    null;

  // Name fallback chain
  const name =
    tags['name:en'] ||       // English name preferred
    tags['name'] ||
    tags['operator'] ||
    tags['brand'] ||
    buildFallbackName(type);

  // Address assembly from OSM addr:* tags
  const address = buildAddress(tags);

  // Opening hours
  const hours = tags['opening_hours'] || null;
  const is24hr =
    hours === '24/7' ||
    tags['24_7'] === 'yes' ||
    tags['opening_hours:covid19'] === '24/7';
  const openNow = determineOpenNow(hours, is24hr);

  // Extra fields per service type
  const emergency = tags['emergency'] || null;
  const healthcare = tags['healthcare'] || null;
  const website = tags['website'] || tags['contact:website'] || tags['url'] || null;
  const operator = tags['operator'] || null;
  const beds = tags['beds'] ? parseInt(tags['beds']) : null;
  const traumaCentre =
    tags['trauma'] === 'yes' ||
    tags['healthcare:speciality']?.includes('trauma') ||
    (name || '').toLowerCase().includes('trauma') ||
    (name || '').toLowerCase().includes('apollo') ||  // Major trauma-capable hospitals
    (name || '').toLowerCase().includes('aiims');

  return {
    // Identity
    id: `${el.type}-${el.id}`,
    osmId: el.id,
    osmType: el.type,          // 'node' | 'way' | 'relation'

    // Display
    name,
    type,
    operator,
    address,
    phone,
    website,

    // Location
    lat,
    lon,
    distance,
    distanceLabel: formatDistance(distance),

    // Status
    hours,
    is24hr,
    openNow,

    // Service-specific
    emergency,
    healthcare,
    traumaCentre,
    beds,

    // Raw tags (for debugging / future use)
    _tags: tags,
  };
}

/** Assemble a readable address string from OSM addr:* tags */
function buildAddress(tags) {
  const parts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:suburb'] || tags['addr:quarter'],
    tags['addr:city'],
    tags['addr:state'],
    tags['addr:postcode'],
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Fallback display name when OSM has no name tag */
function buildFallbackName(type) {
  const fallbacks = {
    [SERVICE_TYPES.HOSPITAL]: 'Hospital',
    [SERVICE_TYPES.POLICE]: 'Police Station',
    [SERVICE_TYPES.AMBULANCE]: 'Ambulance Station',
    [SERVICE_TYPES.TOWING]: 'Towing Service',
    [SERVICE_TYPES.PUNCTURE]: 'Repair Shop',
  };
  return fallbacks[type] || 'Emergency Service';
}

/**
 * Naively determine if a place is open now from opening_hours string.
 * Full OSM opening_hours parsing is complex — this handles the common cases.
 * Returns: true | false | null (null = unknown)
 */
function determineOpenNow(hours, is24hr) {
  if (is24hr) return true;
  if (!hours) return null;

  // Can't parse complex rules (Mo-Fr 08:00-20:00 etc.) without a library
  // For hackathon: flag 24/7 as open, flag 'off' / 'closed' as closed
  if (hours === 'off' || hours === 'closed') return false;
  if (hours.includes('24/7')) return true;

  // Attempt simple hour range check for common format: "HH:MM-HH:MM"
  try {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const match = hours.match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
    if (match) {
      const openMin = parseInt(match[1]) * 60 + parseInt(match[2]);
      const closeMin = parseInt(match[3]) * 60 + parseInt(match[4]);
      return currentMinutes >= openMin && currentMinutes <= closeMin;
    }
  } catch {}

  return null; // Unknown
}

// ─── Sort & Filter Pipeline ───────────────────────────────────────────────────

/**
 * Sort results by distance ascending, remove nulls, cap at MAX_RESULTS.
 * Also deduplicates by name+type (OSM sometimes returns the same place
 * from multiple tag filters).
 */
function sortAndFilter(results) {
  // Remove nulls (elements without coordinates)
  const valid = results.filter(Boolean);

  // Deduplicate by name similarity (same name within 50m → keep nearest)
  const seen = new Map();
  const deduped = [];
  for (const item of valid) {
    const key = `${item.name?.toLowerCase().trim()}-${item.type}`;
    const existing = seen.get(key);
    if (!existing || item.distance < existing.distance) {
      seen.set(key, item);
    }
  }
  seen.forEach(item => deduped.push(item));

  // Sort by distance ascending
  deduped.sort((a, b) => a.distance - b.distance);

  // Cap at max results
  return deduped.slice(0, OSM.MAX_RESULTS || 20);
}

// ─── Per-Type Search Functions ────────────────────────────────────────────────

/**
 * Search for hospitals and trauma centres near a location.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} radiusKm  default 10
 * @returns {Promise<object[]>}
 */
export async function searchHospitals(lat, lon, radiusKm = OSM.DEFAULT_RADIUS_KM) {
  const radiusM = radiusKm * 1000;

  // OSM tags that identify hospitals / medical facilities
  const tags = [
    'amenity=hospital',
    'amenity=clinic',
    'healthcare=hospital',
    'healthcare=clinic',
    'amenity=doctors',
    'healthcare=centre',
  ];

  const query = buildOverpassQuery(tags, lat, lon, radiusM);
  const elements = await fetchOverpass(query);

  const results = elements.map(el =>
    normaliseElement(el, SERVICE_TYPES.HOSPITAL, lat, lon)
  );

  // Sort trauma centres first within distance groups
  const sorted = sortAndFilter(results);
  sorted.sort((a, b) => {
    if (a.traumaCentre && !b.traumaCentre) return -1;
    if (!a.traumaCentre && b.traumaCentre) return 1;
    return a.distance - b.distance;
  });

  return sorted;
}

/**
 * Search for police stations near a location.
 */
export async function searchPolice(lat, lon, radiusKm = OSM.DEFAULT_RADIUS_KM) {
  const radiusM = radiusKm * 1000;
  const tags = ['amenity=police'];
  const query = buildOverpassQuery(tags, lat, lon, radiusM);
  const elements = await fetchOverpass(query);

  const results = elements.map(el =>
    normaliseElement(el, SERVICE_TYPES.POLICE, lat, lon)
  );

  return sortAndFilter(results);
}

/**
 * Search for ambulance stations near a location.
 */
export async function searchAmbulance(lat, lon, radiusKm = OSM.DEFAULT_RADIUS_KM) {
  const radiusM = radiusKm * 1000;
  const tags = [
    'emergency=ambulance_station',
    'amenity=ambulance_station',
    'emergency=medical_service',
    'healthcare=emergency',
  ];
  const query = buildOverpassQuery(tags, lat, lon, radiusM);
  const elements = await fetchOverpass(query);

  const results = elements.map(el =>
    normaliseElement(el, SERVICE_TYPES.AMBULANCE, lat, lon)
  );

  return sortAndFilter(results);
}

/**
 * Search for towing services and car repair shops.
 */
export async function searchTowing(lat, lon, radiusKm = OSM.DEFAULT_RADIUS_KM) {
  const radiusM = radiusKm * 1000;
  const tags = [
    'service=vehicle:towing',
    'amenity=car_repair',
    'shop=car_repair',
    'emergency=towing_service',
    'shop=vehicle_repair',
  ];
  const query = buildOverpassQuery(tags, lat, lon, radiusM);
  const elements = await fetchOverpass(query);

  const results = elements.map(el =>
    normaliseElement(el, SERVICE_TYPES.TOWING, lat, lon)
  );

  return sortAndFilter(results);
}

/**
 * Search for tyre shops and puncture repair stations.
 */
export async function searchPuncture(lat, lon, radiusKm = OSM.DEFAULT_RADIUS_KM) {
  const radiusM = radiusKm * 1000;
  const tags = [
    'shop=tyres',
    'shop=tyre',
    'amenity=bicycle_repair_station',
    'craft=tyre_technician',
  ];
  const query = buildOverpassQuery(tags, lat, lon, radiusM);
  const elements = await fetchOverpass(query);

  const results = elements.map(el =>
    normaliseElement(el, SERVICE_TYPES.PUNCTURE, lat, lon)
  );

  return sortAndFilter(results);
}

// ─── Main Entry Point: searchNearby ──────────────────────────────────────────

/**
 * Universal search function — routes to the correct type-specific searcher.
 * This is what most screens should call.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} type     One of SERVICE_TYPES constants
 * @param {number} radiusKm Default 10km
 * @returns {Promise<object[]>} Sorted array of service objects
 */
export async function searchNearby(lat, lon, type, radiusKm = OSM.DEFAULT_RADIUS_KM) {
  if (!lat || !lon) throw new Error('searchNearby: lat/lon required');

  switch (type) {
    case SERVICE_TYPES.HOSPITAL:  return searchHospitals(lat, lon, radiusKm);
    case SERVICE_TYPES.POLICE:    return searchPolice(lat, lon, radiusKm);
    case SERVICE_TYPES.AMBULANCE: return searchAmbulance(lat, lon, radiusKm);
    case SERVICE_TYPES.TOWING:    return searchTowing(lat, lon, radiusKm);
    case SERVICE_TYPES.PUNCTURE:  return searchPuncture(lat, lon, radiusKm);
    default:
      throw new Error(`searchNearby: unknown type "${type}"`);
  }
}

// ─── Search All Types in Parallel ────────────────────────────────────────────

/**
 * Fetch all 5 service types simultaneously using Promise.allSettled.
 * Failed types return an empty array (not a thrown error), so a single
 * Overpass hiccup doesn't kill the whole SOS flow.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} radiusKm
 * @returns {Promise<{
 *   hospital: object[], police: object[], ambulance: object[],
 *   towing: object[], puncture: object[], errors: object
 * }>}
 */
export async function searchAll(lat, lon, radiusKm = OSM.DEFAULT_RADIUS_KM) {
  if (!lat || !lon) throw new Error('searchAll: lat/lon required');

  const [hospitals, police, ambulance, towing, puncture] = await Promise.allSettled([
    searchHospitals(lat, lon, radiusKm),
    searchPolice(lat, lon, radiusKm),
    searchAmbulance(lat, lon, radiusKm),
    searchTowing(lat, lon, radiusKm),
    searchPuncture(lat, lon, radiusKm),
  ]);

  const extract = (settled) =>
    settled.status === 'fulfilled' ? settled.value : [];

  const errors = {};
  [
    ['hospital', hospitals],
    ['police', police],
    ['ambulance', ambulance],
    ['towing', towing],
    ['puncture', puncture],
  ].forEach(([key, settled]) => {
    if (settled.status === 'rejected') {
      errors[key] = settled.reason?.message || 'Unknown error';
      console.warn(`[SearchService] ${key} search failed:`, settled.reason?.message);
    }
  });

  return {
    hospital: extract(hospitals),
    police: extract(police),
    ambulance: extract(ambulance),
    towing: extract(towing),
    puncture: extract(puncture),
    errors,
    // Flat list of all results sorted by distance (useful for map pins)
    all: sortAndFilter([
      ...extract(hospitals),
      ...extract(police),
      ...extract(ambulance),
      ...extract(towing),
      ...extract(puncture),
    ]),
  };
}

// ─── Nearest Single Result ────────────────────────────────────────────────────

/**
 * Get just the single nearest service of a given type.
 * Used by: ChatBot (show closest result), VoiceService (speak result).
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} type
 * @returns {Promise<object|null>}
 */
export async function getNearestService(lat, lon, type) {
  try {
    const results = await searchNearby(lat, lon, type, 15); // 15km for nearest
    return results.length > 0 ? results[0] : null;
  } catch (error) {
    console.error('[SearchService] getNearestService failed:', error.message);
    return null;
  }
}

/**
 * Get the nearest service across ALL types.
 * Used by: SOS button (what's the single most critical place to go right now?)
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} priorityType  The type to bias toward (e.g. HOSPITAL for critical)
 * @returns {Promise<object|null>}
 */
export async function getAbsoluteNearest(lat, lon, priorityType = SERVICE_TYPES.HOSPITAL) {
  try {
    const all = await searchAll(lat, lon, 20);
    // Return nearest of the priority type first; fall back to any nearest
    const priority = all[priorityType];
    if (priority && priority.length > 0) return priority[0];
    return all.all.length > 0 ? all.all[0] : null;
  } catch (error) {
    console.error('[SearchService] getAbsoluteNearest failed:', error.message);
    return null;
  }
}

// ─── Default Export ───────────────────────────────────────────────────────────
export default {
  searchNearby,
  searchAll,
  searchHospitals,
  searchPolice,
  searchAmbulance,
  searchTowing,
  searchPuncture,
  getNearestService,
  getAbsoluteNearest,
};
