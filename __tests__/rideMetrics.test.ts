import { calculateAverageSpeedKmh } from '../src/domain/ride/rideMetrics';

test('calculates average speed from distance and moving time', () => {
  expect(calculateAverageSpeedKmh(2_500, 1_500)).toBe(6);
});

test('does not report average speed without distance or moving time', () => {
  expect(calculateAverageSpeedKmh(0, 1_500)).toBeNull();
  expect(calculateAverageSpeedKmh(2_500, 0)).toBeNull();
  expect(calculateAverageSpeedKmh(null, 1_500)).toBeNull();
  expect(calculateAverageSpeedKmh(2_500, Number.NaN)).toBeNull();
});

