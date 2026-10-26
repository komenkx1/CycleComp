/**
 * End-to-end pipeline: Google Maps link → GpxRoute with elevation.
 *
 * Orchestrates the full conversion:
 * 1. Resolve & parse the Google Maps URL → extract waypoints
 * 2. Geocode any place-name waypoints via Nominatim
 * 3. Generate a cycling route via OSRM
 * 4. Enrich every route point with elevation via Open-Meteo
 * 5. Build a GpxRoute object compatible with the rest of the app
 */

import type {
  GpxRoute,
  GpxRoutePoint,
  GpxRouteSegment,
  RouteBounds,
  RouteCoordinate,
} from '../gpx/GpxRoute';
import {
  lookupElevations,
  type ElevationLookupOptions,
} from './elevationLookup';
import { geocodePlaceName } from './nominatimGeocode';
import { fetchBicycleRoute } from './osrmBicycleRoute';
import {
  parseGoogleMapsLink,
  type ParsedWaypoint,
} from './resolveGoogleMapsUrl';

export type ConversionProgress =
  | { step: 'resolving'; message: string }
  | { step: 'geocoding'; message: string; current: number; total: number }
  | { step: 'routing'; message: string }
  | { step: 'elevation'; message: string; current: number; total: number }
  | { step: 'building'; message: string }
  | { step: 'done'; message: string };

const NOMINATIM_THROTTLE_MS = 1100;

/**
 * Convert a Google Maps link to a fully enriched GpxRoute.
 *
 * @param rawUrl  The Google Maps URL (short or full).
 * @param onProgress  Optional callback for live progress updates.
 */
export async function gmapsLinkToGpxRoute(
  rawUrl: string,
  onProgress?: (progress: ConversionProgress) => void,
  originCoordinate?: [number, number] | null,
  elevationLookupOptions: ElevationLookupOptions = {},
): Promise<GpxRoute> {
  // --- Step 1: Resolve & parse the URL ---
  onProgress?.({ step: 'resolving', message: 'Membaca link Google Maps…' });
  const parsed = await parseGoogleMapsLink(rawUrl, originCoordinate);

  // --- Step 2: Geocode place-name waypoints ---
  const resolvedCoords: RouteCoordinate[] = [];

  for (let i = 0; i < parsed.waypoints.length; i++) {
    const wp = parsed.waypoints[i]!;

    if (wp.type === 'coordinate') {
      resolvedCoords.push([wp.longitude, wp.latitude]);
    } else {
      onProgress?.({
        step: 'geocoding',
        message: `Mencari "${wp.name}"…`,
        current: i + 1,
        total: parsed.waypoints.length,
      });

      // Throttle between Nominatim requests.
      if (resolvedCoords.length > 0) {
        await delay(NOMINATIM_THROTTLE_MS);
      }

      const place = await geocodePlaceName(wp.name);
      resolvedCoords.push([place.longitude, place.latitude]);
    }
  }

  // --- Step 3: Generate bicycle route via OSRM ---
  onProgress?.({ step: 'routing', message: 'Membuat rute sepeda…' });
  const osrmResult = await fetchBicycleRoute(resolvedCoords);

  // --- Step 4: Enrich with elevation ---
  onProgress?.({
    step: 'elevation',
    message: 'Mengambil data elevasi…',
    current: 0,
    total: osrmResult.coordinates.length,
  });

  // For very long routes, downsample for elevation lookup to avoid
  // hammering the API, then interpolate.
  const elevations = await lookupElevationsWithProgress(
    osrmResult.coordinates,
    (current, total) =>
      onProgress?.({
        step: 'elevation',
        message: `Mengambil elevasi… (${current}/${total})`,
        current,
        total,
      }),
    elevationLookupOptions,
  );

  // --- Step 5: Build GpxRoute ---
  onProgress?.({ step: 'building', message: 'Menyusun rute GPX…' });

  const routePoints: GpxRoutePoint[] = osrmResult.coordinates.map(
    (coord, idx) => ({
      coordinate: coord,
      elevationMeters: elevations[idx] ?? null,
    }),
  );

  const segment: GpxRouteSegment = { points: routePoints };
  const bounds = calculateBounds(osrmResult.coordinates);
  const elevationValues = elevations.filter(
    (e): e is number => e !== null && Number.isFinite(e),
  );

  const routeName = parsed.suggestedName ?? buildRouteName(parsed.waypoints);

  const gpxRoute: GpxRoute = {
    name: routeName,
    sourceFileName: `gmaps-${Date.now()}.gpx`,
    segments: [segment],
    bounds,
    distanceMeters: osrmResult.distanceMeters,
    pointCount: routePoints.length,
    elevationPointCount: elevationValues.length,
    minimumElevationMeters:
      elevationValues.length > 0 ? Math.min(...elevationValues) : null,
    maximumElevationMeters:
      elevationValues.length > 0 ? Math.max(...elevationValues) : null,
  };

  onProgress?.({ step: 'done', message: 'Rute siap!' });

  return gpxRoute;
}

// --- Helpers ---

async function lookupElevationsWithProgress(
  coordinates: RouteCoordinate[],
  onChunkProgress: (current: number, total: number) => void,
  elevationLookupOptions: ElevationLookupOptions,
): Promise<(number | null)[]> {
  // For routes with many points, we sample every Nth point for elevation
  // lookup, then interpolate the rest. This keeps API usage reasonable.
  const MAX_ELEVATION_LOOKUPS = 500;

  if (coordinates.length <= MAX_ELEVATION_LOOKUPS) {
    onChunkProgress(coordinates.length, coordinates.length);
    return lookupElevations(coordinates, elevationLookupOptions);
  }

  // Sample every Nth coordinate.
  const sampleInterval = Math.ceil(coordinates.length / MAX_ELEVATION_LOOKUPS);
  const sampledCoords: RouteCoordinate[] = [];
  const sampledIndices: number[] = [];

  for (let i = 0; i < coordinates.length; i += sampleInterval) {
    sampledCoords.push(coordinates[i]!);
    sampledIndices.push(i);
  }

  // Always include the last point.
  if (sampledIndices[sampledIndices.length - 1] !== coordinates.length - 1) {
    sampledCoords.push(coordinates[coordinates.length - 1]!);
    sampledIndices.push(coordinates.length - 1);
  }

  onChunkProgress(sampledCoords.length, sampledCoords.length);
  const sampledElevations = await lookupElevations(sampledCoords, elevationLookupOptions);

  // Interpolate elevation for non-sampled points.
  const allElevations: (number | null)[] = new Array(coordinates.length).fill(null);

  for (let sIdx = 0; sIdx < sampledIndices.length; sIdx++) {
    allElevations[sampledIndices[sIdx]!] = sampledElevations[sIdx] ?? null;
  }

  for (let sIdx = 0; sIdx < sampledIndices.length - 1; sIdx++) {
    const startIdx = sampledIndices[sIdx]!;
    const endIdx = sampledIndices[sIdx + 1]!;
    const startElev = sampledElevations[sIdx] ?? null;
    const endElev = sampledElevations[sIdx + 1] ?? null;

    if (startElev === null || endElev === null) continue;

    for (let i = startIdx + 1; i < endIdx; i++) {
      const t = (i - startIdx) / (endIdx - startIdx);
      allElevations[i] = startElev + t * (endElev - startElev);
    }
  }

  return allElevations;
}

function calculateBounds(coordinates: RouteCoordinate[]): RouteBounds {
  if (coordinates.length === 0) {
    return [0, 0, 0, 0];
  }

  let west = coordinates[0]![0];
  let south = coordinates[0]![1];
  let east = west;
  let north = south;

  for (const [lng, lat] of coordinates) {
    west = Math.min(west, lng);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    north = Math.max(north, lat);
  }

  return [west, south, east, north];
}

function buildRouteName(waypoints: ParsedWaypoint[]): string {
  const names: string[] = [];

  for (const wp of waypoints) {
    if (wp.type === 'placeName') {
      // Shorten long place names.
      const shortName =
        wp.name.length > 25 ? wp.name.substring(0, 25) + '…' : wp.name;
      names.push(shortName);
    } else {
      names.push(`${wp.latitude.toFixed(3)},${wp.longitude.toFixed(3)}`);
    }
  }

  if (names.length >= 2) {
    return `${names[0]} → ${names[names.length - 1]}`;
  }

  return names[0] ?? 'Rute dari Google Maps';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
