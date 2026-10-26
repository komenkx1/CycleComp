/**
 * Resolve and parse Google Maps direction and place URLs.
 *
 * Handles:
 * - Short share links (maps.app.goo.gl/..., goo.gl/maps/...)
 * - Full direction path URLs (google.com/maps/dir/A/B/C/...)
 * - Legacy saddr/daddr URLs (maps.google.com/maps?saddr=...&daddr=...)
 * - Direction query param URLs (google.com/maps/dir/?origin=...&destination=...&waypoints=...)
 * - Single place URLs (google.com/maps/place/... or ?q=...) combined with optional user origin
 *
 * Reads coordinates from the resolved Google Maps URL
 * Camera centers and unrelated HTML pins are not route stops.
 */

export type ParsedWaypoint =
  | { type: 'coordinate'; latitude: number; longitude: number }
  | { type: 'placeName'; name: string };

export interface ParsedGoogleMapsLink {
  waypoints: ParsedWaypoint[];
  originalUrl: string;
  resolvedUrl: string;
  suggestedName?: string;
}

export class GoogleMapsLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleMapsLinkError';
  }
}

const GOOGLE_MAPS_SHORT_PATTERNS = [
  'maps.app.goo.gl/',
  'goo.gl/maps/',
  'g.co/maps/',
];

/**
 * Accepts either a short share link or a full direction URL, resolves
 * it if necessary, and extracts the list of waypoints.
 *
 * @param rawUrl The URL input by the user.
 * @param originCoordinate Optional [longitude, latitude] of the user to use as starting point if URL only has destination.
 */
export async function parseGoogleMapsLink(
  rawUrl: string,
  originCoordinate?: [number, number] | null,
): Promise<ParsedGoogleMapsLink> {
  const trimmed = rawUrl.trim();

  if (trimmed.length === 0) {
    throw new GoogleMapsLinkError('Link kosong. Tempel link Google Maps terlebih dahulu.');
  }

  if (!looksLikeGoogleMapsUrl(trimmed)) {
    throw new GoogleMapsLinkError(
      'Link ini bukan URL Google Maps yang valid. Pastikan link berasal dari Google Maps (misal maps.app.goo.gl atau google.com/maps).',
    );
  }

  let fullUrl = trimmed;
  if (isShortLink(trimmed)) {
    const resolved = await resolveShortUrl(trimmed);
    fullUrl = resolved.finalUrl;
  }

  // Page HTML contains unrelated pins; only the resolved URL defines the stops.
  let waypoints = extractWaypoints(fullUrl);

  // 3. Extract human-readable suggested route name (e.g. "Denpasar → sozo coffee and space")
  const suggestedName = extractRouteNameFromUrlOrHtml(fullUrl);

  // If only 1 waypoint found (e.g., place URL or directions from current location) and user coordinate is available, prepend user origin.
  if (waypoints.length === 1 && originCoordinate) {
    waypoints = [
      {
        type: 'coordinate',
        latitude: originCoordinate[1],
        longitude: originCoordinate[0],
      },
      ...waypoints,
    ];
  }

  if (waypoints.length < 2) {
    if (waypoints.length === 1) {
      throw new GoogleMapsLinkError(
        'Link ini hanya memiliki 1 titik tujuan. Buat rute berarah (Directions) dengan titik awal & tujuan di Google Maps, atau aktifkan GPS terlebih dahulu.',
      );
    }
    throw new GoogleMapsLinkError(
      'Tidak dapat menemukan titik rute di link ini. Pastikan link berisi rute arah (directions) Google Maps.',
    );
  }

  return { waypoints, originalUrl: trimmed, resolvedUrl: fullUrl, suggestedName };
}

export function looksLikeGoogleMapsUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    GOOGLE_MAPS_SHORT_PATTERNS.some(p => lower.includes(p)) ||
    lower.includes('google.com/maps') ||
    lower.includes('google.co.id/maps') ||
    lower.includes('maps.google.com') ||
    lower.includes('maps.google.co.id')
  );
}

export function isShortLink(url: string): boolean {
  const lower = url.toLowerCase();
  return GOOGLE_MAPS_SHORT_PATTERNS.some(p => lower.includes(p));
}

interface ResolvedLinkResult {
  finalUrl: string;
  html: string;
}

async function resolveShortUrl(shortUrl: string): Promise<ResolvedLinkResult> {
  try {
    const response = await fetch(shortUrl, {
      method: 'GET',
      redirect: 'follow',
    });
    const finalUrl = response.url;
    let html = '';
    try {
      html = await response.text();
    } catch {
      // Ignore
    }

    if (isGoogleMapsDomain(finalUrl)) {
      return { finalUrl, html };
    }

    // Fallback: try parsing HTML body for meta refresh, canonical, or script redirects.
    const metaMatch = html.match(
      /content=["'][^"']*url=(https?:\/\/[^"'\s]+)/i,
    );
    if (metaMatch?.[1] && isGoogleMapsDomain(metaMatch[1])) {
      return { finalUrl: metaMatch[1], html };
    }

    const canonicalMatch = html.match(
      /<link[^>]+rel=["']canonical["'][^>]+href=["'](https?:\/\/[^"']+)["']/i,
    );
    if (canonicalMatch?.[1] && isGoogleMapsDomain(canonicalMatch[1])) {
      return { finalUrl: canonicalMatch[1], html };
    }

    const hrefMatch = html.match(
      /href=["'](https?:\/\/(?:www\.)?(?:maps\.)?google\.[a-z.]+\/maps\/[^"']+)["']/i,
    );
    if (hrefMatch?.[1]) {
      return { finalUrl: hrefMatch[1], html };
    }

    throw new GoogleMapsLinkError(
      'Short link tidak dapat dialihkan ke URL Google Maps. Coba salin URL lengkap dari browser.',
    );
  } catch (error) {
    if (error instanceof GoogleMapsLinkError) {
      throw error;
    }
    throw new GoogleMapsLinkError(
      'Gagal membuka link Google Maps. Periksa koneksi internet Anda.',
    );
  }
}

function isGoogleMapsDomain(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes('google.com/maps') ||
    lower.includes('google.co.id/maps') ||
    lower.includes('maps.google.') ||
    (lower.includes('google.') && lower.includes('/maps'))
  );
}

/**
 * Extract exact coordinates embedded directly inside the Google Maps HTML body or URL parameters.
 * Google Maps embeds waypoints using:
 * - !3d<lat>!4d<lng> or %213d<lat>%214d<lng>
 * - !1d<lng>!2d<lat> or %211d<lng>%212d<lat>
 */
/**
 * Helper to determine if a Google Maps URL represents a single destination
 * (e.g. directions from current location /dir//Destination, place links, or single daddr).
 */
export function isSingleDestinationUrl(fullUrl: string): boolean {
  const lower = fullUrl.toLowerCase();

  // /maps/place/ or /maps/search/
  if (lower.includes('/maps/place/') || lower.includes('/maps/search/')) {
    return true;
  }

  // /maps/dir// (empty origin before destination, e.g. /maps/dir//Talasteduh)
  if (/\/maps\/dir\/\/+/i.test(fullUrl)) {
    return true;
  }

  // /maps/dir/ with only 1 non-empty path segment
  const dirMatch = fullUrl.match(/\/maps\/dir\/([^?#]+)/i);
  if (dirMatch?.[1]) {
    const dirPath = dirMatch[1]
      .replace(/@[^/]+.*$/, '')
      .replace(/\/data=.*$/, '');
    const segments = dirPath
      .split('/')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (segments.length === 1) {
      return true;
    }
  }

  // Query params: daddr without saddr, or destination without origin
  const queryIndex = fullUrl.indexOf('?');
  if (queryIndex !== -1) {
    const queryPart = fullUrl.substring(queryIndex + 1).split('#')[0] ?? '';
    const params = new URLSearchParams(queryPart);
    if (
      params.has('daddr') &&
      (!params.has('saddr') || !params.get('saddr')?.trim()) &&
      !params.get('daddr')!.toLowerCase().includes(' to:')
    ) {
      return true;
    }
    if (
      params.has('destination') &&
      (!params.has('origin') || !params.get('origin')?.trim())
    ) {
      return true;
    }
    if (
      (params.has('q') || params.has('query')) &&
      !params.has('origin') &&
      !params.has('saddr')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Extract human-friendly route name from URL (supporting saddr/daddr and path formats).
 */
export function extractRouteNameFromUrlOrHtml(fullUrl: string): string | undefined {
  // Check if saddr and daddr are in URL
  const queryIndex = fullUrl.indexOf('?');
  if (queryIndex !== -1) {
    const queryPart = fullUrl.substring(queryIndex + 1).split('#')[0] ?? '';
    const params = new URLSearchParams(queryPart);
    const saddr = params.get('saddr');
    const daddr = params.get('daddr');

    if (daddr) {
      const stops = daddr.split(/\s+to:\s*/i);
      const lastStop = stops[stops.length - 1]!;
      const lastName = cleanPlaceNameForDisplay(lastStop);

      if (saddr) {
        const startParts = saddr.split(',');
        const isCoord =
          startParts.length === 2 &&
          !isNaN(parseFloat(startParts[0]!)) &&
          !isNaN(parseFloat(startParts[1]!));
        const firstName = isCoord ? '' : cleanPlaceNameForDisplay(saddr);
        if (firstName) {
          return `${firstName} → ${lastName}`;
        }
        return lastName ? `Rute → ${lastName}` : undefined;
      }
      return lastName;
    }
  }

  // Fallback to path-based route name
  return extractRouteNameFromUrl(fullUrl);
}

/**
 * Extract human-friendly route name (e.g., "Penebel → Ubud" or "Talasteduh") from URL path segments.
 */
export function extractRouteNameFromUrl(fullUrl: string): string | undefined {
  // 1. Try /maps/dir/
  const dirMatch = fullUrl.match(/\/maps\/dir\/([^?#]+)/i);
  if (dirMatch?.[1]) {
    const dirPath = dirMatch[1]
      .replace(/@[^/]+.*$/, '')
      .replace(/\/data=.*$/, '');
    const segments = dirPath
      .split('/')
      .map(s => decodeURIComponent(s).replace(/\+/g, ' ').trim())
      .filter(
        s =>
          s.length > 0 &&
          !/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.test(s),
      );

    const names = segments.map(cleanPlaceNameForDisplay).filter(Boolean);
    if (names.length >= 2) {
      return `${names[0]} → ${names[names.length - 1]}`;
    }
    if (names.length === 1) {
      return names[0];
    }
  }

  // 2. Try /maps/place/
  const placeMatch = fullUrl.match(/\/maps\/place\/([^/@?#]+)/i);
  if (placeMatch?.[1]) {
    const raw = decodeURIComponent(placeMatch[1]).replace(/\+/g, ' ').trim();
    if (!/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.test(raw)) {
      return cleanPlaceNameForDisplay(raw);
    }
  }

  // 3. Fallback to pathWaypoints if any
  const pathWaypoints = extractWaypointsFromPath(fullUrl);
  const names: string[] = [];

  for (const wp of pathWaypoints) {
    if (wp.type === 'placeName') {
      const clean = cleanPlaceNameForDisplay(wp.name);
      if (clean) names.push(clean);
    }
  }

  if (names.length >= 2) {
    return `${names[0]} → ${names[names.length - 1]}`;
  }
  if (names.length === 1) {
    return names[0];
  }
  return undefined;
}

function cleanPlaceNameForDisplay(name: string): string {
  return name
    .replace(/\+/g, ' ')
    .replace(/\b(Kec\.|Kecamatan|Kab\.|Kabupaten|Kel\.|Kelurahan|Desa|Kota)\s+/gi, '')
    .split(',')[0]!
    .trim();
}

/**
 * Extract waypoints from any full Google Maps URL.
 */
export function extractWaypoints(fullUrl: string): ParsedWaypoint[] {
  const queryWaypoints = extractWaypointsFromQueryParams(fullUrl);
  const addressWaypoints = extractWaypointsFromSaddrDaddr(fullUrl);
  const pathWaypoints = extractWaypointsFromPath(fullUrl);
  const placeWaypoints = extractPlaceWaypoint(fullUrl);
  const requestedWaypoints = queryWaypoints.length > 0
    ? queryWaypoints
    : addressWaypoints.length > 0
      ? addressWaypoints
      : pathWaypoints.length > 0
        ? pathWaypoints
        : placeWaypoints;
  const geocodeParameter = new URLSearchParams(fullUrl.split('?')[1]?.split('#')[0] ?? '').get('geocode');
  if (geocodeParameter && requestedWaypoints.length > 0) {
    let geocodePins = geocodeParameter.split(';').map(decodeGoogleGeocodePin);
    if (geocodePins.length === requestedWaypoints.length + 1 && geocodePins[0] === null) {
      geocodePins = geocodePins.slice(1);
    }
    if (geocodePins.length === requestedWaypoints.length) {
      const pinnedWaypoints = requestedWaypoints.map((stop, index) =>
        stop.type === 'placeName' ? geocodePins[index] ?? stop : stop,
      );
      if (pinnedWaypoints.every(stop => stop.type === 'coordinate')) return pinnedWaypoints;
    }
  }
  const pinWaypoints = extractWaypointsFromDataParam(fullUrl.replace(/%21/gi, '!'));

  if (requestedWaypoints.length === 0) return pinWaypoints;
  const namedStopCount = requestedWaypoints.filter(stop => stop.type === 'placeName').length;
  if (namedStopCount === 0 || pinWaypoints.length === 0) return requestedWaypoints;

  if (pinWaypoints.length === requestedWaypoints.length) {
    const explicitCoordinatesAgree = requestedWaypoints.every((stop, index) => {
      const pin = pinWaypoints[index]!;
      return stop.type === 'placeName' || (pin.type === 'coordinate' &&
        Math.abs(stop.latitude - pin.latitude) < 0.00001 &&
        Math.abs(stop.longitude - pin.longitude) < 0.00001);
    });
    if (explicitCoordinatesAgree) return pinWaypoints;
  }

  // Links can store the GPS origin in saddr and only encode pins for named stops.
  if (pinWaypoints.length === namedStopCount) {
    let namedStopIndex = 0;
    return requestedWaypoints.map(stop => stop.type === 'coordinate'
      ? stop
      : pinWaypoints[namedStopIndex++]!);
  }
  return requestedWaypoints;
}

function decodeGoogleGeocodePin(encodedPin: string): ParsedWaypoint | null {
  if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(encodedPin)) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const normalizedPin = encodedPin.replace(/-/g, '+').replace(/_/g, '/');
  const coordinateBytes: number[] = [];
  let remainingBits = 0;
  let bitBuffer = 0;
  for (const character of normalizedPin) {
    if (character === '=' || coordinateBytes.length === 10) break;
    bitBuffer = bitBuffer * 64 + alphabet.indexOf(character);
    remainingBits += 6;
    if (remainingBits >= 8) {
      remainingBits -= 8;
      coordinateBytes.push(Math.floor(bitBuffer / 2 ** remainingBits));
      bitBuffer %= 2 ** remainingBits;
    }
  }

  // Google legacy geocode pins begin with signed little-endian E6 lat/lng fields.
  if (coordinateBytes.length !== 10 || coordinateBytes[0] !== 0x15 || coordinateBytes[5] !== 0x1d) return null;
  const pinFields = new DataView(Uint8Array.from(coordinateBytes).buffer);
  const latitude = pinFields.getInt32(1, true) / 1e6;
  const longitude = pinFields.getInt32(6, true) / 1e6;
  return isValidCoordinate(latitude, longitude)
    ? { type: 'coordinate', latitude, longitude }
    : null;
}

/**
 * Extract waypoints from path segments between /dir/ and /@ or /data=.
 */
export function extractWaypointsFromPath(fullUrl: string): ParsedWaypoint[] {
  const dirMatch = fullUrl.match(/\/maps\/dir\/([^?#]+)/i);
  if (!dirMatch?.[1]) {
    return [];
  }

  let dirPath = dirMatch[1];
  dirPath = dirPath.replace(/@[^/]+.*$/, '');
  dirPath = dirPath.replace(/\/data=.*$/, '');

  const segments = dirPath
    .split('/')
    .map(s => decodeURIComponent(s).replace(/\+/g, ' ').trim())
    .filter(s => s.length > 0 && !s.startsWith('data='));

  return segments.map(parseWaypointSegment);
}

/**
 * Extract waypoints from standard URL query params: origin, destination, waypoints.
 */
function extractWaypointsFromQueryParams(fullUrl: string): ParsedWaypoint[] {
  const result: ParsedWaypoint[] = [];
  const queryIndex = fullUrl.indexOf('?');
  if (queryIndex === -1) {
    return result;
  }

  const queryPart = fullUrl.substring(queryIndex + 1).split('#')[0] ?? '';
  const params = new URLSearchParams(queryPart);

  const origin = params.get('origin');
  if (origin && origin.trim()) {
    result.push(parseWaypointSegment(origin.trim()));
  }

  const waypoints = params.get('waypoints');
  if (waypoints && waypoints.trim()) {
    const list = waypoints.split('|');
    for (const wp of list) {
      if (wp.trim()) {
        result.push(parseWaypointSegment(wp.trim()));
      }
    }
  }

  const destination = params.get('destination');
  if (destination && destination.trim()) {
    result.push(parseWaypointSegment(destination.trim()));
  }

  return result;
}

/**
 * Extract waypoints from legacy saddr / daddr query params.
 */
function extractWaypointsFromSaddrDaddr(fullUrl: string): ParsedWaypoint[] {
  const result: ParsedWaypoint[] = [];
  const queryIndex = fullUrl.indexOf('?');
  if (queryIndex === -1) {
    return result;
  }

  const queryPart = fullUrl.substring(queryIndex + 1).split('#')[0] ?? '';
  const params = new URLSearchParams(queryPart);

  const saddr = params.get('saddr');
  const daddr = params.get('daddr');

  if (saddr && saddr.trim()) {
    result.push(parseWaypointSegment(saddr.trim()));
  }

  if (daddr && daddr.trim()) {
    // daddr can contain intermediate waypoints separated by " to:"
    const parts = daddr.split(/\s+to:\s*/i);
    for (const part of parts) {
      if (part.trim()) {
        result.push(parseWaypointSegment(part.trim()));
      }
    }
  }

  return result;
}

/**
 * Extract a single place from /maps/place/... or ?q=... or ?query=.
 */
function extractPlaceWaypoint(fullUrl: string): ParsedWaypoint[] {
  // Check /maps/place/Name/@lat,lng
  const placeMatch = fullUrl.match(/\/maps\/place\/([^/@?#]+)/i);
  if (placeMatch?.[1]) {
    const placeName = decodeURIComponent(placeMatch[1]).replace(/\+/g, ' ').trim();
    if (placeName.length > 0) {
      return [parseWaypointSegment(placeName)];
    }
  }

  // Check query params: q or query
  const queryIndex = fullUrl.indexOf('?');
  if (queryIndex !== -1) {
    const queryPart = fullUrl.substring(queryIndex + 1).split('#')[0] ?? '';
    const params = new URLSearchParams(queryPart);
    const q = params.get('q') || params.get('query');
    if (q && q.trim()) {
      return [parseWaypointSegment(q.trim())];
    }
  }

  return [];
}

/**
 * Parse a segment or query value into a coordinate or place name.
 */
function parseWaypointSegment(segment: string): ParsedWaypoint {
  // Check for raw coordinates like "-8.5069,115.2625" or "-8.5069, 115.2625".
  const coordMatch = segment.match(
    /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/,
  );

  if (coordMatch?.[1] && coordMatch?.[2]) {
    const lat = parseFloat(coordMatch[1]);
    const lng = parseFloat(coordMatch[2]);

    if (isValidCoordinate(lat, lng)) {
      return { type: 'coordinate', latitude: lat, longitude: lng };
    }
  }

  // It's a place name. Replace '+' with spaces.
  return { type: 'placeName', name: segment.replace(/\+/g, ' ').trim() };
}

/**
 * Extract coordinates from the data= parameter using !1d/!2d, !2d/!1d, !3d/!4d patterns.
 */
export function extractWaypointsFromDataParam(fullUrl: string): ParsedWaypoint[] {
  const coordinatePatterns = [
    { pattern: /!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/g, longitudeFirst: true },
    { pattern: /!2d(-?\d+(?:\.\d+)?)!1d(-?\d+(?:\.\d+)?)/g, longitudeFirst: false },
    { pattern: /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g, longitudeFirst: false },
    { pattern: /!4d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/g, longitudeFirst: true },
  ];

  for (const { pattern, longitudeFirst } of coordinatePatterns) {
    const pinWaypoints: ParsedWaypoint[] = [];
    let coordinateMatch: RegExpExecArray | null;
    while ((coordinateMatch = pattern.exec(fullUrl)) !== null) {
      const firstCoordinate = Number(coordinateMatch[1]);
      const secondCoordinate = Number(coordinateMatch[2]);
      const latitude = longitudeFirst ? secondCoordinate : firstCoordinate;
      const longitude = longitudeFirst ? firstCoordinate : secondCoordinate;
      if (isValidCoordinate(latitude, longitude)) {
        pinWaypoints.push({ type: 'coordinate', latitude, longitude });
      }
    }
    if (pinWaypoints.length > 0) return pinWaypoints;
  }
  return [];
}

function isValidCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}
