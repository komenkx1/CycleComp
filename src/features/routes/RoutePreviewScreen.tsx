import {
  Camera,
  GeoJSONSource,
  Layer,
  LocationManager,
  Map,
  NativeUserLocation,
  type CameraRef,
  type MapRef,
  type ViewState,
} from '@maplibre/maplibre-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StatusBar,
  Switch,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  buildRouteLineFeature,
  type GpxRoute,
  type RouteBounds,
  type TerrainElevationEnrichment,
} from '../../domain/routes/gpx/GpxRoute';
import {
  reverseRouteForReturn,
} from '../../domain/routes/gpx/routeBack';
import { prepareRecordedRouteBack } from './prepareRecordedRouteBack';
import {
  boundsContain,
  INDONESIA_MAP_BOUNDS,
  INDONESIA_MAP_STYLE_URL,
  ONLINE_MAP_STYLE_URL,
  selectedAreaFromFrameCorners,
} from '../maps/offlineMapSource';
import {
  type SavedMapArea,
  useOfflineMapPacks,
} from '../maps/useOfflineMapPacks';
import {
  GpxImportCanceledError,
  pickAndImportGpxRoute,
} from './importGpxRoute';
import { rideElapsedSeconds } from '../../domain/ride/rideDuration';
import { RideDashboard } from '../ride/RideDashboard';
import { useRideTracking } from '../ride/useRideTracking';
import { useRideHistory } from '../history/useRideHistory';
import { RideHistoryPanel } from '../history/RideHistoryPanel';
import { useStrava } from '../strava/useStrava';
import { StravaSettingsCard } from '../strava/StravaSettingsCard';
import { AmoledTheme } from '../../theme/colors';
import {
  analyzeRouteElevation,
  distanceBetweenCoords,
  findClimbStateForRider,
  type ClimbAlertState,
} from '../../domain/routes/elevation/routeElevationAnalysis';
import { useAppActive } from '../ride/useAppActive';
import { NavigationGuidanceBanner } from '../navigation/NavigationGuidanceBanner';
import { getNavigationGuidance } from '../../domain/routes/navigation/routeNavigationGuidance';
import { GmapsLinkModal } from '../search/GmapsLinkModal';
import { ElevationProfileChart } from '../elevation/ElevationProfileChart';
import { ClimbListSection } from '../elevation/ClimbListSection';
import { TerrainPackManager } from '../elevation/TerrainPackManager';
import {
  getTerrainGridPackInventory,
  type TerrainGridPackSummary,
} from '../elevation/terrainGridPackService';
import {
  NavigationAudioCueManager,
  isSoundEnabled,
  playAudioCue,
  toggleSoundEnabled,
} from '../audio/audioCueService';
import { EnduranceScreenOverlay } from '../ride/EnduranceScreenOverlay';
import { SFIcon } from '../../components/SFIcon';

const INITIAL_MAP_CENTER: [number, number] = [115.1889, -8.4095];

type RouteLoadState =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'loaded'; route: GpxRoute }
  | { status: 'error'; message: string };

type MainTab = 'ride' | 'routes' | 'maps' | 'settings';

const MAIN_TABS: { id: MainTab; label: string }[] = [
  { id: 'ride', label: 'Ride' },
  { id: 'routes', label: 'Rute' },
  { id: 'maps', label: 'Peta' },
  { id: 'settings', label: 'Setelan' },
];

const INITIAL_NAVIGATION_ZOOM = 15;
const LOCATION_FOLLOW_ZOOM = 16;
const MIN_NAVIGATION_ZOOM = 3;
const MAX_NAVIGATION_ZOOM = 18;

export function RoutePreviewScreen() {
  const appActive = useAppActive();
  const { height: windowHeight } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState<MainTab>('ride');
  const [routeLoadState, setRouteLoadState] = useState<RouteLoadState>({
    status: 'empty',
  });
  const [routeBackActive, setRouteBackActive] = useState(false);
  const [routeBackBusy, setRouteBackBusy] = useState(false);
  const [routeBackSourceRoute, setRouteBackSourceRoute] = useState<GpxRoute | null>(null);
  const [gmapsModalVisible, setGmapsModalVisible] = useState(false);
  const [navigationZoom, setNavigationZoom] = useState(INITIAL_NAVIGATION_ZOOM);
  const [povMode, setPovMode] = useState<'3d' | '2d'>('3d');
  const [currentPosition, setCurrentPosition] = useState<{
    coordinate: [number, number];
    accuracyMeters: number;
  } | null>(null);
  const [rideFollowing, setRideFollowing] = useState(true);
  const [previewFollowing, setPreviewFollowing] = useState(false);
  const [areaPickerOpen, setAreaPickerOpen] = useState(false);
  const [selectedAreaBounds, setSelectedAreaBounds] = useState<RouteBounds | null>(null);
  const [mapViewportSize, setMapViewportSize] = useState({ width: 0, height: 0 });
  const [updatingAreaId, setUpdatingAreaId] = useState<string | null>(null);
  const [userLocationEnabled, setUserLocationEnabled] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapRef>(null);
  const selectedAreaBoundsRequest = useRef(0);
  const visibleMapZoom = useRef(INITIAL_NAVIGATION_ZOOM);
  const hasCenteredOnUser = useRef(false);
  const pendingCenterOnUser = useRef(false);
  const [dashboardHeight, setDashboardHeight] = useState(280);
  const [idlePanelHeight, setIdlePanelHeight] = useState(300);

  const insets = useSafeAreaInsets();

  const {
    rideSnapshot,
    trackSegments,
    lastFinishedRide,
    rideError,
    rideBusy,
    rideChecking,
    refreshRide,
    getRideElevationTrack,
    startRide,
    setWatchHeartRateEnabled,
    setAutoPauseEnabled,
    setSensorDiagnosticsEnabled,
    pauseRide,
    resumeRide,
    finishRide,
    shareFinishedRide,
    shareFinishedSensorTrace,
    openStravaUpload,
    dismissFinishedRide,
  } = useRideTracking();

  const strava = useStrava();
  const rideHistory = useRideHistory();
  const [routeSubTab, setRouteSubTab] = useState<'history' | 'import'>('import');

  const importedRoute =
    routeLoadState.status === 'loaded' ? routeLoadState.route : null;
  const activePreviewRoute = rideHistory.selectedRide?.route ?? importedRoute ?? null;
  const {
    savedMapAreas,
    mapPackCheck,
    mapPackError,
    areaUpdateProgress = {},
    downloadArea,
    pauseArea,
    resumeArea,
    updateArea,
    deleteArea,
  } = useOfflineMapPacks();
  const readyMapAreas = savedMapAreas.filter(area => area.status === 'ready');
  const totalSavedBytes = useMemo(
    () => savedMapAreas.reduce((sum, area) => sum + (area.downloadedBytes || 0), 0),
    [savedMapAreas],
  );
  const selectedAreaAlreadySaved = selectedAreaBounds !== null &&
    readyMapAreas.some(area => boundsContain(area.bounds, selectedAreaBounds));
  const areaDownloadInProgress =
    savedMapAreas.some(area => area.status === 'downloading') ||
    Object.keys(areaUpdateProgress).length > 0;
  const routeHasOfflineMap = activePreviewRoute
    ? readyMapAreas.some(area => boundsContain(area.bounds, activePreviewRoute.bounds))
    : readyMapAreas.length > 0;

  const [installedTerrainPacks, setInstalledTerrainPacks] = useState<TerrainGridPackSummary[]>([]);

  useEffect(() => {
    let isMounted = true;
    getTerrainGridPackInventory()
      .then(inventory => {
        if (isMounted) {
          setInstalledTerrainPacks(inventory.packs);
        }
      })
      .catch(() => {
        if (isMounted) {
          setInstalledTerrainPacks([]);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [activeTab]);

  const routeTerrainStatus: 'ready' | 'missing' | 'partial' | undefined = useMemo(() => {
    if (!activePreviewRoute) {
      return undefined;
    }
    if (installedTerrainPacks.length === 0) {
      return 'missing';
    }
    const fullyCovers = installedTerrainPacks.some(pack =>
      boundsContain(pack.requestedBoundsWgs84, activePreviewRoute.bounds),
    );
    if (fullyCovers) {
      return 'ready';
    }
    const overlaps = installedTerrainPacks.some(pack => {
      const [pW, pS, pE, pN] = pack.requestedBoundsWgs84;
      const [rW, rS, rE, rN] = activePreviewRoute.bounds;
      return !(pE < rW || pW > rE || pN < rS || pS > rN);
    });
    if (overlaps) {
      return 'partial';
    }
    return 'missing';
  }, [activePreviewRoute, installedTerrainPacks]);
  const rideIsOpen = rideSnapshot.status === 'active' ||
    rideSnapshot.status === 'paused' ||
    rideSnapshot.status === 'recoveryNeeded';
  const currentBottomPadding = useMemo(() => {
    if (rideIsOpen) {
      return Math.max(dashboardHeight + 16, 120);
    }
    if (areaPickerOpen) {
      return Math.round(windowHeight * 0.58);
    }
    return idlePanelHeight + 16;
  }, [rideIsOpen, dashboardHeight, areaPickerOpen, idlePanelHeight, windowHeight]);

  const cameraPadding = useMemo(() => ({
    top: 30,
    bottom: currentBottomPadding,
    left: 20,
    right: 20,
  }), [currentBottomPadding]);
  const areaSelectionFrameLayout = useMemo(() => {
    const { width, height } = mapViewportSize;
    if (width <= 0 || height <= 0) {
      return null;
    }

    const visibleMapTop = Math.min(cameraPadding.top, height);
    const visibleMapBottom = Math.max(visibleMapTop, height - cameraPadding.bottom);
    const visibleMapHeight = visibleMapBottom - visibleMapTop;
    const frameHeight = Math.min(height * 0.3, Math.max(0, visibleMapHeight - 24));
    if (frameHeight <= 0) {
      return null;
    }

    return {
      left: width * 0.18,
      top: visibleMapTop + (visibleMapHeight - frameHeight) / 2,
      width: width * 0.64,
      height: frameHeight,
    };
  }, [cameraPadding, mapViewportSize]);

  const refreshSelectedAreaBoundsFromFrame = useCallback(async () => {
    const map = mapRef.current;
    const frameLayout = areaSelectionFrameLayout;
    if (!areaPickerOpen || !map || !frameLayout) {
      return;
    }

    const requestId = ++selectedAreaBoundsRequest.current;
    const frameCorners: [number, number][] = [
      [frameLayout.left, frameLayout.top],
      [frameLayout.left + frameLayout.width, frameLayout.top],
      [frameLayout.left, frameLayout.top + frameLayout.height],
      [frameLayout.left + frameLayout.width, frameLayout.top + frameLayout.height],
    ];

    try {
      const projectedCorners = await Promise.all(
        frameCorners.map(point => map.unproject(point)),
      );
      if (requestId !== selectedAreaBoundsRequest.current) {
        return;
      }
      setSelectedAreaBounds(selectedAreaFromFrameCorners(projectedCorners));
    } catch {
      if (requestId === selectedAreaBoundsRequest.current) {
        setSelectedAreaBounds(null);
      }
    }
  }, [areaPickerOpen, areaSelectionFrameLayout]);

  useEffect(() => {
    refreshSelectedAreaBoundsFromFrame();
  }, [refreshSelectedAreaBoundsFromFrame]);

  const cameraPaddingRef = useRef(cameraPadding);
  cameraPaddingRef.current = cameraPadding;
  const startingMapCenter: [number, number] = readyMapAreas.length > 0
    ? [
        (readyMapAreas[0].bounds[0] + readyMapAreas[0].bounds[2]) / 2,
        (readyMapAreas[0].bounds[1] + readyMapAreas[0].bounds[3]) / 2,
      ]
    : INITIAL_MAP_CENTER;
  const mapStyle =
    (routeHasOfflineMap || (rideIsOpen && readyMapAreas.length > 0)) && !areaPickerOpen
      ? INDONESIA_MAP_STYLE_URL
      : ONLINE_MAP_STYLE_URL;
  const routeElevationAnalysis = useMemo(
    () => (activePreviewRoute ? analyzeRouteElevation(activePreviewRoute) : null),
    [activePreviewRoute],
  );
  const gradientRouteFeature = useMemo(() => {
    if (
      routeElevationAnalysis &&
      routeElevationAnalysis.gradientFeatureCollection.features.length > 0
    ) {
      return JSON.stringify(routeElevationAnalysis.gradientFeatureCollection);
    }
    return null;
  }, [routeElevationAnalysis]);
  const routeLineFeature = useMemo(
    () => (activePreviewRoute ? JSON.stringify(buildRouteLineFeature(activePreviewRoute)) : null),
    [activePreviewRoute],
  );
  const recordedLineFeature = useMemo(() => trackSegments.some(segment => segment.length >= 2) ? JSON.stringify({
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'MultiLineString' as const, coordinates: trackSegments.filter(segment => segment.length >= 2) },
  }) : null, [trackSegments]);

  const routeStartPointFeature = useMemo(() => {
    const firstPoint = activePreviewRoute?.segments[0]?.points[0];
    if (!firstPoint) return null;
    return JSON.stringify({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: firstPoint.coordinate },
    });
  }, [activePreviewRoute]);

  const routeFinishPointFeature = useMemo(() => {
    const segments = activePreviewRoute?.segments;
    if (!segments || segments.length === 0) return null;
    const lastSeg = segments[segments.length - 1];
    const lastPoint = lastSeg.points[lastSeg.points.length - 1];
    if (!lastPoint) return null;
    return JSON.stringify({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: lastPoint.coordinate },
    });
  }, [activePreviewRoute]);

  const activeRiderCoordinate = rideIsOpen
    ? (rideSnapshot.lastCoordinate ?? currentPosition?.coordinate)
    : currentPosition?.coordinate;
  const rideFixAgeMilliseconds = rideSnapshot.lastFixAt
    ? Date.now() - Date.parse(rideSnapshot.lastFixAt)
    : Infinity;
  const rideHasFreshFix = rideFixAgeMilliseconds >= 0 && rideFixAgeMilliseconds <= 10000;
  const lastKnownSpeedMpsRef = useRef<number | null>(null);

  useEffect(() => {
    if (rideSnapshot.autoPaused || rideSnapshot.status === 'paused') {
      lastKnownSpeedMpsRef.current = 0;
    } else if (
      rideSnapshot.status === 'active' &&
      rideSnapshot.speedMetersPerSecond != null &&
      Number.isFinite(rideSnapshot.speedMetersPerSecond)
    ) {
      lastKnownSpeedMpsRef.current = rideSnapshot.speedMetersPerSecond;
    } else if (rideSnapshot.status === 'idle' || rideSnapshot.status === 'finished') {
      lastKnownSpeedMpsRef.current = null;
    }
  }, [rideSnapshot.autoPaused, rideSnapshot.status, rideSnapshot.speedMetersPerSecond]);

  const climbAlert: ClimbAlertState = useMemo(() => {
    if (!routeElevationAnalysis) {
      return {
        type: 'none',
        currentGradePercent: null,
        currentElevationMeters: null,
        nextClimbDistanceMeters: null,
        totalClimbs: 0,
      };
    }
    return findClimbStateForRider(activeRiderCoordinate, routeElevationAnalysis);
  }, [routeElevationAnalysis, activeRiderCoordinate]);

  const routeCoordinates = useMemo(() => {
    if (!activePreviewRoute) return [];
    return activePreviewRoute.segments.flatMap(segment => segment.points.map(p => p.coordinate));
  }, [activePreviewRoute]);

  const turnGuidance = useMemo(() => {
    if (!importedRoute || routeCoordinates.length < 2) {
      return null;
    }
    return getNavigationGuidance(routeCoordinates, activeRiderCoordinate);
  }, [importedRoute, routeCoordinates, activeRiderCoordinate]);

  const audioCueManagerRef = useRef(new NavigationAudioCueManager());
  const [soundEnabled, setSoundEnabledState] = useState(isSoundEnabled());
  const [enduranceModeActive, setEnduranceModeActive] = useState(false);
  const [endurancePeeking, setEndurancePeeking] = useState(false);
  const enduranceCovered = rideIsOpen && enduranceModeActive && !endurancePeeking;
  const mapVisible = appActive && !enduranceCovered;
  const lastMapView = useRef<{ context: string; view: Omit<ViewState, 'bounds'> } | null>(null);
  const mapContext = `${mapStyle}:${areaPickerOpen}:${activePreviewRoute?.sourceFileName ?? (activePreviewRoute ? activePreviewRoute.name : '')}`;
  const endurancePeekTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => () => {
    if (endurancePeekTimeoutRef.current) {
      clearTimeout(endurancePeekTimeoutRef.current);
    }
  }, []);

  const handleToggleSound = useCallback(() => {
    const next = toggleSoundEnabled();
    setSoundEnabledState(next);
    if (next) {
      playAudioCue('click');
    }
  }, []);

  const handleToggleEndurance = useCallback(() => {
    setEnduranceModeActive(prev => {
      const next = !prev;
      playAudioCue('click');
      if (next) {
        setEndurancePeeking(false);
      }
      return next;
    });
  }, []);

  const handleWakeUpEndurance = useCallback(() => {
    setEndurancePeeking(true);
    playAudioCue('click');
    if (endurancePeekTimeoutRef.current) {
      clearTimeout(endurancePeekTimeoutRef.current);
    }
    endurancePeekTimeoutRef.current = setTimeout(() => {
      setEndurancePeeking(false);
    }, 15000);
  }, []);

  const isOffRoute = useMemo(() => {
    if (!rideIsOpen || !importedRoute || routeCoordinates.length < 2 || !activeRiderCoordinate) {
      return false;
    }
    let minDist = Infinity;
    for (let i = 0; i < routeCoordinates.length; i++) {
      const d = distanceBetweenCoords(activeRiderCoordinate, routeCoordinates[i]);
      if (d < minDist) minDist = d;
      if (minDist <= 55) return false;
    }
    return minDist > 55;
  }, [rideIsOpen, importedRoute, routeCoordinates, activeRiderCoordinate]);

  useEffect(() => {
    if (!rideIsOpen) {
      audioCueManagerRef.current.reset();
      if (enduranceModeActive) {
        setEnduranceModeActive(false);
        setEndurancePeeking(false);
      }
      return;
    }

    const hasGpxClimb = climbAlert.type === 'upcoming' || climbAlert.type === 'active';
    const effectiveClimbType: 'none' | 'upcoming' | 'active' = hasGpxClimb
      ? climbAlert.type
      : (rideSnapshot.terrainClimbStatus === 'upcoming' || rideSnapshot.terrainClimbStatus === 'active')
      ? rideSnapshot.terrainClimbStatus
      : 'none';
    const effectiveDistanceToClimbMeters = hasGpxClimb
      ? (climbAlert.type === 'upcoming' ? climbAlert.distanceToStartMeters : null)
      : (rideSnapshot.terrainClimbStatus === 'upcoming' ? rideSnapshot.terrainClimbDistanceToStartMeters : null);
    const effectiveClimbId = hasGpxClimb
      ? climbAlert.climbIndex
      : (rideSnapshot.terrainClimbStatus === 'upcoming' || rideSnapshot.terrainClimbStatus === 'active')
      ? 'free_ride_terrain'
      : null;

    audioCueManagerRef.current.evaluateGuidance({
      distanceToTurnMeters: turnGuidance?.distanceMeters,
      turnCoordinate: turnGuidance?.coordinate,
      turnType: turnGuidance?.type,
      isOffRoute,
      climbType: effectiveClimbType,
      distanceToClimbMeters: effectiveDistanceToClimbMeters,
      climbId: effectiveClimbId,
    });

    if (enduranceModeActive) {
      const hasUpcomingTurn =
        turnGuidance &&
        turnGuidance.type !== 'straight' &&
        turnGuidance.type !== 'finish' &&
        turnGuidance.distanceMeters <= 180;
      const hasClimbEvent =
        effectiveClimbType === 'upcoming' || effectiveClimbType === 'active';

      if (hasUpcomingTurn || hasClimbEvent || isOffRoute) {
        if (!endurancePeeking) {
          setEndurancePeeking(true);
        }
      }
    }
  }, [
    rideIsOpen,
    turnGuidance,
    climbAlert,
    rideSnapshot.terrainClimbStatus,
    rideSnapshot.terrainClimbDistanceToStartMeters,
    isOffRoute,
    enduranceModeActive,
    endurancePeeking,
  ]);

  const showUserLocation = userLocationEnabled || rideIsOpen;
  const isFollowing = rideIsOpen && rideFollowing;

  useEffect(() => {
    if (mapPackCheck === 'done' && savedMapAreas.length === 0 && !rideIsOpen) {
      setActiveTab('maps');
      setAreaPickerOpen(true);
    }
  }, [mapPackCheck, savedMapAreas.length, rideIsOpen]);

  useEffect(() => {
    if (!showUserLocation || !mapVisible) {
      return;
    }

    function updateCurrentPosition(location: {
      coords: { longitude: number; latitude: number; accuracy: number };
    }) {
      const coords: [number, number] = [
        location.coords.longitude,
        location.coords.latitude,
      ];
      const accuracyMeters = Math.round(location.coords.accuracy);
      setCurrentPosition(previousPosition =>
        previousPosition?.coordinate[0] === coords[0] &&
        previousPosition.coordinate[1] === coords[1] &&
        previousPosition.accuracyMeters === accuracyMeters
          ? previousPosition
          : { coordinate: coords, accuracyMeters },
      );

      if (pendingCenterOnUser.current) {
        pendingCenterOnUser.current = false;
        setPreviewFollowing(true);
        const targetZoom = Math.max(visibleMapZoom.current, LOCATION_FOLLOW_ZOOM);
        visibleMapZoom.current = targetZoom;
        applyCameraStop({
          center: coords,
          zoom: targetZoom,
          padding: cameraPaddingRef.current,
          duration: 400,
        });
      }
    }

    LocationManager.addListener(updateCurrentPosition);
    return () => LocationManager.removeListener(updateCurrentPosition);
  }, [showUserLocation, mapVisible]);

  async function locateUser() {
    setIsLocating(true);
    let locationAllowed = false;
    try {
      locationAllowed = await LocationManager.requestPermissions();
    } catch {
      locationAllowed = false;
    }

    if (!locationAllowed) {
      setIsLocating(false);
      Alert.alert(
        'Izin Lokasi Diperlukan',
        'Aktifkan izin lokasi untuk CycleComp di Pengaturan iPhone agar peta dapat menampilkan posisi Anda saat ini.',
        [
          { text: 'Batal', style: 'cancel' },
          { text: 'Buka Pengaturan', onPress: () => Linking.openSettings() },
        ],
      );
      return;
    }

    setUserLocationEnabled(true);
    setPreviewFollowing(true);

    if (currentPosition?.coordinate) {
      const targetZoom = Math.max(visibleMapZoom.current, LOCATION_FOLLOW_ZOOM);
      visibleMapZoom.current = targetZoom;
      applyCameraStop({
        center: currentPosition.coordinate,
        zoom: targetZoom,
        padding: cameraPadding,
        duration: 400,
      });
      setIsLocating(false);
      return;
    }

    pendingCenterOnUser.current = true;

    if (typeof LocationManager.getCurrentPosition === 'function') {
      try {
        const position = await LocationManager.getCurrentPosition();
        if (position?.coords) {
          const coords: [number, number] = [
            position.coords.longitude,
            position.coords.latitude,
          ];
          setCurrentPosition({
            coordinate: coords,
            accuracyMeters: Math.round(position.coords.accuracy),
          });
          if (pendingCenterOnUser.current) {
            pendingCenterOnUser.current = false;
            setPreviewFollowing(true);
            const targetZoom = Math.max(visibleMapZoom.current, LOCATION_FOLLOW_ZOOM);
            visibleMapZoom.current = targetZoom;
            applyCameraStop({
              center: coords,
              zoom: targetZoom,
              padding: cameraPadding,
              duration: 400,
            });
          }
        }
      } catch {
        // Handled by LocationManager listener
      }
    }
    setIsLocating(false);
  }

  // Smoothly follow rider coordinate and dynamically raise/shift camera when bottom sheet expands/contracts
  useEffect(() => {
    if (!isFollowing || !activeRiderCoordinate) {
      return;
    }
    const targetBearing =
      povMode === '3d' &&
      rideSnapshot.courseDegrees != null &&
      rideSnapshot.courseDegrees >= 0
        ? rideSnapshot.courseDegrees
        : undefined;

    applyCameraStop({
      center: activeRiderCoordinate,
      pitch: povMode === '3d' ? 55 : 0,
      zoom: navigationZoom,
      padding: cameraPadding,
      ...(targetBearing !== undefined ? { bearing: targetBearing } : {}),
      duration: hasCenteredOnUser.current ? 450 : 500,
      easing: hasCenteredOnUser.current ? 'linear' : 'ease',
    });
    hasCenteredOnUser.current = true;
  }, [
    isFollowing,
    activeRiderCoordinate,
    povMode,
    rideSnapshot.courseDegrees,
    navigationZoom,
    cameraPadding,
  ]);



  async function startRecordedRide() {
    if (!routeHasOfflineMap) {
      return false;
    }
    let locationAllowed = false;
    try {
      locationAllowed = await LocationManager.requestPermissions();
    } catch {
      locationAllowed = false;
    }
    if (!locationAllowed) {
      Alert.alert('Lokasi belum diizinkan', 'Aktifkan lokasi tepat untuk CycleComp di Pengaturan iPhone.');
      return false;
    }
    hasCenteredOnUser.current = false;
    setRideFollowing(true);
    setPovMode('3d');
    setAreaPickerOpen(false);

    if (currentPosition?.coordinate) {
      hasCenteredOnUser.current = true;
      applyCameraStop({
        center: currentPosition.coordinate,
        pitch: 55,
        zoom: INITIAL_NAVIGATION_ZOOM,
        padding: cameraPadding,
        duration: 500,
      });
    }

    const startedRide = await startRide();
    return startedRide?.status === 'active';
  }

  async function startRouteBack() {
    if (routeBackBusy || routeBackActive) {
      return;
    }

    setRouteBackBusy(true);
    const routeBeforeReturn = importedRoute;

    try {
      let routeToReturn: GpxRoute | null = null;
      let routeToRestore: GpxRoute | null = routeBeforeReturn;

      if (routeBeforeReturn) {
        routeToReturn = reverseRouteForReturn(routeBeforeReturn);
      } else {
        const freshRideSnapshot = await refreshRide();
        const elevationTrackSegments = await getRideElevationTrack();
        const recordedTrackSegments = elevationTrackSegments.length > 0
          ? elevationTrackSegments
          : freshRideSnapshot?.trackSegments?.map(trackSegment => trackSegment.map(coordinate => ({
            coordinate,
            elevationMeters: null,
          }))) ?? [];
        const recordedRouteBack = await prepareRecordedRouteBack(recordedTrackSegments);

        routeToReturn = recordedRouteBack?.returnRoute ?? null;
        routeToRestore = recordedRouteBack?.forwardRoute ?? null;
      }

      if (!routeToReturn || !routeToRestore) {
        Alert.alert(
          'Jejak belum cukup',
          'Route Back tersedia setelah CycleComp merekam setidaknya 30 meter jalur GPS.',
        );
        return;
      }

      setRouteLoadState({ status: 'loaded', route: routeToReturn });
      setRideFollowing(true);
      setPovMode('3d');
      setActiveTab('ride');
      hasCenteredOnUser.current = false;

      if (rideIsOpen) {
        const routeBackRide = rideSnapshot.status === 'active'
          ? rideSnapshot
          : await resumeRide();

        if (!routeBackRide) {
          setRouteLoadState({ status: 'loaded', route: routeBeforeReturn ?? routeToRestore });
          return;
        }

        const activeRideCoordinate = routeBackRide.lastCoordinate ?? currentPosition?.coordinate;
        if (activeRideCoordinate) {
          applyCameraStop({
            center: activeRideCoordinate,
            pitch: 55,
            zoom: navigationZoom,
            padding: cameraPadding,
            duration: 450,
          });
          hasCenteredOnUser.current = true;
        }

        setRouteBackSourceRoute(routeToRestore);
        setRouteBackActive(true);
        return;
      }

      const rideStarted = await startRecordedRide();
      if (!rideStarted) {
        setRouteLoadState({ status: 'loaded', route: routeBeforeReturn ?? routeToRestore });
        return;
      }

      setRouteBackSourceRoute(routeToRestore);
      setRouteBackActive(true);
    } catch (error) {
      setRouteLoadState(
        routeBeforeReturn
          ? { status: 'loaded', route: routeBeforeReturn }
          : { status: 'empty' },
      );
      Alert.alert(
        'Route Back belum siap',
        error instanceof Error ? error.message : 'Jejak GPS belum dapat dibaca.',
      );
    } finally {
      setRouteBackBusy(false);
    }
  }

  function confirmFinishRide() {
    Alert.alert(
      'Selesaikan perjalanan?',
      'Jejak GPS yang terekam akan disimpan sebagai file GPX di perangkat.',
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Selesai dan simpan',
          onPress: async () => {
            const finishedRide = await finishRide();
            void rideHistory.loadRides();
            if (finishedRide?.status === 'finished' && routeBackSourceRoute) {
              setRouteLoadState({ status: 'loaded', route: routeBackSourceRoute });
              setRouteBackSourceRoute(null);
              setRouteBackActive(false);
            }
          },
        },
      ],
    );
  }

  function togglePovMode() {
    const nextMode = povMode === '3d' ? '2d' : '3d';
    setPovMode(nextMode);
    const target = rideSnapshot.lastCoordinate ?? currentPosition?.coordinate;
    if (nextMode === '2d') {
      applyCameraStop({
        ...(target && rideFollowing ? { center: target } : {}),
        pitch: 0,
        bearing: 0,
        padding: cameraPadding,
        duration: 300,
      });
    } else {
      applyCameraStop({
        ...(target && rideFollowing ? { center: target } : {}),
        pitch: 55,
        padding: cameraPadding,
        duration: 300,
      });
    }
  }

  function changeRideZoom(zoomDifference: number) {
    const requestedZoom = Math.max(
      MIN_NAVIGATION_ZOOM,
      Math.min(MAX_NAVIGATION_ZOOM, visibleMapZoom.current + zoomDifference),
    );
    visibleMapZoom.current = requestedZoom;
    setNavigationZoom(requestedZoom);
    applyCameraStop({ zoom: requestedZoom, duration: 200, easing: 'ease' });
  }

  function changeNavigationZoom(zoomDifference: number) {
    const requestedZoom = Math.max(
      MIN_NAVIGATION_ZOOM,
      Math.min(MAX_NAVIGATION_ZOOM, visibleMapZoom.current + zoomDifference),
    );
    visibleMapZoom.current = requestedZoom;
    applyCameraStop({ zoom: requestedZoom, duration: 200, easing: 'ease' });
  }

  function changeAreaZoom(zoomDifference: number) {
    const requestedZoom = Math.max(
      MIN_NAVIGATION_ZOOM,
      Math.min(MAX_NAVIGATION_ZOOM, visibleMapZoom.current + zoomDifference),
    );
    visibleMapZoom.current = requestedZoom;
    applyCameraStop({ zoom: requestedZoom, duration: 200, easing: 'ease' });
  }

  function selectMainTab(tab: MainTab) {
    setActiveTab(tab);
    setAreaPickerOpen(tab === 'maps');
  }

  function applyCameraStop(stop: Parameters<CameraRef['setStop']>[0]) {
    try {
      const cameraUpdate = cameraRef.current?.setStop(stop);
      cameraUpdate?.catch(error => {
        if (isDetachedCameraError(error)) {
          return;
        }
        console.warn('CycleComp camera update failed', error);
      });
    } catch (error) {
      if (!isDetachedCameraError(error)) {
        console.warn('CycleComp camera update failed', error);
      }
    }
  }

  async function replaceAreaCoverage(areaId: string, bounds: RouteBounds) {
    setUpdatingAreaId(areaId);
    try {
      await updateArea(areaId, bounds);
    } finally {
      setUpdatingAreaId(null);
    }
  }

  async function importGpxRoute() {
    const previousRouteLoadState = routeLoadState;
    setRouteLoadState({ status: 'loading' });

    try {
      const route = await pickAndImportGpxRoute();
      setRouteLoadState({ status: 'loaded', route });
      setRouteBackActive(false);
      setRouteBackSourceRoute(null);
      setActiveTab('routes');
      fitRouteBounds(route.bounds);
    } catch (error) {
      if (error instanceof GpxImportCanceledError) {
        setRouteLoadState(previousRouteLoadState);
        return;
      }

      setRouteLoadState({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'GPX tidak dapat dibaca. Pilih file lain.',
      });
    }
  }

  function confirmClearGpxRoute() {
    Alert.alert(
      'Hapus rute GPX?',
      'Rute akan dilepas dari peta dan kembali ke mode navigasi bebas tanpa GPX.',
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Hapus rute',
          style: 'destructive',
          onPress: () => {
            setRouteLoadState({ status: 'empty' });
            setRouteBackSourceRoute(null);
            setRouteBackActive(false);
          },
        },
      ],
    );
  }

  function confirmDeleteArea(area: SavedMapArea, areaIndex: number) {
    Alert.alert(
      `Hapus Area ${areaIndex + 1}?`,
      `Area peta offline sebesar ${formatMapSize(area.downloadedBytes)} akan dihapus dari penyimpanan iPhone.`,
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Hapus',
          style: 'destructive',
          onPress: () => {
            deleteArea(area.id);
          },
        },
      ],
    );
  }

  const fitRouteBounds = useCallback((bounds: RouteBounds, paddingBottom?: number) => {
    const [west, south, east, north] = bounds;
    const padBottom = paddingBottom ?? Math.max(idlePanelHeight + 24, 340);
    if (Math.abs(east - west) < 0.0001 && Math.abs(north - south) < 0.0001) {
      applyCameraStop({
        center: [(west + east) / 2, (south + north) / 2],
        zoom: 16,
        padding: { top: 90, right: 28, bottom: padBottom, left: 28 },
        duration: 600,
        easing: 'ease',
      });
    } else {
      applyCameraStop({
        bounds,
        padding: { top: 90, right: 28, bottom: padBottom, left: 28 },
        duration: 600,
        easing: 'ease',
      });
    }
  }, [idlePanelHeight]);

  function focusOnArea(bounds: RouteBounds) {
    applyCameraStop({
      bounds,
      pitch: 0,
      padding: cameraPadding,
      duration: 500,
      easing: 'ease',
    });
  }

  function renderRidePanel() {
    const routeIsReady = importedRoute !== null;

    return (
      <View>
        <View style={styles.homeBrandHeader}>
          <Image
            source={require('../../assets/app_icon.png')}
            style={styles.homeBrandIcon}
          />
          <View style={styles.homeBrandTextCol}>
            <Text style={styles.homeEyebrow}>CYCLECOMP · RIDE</Text>
            <Text style={styles.homeTitle}>Siap bersepeda?</Text>
          </View>
        </View>
        {importedRoute ? (
          <View style={styles.homeRouteCard}>
            <View style={styles.homeRouteText}>
              <Text numberOfLines={1} style={styles.homeRouteName}>{importedRoute.name}</Text>
              <Text style={styles.homeRouteFacts}>
                {formatDistance(importedRoute.distanceMeters)} · +{routeElevationAnalysis?.totalAscentMeters ?? 0} m
              </Text>
            </View>
            <Text style={routeHasOfflineMap ? styles.homeReadyLabel : styles.homeNeedsMapLabel}>
              {routeHasOfflineMap ? 'SIAP' : 'BUTUH PETA'}
            </Text>
          </View>
        ) : (
          <Text style={styles.homeDescription}>
            Pilih rute GPX untuk navigasi, atau mulai merekam perjalanan bebas.
          </Text>
        )}
        {routeIsReady && !routeHasOfflineMap ? (
          <ImportButton label="Siapkan peta offline untuk rute" onPress={() => selectMainTab('maps')} variant="secondary" />
        ) : null}
        {(routeIsReady ? routeHasOfflineMap : readyMapAreas.length > 0) && !rideChecking ? (
          <ImportButton
            hint="Meminta izin lokasi lalu mulai merekam perjalanan"
            label={rideBusy ? 'Menyiapkan perjalanan...' : routeIsReady ? 'Mulai navigasi' : 'Mulai ride bebas'}
            onPress={startRecordedRide}
          />
        ) : null}
        <View style={styles.homeSecondaryActions}>
          <Pressable accessibilityRole="button" onPress={importGpxRoute} style={styles.homeSecondaryButton}>
            <Text style={styles.homeSecondaryButtonText}>Pilih GPX</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => setGmapsModalVisible(true)} style={styles.homeSecondaryButton}>
            <Text style={styles.homeSecondaryButtonText}>Link Google Maps</Text>
          </Pressable>
        </View>
        {readyMapAreas.length === 0 ? (
          <Pressable accessibilityRole="button" onPress={() => selectMainTab('maps')} style={styles.homeMapNotice}>
            <Text style={styles.homeMapNoticeTitle}>Peta offline belum disiapkan</Text>
            <Text style={styles.homeMapNoticeText}>Unduh area sebelum mulai ride.</Text>
          </Pressable>
        ) : null}
        {rideError ? <Text style={styles.mapPackError}>{rideError}</Text> : null}
      </View>
    );
  }

  function renderSettingsPanel() {
    return (
      <View>
        <View style={styles.appBrandingCard}>
          <Image
            source={require('../../assets/app_icon.png')}
            style={styles.appBrandingLogo}
          />
          <View style={styles.appBrandingDetails}>
            <Text style={styles.appBrandingTitle}>CycleComp</Text>
            <Text style={styles.appBrandingSubtitle}>GPS & Offline Terrain Computer</Text>
            <Text style={styles.appBrandingMeta}>v0.0.1 (Build 1) · Standalone AMOLED Engine</Text>
          </View>
        </View>

        <Text style={styles.homeEyebrow}>PREFERENSI RIDE</Text>
        <Text style={styles.homeTitle}>Setelan</Text>
        <View style={styles.watchHeartRateRow}>
          <View style={styles.watchHeartRateDescription}>
            <Text style={styles.watchHeartRateTitle}>HR · realme Watch 5</Text>
            <Text style={styles.watchHeartRateHint}>
              {rideSnapshot.watchHeartRateMessage ?? (
                rideSnapshot.watchHeartRateEnabled
                  ? rideSnapshot.watchHeartRateStatus === 'ready'
                    ? 'Jam siap. Mulai Outdoor Cycle di jam dulu, lalu tap Mulai di CycleComp.'
                    : 'Menyiapkan koneksi jam…'
                  : 'Mulai Outdoor Cycle di jam tangan terlebih dahulu, lalu CycleComp akan membaca HR.'
              )}
            </Text>
          </View>
          <Switch
            accessibilityLabel="Gunakan HR realme Watch 5 selama ride"
            disabled={rideBusy || rideChecking || rideSnapshot.watchHeartRateStatus === 'stopping'}
            value={rideSnapshot.watchHeartRateEnabled ?? false}
            onValueChange={enabled => { setWatchHeartRateEnabled(enabled); }}
          />
        </View>
        <View style={styles.watchHeartRateRow}>
          <View style={styles.watchHeartRateDescription}>
            <Text style={styles.watchHeartRateTitle}>Auto-pause</Text>
            <Text style={styles.watchHeartRateHint}>
              Menjeda setelah berhenti terkonfirmasi dari lokasi dan, bila tersedia, aktivitas gerak. Lanjut setelah perpindahan terkonfirmasi.
            </Text>
          </View>
          <Switch
            accessibilityLabel="Auto-pause perjalanan"
            disabled={rideBusy || rideChecking}
            value={rideSnapshot.autoPauseEnabled ?? false}
            onValueChange={enabled => { setAutoPauseEnabled(enabled); }}
          />
        </View>
        <View style={styles.watchHeartRateRow}>
          <View style={styles.watchHeartRateDescription}>
            <Text style={styles.watchHeartRateTitle}>Diagnostik sensor</Text>
            <Text style={styles.watchHeartRateHint}>
              Rekam lokasi tepat, kualitas GPS, dan ringkasan gerak untuk memeriksa speed dan auto-pause. File lokal maksimal 10 MB; bagikan hanya saat diperlukan.
            </Text>
          </View>
          <Switch
            accessibilityLabel="Rekam diagnostik sensor selama ride"
            disabled={rideBusy || rideChecking || rideIsOpen}
            value={rideSnapshot.sensorDiagnosticsEnabled ?? false}
            onValueChange={enabled => { setSensorDiagnosticsEnabled(enabled); }}
          />
        </View>
        <View style={styles.watchHeartRateRow}>
          <View style={styles.watchHeartRateDescription}>
            <Text style={styles.watchHeartRateTitle}>Suara navigasi</Text>
            <Text style={styles.watchHeartRateHint}>Petunjuk belokan dan peringatan saat berkendara.</Text>
          </View>
          <Switch accessibilityLabel="Suara navigasi" value={soundEnabled} onValueChange={handleToggleSound} />
        </View>
        <Pressable
          accessibilityLabel="Kelola peta offline"
          accessibilityRole="button"
          onPress={() => selectMainTab('maps')}
          style={({ pressed }) => [styles.settingsMapSummary, pressed && styles.homeSecondaryButtonPressed]}
        >
          <View style={styles.settingsMapText}>
            <Text style={styles.watchHeartRateTitle}>Peta offline</Text>
            <Text style={styles.watchHeartRateHint}>
              {readyMapAreas.length} area siap · {formatMapSize(totalSavedBytes)} tersimpan
            </Text>
          </View>
          <Text style={styles.settingsMapAction}>Kelola ›</Text>
        </Pressable>
        <Text style={[styles.homeEyebrow, { marginTop: 14 }]}>INTEGRASI STRAVA</Text>
        <StravaSettingsCard
          isConnected={strava.isConnected}
          athlete={strava.athlete}
          onConnect={strava.connect}
          onDisconnect={strava.disconnect}
        />
        <TerrainPackManager mapAreaBounds={readyMapAreas.map(area => area.bounds)} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      {mapVisible ? <Map
        accessibilityLabel="Peta CycleComp"
        mapStyle={mapStyle}
        onLayout={event => {
          const { width, height } = event.nativeEvent.layout;
          setMapViewportSize(previousSize =>
            previousSize.width === width && previousSize.height === height
              ? previousSize
              : { width, height },
          );
        }}
        preferredFramesPerSecond={30}
        ref={mapRef}
        style={styles.map}
        touchPitch={!areaPickerOpen}
        touchRotate={!areaPickerOpen}
        onDidFinishLoadingMap={() => {
          refreshSelectedAreaBoundsFromFrame();
        }}
        onRegionDidChange={event => {
          const { center, zoom, bearing, pitch } = event.nativeEvent;
          lastMapView.current = { context: mapContext, view: { center, zoom, bearing, pitch } };
          visibleMapZoom.current = event.nativeEvent.zoom;
          if (areaPickerOpen) {
            refreshSelectedAreaBoundsFromFrame();
          }
        }}
        onRegionWillChange={event => {
          if (rideIsOpen && event.nativeEvent.userInteraction) {
            setRideFollowing(false);
          } else if (!rideIsOpen && event.nativeEvent.userInteraction) {
            setPreviewFollowing(false);
            pendingCenterOnUser.current = false;
          }
        }}
      >
        <Camera
          key={
            activePreviewRoute
              ? `route-${activePreviewRoute.sourceFileName || activePreviewRoute.name || 'preview'}`
              : 'empty-route'
          }
          ref={cameraRef}
          testID="route-camera"
          initialViewState={
            lastMapView.current?.context === mapContext
              ? lastMapView.current.view
              : areaPickerOpen
              ? {
                  center: startingMapCenter,
                  zoom: 14,
                }
              : activePreviewRoute
              ? {
                  bounds: activePreviewRoute.bounds,
                  padding: { top: 90, right: 28, bottom: Math.max(idlePanelHeight + 24, 340), left: 28 },
                }
              : {
                  center: startingMapCenter,
                  zoom: 14,
                }
          }
          maxZoom={MAX_NAVIGATION_ZOOM}
          minZoom={MIN_NAVIGATION_ZOOM}
          pitch={isFollowing && povMode === '3d' ? 55 : 0}
          padding={cameraPadding}
          center={
            isFollowing
              ? (activeRiderCoordinate ?? undefined)
              : previewFollowing && !rideIsOpen && !activePreviewRoute
              ? (currentPosition?.coordinate ?? undefined)
              : undefined
          }
          zoom={
            rideIsOpen && rideFollowing
              ? navigationZoom
              : undefined
          }
        />
        {showUserLocation ? (
          <NativeUserLocation mode="heading" testID="user-location-dot" />
        ) : null}
        {gradientRouteFeature ? (
          <GeoJSONSource data={gradientRouteFeature} id="imported-route-gradient">
            <Layer
              id="imported-route-gradient-outline"
              layout={{
                'line-cap': 'round',
                'line-join': 'round',
              }}
              paint={{
                'line-color': '#000000',
                'line-opacity': 0.9,
                'line-width': 7.5,
              }}
              type="line"
            />
            <Layer
              id="imported-route-gradient-line"
              layout={{
                'line-cap': 'round',
                'line-join': 'round',
              }}
              paint={{
                'line-color': ['get', 'color'],
                'line-width': 5,
              }}
              type="line"
            />
          </GeoJSONSource>
        ) : routeLineFeature ? (
          <GeoJSONSource data={routeLineFeature} id="imported-route">
            <Layer
              id="imported-route-outline"
              layout={{
                'line-cap': 'round',
                'line-join': 'round',
              }}
              paint={{
                'line-color': '#1C1C1E',
                'line-opacity': 0.85,
                'line-width': 7,
              }}
              type="line"
            />
            <Layer
              id="imported-route-line"
              layout={{
                'line-cap': 'round',
                'line-join': 'round',
              }}
              paint={{
                'line-color': rideIsOpen ? '#8E8E93' : '#FF521A',
                'line-width': 4,
              }}
              type="line"
            />
          </GeoJSONSource>
        ) : null}
        {recordedLineFeature ? (
          <GeoJSONSource data={recordedLineFeature} id="recorded-ride">
            <Layer
              id="recorded-ride-outline"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': '#1C1C1E', 'line-width': 7 }}
              type="line"
            />
            <Layer
              id="recorded-ride-line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': '#E86A28', 'line-width': 4 }}
              type="line"
            />
          </GeoJSONSource>
        ) : null}
        {routeStartPointFeature ? (
          <GeoJSONSource data={routeStartPointFeature} id="route-start-point">
            <Layer
              id="route-start-circle"
              paint={{
                'circle-color': '#10B981',
                'circle-radius': 7,
                'circle-stroke-color': '#FFFFFF',
                'circle-stroke-width': 2,
              }}
              type="circle"
            />
          </GeoJSONSource>
        ) : null}
        {routeFinishPointFeature ? (
          <GeoJSONSource data={routeFinishPointFeature} id="route-finish-point">
            <Layer
              id="route-finish-circle"
              paint={{
                'circle-color': '#EF4444',
                'circle-radius': 7,
                'circle-stroke-color': '#FFFFFF',
                'circle-stroke-width': 2,
              }}
              type="circle"
            />
          </GeoJSONSource>
        ) : null}
      </Map> : null}

      {areaPickerOpen && !rideIsOpen ? (
        <View
          pointerEvents="none"
          testID="area-selection-frame"
          style={[
            styles.areaSelectionFrame,
            areaSelectionFrameLayout,
          ]}
        >
          <View style={styles.areaSelectionLabel}>
            <Text style={styles.areaSelectionLabelText}>AREA DIPILIH</Text>
          </View>
        </View>
      ) : null}

      {/* Top Floating Header Pill */}
      {!areaPickerOpen ? (
        <SafeAreaView edges={['top']} pointerEvents="box-none" style={styles.topHudContainer}>
          {rideIsOpen ? (
            <NavigationGuidanceBanner
              instruction={turnGuidance}
              climbAlert={climbAlert}
              routeName={importedRoute ? importedRoute.name : undefined}
              isPaused={rideSnapshot.status === 'paused'}
              accuracyMeters={rideSnapshot.horizontalAccuracyMeters}
              soundEnabled={soundEnabled}
              onToggleSound={handleToggleSound}
            />
          ) : (
            <View style={styles.topGlassCapsule}>
              <Image
                source={require('../../assets/app_icon.png')}
                style={styles.topCapsuleAppIcon}
              />
              <Text style={styles.topCapsuleTitle}>CycleComp</Text>
              <View style={styles.topCapsuleDivider} />
              <View
                style={[
                  styles.topCapsuleIconDot,
                  currentPosition ? styles.topCapsuleGpsActiveDot : null,
                ]}
              />
              <Text style={styles.topCapsuleSubtitle}>
                {currentPosition
                  ? `GPS ±${currentPosition.accuracyMeters} m`
                  : readyMapAreas.length > 0
                  ? `${readyMapAreas.length} Peta Siap`
                  : 'Indonesia'}
              </Text>
            </View>
          )}
        </SafeAreaView>
      ) : null}

      {rideIsOpen ? (
        <RideDashboard
          visible={appActive && !enduranceCovered}
          ride={rideSnapshot}
          busy={rideBusy}
          error={rideError}
          following={rideFollowing}
          currentGrade={rideSnapshot.status === 'active' && rideHasFreshFix
            ? rideSnapshot.liveGradePercent ?? null
            : null}
          currentGradeSource={rideSnapshot.status === 'active' && rideHasFreshFix
            ? rideSnapshot.liveGradeSource ?? null
            : null}
          climbAlert={climbAlert}
          povMode={povMode}
          onTogglePov={togglePovMode}
          enduranceActive={enduranceModeActive}
          onToggleEndurance={handleToggleEndurance}
          canRouteBack={
            !routeBackActive &&
            (importedRoute !== null || (rideSnapshot.pointCount ?? 0) >= 2)
          }
          routeBackBusy={routeBackBusy}
          onRouteBack={startRouteBack}
          onRecenter={() => {
            setRideFollowing(true);
            const target = rideSnapshot.lastCoordinate ?? currentPosition?.coordinate;
            if (target) {
              applyCameraStop({
                center: target,
                pitch: povMode === '3d' ? 55 : 0,
                zoom: navigationZoom,
                padding: cameraPadding,
                duration: 350,
                easing: 'ease',
              });
            }
          }}
          onZoomIn={() => changeRideZoom(1)}
          onZoomOut={() => changeRideZoom(-1)}
          onToggleAutoPause={enabled => { setAutoPauseEnabled(enabled); }}
          onPause={() => { pauseRide(); }}
          onResume={() => { resumeRide(); }}
          onFinish={confirmFinishRide}
          onHeightChange={setDashboardHeight}
        />
      ) : areaPickerOpen ? (
        <View pointerEvents="box-none" style={styles.bottomSheetContainer}>
          <View pointerEvents="box-none" style={styles.areaZoomControlsRow}>
            <View style={styles.mapControlsCluster}>
              <NavigationButton
                active={previewFollowing}
                accessibilityLabel="Pusatkan ke lokasi saya"
                label={isLocating ? '...' : ''}
                icon={isLocating ? undefined : 'location.fill'}
                onPress={locateUser}
                square
              />
              <NavigationButton
                accessibilityLabel="Perkecil area peta"
                label="−"
                onPress={() => changeAreaZoom(-1)}
                square
              />
              <NavigationButton
                accessibilityLabel="Perbesar area peta"
                label="+"
                onPress={() => changeAreaZoom(1)}
                square
              />
            </View>
          </View>
          <View style={[styles.bottomSheetCard, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeaderRow}>
              <View style={styles.headerTitleBlock}>
                <Text style={styles.technicalLabel}>PETA OFFLINE</Text>
                <Text style={styles.stateTitle}>
                  {savedMapAreas.length > 0 ? 'Kelola area offline' : 'Pilih area offline'}
                </Text>
              </View>
              <NavigationButton label="Tutup" onPress={() => selectMainTab('ride')} />
            </View>

            <ScrollView
              style={[styles.sheetScrollBody, { maxHeight: windowHeight * 0.43 }]}
              contentContainerStyle={styles.sheetScrollContent}
              showsVerticalScrollIndicator={false}
            >
              {savedMapAreas.length > 0 ? (
                <View style={styles.mapPackStorageSummary}>
                  <SFIcon name="internaldrive" color={AmoledTheme.textSecondary} size={15} />
                  <Text style={styles.storageSummaryText}>
                    {savedMapAreas.length} area tersimpan · Total {formatMapSize(totalSavedBytes)}
                  </Text>
                </View>
              ) : null}

              {savedMapAreas.length > 0 ? (
                <View style={styles.savedAreasSection}>
                  <Text style={styles.sectionHeaderTitle}>AREA TERSIMPAN</Text>
                  {savedMapAreas.map((area, areaIndex) => {
                    const updateProgress = areaUpdateProgress[area.id];
                    let areaStatusText: string;
                    if (updateProgress) {
                      areaStatusText = `Memperbarui ${Math.round(
                        updateProgress.percentage,
                      )}% (${formatMapSize(updateProgress.downloadedBytes)})`;
                    } else if (area.status === 'ready') {
                      areaStatusText = `Tersimpan · ${formatMapSize(
                        area.downloadedBytes,
                      )}`;
                    } else if (area.status === 'downloading') {
                      areaStatusText = `Mengunduh ${Math.round(
                        area.percentage,
                      )}% (${formatMapSize(area.downloadedBytes)})`;
                    } else if (area.status === 'paused') {
                      areaStatusText = `Dijeda ${Math.round(
                        area.percentage,
                      )}% (${formatMapSize(area.downloadedBytes)})`;
                    } else {
                      areaStatusText = 'Gagal mengunduh';
                    }

                    return (
                      <View key={area.id} style={styles.savedAreaCard}>
                        <View style={styles.savedAreaHeader}>
                          <View style={styles.savedAreaTitleCol}>
                            <Text style={styles.savedAreaTitle}>{`Area ${areaIndex + 1}`}</Text>
                            <Text style={styles.savedAreaSubtitle}>{areaStatusText}</Text>
                          </View>
                        </View>
                        <Text style={styles.savedAreaBounds}>
                          Cakupan: {formatMapAreaBounds(area.bounds)}
                        </Text>
                        <View style={styles.savedAreaActions}>
                          <Pressable
                            accessibilityLabel={`Tampilkan seluruh batas Area ${
                              areaIndex + 1
                            } di peta`}
                            accessibilityRole="button"
                            onPress={() => focusOnArea(area.bounds)}
                            style={({ pressed }) => [
                              styles.areaActionBtn,
                              pressed && styles.areaActionBtnPressed,
                            ]}
                          >
                            <Text style={styles.areaActionBtnText}>Lihat</Text>
                          </Pressable>
                          <Pressable
                            accessibilityLabel={`${
                              area.status === 'ready'
                                ? 'Terapkan cakupan pilihan ke'
                                : area.status === 'downloading'
                                  ? 'Jeda'
                                  : 'Lanjutkan'
                            } Area ${areaIndex + 1}`}
                            accessibilityRole="button"
                            disabled={
                              updatingAreaId !== null ||
                              (area.status === 'ready' &&
                                Boolean(
                                  selectedAreaBounds &&
                                    !boundsContain(
                                      INDONESIA_MAP_BOUNDS,
                                      selectedAreaBounds,
                                    ),
                                ))
                            }
                            onPress={() => {
                              if (area.status === 'ready') {
                                replaceAreaCoverage(
                                  area.id,
                                  selectedAreaBounds ?? area.bounds,
                                );
                              } else if (area.status === 'downloading') {
                                pauseArea(area.id);
                              } else {
                                resumeArea(area.id);
                              }
                            }}
                            style={({ pressed }) => [
                              styles.areaActionBtn,
                              pressed && styles.areaActionBtnPressed,
                              updatingAreaId !== null && styles.areaActionBtnDisabled,
                            ]}
                          >
                            <Text style={styles.areaActionBtnText}>
                              {area.status === 'ready'
                                ? updatingAreaId === area.id
                                  ? '...'
                                  : 'Perbarui'
                                : area.status === 'downloading'
                                  ? 'Jeda'
                                  : 'Lanjut'}
                            </Text>
                          </Pressable>
                          <Pressable
                            accessibilityLabel={`Hapus Area ${areaIndex + 1}`}
                            accessibilityRole="button"
                            disabled={updatingAreaId === area.id}
                            onPress={() => confirmDeleteArea(area, areaIndex)}
                            style={({ pressed }) => [
                              styles.areaDeleteBtn,
                              pressed && styles.areaDeleteBtnPressed,
                              updatingAreaId === area.id && styles.areaActionBtnDisabled,
                            ]}
                          >
                            <Text style={styles.areaDeleteBtnText}>Hapus</Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })}
                </View>
              ) : null}

              <View style={styles.addAreaSection}>
                <Text style={styles.sectionHeaderTitle}>TAMBAH AREA BARU</Text>
                <Text style={styles.stateDescription}>
                  Geser atau zoom peta untuk memilih cakupan. Pilihan baru
                  diterapkan setelah Unduh atau Perbarui.
                </Text>
                {selectedAreaBounds ? (
                  <Text style={styles.selectedAreaBounds}>
                    Pilihan: {formatMapAreaBounds(selectedAreaBounds)}
                  </Text>
                ) : null}
                {mapPackError ? (
                  <Text style={styles.mapPackError}>
                    Paket peta gagal diproses: {mapPackError}
                  </Text>
                ) : null}
                {!mapPackError &&
                selectedAreaBounds &&
                !boundsContain(INDONESIA_MAP_BOUNDS, selectedAreaBounds) ? (
                  <Text style={styles.mapPackError}>
                    Kotak melewati batas wilayah Indonesia. Perbesar atau geser
                    ke dalam area.
                  </Text>
                ) : !mapPackError && selectedAreaAlreadySaved ? (
                  <Text style={styles.mapPackText}>
                    Area pilihan ini sudah tercakup dalam peta tersimpan.
                  </Text>
                ) : null}
                <MapPackButton
                  label={areaDownloadInProgress ? 'Sedang mengunduh...' : 'Unduh area ini'}
                  disabled={
                    !selectedAreaBounds ||
                    !boundsContain(INDONESIA_MAP_BOUNDS, selectedAreaBounds) ||
                    selectedAreaAlreadySaved ||
                    areaDownloadInProgress
                  }
                  onPress={() => {
                    if (selectedAreaBounds) {
                      downloadArea(selectedAreaBounds);
                    }
                  }}
                />
              </View>
            </ScrollView>
            <MainTabBar activeTab={activeTab} onSelect={selectMainTab} />
          </View>
        </View>
      ) : lastFinishedRide ? null : (
        <View pointerEvents="box-none" style={styles.bottomSheetContainer}>
          <View
            pointerEvents="box-none"
            style={styles.mapControlsRow}
          >
            <View style={styles.mapControlsCluster}>
              <NavigationButton
                active={previewFollowing}
                accessibilityLabel="Pusatkan ke lokasi saya"
                label={isLocating ? '...' : ''}
                icon={isLocating ? undefined : 'location.fill'}
                onPress={locateUser}
                square
              />
              <NavigationButton
                accessibilityLabel="Buat rute dari Google Maps"
                label=""
                icon="link"
                onPress={() => setGmapsModalVisible(true)}
                square
              />
              <NavigationButton
                accessibilityLabel="Perkecil peta"
                label="−"
                onPress={() => changeNavigationZoom(-1)}
                square
              />
              <NavigationButton
                accessibilityLabel="Perbesar peta"
                label="+"
                onPress={() => changeNavigationZoom(1)}
                square
              />
            </View>
          </View>
          <View
            onLayout={event => {
              const panelHeight = event.nativeEvent.layout.height;
              if (panelHeight > 0) setIdlePanelHeight(panelHeight);
            }}
            style={[
              styles.bottomSheetCard,
              styles.mainTabPanel,
              { paddingBottom: Math.max(insets.bottom, 12) },
            ]}
          >
            <ScrollView
              style={{ maxHeight: windowHeight * 0.48 }}
              contentContainerStyle={styles.mainTabContent}
              showsVerticalScrollIndicator={false}
            >
              {activeTab === 'ride'
                ? renderRidePanel()
                : activeTab === 'routes'
                  ? renderRoutesPanel()
                  : renderSettingsPanel()}
            </ScrollView>
            <MainTabBar activeTab={activeTab} onSelect={selectMainTab} />
          </View>
        </View>
      )}

      {lastFinishedRide ? (
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.technicalLabel}>Perjalanan selesai</Text>
            <Text style={styles.stateTitle}>
              {lastFinishedRide.fileUrl ? 'GPX tersimpan' : 'Tidak ada titik GPS'}
            </Text>
            <Text style={styles.stateDescription}>
              {lastFinishedRide.fileUrl
                ? `${formatDistance(lastFinishedRide.distanceMeters ?? 0)} direkam dari ${lastFinishedRide.pointCount ?? 0} titik. File tersedia di Files → Di iPhone Saya → CycleComp → Rides.`
                : 'Perjalanan selesai tanpa posisi yang layak direkam, jadi GPX kosong tidak dibuat.'}
            </Text>
            <View style={styles.modalActionsContainer}>
              {lastFinishedRide.fileUrl ? (
                <>
                  <ImportButton
                    label="Bagikan GPX"
                    hint="Pilih Simpan ke File untuk mengunggah rekaman ini ke Strava"
                    onPress={shareFinishedRide}
                  />
                  <Text style={styles.stateDescription}>
                    Untuk Strava, pilih file GPX di CycleComp → Rides pada halaman unggah. Jika folder belum terlihat, simpan dulu lewat Bagikan GPX → Simpan ke File. Setelah masuk Strava, pilih jenis aktivitas Ride lalu simpan.
                  </Text>
                  <ImportButton
                    label="Buka unggah Strava"
                    hint="Membuka situs Strava. Pilih GPX dan simpan aktivitas di sana; belum ada pengiriman otomatis."
                    onPress={openStravaUpload}
                    variant="secondary"
                  />
                </>
              ) : null}
              {lastFinishedRide.sensorTraceFileUrl ? (
                <>
                  <ImportButton
                    label="Bagikan diagnostik sensor"
                    hint="Berisi lokasi tepat. Simpan atau bagikan secara manual untuk analisis ride ini."
                    onPress={shareFinishedSensorTrace}
                    variant="secondary"
                  />
                  {lastFinishedRide.sensorTraceStatus === 'full' || lastFinishedRide.sensorTraceStatus === 'error' ? (
                    <Text style={styles.stateDescription}>
                      {lastFinishedRide.sensorTraceStatus === 'full'
                        ? 'Trace mencapai batas 10 MB; bagian akhir perjalanan tidak tercatat.'
                        : 'Pencatatan diagnostik terhenti karena kesalahan file. Data yang sempat tersimpan masih dapat dibagikan.'}
                    </Text>
                  ) : null}
                </>
              ) : null}
              <Pressable
                accessibilityLabel="Kembali ke peta"
                accessibilityRole="button"
                onPress={dismissFinishedRide}
                style={({ pressed }) => [
                  styles.modalSecondaryButton,
                  pressed && styles.modalSecondaryButtonPressed,
                ]}
              >
                <Text style={styles.modalSecondaryButtonText}>Kembali ke peta</Text>
              </Pressable>
            </View>
            {rideError ? <Text style={styles.mapPackError}>{rideError}</Text> : null}
          </View>
        </View>
      ) : null}

      <GmapsLinkModal
        visible={gmapsModalVisible}
        onClose={() => setGmapsModalVisible(false)}
        onRouteCreated={route => {
          setRouteLoadState({ status: 'loaded', route });
          setRouteBackActive(false);
          setRouteBackSourceRoute(null);
          setActiveTab('routes');
        }}
        userCoordinate={currentPosition?.coordinate}
      />

      <EnduranceScreenOverlay
        visible={enduranceCovered}
        speedKmh={
          rideSnapshot.autoPaused || rideSnapshot.status === 'paused'
            ? 0
            : rideSnapshot.status === 'active' && rideHasFreshFix
              ? (rideSnapshot.speedMetersPerSecond ?? lastKnownSpeedMpsRef.current) != null
                ? (rideSnapshot.speedMetersPerSecond ?? lastKnownSpeedMpsRef.current)! * 3.6
                : null
              : null
        }
        heartRateBpm={rideSnapshot.status === 'active' && rideSnapshot.heartRateRecordedAt &&
          Date.now() - Date.parse(rideSnapshot.heartRateRecordedAt) >= 0 &&
          Date.now() - Date.parse(rideSnapshot.heartRateRecordedAt) <= 15000
          ? rideSnapshot.heartRateBpm : null}
        elapsedSeconds={rideElapsedSeconds(rideSnapshot)}
        distanceMeters={rideSnapshot.distanceMeters}
        movingSeconds={rideSnapshot.movingSeconds}
        totalAscentMeters={rideSnapshot.elevationDataAvailable === false ? null : rideSnapshot.ascentMeters}
        liveGradePercent={rideSnapshot.status === 'active' && rideHasFreshFix
          ? rideSnapshot.liveGradePercent
          : null}
        liveGradeSource={rideSnapshot.status === 'active' && rideHasFreshFix
          ? rideSnapshot.liveGradeSource
          : null}
        routeProfileAvailable={(routeElevationAnalysis?.climbs.length ?? 0) > 0}
        turnInstruction={turnGuidance}
        climbAlert={climbAlert}
        terrainClimbStatus={rideSnapshot.terrainClimbStatus}
        terrainClimbDistanceToStartMeters={rideSnapshot.terrainClimbDistanceToStartMeters}
        terrainClimbAverageGradePercent={rideSnapshot.terrainClimbAverageGradePercent}
        onWakeUp={handleWakeUpEndurance}
        onDisableEndurance={() => setEnduranceModeActive(false)}
      />
    </View>
  );

  function renderRoutesPanel() {
    return (
      <View>
        <View style={styles.segmentControlContainer}>
          <Pressable
            accessibilityRole="tab"
            accessibilityLabel="Tab Riwayat Gowes"
            onPress={() => setRouteSubTab('history')}
            style={[
              styles.segmentButton,
              routeSubTab === 'history' && styles.segmentButtonActive,
            ]}
          >
            <Text
              style={[
                styles.segmentButtonText,
                routeSubTab === 'history' && styles.segmentButtonTextActive,
              ]}
            >
              Riwayat ({rideHistory.rides.length})
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="tab"
            accessibilityLabel="Tab Rute Impor"
            onPress={() => setRouteSubTab('import')}
            style={[
              styles.segmentButton,
              routeSubTab === 'import' && styles.segmentButtonActive,
            ]}
          >
            <Text
              style={[
                styles.segmentButtonText,
                routeSubTab === 'import' && styles.segmentButtonTextActive,
              ]}
            >
              Rute Impor
            </Text>
          </Pressable>
        </View>

        {routeSubTab === 'history' ? (
          <RideHistoryPanel
            rides={rideHistory.rides}
            loading={rideHistory.loading}
            selectedRide={rideHistory.selectedRide}
            loadingSelected={rideHistory.loadingSelected}
            onSelectRide={async (file) => {
              setPreviewFollowing(false);
              pendingCenterOnUser.current = false;
              const detail = await rideHistory.selectRide(file);
              if (detail) {
                fitRouteBounds(detail.route.bounds);
              }
            }}
            onFocusRoute={(route) => {
              setPreviewFollowing(false);
              pendingCenterOnUser.current = false;
              fitRouteBounds(route.bounds);
            }}
            onClearSelectedRide={() => {
              rideHistory.clearSelectedRide();
              if (importedRoute) {
                fitRouteBounds(importedRoute.bounds);
              } else if (currentPosition?.coordinate) {
                applyCameraStop({
                  center: currentPosition.coordinate,
                  zoom: LOCATION_FOLLOW_ZOOM,
                  padding: cameraPadding,
                  duration: 400,
                  easing: 'ease',
                });
              }
            }}
            onDeleteRide={rideHistory.deleteRide}
            onShareRide={rideHistory.shareRide}
            onShareSensorTrace={rideHistory.shareSensorTrace}
            onUseAsNavRoute={(route) => {
              setRouteLoadState({ status: 'loaded', route });
              rideHistory.clearSelectedRide();
              setActiveTab('ride');
              fitRouteBounds(route.bounds);
            }}
            onUploadToStrava={async (selected) => {
              if (!strava.isConnected) {
                Alert.alert(
                  'Hubungkan Strava',
                  'Akun Strava belum terhubung. Buka tab Setelan untuk menghubungkan akun Strava Anda?',
                  [
                    { text: 'Batal', style: 'cancel' },
                    { text: 'Buka Setelan', onPress: () => selectMainTab('settings') },
                  ],
                );
                return;
              }
              const res = await strava.uploadRide(selected.file, selected.route.name);
              if (res.success && res.activityId) {
                Alert.alert(
                  'Berhasil Diunggah!',
                  `Aktivitas "${selected.route.name || selected.file.fileName}" berhasil dipublikasikan ke Strava (ID: #${res.activityId}). Buka di Strava?`,
                  [
                    { text: 'Tutup', style: 'cancel' },
                    {
                      text: 'Buka di Strava',
                      onPress: () => strava.openStravaActivity(res.activityId!),
                    },
                  ],
                );
              }
            }}
            stravaConnected={strava.isConnected}
            stravaUploadingFileId={strava.uploadingFileId}
            stravaUploadProgressMessage={strava.uploadProgressMessage}
            uploadedRides={strava.uploadedRides}
            onOpenStravaActivity={strava.openStravaActivity}
          />
        ) : (
          renderPanelContent()
        )}
      </View>
    );
  }

  function renderPanelContent() {
    if (lastFinishedRide) {
      return (
        <View style={styles.minimizedSheetRow}>
          <View style={styles.minimizedRouteInfoCol}>
            <Text style={styles.minimizedRouteName}>Perjalanan selesai</Text>
            <Text style={styles.minimizedRouteFacts}>
              {lastFinishedRide.fileUrl
                ? `${formatDistance(lastFinishedRide.distanceMeters ?? 0)} direkam`
                : 'Selesai tanpa rekaman'}
            </Text>
          </View>
        </View>
      );
    }

    if (routeLoadState.status === 'loading') {
      return (
        <View accessibilityLiveRegion="polite" style={styles.centeredPanelContent}>
          <ActivityIndicator color="#FF521A" size="small" />
          <Text style={styles.stateTitle}>Membaca GPX</Text>
          <Text style={styles.stateDescription}>
            Memeriksa track, koordinat, dan elevasi.
          </Text>
        </View>
      );
    }

    if (routeLoadState.status === 'error') {
      return (
        <View accessibilityLiveRegion="assertive">
          <Text style={styles.stateTitle}>GPX tidak dapat digunakan</Text>
          <Text style={styles.errorDescription}>{routeLoadState.message}</Text>
          <ImportButton
            hint="Buat rute sepeda otomatis dari link Google Maps"
            label="Buat rute dari Google Maps"
            icon="link"
            onPress={() => setGmapsModalVisible(true)}
          />
          <ImportButton label="Pilih file GPX lain" onPress={importGpxRoute} variant="secondary" />
        </View>
      );
    }

    if (routeLoadState.status === 'loaded') {
      const { route } = routeLoadState;
      const terrainElevationNote = terrainElevationEnrichmentMessage(
        route.terrainElevationEnrichment,
      );

      return (
        <View>
          <View style={styles.loadedRouteHeader}>
            <View style={styles.loadedRouteTitleBlock}>
              <Text style={styles.technicalLabel}>RUTE GPX</Text>
              <Text numberOfLines={2} style={styles.routeName}>
                {route.name}
              </Text>
            </View>
            <View style={styles.loadedRouteHeaderActions}>
              <Pressable
                accessibilityLabel="Hapus rute GPX dari peta"
                accessibilityRole="button"
                onPress={confirmClearGpxRoute}
                style={({ pressed }) => [
                  styles.clearRouteButton,
                  pressed && styles.clearRouteButtonPressed,
                ]}
              >
                <Text style={styles.clearRouteButtonText}>✕ Hapus</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.routeFacts}>
            <RouteFact
              label="Jarak"
              value={(route.distanceMeters / 1000).toLocaleString('id-ID', {
                maximumFractionDigits: 1,
                minimumFractionDigits: 1,
              })}
              unit="km"
            />
            <RouteFact
              label="Titik"
              value={route.pointCount.toLocaleString('id-ID')}
            />
            <RouteFact
              label="Elevasi"
              value={
                route.minimumElevationMeters !== null && route.maximumElevationMeters !== null
                  ? `${Math.round(route.minimumElevationMeters)}–${Math.round(route.maximumElevationMeters)}`
                  : '—'
              }
              unit={route.minimumElevationMeters !== null ? 'm' : undefined}
            />
            {routeElevationAnalysis ? (
              <RouteFact
                label="Total naik"
                value={`+${routeElevationAnalysis.totalAscentMeters}`}
                unit="m"
              />
            ) : null}
          </View>
          {terrainElevationNote ? (
            <Text
              style={[
                styles.terrainElevationNote,
                route.terrainElevationEnrichment?.status === 'lookup_error' && styles.terrainElevationWarning,
              ]}
            >
              {terrainElevationNote}
            </Text>
          ) : null}
          {routeElevationAnalysis && routeElevationAnalysis.samples.length > 0 ? (
            <View style={styles.elevationChartContainer}>
              <View style={styles.elevationChartHeaderRow}>
                <Text style={styles.technicalLabel}>PROFIL ELEVASI RUTE</Text>
              </View>
              <ElevationProfileChart
                samples={routeElevationAnalysis.samples}
                height={85}
                interactive={true}
                showLabels={true}
              />
            </View>
          ) : null}

          {routeElevationAnalysis && routeElevationAnalysis.climbs.length > 0 ? (
            <ClimbListSection
              climbs={routeElevationAnalysis.climbs}
              maxGradePercent={routeElevationAnalysis.maxGradePercent}
              totalAscentMeters={routeElevationAnalysis.totalAscentMeters}
              onSelectClimb={climb => {
                applyCameraStop({
                  center: climb.startCoordinate,
                  zoom: 15,
                  duration: 400,
                });
              }}
            />
          ) : null}
          <View style={styles.gradientLegendRow}>
            <View style={styles.legendChip}>
              <View style={[styles.legendDot, { backgroundColor: '#0284C7' }]} />
              <Text style={styles.legendText}>Turun</Text>
            </View>
            <View style={styles.legendChip}>
              <View style={[styles.legendDot, { backgroundColor: '#10B981' }]} />
              <Text style={styles.legendText}>0–3%</Text>
            </View>
            <View style={styles.legendChip}>
              <View style={[styles.legendDot, { backgroundColor: '#F59E0B' }]} />
              <Text style={styles.legendText}>3–6%</Text>
            </View>
            <View style={styles.legendChip}>
              <View style={[styles.legendDot, { backgroundColor: '#F97316' }]} />
              <Text style={styles.legendText}>6–9%</Text>
            </View>
            <View style={styles.legendChip}>
              <View style={[styles.legendDot, { backgroundColor: '#DC2626' }]} />
              <Text style={styles.legendText}>9–13%</Text>
            </View>
            <View style={styles.legendChip}>
              <View style={[styles.legendDot, { backgroundColor: '#FF1E42' }]} />
              <Text style={styles.legendText}>≥13%</Text>
            </View>
          </View>
          <MapPackControl
            mapPackCheck={mapPackCheck}
            readyAreaCount={readyMapAreas.length}
            routeHasOfflineMap={routeHasOfflineMap}
            terrainStatus={routeTerrainStatus}
            onManage={() => selectMainTab('maps')}
            onManageTerrain={() => selectMainTab('settings')}
          />
          {routeHasOfflineMap && !rideChecking ? (
            <View style={styles.routeDirectionSection}>
              <Text style={styles.routeDirectionTitle}>Arah perjalanan</Text>
              <Text style={styles.routeDirectionHint}>
                Pilih arah untuk mengikuti jalur GPX ini.
              </Text>
              <View style={styles.routeDirectionActions}>
                <RouteDirectionButton
                  icon="arrow.up.forward"
                  label={rideBusy ? 'Menyiapkan...' : 'Ikuti rute'}
                  accessibilityLabel="Mulai navigasi mengikuti arah rute GPX"
                  primary={true}
                  disabled={rideBusy || routeBackBusy}
                  onPress={startRecordedRide}
                />
                <RouteDirectionButton
                  icon="arrow.uturn.backward"
                  label={routeBackBusy ? 'Menyiapkan...' : 'Rute balik'}
                  accessibilityLabel="Mulai Route Back menuju titik awal melalui jalur GPX yang sama"
                  disabled={rideBusy || routeBackBusy}
                  onPress={startRouteBack}
                />
              </View>
              <Text style={styles.routeDirectionFootnote}>
                Rute balik mengikuti jalur yang sama menuju titik awal.
              </Text>
            </View>
          ) : null}
          {rideError ? <Text style={styles.mapPackError}>{rideError}</Text> : null}
          <View style={styles.loadedRouteSecondaryActionsRow}>
            <Pressable
              accessibilityHint="Buat rute sepeda otomatis dari link Google Maps"
              accessibilityLabel="Link GMaps"
              accessibilityRole="button"
              onPress={() => setGmapsModalVisible(true)}
              style={({ pressed }) => [
                styles.secondaryActionButton,
                pressed && styles.secondaryActionButtonPressed,
              ]}
            >
              <SFIcon name="link" color={AmoledTheme.textPrimary} size={15} />
              <Text style={styles.secondaryActionButtonText}>Link GMaps</Text>
            </Pressable>
            <Pressable
              accessibilityHint="Membuka file GPX lain dari perangkat"
              accessibilityLabel="Ganti GPX"
              accessibilityRole="button"
              onPress={importGpxRoute}
              style={({ pressed }) => [
                styles.secondaryActionButton,
                pressed && styles.secondaryActionButtonPressed,
              ]}
            >
              <SFIcon name="folder" color={AmoledTheme.textPrimary} size={15} />
              <Text style={styles.secondaryActionButtonText}>Ganti GPX</Text>
            </Pressable>
            <Pressable
              accessibilityHint="Hapus rute GPX saat ini dari peta"
              accessibilityLabel="Hapus rute GPX"
              accessibilityRole="button"
              onPress={confirmClearGpxRoute}
              style={({ pressed }) => [
                styles.secondaryActionDestructiveButton,
                pressed && styles.secondaryActionDestructiveButtonPressed,
              ]}
            >
              <Text style={styles.secondaryActionDestructiveButtonText}>✕ Hapus</Text>
            </Pressable>
          </View>
          <Text numberOfLines={1} style={styles.sourceFileNameFootnote}>
            {route.sourceFileName}
          </Text>
        </View>
      );
    }

    return (
      <View>
        <View style={styles.emptyStateHeaderRow}>
          <Text style={styles.stateTitle}>Belum ada rute</Text>
        </View>
        <Text style={styles.stateDescription}>
          Tempel link rute dari Google Maps atau pilih file GPX untuk memeriksa jalur dan elevasinya.
        </Text>
        <ImportButton
          hint="Buat rute sepeda otomatis dari link Google Maps"
          label="Buat rute dari Google Maps"
          icon="link"
          onPress={() => setGmapsModalVisible(true)}
        />
        <ImportButton
          label="Pilih file GPX"
          onPress={importGpxRoute}
          variant="secondary"
        />
        <View style={styles.offlineStatusCard}>
          <Text style={styles.onlineMapNotice}>
            {readyMapAreas.length > 0
              ? `${readyMapAreas.length} area offline tersimpan. Impor GPX untuk memeriksa cakupannya.`
              : 'Belum ada peta offline yang tersimpan.'}
          </Text>
          <MapPackButton label="Kelola area peta" onPress={() => selectMainTab('maps')} />
        </View>
        {readyMapAreas.length > 0 && !rideChecking ? (
          <ImportButton
            hint="Mulai mengikuti posisi GPS dan merekam GPX tanpa rute impor"
            label={rideBusy ? 'Menyiapkan perjalanan...' : 'Mulai navigasi'}
            onPress={startRecordedRide}
          />
        ) : null}
        {rideError ? <Text style={styles.mapPackError}>{rideError}</Text> : null}
      </View>
    );
  }
}

interface NavigationButtonProps {
  accessibilityLabel?: string;
  label: string;
  icon?: string;
  onPress: () => void;
  square?: boolean;
  active?: boolean;
  emphasized?: boolean;
}

function NavigationButton({
  accessibilityLabel,
  label,
  icon,
  onPress,
  square = false,
  active = false,
  emphasized = false,
}: NavigationButtonProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.navigationButton,
        square ? styles.squareNavigationButton : null,
        active ? styles.activeNavigationButton : null,
        emphasized ? styles.emphasizedNavigationButton : null,
        pressed ? styles.navigationButtonPressed : null,
      ]}
    >
      {icon ? (
        <SFIcon name={icon} color={active || emphasized ? AmoledTheme.textPrimary : '#FFFFFF'} size={17} />
      ) : (
        <Text
          style={[
            styles.navigationButtonLabel,
            active || emphasized ? styles.activeNavigationButtonLabel : null,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export interface MapPackControlProps {
  mapPackCheck: 'checking' | 'done' | 'failed';
  readyAreaCount: number;
  routeHasOfflineMap: boolean;
  terrainStatus?: 'ready' | 'missing' | 'partial';
  onManage: () => void;
  onManageTerrain?: () => void;
}

export function MapPackControl({
  mapPackCheck,
  readyAreaCount,
  routeHasOfflineMap,
  terrainStatus,
  onManage,
  onManageTerrain,
}: MapPackControlProps) {
  if (mapPackCheck === 'checking') {
    return (
      <View style={styles.mapPackRow}>
        <ActivityIndicator color="#007AFF" size="small" />
        <Text style={styles.mapPackText}>Memeriksa peta offline...</Text>
      </View>
    );
  }

  if (mapPackCheck === 'failed') {
    return (
      <Text style={[styles.mapPackText, styles.mapPackStandalone]}>
        Peta offline belum dapat diperiksa. Buka ulang aplikasi untuk mencoba lagi.
      </Text>
    );
  }

  let statusText: string;
  let showTerrainAction = false;

  if (routeHasOfflineMap) {
    if (terrainStatus === 'ready') {
      statusText = 'Lengkap untuk offline · Peta dan medan siap.';
    } else if (terrainStatus === 'missing') {
      statusText = 'Peta siap · Medan belum diunduh.';
      showTerrainAction = Boolean(onManageTerrain);
    } else if (terrainStatus === 'partial') {
      statusText = 'Peta siap · Data medan belum lengkap.';
      showTerrainAction = Boolean(onManageTerrain);
    } else {
      statusText = `${readyAreaCount} area offline siap untuk GPX ini.`;
    }
  } else {
    statusText = readyAreaCount > 0
      ? 'GPX ini di luar area offline yang tersimpan.'
      : 'Belum ada peta offline.';
  }

  return (
    <View accessibilityLiveRegion="polite" style={styles.mapPackRow}>
      <Text style={[styles.mapPackText, styles.mapPackStatus]}>
        {statusText}
      </Text>
      <View style={styles.mapPackActionsRow}>
        {showTerrainAction ? (
          <MapPackButton label="Lengkapi data medan" onPress={onManageTerrain!} />
        ) : null}
        <MapPackButton label="Kelola peta" onPress={onManage} />
      </View>
    </View>
  );
}

function MapPackButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.mapPackButton,
        disabled ? styles.mapPackButtonDisabled : null,
        pressed ? styles.mapPackButtonPressed : null,
      ]}
    >
      <Text style={styles.mapPackButtonLabel}>{label}</Text>
    </Pressable>
  );
}

interface RouteFactProps {
  label: string;
  unit?: string;
  value: string;
}

function RouteFact({ label, unit, value }: RouteFactProps) {
  return (
    <View style={styles.routeFact}>
      <View style={styles.routeFactValueRow}>
        <Text
          adjustsFontSizeToFit={true}
          minimumFontScale={0.7}
          numberOfLines={1}
          style={styles.routeFactValue}
        >
          {value}
        </Text>
        {unit ? <Text style={styles.routeFactUnit}> {unit}</Text> : null}
      </View>
      <Text numberOfLines={1} style={styles.routeFactLabel}>
        {label}
      </Text>
    </View>
  );
}

interface ImportButtonProps {
  hint?: string;
  label: string;
  icon?: string;
  onPress: () => void;
  compact?: boolean;
  variant?: 'primary' | 'secondary';
}

interface RouteDirectionButtonProps {
  accessibilityLabel: string;
  disabled: boolean;
  icon: string;
  label: string;
  onPress: () => void;
  primary?: boolean;
}

function RouteDirectionButton({
  accessibilityLabel,
  disabled,
  icon,
  label,
  onPress,
  primary = false,
}: RouteDirectionButtonProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.routeDirectionButton,
        primary ? styles.routeDirectionButtonPrimary : null,
        disabled ? styles.routeDirectionButtonDisabled : null,
        pressed && !disabled ? styles.routeDirectionButtonPressed : null,
      ]}
    >
      <SFIcon
        name={icon}
        color={primary ? '#FFFFFF' : AmoledTheme.accentOrange}
        size={17}
      />
      <Text
        numberOfLines={1}
        style={[
          styles.routeDirectionButtonLabel,
          primary ? styles.routeDirectionButtonPrimaryLabel : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function MainTabBar({
  activeTab,
  onSelect,
}: {
  activeTab: MainTab;
  onSelect: (tab: MainTab) => void;
}) {
  return (
    <View accessibilityRole="tabbar" style={styles.mainTabBar}>
      {MAIN_TABS.map(tab => {
        const selected = activeTab === tab.id;
        return (
          <Pressable
            key={tab.id}
            accessibilityLabel={tab.label}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onSelect(tab.id)}
            style={styles.mainTabButton}
          >
            <View style={[styles.mainTabIndicator, selected && styles.mainTabIndicatorSelected]} />
            <Text style={[styles.mainTabLabel, selected && styles.mainTabLabelSelected]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ImportButton({
  hint = 'Membuka pemilih dokumen iOS',
  label,
  icon,
  onPress,
  compact = false,
  variant = 'primary',
}: ImportButtonProps) {
  return (
    <Pressable
      accessibilityHint={hint}
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.importButton,
        variant === 'secondary' ? styles.secondaryImportButton : null,
        compact ? styles.compactImportButton : null,
        pressed ? styles.importButtonPressed : null,
      ]}
    >
      {icon ? <SFIcon name={icon} color={AmoledTheme.textPrimary} size={17} /> : null}
      <Text
        style={[
          styles.importButtonLabel,
          variant === 'secondary' ? styles.secondaryImportButtonLabel : null,
          compact ? styles.compactImportButtonLabel : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function formatDistance(distanceMeters: number) {
  return `${(distanceMeters / 1000).toLocaleString('id-ID', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })} km`;
}

function formatMapAreaBounds(bounds: RouteBounds) {
  const [west, south, east, north] = bounds;
  const formatCoordinate = (
    coordinate: number,
    positiveDirection: string,
    negativeDirection: string,
  ) => `${Math.abs(coordinate).toLocaleString('id-ID', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}° ${coordinate < 0 ? negativeDirection : positiveDirection}`;

  return `${formatCoordinate(west, 'BT', 'BB')}–${formatCoordinate(east, 'BT', 'BB')} · ${formatCoordinate(north, 'LU', 'LS')}–${formatCoordinate(south, 'LU', 'LS')}`;
}

function formatMapSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toLocaleString('id-ID', {
    maximumFractionDigits: 1,
  })} MB`;
}

function isDetachedCameraError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Invalid `reactTag`') && message.includes('MLRNCamera');
}

function terrainElevationEnrichmentMessage(
  enrichment: TerrainElevationEnrichment | undefined,
): string | null {
  if (!enrichment || enrichment.status === 'not_needed') {
    return null;
  }

  if (enrichment.status === 'no_pack') {
    return 'Elevasi yang hilang tetap kosong; belum ada paket medan offline.';
  }
  if (enrichment.status === 'no_coverage') {
    return `Paket medan offline tidak mencakup ${enrichment.pointCountStillUnknown} titik yang elevasinya kosong.`;
  }
  if (enrichment.status === 'lookup_error') {
    return `Lookup elevasi offline gagal. ${enrichment.errorMessage ?? ''}`.trim();
  }

  const source = enrichment.packIDs.join(', ');
  const datum = enrichment.verticalDatums.join(', ');
  const remainingPointMessage = enrichment.pointCountStillUnknown > 0
    ? ` ${enrichment.pointCountStillUnknown} titik tetap kosong.`
    : '';
  return `Elevasi ${enrichment.pointCountAdded} titik dari ${source} · ${datum}.${remainingPointMessage}`;
}

const styles = StyleSheet.create({
  watchHeartRateRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginBottom: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: AmoledTheme.borderDefault,
  },
  watchHeartRateDescription: { flex: 1 },
  watchHeartRateTitle: { color: AmoledTheme.textPrimary, fontSize: 15, fontWeight: '600' },
  watchHeartRateHint: { color: AmoledTheme.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 4 },

  screen: {
    backgroundColor: AmoledTheme.background,
    flex: 1,
  },
  map: {
    flex: 1,
  },
  areaSelectionFrame: {
    backgroundColor: AmoledTheme.accentBlueFill,
    borderColor: AmoledTheme.accentBlue,
    borderRadius: 8,
    borderWidth: 2.5,
    position: 'absolute',
  },
  areaSelectionLabel: {
    alignSelf: 'flex-start',
    backgroundColor: AmoledTheme.accentBlue,
    borderBottomRightRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  areaSelectionLabelText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  areaZoomControlsRow: {
    alignItems: 'flex-end',
    marginBottom: 10,
    paddingHorizontal: 16,
  },
  mapControlsRow: {
    alignItems: 'flex-end',
    marginBottom: 12,
    paddingHorizontal: 16,
  },
  mapControlsCluster: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.overlayBackground,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 6,
    padding: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
  },
  topHudContainer: {
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 99,
  },
  topHudPill: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.overlayBackground,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 6,
  },
  liveIndicatorDot: {
    backgroundColor: AmoledTheme.accentGreen,
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  pausedIndicatorDot: {
    backgroundColor: AmoledTheme.accentYellow,
  },
  topHudTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: -0.2,
    maxWidth: 180,
  },
  topHudBadge: {
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  topHudBadgeText: {
    color: AmoledTheme.textPrimary,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  topGlassCapsule: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: AmoledTheme.overlayBackground,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
  },
  topCapsuleAppIcon: {
    borderRadius: 4,
    height: 18,
    width: 18,
  },
  topCapsuleIconDot: {
    backgroundColor: AmoledTheme.accentOrange,
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  topCapsuleGpsActiveDot: {
    backgroundColor: AmoledTheme.accentGreen,
  },
  topCapsuleTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  topCapsuleDivider: {
    backgroundColor: AmoledTheme.divider,
    height: 12,
    width: 1,
  },
  topCapsuleSubtitle: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  bottomSheetContainer: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  bottomSheetCard: {
    backgroundColor: AmoledTheme.card,
    borderColor: AmoledTheme.borderDefault,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingTop: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.5,
    shadowRadius: 18,
  },
  mainTabPanel: {
    paddingTop: 12,
  },
  mainTabContent: {
    paddingBottom: 12,
  },
  mainTabBar: {
    borderTopColor: AmoledTheme.borderDefault,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    marginHorizontal: -8,
    minHeight: 54,
  },
  mainTabButton: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: 4,
  },
  mainTabIndicator: {
    backgroundColor: 'transparent',
    borderRadius: 2,
    height: 3,
    marginBottom: 7,
    width: 24,
  },
  mainTabIndicatorSelected: {
    backgroundColor: AmoledTheme.accentOrange,
  },
  mainTabLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  mainTabLabelSelected: {
    color: AmoledTheme.textPrimary,
    fontWeight: '700',
  },
  homeBrandHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    marginBottom: 6,
  },
  homeBrandIcon: {
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 10,
    borderWidth: 1,
    height: 42,
    width: 42,
  },
  homeBrandTextCol: {
    flex: 1,
  },
  appBrandingCard: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 14,
    marginBottom: 20,
    padding: 14,
  },
  appBrandingLogo: {
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 12,
    borderWidth: 1,
    height: 48,
    width: 48,
  },
  appBrandingDetails: {
    flex: 1,
  },
  appBrandingTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  appBrandingSubtitle: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  appBrandingMeta: {
    color: AmoledTheme.accentOrange,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
  },
  segmentControlContainer: {
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 14,
    padding: 3,
  },
  segmentButton: {
    alignItems: 'center',
    borderRadius: 9,
    flex: 1,
    paddingVertical: 8,
  },
  segmentButtonActive: {
    backgroundColor: AmoledTheme.surfaceElevated,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
  },
  segmentButtonText: {
    color: AmoledTheme.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  segmentButtonTextActive: {
    color: AmoledTheme.accentOrange,
    fontWeight: '700',
  },
  homeEyebrow: {
    color: AmoledTheme.accentOrange,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 2,
  },
  homeTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 10,
    marginTop: 3,
  },
  homeDescription: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  homeRouteCard: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  homeRouteText: {
    flex: 1,
    marginRight: 12,
  },
  homeRouteName: {
    color: AmoledTheme.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  homeRouteFacts: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    marginTop: 4,
  },
  homeReadyLabel: {
    color: AmoledTheme.accentGreen,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.7,
  },
  homeNeedsMapLabel: {
    color: AmoledTheme.accentYellow,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.7,
  },
  homeSecondaryActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  homeSecondaryButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 8,
  },
  homeSecondaryButtonPressed: {
    opacity: 0.65,
  },
  homeSecondaryButtonText: {
    color: AmoledTheme.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
  homeMapNotice: {
    borderLeftColor: AmoledTheme.accentOrange,
    borderLeftWidth: 2,
    marginTop: 12,
    paddingLeft: 10,
    paddingVertical: 2,
  },
  homeMapNoticeTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  homeMapNoticeText: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    marginTop: 3,
  },
  settingsMapSummary: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopColor: AmoledTheme.borderDefault,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 4,
    minHeight: 66,
    paddingTop: 10,
  },
  settingsMapText: {
    flex: 1,
  },
  settingsMapAction: {
    color: AmoledTheme.accentOrange,
    fontSize: 13,
    fontWeight: '700',
  },
  sheetHandle: {
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
    borderRadius: 3,
    height: 5,
    marginBottom: 8,
    marginTop: 2,
    width: 40,
  },
  sheetHeaderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  headerTitleBlock: {
    flex: 1,
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: AmoledTheme.modalBackdrop,
    justifyContent: 'center',
    padding: 20,
    zIndex: 100,
  },
  modalCard: {
    backgroundColor: AmoledTheme.card,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 400,
    padding: 22,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    width: '100%',
  },
  savedAreaRow: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  navigationButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: 14,
  },
  squareNavigationButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    height: 36,
    justifyContent: 'center',
    minHeight: 36,
    minWidth: 36,
    paddingHorizontal: 0,
    width: 36,
  },
  activeNavigationButton: {
    backgroundColor: AmoledTheme.accentOrange,
    borderColor: AmoledTheme.accentOrange,
  },
  emphasizedNavigationButton: {
    backgroundColor: AmoledTheme.accentOrange,
    borderColor: AmoledTheme.accentOrange,
  },
  navigationButtonPressed: {
    opacity: 0.7,
  },
  navigationButtonLabel: {
    color: AmoledTheme.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  activeNavigationButtonLabel: {
    color: '#FFFFFF',
  },
  technicalLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  stateTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  stateDescription: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    lineHeight: 19,
    marginTop: 4,
  },
  centeredPanelContent: {
    alignItems: 'center',
    minHeight: 120,
    paddingTop: 16,
  },
  errorDescription: {
    color: AmoledTheme.accentRed,
    fontSize: 14,
    lineHeight: 19,
    marginTop: 6,
  },
  routeName: {
    color: AmoledTheme.textPrimary,
    fontSize: 21,
    fontWeight: '700',
    letterSpacing: -0.4,
    lineHeight: 26,
  },
  routeFacts: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  terrainElevationNote: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 8,
  },
  terrainElevationWarning: {
    color: AmoledTheme.accentYellow,
  },
  routeFact: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    height: 58,
    justifyContent: 'center',
    minWidth: 0,
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  routeFactValueRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'center',
    maxWidth: '100%',
  },
  routeFactValue: {
    color: AmoledTheme.textPrimary,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  routeFactUnit: {
    color: AmoledTheme.textSecondary,
    fontSize: 10,
    fontWeight: '600',
    marginLeft: 1.5,
  },
  routeFactLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 10.5,
    fontWeight: '500',
    marginTop: 2,
    textAlign: 'center',
  },
  offlineStatusCard: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
    marginTop: 12,
    padding: 12,
  },
  mapPackRow: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    marginTop: 12,
    padding: 12,
  },
  mapPackText: {
    color: AmoledTheme.textPrimary,
    flexShrink: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  mapPackStandalone: {
    marginTop: 12,
  },
  mapPackStatus: {
    flex: 1,
    minWidth: 0,
  },
  mapPackError: {
    color: AmoledTheme.accentRed,
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 6,
  },
  mapPackActionsRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 0,
    gap: 8,
  },
  mapPackButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
    justifyContent: 'center',
    minHeight: 38,
    paddingHorizontal: 12,
  },
  mapPackButtonPressed: {
    opacity: 0.75,
  },
  mapPackButtonDisabled: {
    opacity: 0.45,
  },
  mapPackButtonLabel: {
    color: AmoledTheme.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  loadedRouteHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  loadedRouteTitleBlock: {
    flex: 1,
  },
  routeDirectionSection: {
    marginTop: 18,
  },
  routeDirectionTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  routeDirectionHint: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
  routeDirectionActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  routeDirectionButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderEmphasized,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: 8,
  },
  routeDirectionButtonPrimary: {
    backgroundColor: AmoledTheme.accentOrange,
    borderColor: AmoledTheme.accentOrange,
  },
  routeDirectionButtonDisabled: {
    opacity: 0.55,
  },
  routeDirectionButtonPressed: {
    opacity: 0.78,
  },
  routeDirectionButtonLabel: {
    color: AmoledTheme.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  routeDirectionButtonPrimaryLabel: {
    color: '#FFFFFF',
  },
  routeDirectionFootnote: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 7,
  },
  clearRouteButton: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderColor: 'rgba(239, 68, 68, 0.4)',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  clearRouteButtonPressed: {
    opacity: 0.6,
  },
  clearRouteButtonText: {
    color: AmoledTheme.accentRed,
    fontSize: 12,
    fontWeight: '700',
  },
  loadedRouteFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginTop: 14,
  },
  loadedRouteActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  compactDestructiveButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderColor: 'rgba(239, 68, 68, 0.35)',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: 12,
  },
  compactDestructiveButtonPressed: {
    opacity: 0.6,
  },
  compactDestructiveButtonText: {
    color: AmoledTheme.accentRed,
    fontSize: 13,
    fontWeight: '600',
  },
  sheetScrollBody: {
    maxHeight: 420,
  },
  sheetScrollContent: {
    paddingBottom: 8,
  },
  mapPackStorageSummary: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
    marginTop: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  storageSummaryText: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  savedAreasSection: {
    marginBottom: 12,
  },
  addAreaSection: {
    marginTop: 4,
  },
  selectedAreaBounds: {
    color: AmoledTheme.textPrimary,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
    marginTop: 8,
  },
  sectionHeaderTitle: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  savedAreaCard: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
    padding: 12,
  },
  savedAreaHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  savedAreaTitleCol: {
    flex: 1,
  },
  savedAreaTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  savedAreaSubtitle: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  savedAreaBounds: {
    color: AmoledTheme.textTertiary,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 8,
  },
  savedAreaActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'flex-end',
    marginTop: 10,
  },
  areaActionBtn: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  areaActionBtnPressed: {
    opacity: 0.6,
  },
  areaActionBtnDisabled: {
    opacity: 0.45,
  },
  areaActionBtnText: {
    color: AmoledTheme.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
  areaDeleteBtn: {
    alignItems: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderColor: 'rgba(239, 68, 68, 0.35)',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  areaDeleteBtnPressed: {
    opacity: 0.6,
  },
  areaDeleteBtnText: {
    color: AmoledTheme.accentRed,
    fontSize: 12,
    fontWeight: '600',
  },
  sourceFileName: {
    color: AmoledTheme.textSecondary,
    flex: 1,
    fontSize: 12,
  },
  importButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.accentOrange,
    borderColor: AmoledTheme.accentOrange,
    borderRadius: 16,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: 14,
    minHeight: 50,
    paddingHorizontal: 20,
    shadowColor: AmoledTheme.accentOrange,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
  },
  compactImportButton: {
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 0,
    minHeight: 36,
    paddingHorizontal: 12,
    shadowOpacity: 0,
  },
  compactImportButtonLabel: {
    color: AmoledTheme.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  importButtonPressed: {
    opacity: 0.85,
  },
  importButtonLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryImportButton: {
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderEmphasized,
    borderWidth: 1,
    shadowOpacity: 0,
    marginTop: 10,
  },
  secondaryImportButtonLabel: {
    color: AmoledTheme.textPrimary,
    fontWeight: '600',
  },
  onlineMapNotice: {
    color: AmoledTheme.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  elevationChartContainer: {
    marginTop: 10,
    width: '100%',
  },
  elevationChartHeaderRow: {
    marginBottom: 4,
  },
  climbsSummaryBadge: {
    backgroundColor: 'rgba(249, 115, 22, 0.15)',
    borderColor: 'rgba(249, 115, 22, 0.35)',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  climbsSummaryText: {
    color: AmoledTheme.accentOrange,
    fontSize: 12,
    fontWeight: '700',
  },
  gradientLegendRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  legendChip: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  legendDot: {
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  legendText: {
    color: AmoledTheme.textSecondary,
    fontSize: 10,
    fontWeight: '600',
  },
  sheetHandleTouchArea: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 8,
  },
  loadedRouteHeaderActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  minimizeSheetButton: {
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  minimizeSheetButtonPressed: {
    opacity: 0.6,
  },
  minimizeSheetButtonText: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  emptyStateHeaderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  minimizedSheetRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  minimizedRouteInfoCol: {
    flex: 1,
    marginRight: 10,
  },
  minimizedRouteName: {
    color: AmoledTheme.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  minimizedRouteFacts: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  minimizedRouteActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  minimizedStartButton: {
    backgroundColor: AmoledTheme.accentOrange,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  minimizedStartButtonPressed: {
    opacity: 0.8,
  },
  minimizedStartButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  minimizedExpandButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  minimizedExpandButtonPressed: {
    opacity: 0.6,
  },
  minimizedExpandButtonText: {
    color: AmoledTheme.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  modalActionsContainer: {
    gap: 12,
    marginTop: 18,
    width: '100%',
  },
  modalSecondaryButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  modalSecondaryButtonPressed: {
    opacity: 0.7,
  },
  modalSecondaryButtonText: {
    color: AmoledTheme.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  loadedRouteSecondaryActionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
    width: '100%',
  },
  secondaryActionButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  secondaryActionButtonPressed: {
    opacity: 0.7,
  },
  secondaryActionButtonText: {
    color: AmoledTheme.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  secondaryActionDestructiveButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  secondaryActionDestructiveButtonPressed: {
    opacity: 0.7,
  },
  secondaryActionDestructiveButtonText: {
    color: '#EF4444',
    fontSize: 13,
    fontWeight: '700',
  },
  sourceFileNameFootnote: {
    color: AmoledTheme.textTertiary,
    fontSize: 11,
    marginTop: 8,
    textAlign: 'center',
  },
});
