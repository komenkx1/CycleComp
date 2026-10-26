/**
 * OSRM Bicycle Routing via the public demo server.
 *
 * Generates a cycling-optimised route between multiple waypoints.
 * Returns a detailed GeoJSON LineString with coordinates and
 * step-by-step navigation instructions.
 */

import type { RouteCoordinate } from '../gpx/GpxRoute';

export interface OsrmRouteResult {
  /** Ordered coordinates along the route [longitude, latitude]. */
  coordinates: RouteCoordinate[];
  /** Total route distance in metres. */
  distanceMeters: number;
  /** Estimated duration in seconds. */
  durationSeconds: number;
  /** Per-step navigation instructions (for turn-by-turn). */
  steps: OsrmStep[];
}

export interface OsrmStep {
  distanceMeters: number;
  durationSeconds: number;
  name: string;
  maneuverType: string;
  maneuverModifier: string;
  maneuverLocation: RouteCoordinate;
}

export class OsrmRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OsrmRoutingError';
  }
}

const OSRM_BASE_URL = 'https://routing.openstreetmap.de/routed-bike/route/v1/driving';

/**
 * Fetch a bicycle route between the given waypoints.
 *
 * @param waypoints At least 2 waypoints as [longitude, latitude] pairs.
 */
export async function fetchBicycleRoute(
  waypoints: RouteCoordinate[],
): Promise<OsrmRouteResult> {
  if (waypoints.length < 2) {
    throw new OsrmRoutingError('Minimal 2 titik diperlukan untuk membuat rute.');
  }

  // OSRM expects coordinates as "lng,lat;lng,lat;..."
  const coordsString = waypoints
    .map(([lng, lat]) => `${lng},${lat}`)
    .join(';');

  const url = `${OSRM_BASE_URL}/${coordsString}?steps=true&geometries=geojson&overview=full`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'CycleComp/1.0' },
    });
  } catch {
    throw new OsrmRoutingError(
      'Gagal menghubungi server rute. Periksa koneksi internet Anda.',
    );
  }

  if (!response.ok) {
    throw new OsrmRoutingError(
      `Server rute merespons dengan kode ${response.status}. Coba lagi nanti.`,
    );
  }

  const json: OsrmResponse = await response.json();

  if (json.code !== 'Ok' || !json.routes || json.routes.length === 0) {
    throw new OsrmRoutingError(
      'Rute sepeda tidak ditemukan antara titik yang diberikan. Pastikan titik-titik berada di jalan yang dapat dilalui.',
    );
  }

  const primaryRoute = json.routes[0]!;

  // Extract full geometry coordinates.
  const coordinates: RouteCoordinate[] =
    primaryRoute.geometry.coordinates.map(
      ([lng, lat]: [number, number]) => [lng, lat] as RouteCoordinate,
    );

  // Extract step-by-step instructions.
  const steps: OsrmStep[] = [];
  for (const leg of primaryRoute.legs) {
    for (const step of leg.steps) {
      steps.push({
        distanceMeters: step.distance,
        durationSeconds: step.duration,
        name: step.name || 'Tanpa nama',
        maneuverType: step.maneuver.type,
        maneuverModifier: step.maneuver.modifier || '',
        maneuverLocation: [
          step.maneuver.location[0],
          step.maneuver.location[1],
        ] as RouteCoordinate,
      });
    }
  }

  return {
    coordinates,
    distanceMeters: primaryRoute.distance,
    durationSeconds: primaryRoute.duration,
    steps,
  };
}

// --- OSRM JSON Response Types ---

interface OsrmResponse {
  code: string;
  routes: OsrmResponseRoute[];
}

interface OsrmResponseRoute {
  distance: number;
  duration: number;
  geometry: {
    type: string;
    coordinates: [number, number][];
  };
  legs: OsrmResponseLeg[];
}

interface OsrmResponseLeg {
  distance: number;
  duration: number;
  steps: OsrmResponseStep[];
}

interface OsrmResponseStep {
  distance: number;
  duration: number;
  name: string;
  maneuver: {
    type: string;
    modifier?: string;
    location: [number, number];
  };
}
