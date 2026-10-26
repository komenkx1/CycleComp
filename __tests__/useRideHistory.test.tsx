import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { NativeModules } from 'react-native';

import { useRideHistory } from '../src/features/history/useRideHistory';

describe('useRideHistory', () => {
  const mockSavedRides = [
    {
      id: 'CycleComp-TEST1',
      fileName: 'CycleComp-TEST1.gpx',
      fileUrl: 'file:///Documents/Rides/CycleComp-TEST1.gpx',
      filePath: '/Documents/Rides/CycleComp-TEST1.gpx',
      fileSizeBytes: 2048,
      createdAt: '2026-10-20T06:30:00Z',
      hasSensorTrace: true,
    },
    {
      id: 'CycleComp-TEST2',
      fileName: 'CycleComp-TEST2.gpx',
      fileUrl: 'file:///Documents/Rides/CycleComp-TEST2.gpx',
      filePath: '/Documents/Rides/CycleComp-TEST2.gpx',
      fileSizeBytes: 4096,
      createdAt: '2026-10-19T15:00:00Z',
      hasSensorTrace: false,
    },
  ];

  const sampleGpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="CycleComp" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Gowes Pagi</name>
    <trkseg>
      <trkpt lat="-8.50" lon="115.20">
        <ele>100</ele>
        <time>2026-10-20T06:30:00Z</time>
      </trkpt>
      <trkpt lat="-8.51" lon="115.21">
        <ele>120</ele>
        <time>2026-10-20T06:35:00Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

  let hookResult: ReturnType<typeof useRideHistory> | undefined;

  function RideHistoryProbe() {
    hookResult = useRideHistory();
    return null;
  }

  beforeEach(() => {
    hookResult = undefined;
    NativeModules.RideTracking = {
      listSavedRides: jest.fn().mockResolvedValue(mockSavedRides),
      readSavedRideGpx: jest.fn().mockResolvedValue(sampleGpxXml),
      deleteSavedRide: jest.fn().mockResolvedValue(true),
      shareGpx: jest.fn().mockResolvedValue(undefined),
      shareSensorTrace: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('loads saved rides on mount', async () => {
    await act(async () => {
      ReactTestRenderer.create(<RideHistoryProbe />);
    });

    expect(hookResult?.rides).toHaveLength(2);
    expect(hookResult?.rides[0].id).toBe('CycleComp-TEST1');
    expect(hookResult?.rides[0].hasSensorTrace).toBe(true);
  });

  it('selects and parses a saved ride GPX file', async () => {
    await act(async () => {
      ReactTestRenderer.create(<RideHistoryProbe />);
    });

    await act(async () => {
      await hookResult?.selectRide(mockSavedRides[0]);
    });

    expect(hookResult?.selectedRide).not.toBeNull();
    expect(hookResult?.selectedRide?.route.pointCount).toBe(2);
    expect(hookResult?.selectedRide?.route.segments[0].points).toHaveLength(2);
  });

  it('clears selected ride', async () => {
    await act(async () => {
      ReactTestRenderer.create(<RideHistoryProbe />);
    });

    await act(async () => {
      await hookResult?.selectRide(mockSavedRides[0]);
    });
    expect(hookResult?.selectedRide).not.toBeNull();

    act(() => {
      hookResult?.clearSelectedRide();
    });
    expect(hookResult?.selectedRide).toBeNull();
  });

  it('deletes a ride and refreshes list', async () => {
    await act(async () => {
      ReactTestRenderer.create(<RideHistoryProbe />);
    });

    await act(async () => {
      await hookResult?.selectRide(mockSavedRides[0]);
    });

    await act(async () => {
      const success = await hookResult?.deleteRide(mockSavedRides[0]);
      expect(success).toBe(true);
    });

    expect(NativeModules.RideTracking.deleteSavedRide).toHaveBeenCalledWith(
      'file:///Documents/Rides/CycleComp-TEST1.gpx',
    );
    expect(hookResult?.selectedRide).toBeNull();
  });

  it('shares GPX file', async () => {
    await act(async () => {
      ReactTestRenderer.create(<RideHistoryProbe />);
    });

    await act(async () => {
      await hookResult?.shareRide(mockSavedRides[0].fileUrl);
    });

    expect(NativeModules.RideTracking.shareGpx).toHaveBeenCalledWith(
      'file:///Documents/Rides/CycleComp-TEST1.gpx',
    );
  });
});
