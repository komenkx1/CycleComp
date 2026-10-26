import type {
  GpxRoute,
  GpxRoutePoint,
  GpxRouteSegment,
  RouteBounds,
  RouteCoordinate,
} from './GpxRoute';
import { distanceBetweenCoords } from '../elevation/routeElevationAnalysis';

const MINIMUM_ROUTE_BACK_DISTANCE_METERS = 30;

export interface RecordedRoutePoint {
  coordinate: RouteCoordinate;
  elevationMeters: number | null;
}

export function reverseRouteForReturn(route: GpxRoute): GpxRoute {
  const reversedSegments = [...route.segments]
    .reverse()
    .map(reverseRouteSegment);

  return {
    ...route,
    name: `Kembali ke awal · ${route.name}`,
    segments: reversedSegments,
  };
}

export function createRecordedRouteBack(
  recordedTrackSegments: RecordedRoutePoint[][],
): { forwardRoute: GpxRoute; returnRoute: GpxRoute } | null {
  const routeSegments = recordedTrackSegments
    .filter(trackSegment => trackSegment.length >= 2)
    .map(trackSegment => ({
      points: trackSegment,
    }));
  const routePoints = routeSegments.flatMap(segment => segment.points);

  if (routePoints.length < 2) {
    return null;
  }

  const routeBounds = getRouteBounds(routePoints);
  const routeDistanceMeters = getRouteDistance(routeSegments);
  const elevationRange = routePoints.reduce(
    (range, point) => point.elevationMeters === null ? range : ({
      count: range.count + 1,
      minimum: Math.min(range.minimum, point.elevationMeters),
      maximum: Math.max(range.maximum, point.elevationMeters),
    }),
    { count: 0, minimum: Infinity, maximum: -Infinity },
  );

  if (routeDistanceMeters < MINIMUM_ROUTE_BACK_DISTANCE_METERS) {
    return null;
  }

  const forwardRoute: GpxRoute = {
    name: 'Ride bebas',
    sourceFileName: 'ride-bebas.gpx',
    segments: routeSegments,
    bounds: routeBounds,
    distanceMeters: routeDistanceMeters,
    pointCount: routePoints.length,
    elevationPointCount: elevationRange.count,
    minimumElevationMeters: elevationRange.count > 0 ? elevationRange.minimum : null,
    maximumElevationMeters: elevationRange.count > 0 ? elevationRange.maximum : null,
  };

  return {
    forwardRoute,
    returnRoute: reverseRouteForReturn(forwardRoute),
  };
}

function reverseRouteSegment(segment: GpxRouteSegment): GpxRouteSegment {
  return { points: [...segment.points].reverse() };
}

function getRouteBounds(routePoints: GpxRoutePoint[]): RouteBounds {
  let minimumLongitude = Infinity;
  let minimumLatitude = Infinity;
  let maximumLongitude = -Infinity;
  let maximumLatitude = -Infinity;

  for (const point of routePoints) {
    const [longitude, latitude] = point.coordinate;
    minimumLongitude = Math.min(minimumLongitude, longitude);
    minimumLatitude = Math.min(minimumLatitude, latitude);
    maximumLongitude = Math.max(maximumLongitude, longitude);
    maximumLatitude = Math.max(maximumLatitude, latitude);
  }

  return [minimumLongitude, minimumLatitude, maximumLongitude, maximumLatitude];
}

function getRouteDistance(routeSegments: GpxRouteSegment[]): number {
  let totalDistanceMeters = 0;

  for (const segment of routeSegments) {
    for (let index = 1; index < segment.points.length; index++) {
      totalDistanceMeters += distanceBetweenCoords(
        segment.points[index - 1].coordinate,
        segment.points[index].coordinate,
      );
    }
  }

  return totalDistanceMeters;
}
