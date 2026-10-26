import type {
  GpxRoute,
  GpxRoutePoint,
  RouteCoordinate,
  TerrainElevationEnrichment,
} from '../../domain/routes/gpx/GpxRoute';
import {
  getTerrainGridPackInventory,
  sampleInstalledTerrainPacks,
  type OfflineTerrainSample,
  type TerrainGridPackInventory,
} from './terrainGridPackService';

type OfflineTerrainLookup = {
  getInventory: () => Promise<TerrainGridPackInventory>;
  sampleCoordinates: (coordinates: RouteCoordinate[]) => Promise<OfflineTerrainSample[]>;
};

const installedTerrainLookup: OfflineTerrainLookup = {
  getInventory: getTerrainGridPackInventory,
  sampleCoordinates: sampleInstalledTerrainPacks,
};

export async function enrichGpxRouteFromOfflineTerrain(
  route: GpxRoute,
  terrainLookup: OfflineTerrainLookup = installedTerrainLookup,
): Promise<GpxRoute> {
  const missingRoutePoints: Array<{
    segmentIndex: number;
    pointIndex: number;
    coordinate: RouteCoordinate;
  }> = [];

  route.segments.forEach((segment, segmentIndex) => {
    segment.points.forEach((routePoint, pointIndex) => {
      if (routePoint.elevationMeters === null) {
        missingRoutePoints.push({
          segmentIndex,
          pointIndex,
          coordinate: routePoint.coordinate,
        });
      }
    });
  });

  if (missingRoutePoints.length === 0) {
    return withEnrichmentStatus(route, {
      status: 'not_needed',
      pointCountLookedUp: 0,
      pointCountAdded: 0,
      pointCountStillUnknown: 0,
      packIDs: [],
      verticalDatums: [],
    });
  }

  let inventory: TerrainGridPackInventory;
  try {
    inventory = await terrainLookup.getInventory();
  } catch (error) {
    return withEnrichmentStatus(route, failedLookupStatus(missingRoutePoints.length, error));
  }

  if (inventory.packs.length === 0) {
    return withEnrichmentStatus(route, {
      status: 'no_pack',
      pointCountLookedUp: 0,
      pointCountAdded: 0,
      pointCountStillUnknown: missingRoutePoints.length,
      packIDs: [],
      verticalDatums: [],
    });
  }

  let terrainSamples: OfflineTerrainSample[];
  try {
    terrainSamples = await terrainLookup.sampleCoordinates(
      missingRoutePoints.map(missingPoint => missingPoint.coordinate),
    );
    if (terrainSamples.length !== missingRoutePoints.length) {
      throw new Error('Jumlah sampel medan tidak cocok dengan titik rute.');
    }
  } catch (error) {
    return withEnrichmentStatus(
      route,
      failedLookupStatus(missingRoutePoints.length, error, true),
    );
  }

  const routeSegments = route.segments.map(segment => ({
    ...segment,
    points: segment.points.slice(),
  }));
  const usedPackIDs = new Set<string>();
  const usedVerticalDatums = new Set<string>();
  let addedPointCount = 0;

  for (let sampleIndex = 0; sampleIndex < missingRoutePoints.length; sampleIndex++) {
    const missingPoint = missingRoutePoints[sampleIndex]!;
    const terrainSample = terrainSamples[sampleIndex]!;
    if (terrainSample.elevationMeters === null) {
      continue;
    }
    if (
      !Number.isFinite(terrainSample.elevationMeters) ||
      !terrainSample.packID ||
      !terrainSample.verticalDatum
    ) {
      return withEnrichmentStatus(route, failedLookupStatus(
        missingRoutePoints.length,
        new Error('Sampel elevasi tidak memiliki provenance yang valid.'),
      ));
    }

    const sourcePoint = routeSegments[missingPoint.segmentIndex]!.points[missingPoint.pointIndex]!;
    if (sourcePoint.elevationMeters !== null) {
      continue;
    }
    routeSegments[missingPoint.segmentIndex]!.points[missingPoint.pointIndex] = {
      ...sourcePoint,
      elevationMeters: terrainSample.elevationMeters,
      elevationSource: 'offline_dem',
      terrainPackID: terrainSample.packID,
      verticalDatum: terrainSample.verticalDatum,
    };
    usedPackIDs.add(terrainSample.packID);
    usedVerticalDatums.add(terrainSample.verticalDatum);
    addedPointCount += 1;
  }

  const enrichment: TerrainElevationEnrichment = {
    status: addedPointCount === missingRoutePoints.length
      ? 'enriched'
      : addedPointCount > 0
        ? 'partial'
        : 'no_coverage',
    pointCountLookedUp: missingRoutePoints.length,
    pointCountAdded: addedPointCount,
    pointCountStillUnknown: missingRoutePoints.length - addedPointCount,
    packIDs: [...usedPackIDs].sort(),
    verticalDatums: [...usedVerticalDatums].sort(),
  };

  return withEnrichmentStatus({ ...route, segments: routeSegments }, enrichment);
}

function failedLookupStatus(
  missingPointCount: number,
  error: unknown,
  lookupWasAttempted = false,
): TerrainElevationEnrichment {
  return {
    status: 'lookup_error',
    pointCountLookedUp: lookupWasAttempted ? missingPointCount : 0,
    pointCountAdded: 0,
    pointCountStillUnknown: missingPointCount,
    packIDs: [],
    verticalDatums: [],
    errorMessage: error instanceof Error ? error.message : 'Lookup elevasi offline gagal.',
  };
}

function withEnrichmentStatus(
  route: GpxRoute,
  terrainElevationEnrichment: TerrainElevationEnrichment,
): GpxRoute {
  const routePoints: GpxRoutePoint[] = route.segments.flatMap(segment => segment.points);
  const availableElevations = routePoints.flatMap(routePoint =>
    routePoint.elevationMeters === null ? [] : [routePoint.elevationMeters],
  );
  let minimumElevationMeters: number | null = null;
  let maximumElevationMeters: number | null = null;
  for (const elevationMeters of availableElevations) {
    minimumElevationMeters = minimumElevationMeters === null
      ? elevationMeters
      : Math.min(minimumElevationMeters, elevationMeters);
    maximumElevationMeters = maximumElevationMeters === null
      ? elevationMeters
      : Math.max(maximumElevationMeters, elevationMeters);
  }

  return {
    ...route,
    terrainElevationEnrichment,
    elevationPointCount: availableElevations.length,
    minimumElevationMeters,
    maximumElevationMeters,
  };
}
