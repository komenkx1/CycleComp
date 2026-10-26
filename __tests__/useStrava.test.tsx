import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Linking, NativeModules } from 'react-native';

import type { SavedRideFile } from '../src/features/ride/useRideTracking';
import { useStrava } from '../src/features/strava/useStrava';

describe('useStrava hook', () => {
  let mockStorageData: Record<string, unknown> = {};
  let hookResult: ReturnType<typeof useStrava> | undefined;

  function StravaProbe() {
    hookResult = useStrava();
    return null;
  }

  beforeEach(() => {
    hookResult = undefined;
    mockStorageData = {
      config: { clientId: '123456', clientSecret: 'secret_abc' },
      auth: {
        accessToken: 'valid_access_token',
        refreshToken: 'valid_refresh_token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        athlete: {
          id: 554433,
          firstname: 'Mang',
          lastname: 'Wahyu',
        },
      },
      uploadedRides: {
        'OldRide.gpx': 987654321,
      },
    };

    NativeModules.RideTracking = {
      getStravaStorage: jest.fn().mockImplementation(async () => mockStorageData),
      setStravaStorage: jest.fn().mockImplementation(async (data: Record<string, unknown>) => {
        mockStorageData = data;
        return true;
      }),
      uploadGpxToStrava: jest.fn().mockResolvedValue({
        id: 778899,
        status: 'Your activity is still being processed.',
        activity_id: null,
      }),
      checkStravaUploadStatus: jest.fn().mockResolvedValue({
        id: 778899,
        status: 'Your activity is ready.',
        activity_id: 11223344,
      }),
    };

    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads persistent auth and athlete state on mount', async () => {
    await act(async () => {
      ReactTestRenderer.create(<StravaProbe />);
    });

    expect(hookResult?.isConnected).toBe(true);
    expect(hookResult?.athlete?.firstname).toBe('Mang');
    expect(hookResult?.config.clientId).toBe('123456');
    expect(hookResult?.uploadedRides['OldRide.gpx']).toBe(987654321);
  });

  it('falls back to default built-in credentials when storage is empty', async () => {
    mockStorageData = {};
    await act(async () => {
      ReactTestRenderer.create(<StravaProbe />);
    });

    expect(hookResult?.isConnected).toBe(false);
    expect(hookResult?.config.clientId).toBe('289147');
    expect(hookResult?.config.clientSecret).toBe('928b4491fb26f5dcf876d617accd2a824fcc296d');
  });

  it('updates and saves credentials', async () => {
    await act(async () => {
      ReactTestRenderer.create(<StravaProbe />);
    });

    await act(async () => {
      await hookResult?.saveCredentials('999888', 'new_secret_xyz');
    });

    expect(hookResult?.config.clientId).toBe('999888');
    expect(hookResult?.config.clientSecret).toBe('new_secret_xyz');
    expect(NativeModules.RideTracking.setStravaStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { clientId: '999888', clientSecret: 'new_secret_xyz' },
      }),
    );
  });

  it('clears auth on disconnect', async () => {
    await act(async () => {
      ReactTestRenderer.create(<StravaProbe />);
    });

    expect(hookResult?.isConnected).toBe(true);

    await act(async () => {
      await hookResult?.disconnect();
    });

    expect(hookResult?.isConnected).toBe(false);
    expect(hookResult?.athlete).toBeNull();
  });

  it('uploads a ride and polls status until activity_id is returned', async () => {
    await act(async () => {
      ReactTestRenderer.create(<StravaProbe />);
    });

    const mockFile: SavedRideFile = {
      id: 'CycleComp-RIDE2',
      fileName: 'CycleComp-RIDE2.gpx',
      fileUrl: 'file:///Rides/CycleComp-RIDE2.gpx',
      filePath: '/Rides/CycleComp-RIDE2.gpx',
      fileSizeBytes: 4096,
      createdAt: '2026-10-20T08:00:00Z',
      hasSensorTrace: false,
    };

    let uploadRes: { success: boolean; activityId?: number; error?: string } | undefined;
    await act(async () => {
      uploadRes = await hookResult?.uploadRide(mockFile, 'Gowes Sore Canggu');
    });

    expect(uploadRes?.success).toBe(true);
    expect(uploadRes?.activityId).toBe(11223344);
    expect(hookResult?.uploadedRides['CycleComp-RIDE2.gpx']).toBe(11223344);
    expect(NativeModules.RideTracking.uploadGpxToStrava).toHaveBeenCalledWith(
      'file:///Rides/CycleComp-RIDE2.gpx',
      'valid_access_token',
      'Gowes Sore Canggu',
    );
  });

  it('opens Strava activity via deep link or web', async () => {
    await act(async () => {
      ReactTestRenderer.create(<StravaProbe />);
    });

    await act(async () => {
      await hookResult?.openStravaActivity(11223344);
    });

    expect(Linking.canOpenURL).toHaveBeenCalledWith('strava://activities/11223344');
    expect(Linking.openURL).toHaveBeenCalledWith('strava://activities/11223344');
  });
});
