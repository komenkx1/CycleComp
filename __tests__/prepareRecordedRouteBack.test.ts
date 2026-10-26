import type { GpxRoute } from '../src/domain/routes/gpx/GpxRoute';
import { prepareRecordedRouteBack } from '../src/features/routes/prepareRecordedRouteBack';

describe('prepareRecordedRouteBack', () => {
  it('fills only missing elevations before reversing the recorded route', async () => {
    const enrichRoute = jest.fn(async (route: GpxRoute): Promise<GpxRoute> => ({
      ...route,
      segments: [{
        points: [
          {
            ...route.segments[0]!.points[0]!,
            elevationMeters: -14,
            elevationSource: 'offline_dem',
            terrainPackID: 'jatiluwih-v1',
            verticalDatum: 'EGM2008',
          },
          route.segments[0]!.points[1]!,
        ],
      }],
    }));

    const routeBack = await prepareRecordedRouteBack([[
      { coordinate: [115.2, -8.65], elevationMeters: null },
      { coordinate: [115.2, -8.6495], elevationMeters: 0 },
    ]], enrichRoute);

    expect(enrichRoute).toHaveBeenCalledTimes(1);
    expect(routeBack?.forwardRoute.segments[0]?.points.map(point => point.elevationMeters)).toEqual([-14, 0]);
    expect(routeBack?.forwardRoute.segments[0]?.points[0]).toMatchObject({
      elevationSource: 'offline_dem',
      terrainPackID: 'jatiluwih-v1',
      verticalDatum: 'EGM2008',
    });
    expect(routeBack?.returnRoute.segments[0]?.points.map(point => point.elevationMeters)).toEqual([0, -14]);
    expect(routeBack?.returnRoute.segments[0]?.points[1]).toMatchObject({
      elevationSource: 'offline_dem',
      terrainPackID: 'jatiluwih-v1',
      verticalDatum: 'EGM2008',
    });
  });

  it('keeps an insufficient recording unavailable for Route Back', async () => {
    const enrichRoute = jest.fn(async (route: GpxRoute) => route);

    const routeBack = await prepareRecordedRouteBack([[
      { coordinate: [115.2, -8.65], elevationMeters: null },
      { coordinate: [115.2, -8.6499], elevationMeters: null },
    ]], enrichRoute);

    expect(routeBack).toBeNull();
    expect(enrichRoute).not.toHaveBeenCalled();
  });
});
