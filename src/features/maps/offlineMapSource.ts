import type { GpxRoute, RouteBounds } from '../../domain/routes/gpx/GpxRoute';

export const ONLINE_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
export const CYCLECOMP_VPS_BASE_URL = 'https://168.110.215.60:9443';
export const INDONESIA_MAP_STYLE_URL = `${CYCLECOMP_VPS_BASE_URL}/style-v4.json`;
export const INDONESIA_MAP_SOURCE_ID = 'indonesia-protomaps-20261010-z15-v4';
export const INDONESIA_MAP_BOUNDS: RouteBounds = [
  94.5, -11.5, 141.5, 6.5,
];

// Backwards-compatible aliases
export const OFFLINE_MAP_STYLE_URL = INDONESIA_MAP_STYLE_URL;
export const OFFLINE_MAP_SOURCE_ID = INDONESIA_MAP_SOURCE_ID;
export const OFFLINE_MAP_BOUNDS = INDONESIA_MAP_BOUNDS;

export const JATILUWIH_MAP_STYLE_URL = INDONESIA_MAP_STYLE_URL;
export const JATILUWIH_MAP_SOURCE_ID = INDONESIA_MAP_SOURCE_ID;
export const JATILUWIH_LEGACY_MAP_BOUNDS: RouteBounds = [
  115.1091, -8.69713, 115.24081, -8.339159,
];
export const JATILUWIH_MAP_BOUNDS = INDONESIA_MAP_BOUNDS;

export function routeFitsIndonesiaMap(route: GpxRoute): boolean {
  return boundsContain(INDONESIA_MAP_BOUNDS, route.bounds);
}

export function routeFitsOfflineMap(route: GpxRoute): boolean {
  return boundsContain(INDONESIA_MAP_BOUNDS, route.bounds);
}

export function routeFitsJatiluwihMap(route: GpxRoute): boolean {
  return boundsContain(JATILUWIH_LEGACY_MAP_BOUNDS, route.bounds);
}

export function boundsContain(outerBounds: RouteBounds, innerBounds: RouteBounds): boolean {
  const [west, south, east, north] = innerBounds;
  const [mapWest, mapSouth, mapEast, mapNorth] = outerBounds;

  return (
    west >= mapWest &&
    south >= mapSouth &&
    east <= mapEast &&
    north <= mapNorth
  );
}

export function selectedAreaFromFrameCorners(
  frameCorners: readonly [number, number][],
): RouteBounds | null {
  if (
    frameCorners.length !== 4 ||
    frameCorners.some(([longitude, latitude]) =>
      !Number.isFinite(longitude) || !Number.isFinite(latitude),
    )
  ) {
    return null;
  }

  const longitudes = frameCorners.map(([longitude]) => longitude);
  const latitudes = frameCorners.map(([, latitude]) => latitude);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);

  if (west === east || south === north) {
    return null;
  }

  return [west, south, east, north];
}
