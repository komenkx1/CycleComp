/**
 * Geocode place names to coordinates using the Nominatim (OpenStreetMap) API.
 *
 * Free, no API key required.
 * Rate limit: 1 request per second (throttled between calls).
 * Supports Indonesian administrative normalization without changing the destination
 * (e.g., expanding "Kec." -> "Kecamatan", stripping administrative prefixes).
 */

export interface GeocodedPlace {
  latitude: number;
  longitude: number;
  displayName: string;
}

export class GeocodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeocodeError';
  }
}

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'CycleComp/1.0 (cycling-navigation-app)';
const NOMINATIM_THROTTLE_MS = 1100;

/**
 * Geocode a single place name string to coordinates.
 * Generates smart query candidates if the exact string isn't found.
 */
export async function geocodePlaceName(
  placeName: string,
): Promise<GeocodedPlace> {
  const candidates = generateCandidateQueries(placeName);

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;

    if (i > 0) {
      await delay(NOMINATIM_THROTTLE_MS);
    }

    try {
      // 1. Try with Indonesia country code restriction
      const place = await fetchSingleNominatimQuery(candidate, true);
      if (place) {
        return place;
      }
    } catch {
      // Continue to next candidate
    }
  }

  // 2. Fallback: try top candidates without country restriction
  for (let i = 0; i < Math.min(2, candidates.length); i++) {
    const candidate = candidates[i]!;
    await delay(NOMINATIM_THROTTLE_MS);

    try {
      const place = await fetchSingleNominatimQuery(candidate, false);
      if (place) {
        return place;
      }
    } catch {
      // Continue
    }
  }

  throw new GeocodeError(
    `Tempat "${placeName}" tidak ditemukan. Coba gunakan pin koordinat atau nama tempat yang lebih spesifik di Google Maps.`,
  );
}

/**
 * Geocode multiple place names with throttling to respect Nominatim rate limits.
 */
export async function geocodePlaceNames(
  placeNames: string[],
): Promise<GeocodedPlace[]> {
  const results: GeocodedPlace[] = [];

  for (let i = 0; i < placeNames.length; i++) {
    if (i > 0) {
      await delay(NOMINATIM_THROTTLE_MS);
    }
    results.push(await geocodePlaceName(placeNames[i]!));
  }

  return results;
}

async function fetchSingleNominatimQuery(
  query: string,
  restrictToIndonesia: boolean,
): Promise<GeocodedPlace | null> {
  const searchParams: Record<string, string> = {
    q: query,
    format: 'json',
    limit: '1',
  };
  if (restrictToIndonesia) {
    searchParams.countrycodes = 'id';
  }

  const params = new URLSearchParams(searchParams);

  const response = await fetch(`${NOMINATIM_BASE_URL}?${params.toString()}`, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    return null;
  }

  const results: NominatimResult[] = await response.json();
  if (!results || results.length === 0) {
    return null;
  }

  return parseNominatimResult(results[0]!);
}

/**
 * Generate smart query candidates to handle Indonesian administrative prefixes
 * and abbreviations that often cause Nominatim zero-result misses.
 */
export function generateCandidateQueries(placeName: string): string[] {
  const candidates: string[] = [placeName];

  const cleanPostal = (s: string): string =>
    s
      .replace(/\b\d{5}\b/g, '')
      .replace(/\s+,/g, ',')
      .replace(/,\s*,/g, ',')
      .trim();

  // 1. Without 5-digit postal code (OSM in Indonesia often fails with postal codes)
  const noPostal = cleanPostal(placeName);
  if (noPostal !== placeName && noPostal.length > 0 && !candidates.includes(noPostal)) {
    candidates.push(noPostal);
  }

  // 2. Expand standard Indonesian administrative abbreviations
  const expanded = placeName
    .replace(/\bKec\.\s*/gi, 'Kecamatan ')
    .replace(/\bKab\.\s*/gi, 'Kabupaten ')
    .replace(/\bKel\.\s*/gi, 'Kelurahan ')
    .replace(/\bDes\.\s*/gi, 'Desa ')
    .replace(/\bJl\.\s*/gi, 'Jalan ')
    .replace(/\bGg\.\s*/gi, 'Gang ')
    .trim();
  if (expanded !== placeName && !candidates.includes(expanded)) {
    candidates.push(expanded);
  }

  // 3. Strip administrative prefixes: "Kec. Penebel, Kabupaten Tabanan, Bali" -> "Penebel, Tabanan, Bali"
  const stripped = placeName
    .replace(
      /\b(Kec\.|Kecamatan|Kab\.|Kabupaten|Kel\.|Kelurahan|Desa|Kota)\s+/gi,
      '',
    )
    .trim();
  if (stripped.length > 0 && !candidates.includes(stripped)) {
    candidates.push(stripped);
  }

  return candidates;
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
}

function parseNominatimResult(result: NominatimResult): GeocodedPlace {
  const latitude = parseFloat(result.lat);
  const longitude = parseFloat(result.lon);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new GeocodeError('Koordinat dari Nominatim tidak valid.');
  }

  return {
    latitude,
    longitude,
    displayName: result.display_name,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
