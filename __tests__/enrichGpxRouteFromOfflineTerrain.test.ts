import type { GpxRoute } from '../src/domain/routes/gpx/GpxRoute';

jest.mock('@react-native-documents/picker', () => ({
  errorCodes: { OPERATION_CANCELED: 'OPERATION_CANCELED' },
  isErrorWithCode: () => false,
  pickDirectory: jest.fn(),
}));

import {
  enrichGpxRouteFromOfflineTerrain,
} from '../src/features/elevation/enrichGpxRouteFromOfflineTerrain';
import type { TerrainGridPackInventory } from '../src/features/elevation/terrainGridPackService';

const routeWithoutCompleteElevation: GpxRoute = {
  name: 'Jalur uji',
  sourceFileName: 'jalur.gpx',
  segments: [{
    points: [
      {
        coordinate: [115, -8],
        elevationMeters: 0,
        elevationSource: 'gpx_file',
      },
      { coordinate: [115.001, -8], elevationMeters: null },
      { coordinate: [115.002, -8], elevationMeters: null },
    ],
  }],
  bounds: [115, -8, 115.002, -8],
  distanceMeters: 220,
  pointCount: 3,
  elevationPointCount: 1,
  minimumElevationMeters: 0,
  maximumElevationMeters: 0,
};

const installedTerrainInventory: TerrainGridPackInventory = {
  packs: [{
    packID: 'bali-pilot-1',
    schemaVersion: 1,
    requestedBoundsWgs84: [114, -9, 116, -7],
    verticalDatum: 'EGM2008',
    signatureStatus: 'signed',
    signatureKeyID: 'release-1',
  }],
  unavailablePackageCount: 0,
  trustedSigningKeyCount: 1,
  allowUnsignedPilot: false,
};

describe('enrichGpxRouteFromOfflineTerrain', () => {
  it('skips native lookup when the GPX already has elevation for every point', async () => {
    const getInventory = jest.fn();
    const sampleCoordinates = jest.fn();
    const completeRoute: GpxRoute = {
      ...routeWithoutCompleteElevation,
      segments: [{
        points: routeWithoutCompleteElevation.segments[0]!.points.slice(0, 1),
      }],
      pointCount: 1,
    };

    const enrichedRoute = await enrichGpxRouteFromOfflineTerrain(completeRoute, {
      getInventory,
      sampleCoordinates,
    });

    expect(getInventory).not.toHaveBeenCalled();
    expect(sampleCoordinates).not.toHaveBeenCalled();
    expect(enrichedRoute.terrainElevationEnrichment?.status).toBe('not_needed');
  });

  it('fills missing values from a local pack and preserves existing zero elevation', async () => {
    const sampleCoordinates = jest.fn().mockResolvedValue([
      { elevationMeters: -12, packID: 'bali-pilot-1', verticalDatum: 'EGM2008' },
      { elevationMeters: null, packID: null, verticalDatum: null },
    ]);

    const enrichedRoute = await enrichGpxRouteFromOfflineTerrain(
      routeWithoutCompleteElevation,
      {
        getInventory: async () => installedTerrainInventory,
        sampleCoordinates,
      },
    );

    expect(sampleCoordinates).toHaveBeenCalledWith([
      [115.001, -8],
      [115.002, -8],
    ]);
    expect(enrichedRoute.segments[0]?.points.map(point => point.elevationMeters)).toEqual([
      0,
      -12,
      null,
    ]);
    expect(enrichedRoute.segments[0]?.points[1]).toMatchObject({
      elevationSource: 'offline_dem',
      terrainPackID: 'bali-pilot-1',
      verticalDatum: 'EGM2008',
    });
    expect(enrichedRoute.elevationPointCount).toBe(2);
    expect(enrichedRoute.minimumElevationMeters).toBe(-12);
    expect(enrichedRoute.maximumElevationMeters).toBe(0);
    expect(enrichedRoute.terrainElevationEnrichment).toMatchObject({
      status: 'partial',
      pointCountLookedUp: 2,
      pointCountAdded: 1,
      pointCountStillUnknown: 1,
      packIDs: ['bali-pilot-1'],
      verticalDatums: ['EGM2008'],
    });
  });

  it('leaves missing values unknown when no local pack is installed', async () => {
    const sampleCoordinates = jest.fn();
    const enrichedRoute = await enrichGpxRouteFromOfflineTerrain(
      routeWithoutCompleteElevation,
      {
        getInventory: async () => ({
          ...installedTerrainInventory,
          packs: [],
        }),
        sampleCoordinates,
      },
    );

    expect(sampleCoordinates).not.toHaveBeenCalled();
    expect(enrichedRoute.segments[0]?.points[1]?.elevationMeters).toBeNull();
    expect(enrichedRoute.terrainElevationEnrichment?.status).toBe('no_pack');
  });

  it('reports uncovered points without substituting a zero elevation', async () => {
    const enrichedRoute = await enrichGpxRouteFromOfflineTerrain(
      routeWithoutCompleteElevation,
      {
        getInventory: async () => installedTerrainInventory,
        sampleCoordinates: async coordinates => coordinates.map(() => ({
          elevationMeters: null,
          packID: null,
          verticalDatum: null,
        })),
      },
    );

    expect(enrichedRoute.segments[0]?.points.map(point => point.elevationMeters)).toEqual([
      0,
      null,
      null,
    ]);
    expect(enrichedRoute.terrainElevationEnrichment).toMatchObject({
      status: 'no_coverage',
      pointCountAdded: 0,
      pointCountStillUnknown: 2,
    });
  });

  it('keeps the route importable when the local pack lookup fails', async () => {
    const enrichedRoute = await enrichGpxRouteFromOfflineTerrain(
      routeWithoutCompleteElevation,
      {
        getInventory: async () => { throw new Error('Reader unavailable'); },
        sampleCoordinates: jest.fn(),
      },
    );

    expect(enrichedRoute.segments[0]?.points[1]?.elevationMeters).toBeNull();
    expect(enrichedRoute.terrainElevationEnrichment).toMatchObject({
      status: 'lookup_error',
      pointCountStillUnknown: 2,
      errorMessage: 'Reader unavailable',
    });
  });
});
