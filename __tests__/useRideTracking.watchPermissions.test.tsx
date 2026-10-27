import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

import { useRideTracking } from '../src/features/ride/useRideTracking';

jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  NativeEventEmitter: jest.fn().mockImplementation(() => ({ addListener: jest.fn(() => ({ remove: jest.fn() })) })),
  NativeModules: {
    RideTracking: {
      getRideState: jest.fn().mockResolvedValue({ status: 'idle' }),
      setKeepScreenOn: jest.fn().mockResolvedValue(true),
      setWatchHeartRateEnabled: jest.fn().mockResolvedValue({ status: 'idle', watchHeartRateEnabled: true }),
      startRide: jest.fn().mockResolvedValue({ status: 'active' }),
    },
  },
  PermissionsAndroid: {
    PERMISSIONS: {
      BLUETOOTH_SCAN: 'android.permission.BLUETOOTH_SCAN',
      BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT',
      ACCESS_FINE_LOCATION: 'android.permission.ACCESS_FINE_LOCATION',
      ACCESS_COARSE_LOCATION: 'android.permission.ACCESS_COARSE_LOCATION',
      ACTIVITY_RECOGNITION: 'android.permission.ACTIVITY_RECOGNITION',
      POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS',
    },
    RESULTS: { GRANTED: 'granted', DENIED: 'denied' },
    requestMultiple: jest.fn(),
  },
  Platform: { OS: 'android', Version: 33 },
}));

describe('Watch 5 Android permission', () => {
  let hook: ReturnType<typeof useRideTracking>;
  let renderer: ReactTestRenderer.ReactTestRenderer;

  function RideProbe() {
    hook = useRideTracking();
    return null;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.assign(Platform, { OS: 'android', Version: 33 });
    await act(async () => { renderer = ReactTestRenderer.create(<RideProbe />); });
  });

  afterEach(async () => {
    await act(async () => { renderer.unmount(); });
  });

  it('requests nearby-device permissions before enabling on Android 12 and later', async () => {
    (PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue({
      [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN]: 'granted',
      [PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]: 'granted',
    });
    await act(async () => { await hook.setWatchHeartRateEnabled(true); });
    expect(PermissionsAndroid.requestMultiple).toHaveBeenCalledWith([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    expect(NativeModules.RideTracking.setWatchHeartRateEnabled).toHaveBeenCalledWith(true);
    expect(hook.watchPermissionError).toBeNull();
  });

  it('keeps the watch disabled and explains a denied permission', async () => {
    (PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue({
      [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN]: 'granted',
      [PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]: 'denied',
    });
    await act(async () => { await hook.setWatchHeartRateEnabled(true); });
    expect(NativeModules.RideTracking.setWatchHeartRateEnabled).not.toHaveBeenCalled();
    expect(hook.watchPermissionError).toContain('perangkat di sekitar');
  });

  it('requests location on Android 11 and earlier', async () => {
    Object.assign(Platform, { Version: 30 });
    (PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue({
      [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]: 'granted',
    });
    await act(async () => { await hook.setWatchHeartRateEnabled(true); });
    expect(PermissionsAndroid.requestMultiple).toHaveBeenCalledWith([PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]);
    expect(NativeModules.RideTracking.setWatchHeartRateEnabled).toHaveBeenCalledWith(true);
  });

  it('does not request permission when disabling or on iOS', async () => {
    await act(async () => { await hook.setWatchHeartRateEnabled(false); });
    expect(PermissionsAndroid.requestMultiple).not.toHaveBeenCalled();
    expect(NativeModules.RideTracking.setWatchHeartRateEnabled).toHaveBeenCalledWith(false);
    Object.assign(Platform, { OS: 'ios' });
    await act(async () => { await hook.setWatchHeartRateEnabled(true); });
    expect(PermissionsAndroid.requestMultiple).not.toHaveBeenCalled();
    expect(NativeModules.RideTracking.setWatchHeartRateEnabled).toHaveBeenCalledWith(true);
  });

  it('continues GPS recording when optional activity recognition is denied', async () => {
    (PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue({
      [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]: 'granted',
      [PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION]: 'denied',
    });
    await act(async () => { await hook.startRide(); });
    expect(NativeModules.RideTracking.startRide).toHaveBeenCalled();
    expect(hook.rideSnapshot.status).toBe('active');
  });
});
