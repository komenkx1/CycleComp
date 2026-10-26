import { gmapsLinkToGpxRoute } from '../src/domain/routes/search/gmapsLinkToGpxRoute';
import type { ElevationGridWindow } from '../src/domain/terrain/elevationGrid';

describe('gmapsLinkToGpxRoute', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('routes the Wheel Co short link using its Google pin without a geocoding request', async () => {
    const wheelCoUrl = 'https://www.google.com/maps?geocode=FUtfe_8dnjveBg%3D%3D;FSN7e_8dhA7eBilz5MjQ5kDSLTF8GSWZB1ej6g%3D%3D&daddr=Wheel+Co+Sepeda+Bali&saddr=-8.6918936,115.2275500';
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      const requestUrl = url.toString();
      if (requestUrl.includes('maps.app.goo.gl')) {
        return { url: wheelCoUrl, text: async () => '' } as Response;
      }
      if (requestUrl.includes('routing.openstreetmap.de/routed-bike')) {
        return { ok: true, json: async () => ({
          code: 'Ok', routes: [{ distance: 2900, duration: 700, legs: [],
            geometry: { type: 'LineString', coordinates: [[115.22755, -8.6918936], [115.216004, -8.684765]] },
          }],
        }) } as Response;
      }
      if (requestUrl.includes('api.open-meteo.com')) {
        return { ok: true, json: async () => ({ elevation: [10, 12] }) } as Response;
      }
      throw new Error(`Unexpected request: ${requestUrl}`);
    });
    const progressSteps: string[] = [];
    await gmapsLinkToGpxRoute('https://maps.app.goo.gl/pmLBwU3K36WZvvPKA?g_st=ic',
      progress => progressSteps.push(progress.step));
    expect(progressSteps).not.toContain('geocoding');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/115.22755,-8.6918936;115.216004,-8.684765?'),
      expect.any(Object),
    );
  });

  it('converts a Google Maps direction URL into a complete GpxRoute', async () => {
    const mockOsrmResponse = {
      code: 'Ok',
      routes: [
        {
          distance: 12500,
          duration: 2700,
          geometry: {
            type: 'LineString',
            coordinates: [
              [115.26, -8.5],
              [115.25, -8.45],
              [115.24, -8.4],
            ],
          },
          legs: [
            {
              distance: 12500,
              duration: 2700,
              steps: [
                {
                  distance: 6000,
                  duration: 1300,
                  name: 'Jalan Raya',
                  maneuver: { type: 'depart', modifier: '', location: [115.26, -8.5] },
                },
                {
                  distance: 6500,
                  duration: 1400,
                  name: 'Jalan Utama',
                  maneuver: { type: 'turn', modifier: 'right', location: [115.25, -8.45] },
                },
              ],
            },
          ],
        },
      ],
    };

    const mockElevationResponse = {
      elevation: [25, 60, 120],
    };

    global.fetch = jest.fn((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('routing.openstreetmap.de/routed-bike')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockOsrmResponse,
        } as any);
      }
      if (urlStr.includes('api.open-meteo.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockElevationResponse,
        } as any);
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
    });

    const progressSteps: string[] = [];
    const route = await gmapsLinkToGpxRoute(
      'https://www.google.com/maps/dir/-8.50,115.26/-8.40,115.24',
      progress => progressSteps.push(progress.step),
    );

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('routing.openstreetmap.de/routed-bike/route/v1/driving/115.26,-8.5;115.24,-8.4'),
      expect.any(Object),
    );
    expect(route).toBeDefined();
    expect(route.name).toBe('-8.500,115.260 → -8.400,115.240');
    expect(route.distanceMeters).toBe(12500);
    expect(route.pointCount).toBe(3);
    expect(route.minimumElevationMeters).toBe(25);
    expect(route.maximumElevationMeters).toBe(120);
    expect(route.segments[0]?.points[0]?.elevationMeters).toBe(25);
    expect(route.segments[0]?.points[2]?.elevationMeters).toBe(120);
    expect(progressSteps).toContain('resolving');
    expect(progressSteps).toContain('routing');
    expect(progressSteps).toContain('elevation');
    expect(progressSteps).toContain('done');
  });

  it('keeps signed and unavailable elevation samples when building a GPX route', async () => {
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      if (url.toString().includes('routing.openstreetmap.de/routed-bike')) {
        return {
          ok: true,
          json: async () => ({
            code: 'Ok',
            routes: [{
              distance: 500,
              duration: 100,
              geometry: {
                type: 'LineString',
                coordinates: [[115.2, -8.6], [115.201, -8.6], [115.202, -8.6]],
              },
              legs: [],
            }],
          }),
        } as Response;
      }
      if (url.toString().includes('api.open-meteo.com')) {
        return { ok: true, json: async () => ({ elevation: [-12, null, 8] }) } as Response;
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    const route = await gmapsLinkToGpxRoute(
      'https://www.google.com/maps/dir/-8.60,115.20/-8.60,115.202',
    );

    expect(route.segments[0]?.points.map(point => point.elevationMeters)).toEqual([-12, null, 8]);
    expect(route.minimumElevationMeters).toBe(-12);
    expect(route.maximumElevationMeters).toBe(8);
    expect(route.elevationPointCount).toBe(2);
  });

  it('builds route elevations from local grids without calling the elevation API', async () => {
    const routeCoordinates = [[115.2, -8.6], [115.21, -8.6]];
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      if (url.toString().includes('routing.openstreetmap.de/routed-bike')) {
        return {
          ok: true,
          json: async () => ({
            code: 'Ok',
            routes: [{ distance: 500, duration: 100, geometry: {
              type: 'LineString', coordinates: routeCoordinates,
            }, legs: [] }],
          }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    const offlineGridWindow: ElevationGridWindow = {
      rows: 2,
      columns: 2,
      firstCellLongitude: 115.2,
      firstCellLatitude: -8.6,
      longitudeStep: 0.01,
      latitudeStep: -0.01,
      elevationsMeters: new Float32Array([0, -12.5, 4, 8]),
      validityMask: new Uint8Array([0b00001111]),
    };
    const route = await gmapsLinkToGpxRoute(
      'https://www.google.com/maps/dir/-8.60,115.20/-8.60,115.21',
      undefined,
      null,
      {
        offlineGridWindows: [offlineGridWindow],
        allowOnlineFallback: false,
      },
    );

    expect(route.segments[0]?.points.map(point => point.elevationMeters)).toEqual([0, -12.5]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('routing.openstreetmap.de/routed-bike'),
      expect.any(Object),
    );
  });
});
