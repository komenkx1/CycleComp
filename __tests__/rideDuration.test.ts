import { rideDurationSeconds, rideElapsedSeconds } from '../src/domain/ride/rideDuration';

const snapshotAt = Date.parse('2026-10-13T08:00:00Z');
const ride = { status: 'active', durationSeconds: 600, durationUpdatedAt: new Date(snapshotAt).toISOString() };

test('interpolates only active time since the native snapshot', () => {
  expect(rideDurationSeconds(ride, snapshotAt + 30000)).toBe(630);
});

test.each(['paused', 'recoveryNeeded', 'finished'])('freezes duration while %s', status => {
  expect(rideDurationSeconds({ ...ride, status }, snapshotAt + 3600000)).toBe(600);
});

test('resume uses the accumulated active duration and a new snapshot anchor', () => {
  const resumedAt = snapshotAt + 3600000;
  expect(rideDurationSeconds({ ...ride, durationUpdatedAt: new Date(resumedAt).toISOString() }, resumedAt + 10000)).toBe(610);
});

test('does not subtract time on a future timestamp or produce NaN', () => {
  expect(rideDurationSeconds(ride, snapshotAt - 10000)).toBe(600);
  expect(rideDurationSeconds({ ...ride, durationUpdatedAt: 'invalid' })).toBe(600);
});

test('keeps elapsed time running while the active timer is auto-paused', () => {
  const startedAt = new Date(snapshotAt - 600_000).toISOString();
  const rideSnapshot = {
    status: 'active',
    startedAt,
    durationSeconds: 500,
    elapsedSeconds: 600,
  };

  expect(rideDurationSeconds(rideSnapshot, snapshotAt)).toBe(500);
  expect(rideElapsedSeconds(rideSnapshot, snapshotAt)).toBe(600);
  expect(rideElapsedSeconds(rideSnapshot, snapshotAt + 30_000)).toBe(630);
});

test('keeps elapsed time running through a manual pause', () => {
  const pausedRide = {
    status: 'paused',
    startedAt: new Date(snapshotAt - 600_000).toISOString(),
    durationSeconds: 500,
    elapsedSeconds: 600,
  };

  expect(rideDurationSeconds(pausedRide, snapshotAt + 30_000)).toBe(500);
  expect(rideElapsedSeconds(pausedRide, snapshotAt + 30_000)).toBe(630);
});

test('freezes elapsed time at the recorded finish timestamp', () => {
  const rideSnapshot = {
    status: 'finished',
    startedAt: '2026-10-13T08:00:00Z',
    finishedAt: '2026-10-13T08:25:00Z',
  };

  expect(rideElapsedSeconds(rideSnapshot, snapshotAt + 3_600_000)).toBe(1500);
});
