import { useCallback, useEffect, useState } from 'react';
import { AppState, NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';
import type { Permission } from 'react-native';

export type RideSnapshot = {
  status: 'idle' | 'active' | 'paused' | 'recoveryNeeded' | 'finished';
  watchHeartRateEnabled?: boolean;
  watchHeartRateStatus?: 'off' | 'connecting' | 'ready' | 'readingInfo' | 'starting' | 'active' | 'pausing' | 'paused' | 'resuming' | 'stopping' | 'disconnected' | 'error';
  watchHeartRateMessage?: string | null;
  heartRateBpm?: number | null;
  heartRateRecordedAt?: string | null;
  heartRateFileUrl?: string;
  rideId?: string;
  startedAt?: string;
  finishedAt?: string | null;
  durationSeconds?: number;
  timerSeconds?: number;
  elapsedSeconds?: number;
  durationUpdatedAt?: string;
  autoPauseEnabled?: boolean;
  autoPaused?: boolean;
  sensorDiagnosticsEnabled?: boolean;
  sensorTraceStatus?: 'off' | 'active' | 'full' | 'complete' | 'error';
  sensorTraceFileUrl?: string;
  barometerStatus?: 'unavailable' | 'starting' | 'active' | 'simulated' | 'paused' | 'error';
  motionSensorStatus?: 'unavailable' | 'activity_only' | 'starting' | 'active' | 'paused' | 'error';
  motionActivityStatus?: 'unavailable' | 'starting' | 'active' | 'denied' | 'paused';
  motionActivityStationary?: boolean;
  motionAccelerationRmsG?: number | null;
  motionRotationRmsRadiansPerSecond?: number | null;
  movingSeconds?: number;
  manualPausedSeconds?: number;
  autoPausedSeconds?: number;
  unknownMotionSeconds?: number;
  distanceMeters?: number;
  ascentMeters?: number;
  descentMeters?: number;
  elevationDataAvailable?: boolean;
  speedMetersPerSecond?: number | null;
  speedSource?: 'gps' | 'position' | 'held' | 'stationary' | null;
  rawSpeedMetersPerSecond?: number | null;
  speedAccuracyMetersPerSecond?: number | null;
  speedLowerBoundMetersPerSecond?: number | null;
  speedUpperBoundMetersPerSecond?: number | null;
  courseDegrees?: number | null;
  elevationMeters?: number | null;
  relativeElevationMeters?: number | null;
  elevationSource?: 'barometer_gps' | 'gps' | null;
  elevationAnchorQuality?: 'calibrated' | 'gps' | 'unanchored' | 'unavailable' | null;
  liveGradePercent?: number | null;
  liveGradeSource?: 'barometer' | 'gps' | null;
  liveGradeQuality?: 'barometer_relative' | 'gps_vertical' | null;
  liveGradeWindowMeters?: number | null;
  liveGradeSampleCount?: number | null;
  liveGradeUpdatedAt?: string | null;
  horizontalAccuracyMeters?: number | null;
  lastFixAt?: string | null;
  lastCoordinate?: [number, number] | null;
  terrainMatchStatus?:
    | 'noPack'
    | 'acquiring'
    | 'matched'
    | 'uncertain'
    | 'out_of_coverage'
    | 'invalid_observation'
    | 'staleLocation'
    | 'packCorrupt';
  terrainMatchReason?: string;
  terrainMatchPackID?: string | null;
  matchedEdgeID?: number | null;
  matchedSegmentID?: number | null;
  matchedCorridorID?: number | null;
  positionMatchQuality?: 'unavailable' | 'low' | 'medium' | 'high';
  forwardPathQuality?: 'unavailable' | 'ambiguous' | 'known_to_boundary' | 'inferred_to_boundary';
  profileQuality?: 'unavailable' | 'partial' | 'complete';
  positionAlongEdgeMeters?: number | null;
  positionAlongCorridorMeters?: number | null;
  lateralDistanceMeters?: number | null;
  profileDistanceToBoundaryMeters?: number | null;
  terrainClimbStatus?: 'unavailable' | 'none' | 'upcoming' | 'active';
  terrainClimbReason?: string;
  terrainClimbIndex?: number | null;
  terrainClimbDistanceToStartMeters?: number | null;
  terrainClimbDistanceRemainingMeters?: number | null;
  terrainClimbDistanceMeters?: number | null;
  terrainClimbNetRiseMeters?: number | null;
  terrainClimbElevationGainMeters?: number | null;
  terrainClimbAverageGradePercent?: number | null;
  terrainClimbMaxGradePercent?: number | null;
  terrainClimbProgressPercent?: number | null;
  terrainClimbProfileQuality?: 'unavailable' | 'partial' | 'complete';
  terrainClimbKnownForwardDistanceMeters?: number;
  newCoordinate?: [number, number];
  newSegment?: boolean;
  trackSegments?: [number, number][][];
  pointCount?: number;
  fileUrl?: string | null;
};

type RecordedRideElevationSegment = {
  coordinate: [number, number];
  elevationMeters: number | null;
}[][];

export type SavedRideFile = {
  id: string;
  fileName: string;
  fileUrl: string;
  filePath: string;
  fileSizeBytes: number;
  createdAt: string;
  hasSensorTrace: boolean;
};

type RideTrackingModule = {
  getRideState(): Promise<RideSnapshot>;
  getRideElevationTrack(): Promise<RecordedRideElevationSegment>;
  setAutoPauseEnabled(enabled: boolean): Promise<RideSnapshot>;
  setSensorDiagnosticsEnabled(enabled: boolean): Promise<RideSnapshot>;
  setWatchHeartRateEnabled(enabled: boolean): Promise<RideSnapshot>;
  startRide(): Promise<RideSnapshot>;
  pauseRide(): Promise<RideSnapshot>;
  resumeRide(): Promise<RideSnapshot>;
  finishRide(): Promise<RideSnapshot>;
  shareGpx(fileUrl: string): Promise<void>;
  shareSensorTrace(fileUrl: string): Promise<void>;
  listSavedRides(): Promise<SavedRideFile[]>;
  readSavedRideGpx(fileUrl: string): Promise<string>;
  deleteSavedRide(fileUrl: string): Promise<boolean>;
  openStravaUpload(): Promise<void>;
  setKeepScreenOn(keepOn: boolean): Promise<boolean>;
};

const rideTracking = NativeModules.RideTracking as RideTrackingModule | undefined;

export function useRideTracking() {
  const [rideSnapshot, setRideSnapshot] = useState<RideSnapshot>({ status: 'idle' });
  const [trackSegments, setTrackSegments] = useState<[number, number][][]>([]);
  const [lastFinishedRide, setLastFinishedRide] = useState<RideSnapshot | null>(null);
  const [rideError, setRideError] = useState<string | null>(null);
  const [rideBusy, setRideBusy] = useState(false);
  const [rideChecking, setRideChecking] = useState(true);

  const refreshRide = useCallback(async () => {
    if (!rideTracking) {
      setRideError('Perekam perjalanan belum tersedia pada build ini.');
      setRideChecking(false);
      return null;
    }
    try {
      const savedRide = await rideTracking.getRideState();
      setRideSnapshot(savedRide);
      setTrackSegments(savedRide.trackSegments ?? []);
      setRideError(null);
      return savedRide;
    } catch (error) {
      setRideError(rideErrorMessage(error));
      return null;
    } finally {
      setRideChecking(false);
    }
  }, []);

  useEffect(() => {
    refreshRide();
    if (!rideTracking) { return; }

    const rideEvents = new NativeEventEmitter(NativeModules.RideTracking);
    const snapshotListener = rideEvents.addListener('RideTrackingSnapshot', event => {
      const snapshot = event as RideSnapshot;
      setRideSnapshot(snapshot);
      if (snapshot.newCoordinate) {
        setRideError(null);
        setTrackSegments(previousSegments => {
          const newCoordinate = snapshot.newCoordinate as [number, number];
          if (snapshot.newSegment || previousSegments.length === 0) {
            return [...previousSegments, [newCoordinate]];
          }
          return [...previousSegments.slice(0, -1), [...previousSegments[previousSegments.length - 1], newCoordinate]];
        });
      }
    });
    const errorListener = rideEvents.addListener('RideTrackingError', event => {
      setRideError((event as { message: string }).message);
    });
    const appStateListener = AppState.addEventListener('change', state => {
      if (state === 'active') { refreshRide(); }
    });
    return () => {
      snapshotListener.remove();
      errorListener.remove();
      appStateListener.remove();
    };
  }, [refreshRide]);

  async function runRideAction(action: () => Promise<RideSnapshot>) {
    setRideBusy(true);
    setRideError(null);
    try {
      const updatedRide = await action();
      setRideSnapshot(updatedRide);
      if (updatedRide.status === 'finished') {
        setLastFinishedRide(updatedRide);
        setTrackSegments([]);
      } else if (updatedRide.status === 'active' && updatedRide.pointCount === 0) {
        setLastFinishedRide(null);
        setTrackSegments([]);
      }
      return updatedRide;
    } catch (error) {
      setRideError(rideErrorMessage(error));
      return null;
    } finally {
      setRideBusy(false);
    }
  }

  async function shareFinishedRide() {
    if (!rideTracking || !lastFinishedRide?.fileUrl) { return; }
    try {
      await rideTracking.shareGpx(lastFinishedRide.fileUrl);
    } catch (error) {
      setRideError(rideErrorMessage(error));
    }
  }

  async function shareFinishedSensorTrace() {
    if (!rideTracking || !lastFinishedRide?.sensorTraceFileUrl) { return; }
    try {
      await rideTracking.shareSensorTrace(lastFinishedRide.sensorTraceFileUrl);
    } catch (error) {
      setRideError(rideErrorMessage(error));
    }
  }

  async function openStravaUpload() {
    if (!rideTracking) { return; }
    setRideError(null);
    try {
      await rideTracking.openStravaUpload();
    } catch (error) {
      setRideError(error instanceof Error ? error.message : 'Halaman unggah Strava tidak dapat dibuka.');
    }
  }

  async function startRide() {
    if (!rideTracking) return null;
    if (Platform.OS === 'android') {
      const permissionsToRequest: Permission[] = [
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
      ];
      if (Number(Platform.Version) >= 33) {
        permissionsToRequest.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      }
      const permissionResults = await PermissionsAndroid.requestMultiple(permissionsToRequest);
      const locationIsAllowed =
        permissionResults[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;
      if (!locationIsAllowed) {
        setRideError('Pilih akses lokasi presisi agar rekaman rute CycleComp akurat.');
        return null;
      }
    }
    return runRideAction(() => rideTracking.startRide());
  }

  useEffect(() => {
    const isNavigating = rideSnapshot.status === 'active' || rideSnapshot.status === 'paused';
    if (!rideTracking?.setKeepScreenOn) return;

    rideTracking.setKeepScreenOn(isNavigating).catch(() => {});

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        const activeNow = rideSnapshot.status === 'active' || rideSnapshot.status === 'paused';
        rideTracking.setKeepScreenOn(activeNow).catch(() => {});
      }
    });

    return () => {
      subscription.remove();
      rideTracking?.setKeepScreenOn?.(false).catch(() => {});
    };
  }, [rideSnapshot.status]);

  return {
    rideSnapshot,
    trackSegments,
    lastFinishedRide,
    rideError,
    rideBusy,
    rideChecking,
    refreshRide,
    getRideElevationTrack: () => rideTracking?.getRideElevationTrack() ?? Promise.resolve([]),
    setAutoPauseEnabled: (enabled: boolean) => rideTracking && runRideAction(() => rideTracking.setAutoPauseEnabled(enabled)),
    setSensorDiagnosticsEnabled: (enabled: boolean) => rideTracking && runRideAction(() => rideTracking.setSensorDiagnosticsEnabled(enabled)),
    setWatchHeartRateEnabled: (enabled: boolean) => rideTracking && runRideAction(() => rideTracking.setWatchHeartRateEnabled(enabled)),
    startRide,
    pauseRide: () => rideTracking && runRideAction(() => rideTracking.pauseRide()),
    resumeRide: () => rideTracking && runRideAction(() => rideTracking.resumeRide()),
    finishRide: () => rideTracking && runRideAction(() => rideTracking.finishRide()),
    shareFinishedRide,
    shareFinishedSensorTrace,
    openStravaUpload,
    dismissFinishedRide: () => setLastFinishedRide(null),
    setKeepScreenOn: (keepOn: boolean) => rideTracking?.setKeepScreenOn?.(keepOn) ?? Promise.resolve(false),
  };
}

function rideErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Perekaman perjalanan gagal.';
}
