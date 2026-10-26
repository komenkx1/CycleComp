import {
  DEFAULT_SELF_HOSTED_ELEVATION_URL,
  ElevationLookupError,
  lookupElevations,
} from '../src/domain/routes/search/elevationLookup';
import type { ElevationGridWindow } from '../src/domain/terrain/elevationGrid';

describe('lookupElevations', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('queries self-hosted batch elevation endpoint and preserves valid zero, negative, and null values', async () => {
    global.fetch = jest.fn(async (url, init) => {
      expect(url).toBe(DEFAULT_SELF_HOSTED_ELEVATION_URL);
      expect((init as RequestInit).method).toBe('POST');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.coordinates).toHaveLength(4);
      expect(body.coordinates[0]).toEqual({ longitude: 115.2, latitude: -8.6 });

      return {
        ok: true,
        json: async () => ({
          requestId: 'test-req',
          datasetVersion: 'copernicus-glo-30-v1',
          verticalDatum: 'EGM2008',
          samples: [
            { index: 0, elevationMeters: 0, reason: null },
            { index: 1, elevationMeters: -12.5, reason: null },
            { index: 2, elevationMeters: null, reason: 'nodata' },
            { index: 3, elevationMeters: 785.5, reason: null },
          ],
        }),
      } as Response;
    });

    await expect(lookupElevations([
      [115.2, -8.6],
      [115.201, -8.601],
      [115.202, -8.602],
      [115.203, -8.603],
    ])).resolves.toEqual([0, -12.5, null, 785.5]);
  });

  it('falls back to Open-Meteo when self-hosted endpoint returns 503 or network error', async () => {
    let callCount = 0;
    global.fetch = jest.fn(async (url) => {
      callCount++;
      if (typeof url === 'string' && url.includes('/v1/elevation/batch')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ detail: 'Terrain dataset is not ready' }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ elevation: [100, 150] }),
      } as Response;
    });

    const result = await lookupElevations([
      [115.2, -8.6],
      [115.201, -8.601],
    ]);

    expect(callCount).toBe(2);
    expect(result).toEqual([100, 150]);
  });

  it('falls back to Open-Meteo for uncovered points when self-hosted returns null out_of_coverage', async () => {
    global.fetch = jest.fn(async (url) => {
      if (typeof url === 'string' && url.includes('/v1/elevation/batch')) {
        return {
          ok: true,
          json: async () => ({
            samples: [
              { index: 0, elevationMeters: 500, reason: null },
              { index: 1, elevationMeters: null, reason: 'out_of_coverage' },
            ],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ elevation: [25] }),
      } as Response;
    });

    const result = await lookupElevations([
      [115.2, -8.6],
      [10.0, 50.0],
    ]);

    expect(result).toEqual([500, 25]);
  });

  it('splits Open-Meteo requests into bounded batches of 100 without changing point order', async () => {
    let requestCount = 0;
    global.fetch = jest.fn(async () => {
      const batchNumber = requestCount++;
      return {
        ok: true,
        json: async () => ({
          elevation: batchNumber === 0
            ? Array.from({ length: 100 }, (_, index) => index)
            : [100],
        }),
      } as Response;
    });

    const elevations = await lookupElevations(
      Array.from({ length: 101 }, (_, index) => [115 + index / 1000, -8.6] as [number, number]),
      { primaryElevationUrl: null },
    );

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(elevations).toHaveLength(101);
    expect(elevations[0]).toBe(0);
    expect(elevations[99]).toBe(99);
    expect(elevations[100]).toBe(100);
  });

  it('rejects responses that cannot be aligned to the requested coordinates', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ samples: [{ index: 0, elevationMeters: 12 }] }),
    }) as Response);

    await expect(lookupElevations([[115.2, -8.6], [115.201, -8.6]], { primaryElevationUrl: 'http://test/batch' }))
      .rejects.toBeInstanceOf(ElevationLookupError);
  });

  it('rejects invalid coordinates before making a network request', async () => {
    global.fetch = jest.fn();

    await expect(lookupElevations([[181, -8.6]]))
      .rejects.toBeInstanceOf(ElevationLookupError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses local grid values offline and keeps uncovered terrain unknown', async () => {
    global.fetch = jest.fn();

    await expect(lookupElevations(
      [[115.2, -8.6], [115.21, -8.6], [116, -8.6]],
      {
        offlineGridWindows: [createOfflineGridWindow()],
        allowOnlineFallback: false,
      },
    )).resolves.toEqual([0, -12.5, null]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('only requests uncovered points after local grid sampling', async () => {
    global.fetch = jest.fn(async (url, init) => {
      expect(url).toBe(DEFAULT_SELF_HOSTED_ELEVATION_URL);
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.coordinates).toHaveLength(1);
      expect(body.coordinates[0]).toEqual({ longitude: 116, latitude: -8.6 });

      return {
        ok: true,
        json: async () => ({
          samples: [{ index: 0, elevationMeters: 35, reason: null }],
        }),
      } as Response;
    });

    await expect(lookupElevations(
      [[115.2, -8.6], [115.21, -8.6], [116, -8.6]],
      { offlineGridWindows: [createOfflineGridWindow()] },
    )).resolves.toEqual([0, -12.5, 35]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('uses a valid neighboring grid when another window has nodata at the seam', async () => {
    global.fetch = jest.fn();
    const nodataWindow: ElevationGridWindow = {
      ...createOfflineGridWindow(),
      validityMask: new Uint8Array([0b00000101]),
    };
    const neighboringWindow: ElevationGridWindow = {
      rows: 2,
      columns: 2,
      firstCellLongitude: 115.21,
      firstCellLatitude: -8.6,
      longitudeStep: 0.01,
      latitudeStep: -0.01,
      elevationsMeters: new Float32Array([44, 45, 0, 0]),
      validityMask: new Uint8Array([0b00000001]),
    };

    await expect(lookupElevations([[115.21, -8.6]], {
      offlineGridWindows: [nodataWindow, neighboringWindow],
      allowOnlineFallback: false,
    })).resolves.toEqual([44]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

function createOfflineGridWindow(): ElevationGridWindow {
  return {
    rows: 2,
    columns: 2,
    firstCellLongitude: 115.2,
    firstCellLatitude: -8.6,
    longitudeStep: 0.01,
    latitudeStep: -0.01,
    elevationsMeters: new Float32Array([0, -12.5, 10, 20]),
    validityMask: new Uint8Array([0b00001111]),
  };
}
