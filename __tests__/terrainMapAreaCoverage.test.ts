import {
  boundsCoveredByRegions,
  boundsOverlap,
  terrainMapAreaAvailability,
} from '../src/features/elevation/terrainMapAreaCoverage';
import type { RouteBounds } from '../src/domain/routes/gpx/GpxRoute';

test('recognizes complete coverage supplied by adjacent terrain chunks', () => {
  expect(boundsCoveredByRegions(
    [115, -8, 116, -7],
    [
      [115, -8, 115.5, -7],
      [115.5, -8, 116, -7],
    ],
  )).toBe(true);
});

test('does not call a map area complete when there is a gap between chunks', () => {
  expect(boundsCoveredByRegions(
    [115, -8, 116, -7],
    [
      [115, -8, 115.4, -7],
      [115.6, -8, 116, -7],
    ],
  )).toBe(false);
});

test('classifies installed, downloadable, partial, and unavailable map areas', () => {
  const requestedArea: RouteBounds = [115.1, -8.6, 115.2, -8.5];
  expect(terrainMapAreaAvailability(requestedArea, [[115, -9, 116, -8]], [])).toBe('installed');
  expect(terrainMapAreaAvailability(requestedArea, [], [[115, -9, 116, -8]])).toBe('available');
  expect(terrainMapAreaAvailability(requestedArea, [], [[115.1, -8.6, 115.15, -8.5]])).toBe('partial');
  expect(terrainMapAreaAvailability(requestedArea, [], [[116, -9, 117, -8]])).toBe('unavailable');
});

test('bounds touching at an edge do not count as overlapping', () => {
  expect(boundsOverlap([115, -8, 116, -7], [116, -8, 117, -7])).toBe(false);
});

