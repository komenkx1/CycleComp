import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import type { GpxRoute } from '../../../src/domain/routes/gpx/GpxRoute.ts';
import {
  analyzeRouteElevation,
  ROUTE_ELEVATION_PROFILE_ALGORITHM_VERSION,
} from '../../../src/domain/routes/elevation/routeElevationAnalysis.ts';

type ProfileInputPoint = {
  longitude: number;
  latitude: number;
  distanceMeters: number;
  elevationMeters: number | null;
  terrainElevationMeters: number | null;
  sourceReason: string | null;
  qualityFlags: string[];
};

type RoadProfileRequest = {
  profileId: number;
  points: ProfileInputPoint[];
  roadSurfaceSupported: boolean;
};

const inputLines = createInterface({ input: stdin, crlfDelay: Infinity });

for await (const inputLine of inputLines) {
  try {
    const profileRequest = JSON.parse(inputLine) as RoadProfileRequest;
    const profileResult = analyzeRoadProfile(profileRequest);
    stdout.write(`${JSON.stringify(profileResult)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    break;
  }
}

function analyzeRoadProfile(profileRequest: RoadProfileRequest) {
  validateProfileRequest(profileRequest);
  const routePoints = profileRequest.points.map(point => ({
    coordinate: [point.longitude, point.latitude] as [number, number],
    elevationMeters: point.elevationMeters,
    elevationSource: 'offline_dem' as const,
  }));
  const longitudes = routePoints.map(point => point.coordinate[0]);
  const latitudes = routePoints.map(point => point.coordinate[1]);
  const sourceElevations = routePoints.flatMap(point =>
    point.elevationMeters === null ? [] : [point.elevationMeters],
  );
  const route: GpxRoute = {
    name: `OSM profile ${profileRequest.profileId}`,
    sourceFileName: 'osm-pbf',
    segments: [{ points: routePoints }],
    bounds: [
      Math.min(...longitudes),
      Math.min(...latitudes),
      Math.max(...longitudes),
      Math.max(...latitudes),
    ],
    distanceMeters: profileRequest.points.at(-1)?.distanceMeters ?? 0,
    pointCount: routePoints.length,
    elevationPointCount: sourceElevations.length,
    minimumElevationMeters: sourceElevations.length > 0 ? Math.min(...sourceElevations) : null,
    maximumElevationMeters: sourceElevations.length > 0 ? Math.max(...sourceElevations) : null,
  };
  // Connecting sparse profile coordinates would shorten bends and shift surface boundaries.
  const elevationAnalysis = analyzeRouteElevation(
    route,
    [profileRequest.points.map(point => point.distanceMeters)],
  );

  return {
    profileId: profileRequest.profileId,
    profileAlgorithmVersion: ROUTE_ELEVATION_PROFILE_ALGORITHM_VERSION,
    validSampleCount: route.elevationPointCount,
    samples: elevationAnalysis.samples.map(sample => {
      const closestSourcePoint = findClosestSourcePoint(
        sample.distanceMeters,
        profileRequest.points,
      );
      const hasRoadSurfaceProfile = profileRequest.roadSurfaceSupported;
      const profileElevationMeters = hasRoadSurfaceProfile
        ? sample.elevationMeters
        : null;
      const gradePercent = hasRoadSurfaceProfile ? sample.gradePercent : null;
      const qualityFlags = [...closestSourcePoint.qualityFlags];

      if (!hasRoadSurfaceProfile && !qualityFlags.includes('structure_surface_unknown')) {
        qualityFlags.push('structure_surface_unknown');
      }
      if (sample.elevationMeters === null) {
        const unavailableReason = closestSourcePoint.sourceReason ?? 'elevation_unknown';
        if (!qualityFlags.includes(unavailableReason)) qualityFlags.push(unavailableReason);
      }
      if (gradePercent === null) qualityFlags.push('grade_unavailable');

      return {
        distanceMeters: sample.distanceMeters,
        longitude: sample.coordinate[0],
        latitude: sample.coordinate[1],
        terrainElevationMeters: closestSourcePoint.terrainElevationMeters,
        profileElevationMeters,
        gradePercent,
        sourceReason: closestSourcePoint.sourceReason,
        qualityFlags,
      };
    }),
    climbs: profileRequest.roadSurfaceSupported
      ? elevationAnalysis.climbs.map(climb => ({
          climbIndex: climb.id,
          startDistanceMeters: climb.startDistanceMeters,
          endDistanceMeters: climb.endDistanceMeters,
          distanceMeters: climb.distanceMeters,
          netRiseMeters: climb.netRiseMeters ??
            ((climb.endElevationMeters ?? 0) - (climb.startElevationMeters ?? 0)),
          ascentMeters: climb.ascentMeters ?? climb.elevationGainMeters,
          descentMeters: climb.descentMeters ?? 0,
          averageGradePercent: climb.averageGradePercent,
          maxGradePercent: climb.maxGradePercent,
          startElevationMeters: climb.startElevationMeters,
          endElevationMeters: climb.endElevationMeters,
        }))
      : [],
  };
}

function validateProfileRequest(profileRequest: RoadProfileRequest): void {
  if (
    !Number.isInteger(profileRequest.profileId) ||
    typeof profileRequest.roadSurfaceSupported !== 'boolean' ||
    !Array.isArray(profileRequest.points) ||
    profileRequest.points.length < 2
  ) {
    throw new Error('road profile request has invalid metadata or too few points');
  }

  let previousDistanceMeters = -1;
  for (const point of profileRequest.points) {
    if (
      !Number.isFinite(point.longitude) ||
      !Number.isFinite(point.latitude) ||
      point.longitude < -180 ||
      point.longitude > 180 ||
      point.latitude < -90 ||
      point.latitude > 90 ||
      !Number.isFinite(point.distanceMeters) ||
      point.distanceMeters < previousDistanceMeters ||
      (point.elevationMeters !== null && !Number.isFinite(point.elevationMeters)) ||
      (point.terrainElevationMeters !== null && !Number.isFinite(point.terrainElevationMeters)) ||
      (point.sourceReason !== null && typeof point.sourceReason !== 'string') ||
      !Array.isArray(point.qualityFlags) ||
      point.qualityFlags.some(flag => typeof flag !== 'string')
    ) {
      throw new Error(`road profile request contains an invalid point for profile ${profileRequest.profileId}`);
    }
    previousDistanceMeters = point.distanceMeters;
  }
}

function findClosestSourcePoint(
  distanceMeters: number,
  sourcePoints: ProfileInputPoint[],
): ProfileInputPoint {
  let lowIndex = 0;
  let highIndex = sourcePoints.length - 1;

  while (lowIndex < highIndex) {
    const middleIndex = Math.floor((lowIndex + highIndex) / 2);
    const middlePoint = sourcePoints[middleIndex];
    if (!middlePoint || middlePoint.distanceMeters < distanceMeters) {
      lowIndex = middleIndex + 1;
    } else {
      highIndex = middleIndex;
    }
  }

  const upperPoint = sourcePoints[lowIndex];
  const lowerPoint = sourcePoints[Math.max(0, lowIndex - 1)];
  if (!upperPoint || !lowerPoint) {
    throw new Error('road profile sample could not be matched to its source elevation');
  }
  return Math.abs(upperPoint.distanceMeters - distanceMeters) <
    Math.abs(lowerPoint.distanceMeters - distanceMeters)
    ? upperPoint
    : lowerPoint;
}
