import { createRecordedRouteBack } from '../src/domain/routes/gpx/routeBack';

test('preserves signed recorded elevations and reverses them with the recorded track', () => {
  const routeBack = createRecordedRouteBack([[
    { coordinate: [106, -6], elevationMeters: -12 },
    { coordinate: [106, -5.999], elevationMeters: -8 },
  ]]);

  expect(routeBack?.forwardRoute.minimumElevationMeters).toBe(-12);
  expect(routeBack?.forwardRoute.maximumElevationMeters).toBe(-8);
  expect(routeBack?.returnRoute.segments[0]?.points.map(point => point.elevationMeters)).toEqual([-8, -12]);
});
