import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { NativeModules } from 'react-native';

import { useRideTracking } from '../src/features/ride/useRideTracking';

const mockRideListeners: Record<string, (event: unknown) => void> = {};

jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: jest.fn((name: string, listener: (event: unknown) => void) => {
      mockRideListeners[name] = listener;
      return { remove: jest.fn() };
    }),
  })),
  NativeModules: {
    RideTracking: {
      getRideState: jest.fn().mockResolvedValue({ status: 'active', trackSegments: [] }),
      setKeepScreenOn: jest.fn().mockResolvedValue(true),
    },
  },
  PermissionsAndroid: {},
  Platform: { OS: 'android', Version: 36 },
}));

it('replaces the displayed track when native recording backfills a segment', async () => {
  let ride: ReturnType<typeof useRideTracking>;
  function RideProbe() {
    ride = useRideTracking();
    return null;
  }

  let renderer: ReactTestRenderer.ReactTestRenderer;
  await act(async () => { renderer = ReactTestRenderer.create(<RideProbe />); });
  await act(async () => {
    mockRideListeners.RideTrackingSnapshot({ status: 'active', newCoordinate: [115, -8], newSegment: true });
  });
  expect(ride!.trackSegments).toEqual([[[115, -8]]]);

  const backfilledSegments = [[[115, -8]], [[115.001, -8], [115.002, -8]]];
  await act(async () => {
    mockRideListeners.RideTrackingSnapshot({ status: 'active', trackSegments: backfilledSegments });
  });
  expect(ride!.trackSegments).toEqual(backfilledSegments);
  await act(async () => { renderer!.unmount(); });
});

it('shows an unreadable checkpoint error without treating it as an idle ride', async () => {
  const message = 'Checkpoint perjalanan tidak dapat dibaca. Data tersimpan dipertahankan.';
  (NativeModules.RideTracking.getRideState as jest.Mock).mockResolvedValueOnce({
    status: 'recoveryNeeded',
    recordingErrorMessage: message,
  });
  let ride: ReturnType<typeof useRideTracking>;
  function RideProbe() {
    ride = useRideTracking();
    return null;
  }

  let renderer: ReactTestRenderer.ReactTestRenderer;
  await act(async () => { renderer = ReactTestRenderer.create(<RideProbe />); });
  expect(ride!.rideSnapshot.status).toBe('recoveryNeeded');
  expect(ride!.rideError).toBe(message);
  await act(async () => { renderer!.unmount(); });
});
