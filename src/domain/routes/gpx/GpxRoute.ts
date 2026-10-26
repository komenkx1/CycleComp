import type { Feature, MultiLineString } from 'geojson';

export type RouteCoordinate = [longitude: number, latitude: number];
export type RouteBounds = [
  west: number,
  south: number,
  east: number,
  north: number,
];

export type RouteElevationSource = 'gpx_file' | 'offline_dem';

export type TerrainElevationEnrichment = {
  status: 'not_needed' | 'enriched' | 'partial' | 'no_pack' | 'no_coverage' | 'lookup_error';
  pointCountLookedUp: number;
  pointCountAdded: number;
  pointCountStillUnknown: number;
  packIDs: string[];
  verticalDatums: string[];
  errorMessage?: string;
};

export interface GpxRoutePoint {
  coordinate: RouteCoordinate;
  elevationMeters: number | null;
  elevationSource?: RouteElevationSource;
  terrainPackID?: string;
  verticalDatum?: string;
}

export interface GpxRouteSegment {
  points: GpxRoutePoint[];
}

export interface GpxRoute {
  name: string;
  sourceFileName: string;
  segments: GpxRouteSegment[];
  bounds: RouteBounds;
  distanceMeters: number;
  pointCount: number;
  elevationPointCount: number;
  minimumElevationMeters: number | null;
  maximumElevationMeters: number | null;
  terrainElevationEnrichment?: TerrainElevationEnrichment;
}

export function buildRouteLineFeature(
  route: GpxRoute,
): Feature<MultiLineString> {
  return {
    type: 'Feature',
    properties: {
      name: route.name,
    },
    geometry: {
      type: 'MultiLineString',
      coordinates: route.segments.map(segment =>
        segment.points.map(routePoint => routePoint.coordinate),
      ),
    },
  };
}
