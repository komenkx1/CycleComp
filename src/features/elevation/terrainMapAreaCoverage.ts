import type { RouteBounds } from '../../domain/routes/gpx/GpxRoute';

export type TerrainMapAreaAvailability = 'installed' | 'available' | 'partial' | 'unavailable';

export function terrainMapAreaAvailability(
  mapAreaBounds: RouteBounds,
  installedTerrainBounds: RouteBounds[],
  availableTerrainBounds: RouteBounds[],
  partialTerrainBounds: RouteBounds[] = [],
): TerrainMapAreaAvailability {
  if (boundsCoveredByRegions(mapAreaBounds, installedTerrainBounds)) {
    return 'installed';
  }
  if (boundsCoveredByRegions(mapAreaBounds, availableTerrainBounds)) {
    return 'available';
  }
  if ([...installedTerrainBounds, ...availableTerrainBounds, ...partialTerrainBounds]
    .some(bounds => boundsOverlap(mapAreaBounds, bounds))) {
    return 'partial';
  }
  return 'unavailable';
}

export function boundsOverlap(firstBounds: RouteBounds, secondBounds: RouteBounds): boolean {
  const [firstWest, firstSouth, firstEast, firstNorth] = firstBounds;
  const [secondWest, secondSouth, secondEast, secondNorth] = secondBounds;
  return firstWest < secondEast && firstEast > secondWest &&
    firstSouth < secondNorth && firstNorth > secondSouth;
}

export function boundsCoveredByRegions(
  targetBounds: RouteBounds,
  coverageRegions: RouteBounds[],
): boolean {
  const [targetWest, targetSouth, targetEast, targetNorth] = targetBounds;
  if (targetWest >= targetEast || targetSouth >= targetNorth || coverageRegions.length === 0) {
    return false;
  }

  const intersectingRegions = coverageRegions
    .filter(region => boundsOverlap(targetBounds, region))
    .map(region => [
      Math.max(targetWest, region[0]),
      Math.max(targetSouth, region[1]),
      Math.min(targetEast, region[2]),
      Math.min(targetNorth, region[3]),
    ] as RouteBounds);
  if (intersectingRegions.length === 0) {
    return false;
  }

  const longitudeCuts = [...new Set([
    targetWest,
    targetEast,
    ...intersectingRegions.flatMap(region => [region[0], region[2]]),
  ])].sort((firstLongitude, secondLongitude) => firstLongitude - secondLongitude);

  for (let cutIndex = 0; cutIndex < longitudeCuts.length - 1; cutIndex += 1) {
    const stripWest = longitudeCuts[cutIndex]!;
    const stripEast = longitudeCuts[cutIndex + 1]!;
    if (stripWest >= stripEast) {
      continue;
    }

    const stripCenter = (stripWest + stripEast) / 2;
    const latitudeIntervals = intersectingRegions
      .filter(region => region[0] <= stripCenter && region[2] >= stripCenter)
      .map(region => [region[1], region[3]] as const)
      .sort((firstInterval, secondInterval) => firstInterval[0] - secondInterval[0]);

    let coveredNorth = targetSouth;
    for (const [intervalSouth, intervalNorth] of latitudeIntervals) {
      if (intervalSouth > coveredNorth) {
        break;
      }
      coveredNorth = Math.max(coveredNorth, intervalNorth);
      if (coveredNorth >= targetNorth) {
        break;
      }
    }
    if (coveredNorth < targetNorth) {
      return false;
    }
  }

  return true;
}
