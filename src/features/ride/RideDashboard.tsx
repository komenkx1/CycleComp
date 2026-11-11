import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutAnimation,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { rideDurationSeconds, rideElapsedSeconds } from '../../domain/ride/rideDuration';
import { calculateAverageSpeedKmh } from '../../domain/ride/rideMetrics';
import type { RideSnapshot } from './useRideTracking';
import { AmoledTheme } from '../../theme/colors';
import { SFIcon } from '../../components/SFIcon';
import { AmoledSwitch } from '../../components/AmoledSwitch';
import {
  type ClimbAlertState,
  type RouteSample,
  formatGradePercent,
  getGradeColor,
  getShortGradeLabel,
} from '../../domain/routes/elevation/routeElevationAnalysis';
import { ElevationProfileChart } from '../elevation/ElevationProfileChart';

type RideDashboardProps = {
  visible?: boolean;
  ride: RideSnapshot;
  busy: boolean;
  error: string | null;
  following: boolean;
  currentGrade?: number | null;
  currentGradeSource?: 'barometer' | 'gps' | null;
  climbAlert?: ClimbAlertState;
  routeSamples?: RouteSample[];
  povMode?: '3d' | '2d';
  onTogglePov?: () => void;
  enduranceActive?: boolean;
  onToggleEndurance?: () => void;
  canRouteBack?: boolean;
  routeBackBusy?: boolean;
  onRouteBack?: () => void;
  onAddDestination?: () => void;
  onRecenter: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleAutoPause?: (enabled: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
  onHeightChange?: (height: number) => void;
};

export function RideDashboard({
  visible = true,
  ride,
  busy,
  error,
  following,
  currentGrade = null,
  currentGradeSource = null,
  climbAlert,
  routeSamples,
  povMode = '3d',
  onTogglePov,
  enduranceActive = false,
  onToggleEndurance,
  canRouteBack = false,
  routeBackBusy = false,
  onRouteBack,
  onAddDestination,
  onRecenter,
  onZoomIn,
  onZoomOut,
  onToggleAutoPause,
  onPause,
  onResume,
  onFinish,
  onHeightChange,
}: RideDashboardProps) {
  const [expanded, setExpanded] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [ridePage, setRidePage] = useState<'map' | 'data' | 'climb'>('map');
  const [currentTime, setCurrentTime] = useState(Date.now);
  const [lastKnownSpeed, setLastKnownSpeed] = useState<number | null>(null);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const snapshotCheckTime = Date.now();
  const fixAgeMilliseconds = ride.lastFixAt ? snapshotCheckTime - Date.parse(ride.lastFixAt) : Infinity;
  const recentGpsFix = fixAgeMilliseconds >= 0 && fixAgeMilliseconds <= 10000;
  const showsOfflineTerrainClimb = ride.status === 'active' && !ride.autoPaused && recentGpsFix &&
    (!climbAlert || climbAlert.type === 'none') &&
    (ride.terrainClimbStatus === 'upcoming' || ride.terrainClimbStatus === 'active');

  useEffect(() => {
    if (ride.autoPaused || ride.status === 'paused') {
      setLastKnownSpeed(0);
    } else if (
      ride.status === 'active' &&
      ride.speedMetersPerSecond != null &&
      Number.isFinite(ride.speedMetersPerSecond)
    ) {
      setLastKnownSpeed(ride.speedMetersPerSecond);
    } else if (ride.status === 'idle' || ride.status === 'finished') {
      setLastKnownSpeed(null);
    }
  }, [ride.autoPaused, ride.status, ride.speedMetersPerSecond]);

  useEffect(() => {
    const estimatedHeight = minimized ? 150 + (showsOfflineTerrainClimb ? 24 : 0) : (expanded ? 590 : 340) + (showsOfflineTerrainClimb ? 74 : 0);
    onHeightChange?.(estimatedHeight);
  }, [minimized, expanded, showsOfflineTerrainClimb, onHeightChange]);

  useEffect(() => {
    if (!visible) { return; }
    setCurrentTime(Date.now());
    const clock = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [visible]);

  const slideHandle = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, movement) =>
      Math.abs(movement.dy) > 8 && Math.abs(movement.dy) > Math.abs(movement.dx),
    onPanResponderRelease: (_, movement) => {
      if (movement.dy > 35) {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        if (expanded) {
          setExpanded(false);
        } else {
          setMinimized(true);
        }
      } else if (movement.dy < -35) {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        if (minimized) {
          setMinimized(false);
        } else {
          setExpanded(true);
        }
      }
    },
  }), [expanded, minimized]);

  const pageTouchStart = useRef<{ x: number; y: number } | null>(null);

  function finishPageSwipe(endX: number, endY: number) {
    const start = pageTouchStart.current;
    pageTouchStart.current = null;
    if (!start) return;
    const horizontalDistance = endX - start.x;
    const verticalDistance = endY - start.y;
    if (Math.abs(horizontalDistance) < 50 || Math.abs(horizontalDistance) <= Math.abs(verticalDistance) * 1.5) return;
    const pages = ['map', 'data', 'climb'] as const;
    const pageOffset = horizontalDistance < 0 ? 1 : -1;
    setRidePage(currentPage => {
      const nextIndex = Math.max(0, Math.min(pages.length - 1, pages.indexOf(currentPage) + pageOffset));
      return pages[nextIndex];
    });
  }

  const rideIsRecording = ride.status === 'active';
  const rideIsRecoverable = ride.status === 'recoveryNeeded';
  const elapsedSeconds = rideElapsedSeconds(ride, currentTime);
  const timerSeconds = rideDurationSeconds(ride, currentTime);
  const heartRateAgeMilliseconds = ride.heartRateRecordedAt ? snapshotCheckTime - Date.parse(ride.heartRateRecordedAt) : Infinity;
  const recentHeartRate = heartRateAgeMilliseconds >= 0 && heartRateAgeMilliseconds <= 15000;
  const displayedHeartRate = ride.watchHeartRateEnabled && rideIsRecording && !ride.autoPaused && recentHeartRate ? ride.heartRateBpm : null;
  const minimizedHeartRateLabel = !ride.watchHeartRateEnabled ? 'HR NONAKTIF' :
    !rideIsRecording || ride.autoPaused ? 'HR DIJEDA' :
    displayedHeartRate != null ? 'HEART RATE' :
    ride.watchHeartRateStatus === 'disconnected' ? 'HR TERPUTUS' :
    ride.watchHeartRateStatus === 'error' ? 'HR BERMASALAH' : 'MENUNGGU HR';
  const displayedPower = rideIsRecording && !ride.autoPaused && recentGpsFix ? ride.virtualPowerWatts : null;
  const currentSpeed = ride.autoPaused || ride.status === 'paused'
    ? 0
    : rideIsRecording && recentGpsFix
      ? (ride.speedMetersPerSecond ?? lastKnownSpeed)
      : null;
  const averageSpeedKmh = calculateAverageSpeedKmh(ride.distanceMeters, ride.movingSeconds);
  const averageSpeedLabel = averageSpeedKmh == null
    ? 'Rata-rata —'
    : `Rata-rata ${formatSpeedKmh(averageSpeedKmh)} km/j`;
  const displayedGrade = currentGradeSource ? currentGrade : null;
  const climbProfileSamples = useMemo(() => {
    if (!climbAlert || climbAlert.type === 'none' || !routeSamples) return [];
    return routeSamples.filter(sample => sample.distanceMeters >= climbAlert.climb.startDistanceMeters &&
      sample.distanceMeters <= climbAlert.climb.endDistanceMeters && sample.elevationMeters !== null);
  }, [climbAlert, routeSamples]);

  if (!visible) { return null; }

  return (
    <View pointerEvents="box-none" style={[styles.bottomArea, ridePage !== 'map' && !minimized && { top: insets.top + 140 }]}>
      {ridePage === 'map' ? <View pointerEvents="box-none" style={styles.mapControlsRow}>
        <View style={styles.mapControlsStack}>
          {onAddDestination ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Tambah tujuan" onPress={onAddDestination} style={styles.routeBackMapButton}>
              <SFIcon name="map.fill" color={AmoledTheme.accentOrange} size={17} />
              <Text style={styles.routeBackMapButtonLabel}>Tujuan</Text>
            </Pressable>
          ) : null}
          {canRouteBack && onRouteBack ? (
            <Pressable
              accessibilityHint="Mengikuti kembali jejak GPS yang sudah terekam menuju titik awal."
              accessibilityLabel="Mulai Route Back"
              accessibilityRole="button"
              disabled={busy || routeBackBusy}
              onPress={onRouteBack}
              style={({ pressed }) => [
                styles.routeBackMapButton,
                (busy || routeBackBusy) && styles.routeBackMapButtonDisabled,
                pressed && !busy && !routeBackBusy && styles.routeBackMapButtonPressed,
              ]}
            >
              <SFIcon name="arrow.uturn.backward" color={AmoledTheme.accentOrange} size={17} />
              <Text style={styles.routeBackMapButtonLabel}>
                {routeBackBusy ? 'Menyiapkan...' : 'Route Back'}
              </Text>
            </Pressable>
          ) : null}
          <View style={styles.mapControlsCluster}>
            {onToggleEndurance ? (
              <DashboardButton
                active={enduranceActive}
                label=""
                icon="bolt.fill"
                accessibilityLabel="Mode Hemat Baterai Layar AMOLED"
                onPress={onToggleEndurance}
                square
              />
            ) : null}
            {onTogglePov ? (
              <DashboardButton
                active={povMode === '3d'}
                label={povMode === '3d' ? '3D' : '2D'}
                accessibilityLabel={
                  povMode === '3d'
                    ? 'Ganti ke pandangan 2D utara'
                    : 'Ganti ke pandangan 3D POV'
                }
                onPress={onTogglePov}
                square
              />
            ) : null}
            <DashboardButton
              label="Pusatkan"
              accessibilityLabel="Pusatkan"
              onPress={onRecenter}
              emphasized={!following}
              compact
            />
            <DashboardButton
              label="−"
              accessibilityLabel="Perkecil peta"
              onPress={onZoomOut}
              square
            />
            <DashboardButton
              label="+"
              accessibilityLabel="Perbesar peta"
              onPress={onZoomIn}
              square
            />
          </View>
        </View>
      </View> : null}
      <View
        onLayout={e => {
          const h = e.nativeEvent.layout.height;
          if (h > 0) {
            onHeightChange?.(h);
          }
        }}
        style={[styles.card, ridePage !== 'map' && !minimized && styles.instrumentCard, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}
      >
        <View {...slideHandle.panHandlers}>
          <Pressable
            accessibilityHint="Geser ke atas untuk rincian, ke bawah untuk ringkas"
            accessibilityLabel={minimized ? 'Perluas panel perjalanan' : (expanded ? 'Ringkas panel perjalanan' : 'Perluas panel perjalanan')}
            accessibilityRole="button"
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              if (minimized) {
                setMinimized(false);
              } else {
                setExpanded(current => !current);
              }
            }}
            style={styles.handleTouchArea}
          >
            <View style={styles.handle} />
          </Pressable>
        </View>

        {minimized ? (
          <>
          <View style={styles.minimizedContent}>
            <View style={styles.minimizedMetricsGroup}>
              <View style={styles.minimizedSpeedColumn}>
                <Text style={styles.minimizedMetricLabel}>KECEPATAN</Text>
                <Text testID="minimized-speed" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={styles.minimizedSpeedValue}>
                  {formatSpeed(currentSpeed)} <Text style={styles.minimizedSpeedUnit}>km/j</Text>
                </Text>
              </View>
              <View style={styles.minimizedSpeedColumn} accessibilityLabel={
                !ride.watchHeartRateEnabled ? 'Heart rate tidak aktif' :
                !rideIsRecording || ride.autoPaused ? 'Heart rate dijeda' :
                displayedHeartRate == null ? 'Heart rate tidak tersedia' : `Heart rate ${displayedHeartRate} bpm`
              }>
                <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={styles.minimizedMetricLabel}>{minimizedHeartRateLabel}</Text>
                <Text testID="minimized-heart-rate" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={styles.minimizedSpeedValue}>
                  {displayedHeartRate ?? '—'} <Text style={styles.minimizedSpeedUnit}>bpm</Text>
                </Text>
              </View>
            </View>

            <View style={styles.minimizedActions}>
              <Pressable
                accessibilityLabel={rideIsRecording ? 'Jeda' : rideIsRecoverable ? 'Pulihkan' : 'Lanjutkan'}
                accessibilityRole="button"
                disabled={busy}
                onPress={rideIsRecording ? onPause : onResume}
                style={({ pressed }) => [
                  styles.minimizedActionBtn,
                  pressed && styles.minimizedActionBtnPressed,
                ]}
              >
                <SFIcon name={rideIsRecording ? 'pause.fill' : 'play.fill'} size={15} />
              </Pressable>
              <Pressable
                accessibilityLabel="Perluas panel perjalanan"
                accessibilityRole="button"
                onPress={() => {
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setMinimized(false);
                }}
                style={({ pressed }) => [
                  styles.minimizedActionBtn,
                  pressed && styles.minimizedActionBtnPressed,
                ]}
              >
                <Text style={styles.minimizedActionBtnIcon}>▲</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.minimizedDetails}>
            <View style={styles.minimizedMetricItem}>
              <Text style={styles.minimizedMetricLabel}>RATA-RATA</Text>
              <Text testID="ride-average-speed" accessibilityLabel={averageSpeedLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={styles.minimizedMetricValue}>
                {averageSpeedKmh == null ? '—' : `${formatSpeedKmh(averageSpeedKmh)} km/j`}
              </Text>
            </View>
            <View style={styles.minimizedMetricItem}>
              <Text style={styles.minimizedMetricLabel}>GRADIEN</Text>
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[styles.minimizedMetricValue, { color: getGradeColor(displayedGrade) }]}>{formatGradePercent(displayedGrade)}</Text>
            </View>
            <View style={styles.minimizedMetricItem}>
              <Text style={styles.minimizedMetricLabel}>JARAK</Text>
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={styles.minimizedMetricValue}>{formatDistance(ride.distanceMeters)}</Text>
            </View>
            <View style={styles.minimizedMetricItem}>
              <Text style={styles.minimizedMetricLabel}>WAKTU</Text>
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={styles.minimizedMetricValue}>{formatDuration(elapsedSeconds)}</Text>
            </View>
          </View>
          {showsOfflineTerrainClimb ? (
            <Text testID="minimized-terrain-climb-alert" style={styles.terrainClimbTitle}>
              {ride.terrainClimbStatus === 'active'
                ? `Tanjakan aktif · sisa ${ride.terrainClimbDistanceRemainingMeters == null ? '—' : formatTerrainDistance(ride.terrainClimbDistanceRemainingMeters)}`
                : `Tanjakan ${ride.terrainClimbDistanceToStartMeters == null ? '—' : `${Math.round(ride.terrainClimbDistanceToStartMeters)} m`} lagi · ${formatGradePercent(ride.terrainClimbAverageGradePercent ?? null)}`}
            </Text>
          ) : null}
          </>
        ) : (
          <>
            <View style={styles.headingRow}>
              <View style={styles.statusIndicatorBlock}>
                <View
                  style={[
                    styles.statusDot,
                    rideIsRecording
                      ? styles.recordingDot
                      : rideIsRecoverable
                      ? styles.recoveryDot
                      : styles.pausedDot,
                  ]}
                />
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.statusText}>
                  {rideIsRecoverable
                    ? 'Perjalanan perlu dipulihkan'
                    : ride.autoPaused
                    ? 'Jeda otomatis · menunggu gerak'
                    : rideIsRecording ? 'Merekam perjalanan' : 'Perjalanan dijeda'}
                </Text>
              </View>
              <View style={styles.headingRightBlock}>
                <View style={styles.sourceBadge}>
                  <Text numberOfLines={1} style={styles.sourceText}>{getElevationSourceLabel(ride)}</Text>
                </View>
                <Pressable
                  accessibilityHint="Perkecil panel perjalanan ke bar ringkas"
                  accessibilityLabel="Perkecil panel perjalanan"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setMinimized(true);
                  }}
                  style={styles.minimizeBtn}
                >
                  <Text style={styles.minimizeBtnText}>▼</Text>
                </Pressable>
              </View>
            </View>
            <View style={styles.pageTabs} accessibilityRole="tablist">
              {([
                { id: 'map', label: 'Peta' },
                { id: 'data', label: 'Data' },
                { id: 'climb', label: 'Tanjakan' },
              ] as const).map(page => (
                <Pressable
                  key={page.id}
                  accessibilityRole="tab"
                  accessibilityLabel={`Halaman ${page.label}`}
                  accessibilityState={{ selected: ridePage === page.id }}
                  onPress={() => setRidePage(page.id)}
                  style={[styles.pageTab, ridePage === page.id && styles.pageTabSelected]}
                >
                  <Text style={[styles.pageTabLabel, ridePage === page.id && styles.pageTabLabelSelected]}>
                    {page.label}
                  </Text>
                </Pressable>
              ))}
            </View>
        {showsOfflineTerrainClimb ? (
          <View
            accessibilityLiveRegion="polite"
            accessibilityRole="alert"
            style={styles.terrainClimbAlert}
            testID="offline-terrain-climb-alert"
          >
            <View style={styles.terrainClimbHeading}>
              <SFIcon
                name={ride.terrainClimbStatus === 'active' ? 'mountain.2.fill' : 'exclamationmark.triangle.fill'}
                color={AmoledTheme.accentYellow}
                size={16}
              />
              <Text style={styles.terrainClimbTitle}>
                {ride.terrainClimbStatus === 'active' ? 'Tanjakan aktif' : 'Tanjakan di depan'}
              </Text>
              <Text style={styles.terrainClimbDistance}>
                {ride.terrainClimbStatus === 'active'
                  ? `Sisa ${ride.terrainClimbDistanceRemainingMeters == null ? '—' : formatTerrainDistance(ride.terrainClimbDistanceRemainingMeters)}`
                  : `${ride.terrainClimbDistanceToStartMeters == null ? '—' : `${Math.round(ride.terrainClimbDistanceToStartMeters)} m`} lagi`}
              </Text>
            </View>
            <Text style={styles.terrainClimbMetrics}>
              {`${ride.terrainClimbElevationGainMeters == null ? '—' : `+${Math.round(ride.terrainClimbElevationGainMeters)} m`} · rata-rata ${formatGradePercent(ride.terrainClimbAverageGradePercent ?? null)} · maks ${formatGradePercent(ride.terrainClimbMaxGradePercent ?? null)}`}
            </Text>
            <Text style={styles.terrainClimbSource}>
              {ride.forwardPathQuality === 'inferred_to_boundary'
                ? ride.terrainClimbProfileQuality === 'complete'
                  ? 'Perkiraan jalur · profil lengkap'
                  : 'Perkiraan jalur · profil sebagian'
                : ride.terrainClimbProfileQuality === 'complete'
                ? 'Profil medan offline lengkap'
                : 'Profil medan offline sebagian'}
            </Text>
          </View>
        ) : null}
            <ScrollView
              testID="ride-page-swipe"
              onTouchStart={event => {
                pageTouchStart.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
              }}
              onTouchEnd={event => finishPageSwipe(event.nativeEvent.pageX, event.nativeEvent.pageY)}
              onTouchCancel={() => { pageTouchStart.current = null; }}
              style={{ maxHeight: windowHeight * (ridePage === 'map' ? 0.45 : 0.65) }}
              showsVerticalScrollIndicator={false}
            >
              <View>
                {ridePage === 'map' ? <>
            <View style={styles.primaryMetrics}>
              <View style={styles.mapSpeedCell}>
                <Text style={styles.instrumentLabel}>Kecepatan</Text>
                <View style={styles.speedColumn}>
                  <View style={styles.speedBlock}>
                    <Text style={styles.primaryValue}>{formatSpeed(currentSpeed)}</Text>
                    <Text style={styles.speedUnit}>km/j</Text>
                  </View>
                  <Text
                    numberOfLines={1}
                    testID="ride-average-speed"
                    style={styles.averageSpeedLabel}
                  >
                    {averageSpeedLabel}
                  </Text>
                </View>
              </View>
              <Metric label="Jarak" value={formatDistance(ride.distanceMeters)} />
            </View>
            <View style={styles.secondaryMetrics}>
              <Metric label="Waktu total" value={formatDuration(elapsedSeconds)} />
              <Metric label="Total naik" value={ride.elevationDataAvailable === false || ride.ascentMeters == null ? '— m' : `${Math.round(ride.ascentMeters)} m`} />
            </View>
            <View style={styles.mapSecondaryReadings}>
              <View style={styles.mapReadingCell}>
                <Text style={styles.mapReadingLabel}>Gradien</Text>
                <Text
                  testID="ride-live-grade"
                  style={[styles.mapReadingValue, { color: getGradeColor(displayedGrade) }]}
                  adjustsFontSizeToFit
                  numberOfLines={1}
                >
                  {formatGradePercent(displayedGrade)}
                </Text>
                <Text style={styles.mapReadingHint}>
                  {currentGradeSource
                    ? `${getShortGradeLabel(currentGrade)} · ${currentGradeSource === 'barometer' ? 'barometer' : 'GPS'}`
                    : 'Mengukur gradien'}
                </Text>
              </View>
              <View style={styles.mapReadingCell}>
                <Text style={styles.mapReadingLabel}>Elevasi</Text>
                <Text style={styles.mapReadingValue} adjustsFontSizeToFit numberOfLines={1}>
                  {ride.elevationMeters == null
                    ? '—'
                    : `${Math.round(ride.elevationMeters).toLocaleString('id-ID')} m`}
                </Text>
                <Text style={styles.mapReadingHint}>
                  {ride.elevationSource === 'barometer_gps'
                    ? 'Absolut · barometer'
                    : ride.elevationSource === 'gps' ? 'GPS' : 'Belum tersedia'}
                </Text>
                {ride.relativeElevationMeters == null ? null : (
                  <Text testID="ride-relative-elevation" style={styles.relativeElevationLabel}>
                    Baro Δ {formatSignedElevationMeters(ride.relativeElevationMeters)} m
                  </Text>
                )}
              </View>
            </View>
        {ride.watchHeartRateEnabled ? (
          <View style={styles.heartRateRow}>
            <Text testID="ride-heart-rate" style={styles.heartRateValue}>{displayedHeartRate ?? '—'} <Text style={styles.metricLabel}>bpm</Text></Text>
            <Text style={styles.heartRateStatus}>
              {ride.watchHeartRateMessage ?? (
                !rideIsRecording ? 'HR dijeda' : displayedHeartRate != null
                  ? 'HR · Watch 5' : ride.watchHeartRateStatus === 'active'
                    ? 'Menunggu HR jam' : 'Menyambungkan HR jam…'
              )}
            </Text>
          </View>
        ) : null}
        {ride.virtualPowerMassKg != null && ride.virtualPowerMassKg > 0 ? (
          <View style={styles.heartRateRow}>
            <Text testID="ride-map-power" style={styles.heartRateValue}>
              {displayedPower == null ? '—' : Math.round(displayedPower)} <Text style={styles.metricLabel}>W</Text>
            </Text>
            <Text style={styles.heartRateStatus}>Power · estimasi</Text>
          </View>
        ) : null}
        {onToggleAutoPause ? (
          <View style={styles.autoPauseRow}>
            <Text style={styles.autoPauseLabel}>Auto-pause</Text>
            <AmoledSwitch
              accessibilityLabel="Auto-pause perjalanan"
              disabled={busy}
              value={ride.autoPauseEnabled ?? false}
              onValueChange={onToggleAutoPause}
            />
          </View>
        ) : null}
        {expanded ? (
          <View style={styles.expandedMetrics}>
            <Metric compact label="Bergerak" value={formatDuration(ride.movingSeconds)} />
            <Metric compact label="Timer aktif" value={formatDuration(timerSeconds)} />
            <Metric
              compact
              label="Total turun"
              value={ride.elevationDataAvailable === false || ride.descentMeters == null ? '— m' : `${Math.round(ride.descentMeters)} m`}
            />
            <Metric
              compact
              label="Akurasi GPS"
              value={
                ride.horizontalAccuracyMeters == null
                  ? 'Menunggu'
                  : `±${Math.round(ride.horizontalAccuracyMeters)} m`
              }
            />
            {climbAlert && climbAlert.totalClimbs > 0 ? (
              <Metric
                compact
                label="Tanjakan"
                value={
                  climbAlert.type === 'active'
                    ? `T${climbAlert.climbIndex}/${climbAlert.totalClimbs} (Aktif)`
                    : `${climbAlert.totalClimbs} segmen`
                }
              />
            ) : null}
          </View>
        ) : null}
        {ride.pointCount === 0 ? (
          <Text style={styles.hintText}>Menunggu titik GPS pertama sebelum menggambar jejak.</Text>
        ) : !following ? (
          <Text style={styles.hintText}>Peta digeser. Ketuk Pusatkan agar kembali mengikuti titik biru.</Text>
        ) : null}
                </> : ridePage === 'data' ? (
                  <View testID="ride-data-page" style={styles.instrumentPage}>
                    <Text style={styles.instrumentLabel}>Kecepatan</Text>
                    <Text style={styles.instrumentSpeed} adjustsFontSizeToFit numberOfLines={1}>
                      {formatSpeed(currentSpeed)} <Text style={styles.instrumentUnit}>km/j</Text>
                    </Text>
                    <Text style={styles.instrumentHint}>{averageSpeedLabel}</Text>
                    <View style={styles.instrumentGrid}>
                      <InstrumentMetric label="Jarak" value={formatDistance(ride.distanceMeters)} />
                      <InstrumentMetric label="Waktu total" value={formatDuration(elapsedSeconds)} />
                      <InstrumentMetric label="Total naik" value={ride.elevationDataAvailable === false || ride.ascentMeters == null ? '—' : `${Math.round(ride.ascentMeters)} m`} />
                      <InstrumentMetric label="HR · Watch 5" value={displayedHeartRate == null ? '—' : `${displayedHeartRate} bpm`} />
                      {ride.virtualPowerMassKg != null ? (
                        <InstrumentMetric label="Power · estimasi" value={displayedPower == null ? '—' : `${Math.round(displayedPower)} W`} />
                      ) : null}
                      <InstrumentMetric label="Elevasi" value={ride.elevationMeters == null ? '—' : `${Math.round(ride.elevationMeters)} m`} />
                      <InstrumentMetric label="Gradien" value={formatGradePercent(displayedGrade)} />
                      <InstrumentMetric label="Bergerak" value={formatDuration(ride.movingSeconds)} />
                      <InstrumentMetric label="Total turun" value={ride.elevationDataAvailable === false || ride.descentMeters == null ? '—' : `${Math.round(ride.descentMeters)} m`} />
                    </View>
                    <Text style={styles.instrumentHint}>{getElevationSourceLabel(ride)} · GPS {ride.horizontalAccuracyMeters == null ? 'menunggu' : `±${Math.round(ride.horizontalAccuracyMeters)} m`}</Text>
                  </View>
                ) : (
                  <View testID="ride-climb-page" style={styles.instrumentPage}>
                    {climbAlert && climbAlert.type !== 'none' ? <>
                      <Text style={styles.instrumentLabel}>{`Tanjakan ${climbAlert.climbIndex} dari ${climbAlert.totalClimbs}`}</Text>
                      <Text style={styles.instrumentSpeed}>{formatGradePercent(climbAlert.climb.averageGradePercent)}</Text>
                      <Text style={styles.instrumentHint}>Gradien rata-rata</Text>
                      {climbProfileSamples.length >= 2 ? (
                        <ElevationProfileChart
                          samples={climbProfileSamples}
                          height={90}
                          showLabels={false}
                          riderProgressPercent={climbAlert.type === 'active' ? climbAlert.progressPercent : null}
                        />
                      ) : (
                        <Text style={styles.instrumentHint}>Profil elevasi belum tersedia.</Text>
                      )}
                      <View style={styles.instrumentGrid}>
                        <InstrumentMetric label={climbAlert.type === 'active' ? 'Sisa' : 'Mulai dalam'} value={formatTerrainDistance(climbAlert.type === 'active' ? climbAlert.distanceRemainingMeters : climbAlert.distanceToStartMeters)} />
                        <InstrumentMetric label="Panjang" value={formatTerrainDistance(climbAlert.climb.distanceMeters)} />
                        <InstrumentMetric
                          label={climbAlert.type === 'active' ? 'Sisa naik' : 'Naik'}
                          value={climbAlert.type === 'active'
                            ? (climbAlert.gainRemainingMeters == null ? '—' : `+${Math.round(climbAlert.gainRemainingMeters)} m`)
                            : `+${Math.round(climbAlert.climb.elevationGainMeters)} m`}
                        />
                        <InstrumentMetric label="Maksimum" value={formatGradePercent(climbAlert.climb.maxGradePercent)} />
                      </View>
                    </> : showsOfflineTerrainClimb ? <>
                      <Text style={styles.instrumentLabel}>{ride.terrainClimbStatus === 'active' ? 'Tanjakan aktif' : 'Tanjakan di depan'}</Text>
                      <Text style={styles.instrumentSpeed}>{formatGradePercent(ride.terrainClimbAverageGradePercent ?? null)}</Text>
                      <Text style={styles.instrumentHint}>Gradien rata-rata · medan offline</Text>
                      <View style={styles.instrumentGrid}>
                        <InstrumentMetric label={ride.terrainClimbStatus === 'active' ? 'Sisa' : 'Mulai dalam'} value={ride.terrainClimbStatus === 'active' ? (ride.terrainClimbDistanceRemainingMeters == null ? '—' : formatTerrainDistance(ride.terrainClimbDistanceRemainingMeters)) : (ride.terrainClimbDistanceToStartMeters == null ? '—' : formatTerrainDistance(ride.terrainClimbDistanceToStartMeters))} />
                        <InstrumentMetric label="Naik" value={ride.terrainClimbElevationGainMeters == null ? '—' : `+${Math.round(ride.terrainClimbElevationGainMeters)} m`} />
                      </View>
                    </> : <>
                      <Text style={styles.instrumentLabel}>Tanjakan</Text>
                      <Text style={styles.instrumentEmpty}>{climbAlert && climbAlert.totalClimbs > 0 ? 'Tidak ada tanjakan aktif' : 'Belum ada tanjakan tersedia'}</Text>
                      <Text style={styles.instrumentHint}>
                        {climbAlert && climbAlert.totalClimbs > 0
                          ? 'Peringatan akan muncul saat mendekati tanjakan.'
                          : 'Profil akan muncul saat data rute atau medan tersedia.'}
                      </Text>
                    </>}
                    {((climbAlert && climbAlert.type !== 'none') || showsOfflineTerrainClimb) &&
                    (ride.watchHeartRateEnabled || (ride.virtualPowerMassKg != null && ride.virtualPowerMassKg > 0)) ? (
                      <View style={styles.instrumentGrid}>
                        {ride.watchHeartRateEnabled ? <InstrumentMetric label="HR · Watch 5" value={displayedHeartRate == null ? '—' : `${displayedHeartRate} bpm`} /> : null}
                        {ride.virtualPowerMassKg != null && ride.virtualPowerMassKg > 0 ? <InstrumentMetric label="Power · estimasi" value={displayedPower == null ? '—' : `${Math.round(displayedPower)} W`} /> : null}
                      </View>
                    ) : null}
                  </View>
                )}
              </View>
            </ScrollView>
            {error ? (
              <Text accessibilityLiveRegion="assertive" style={styles.errorText}>{error}</Text>
            ) : null}
            <View style={styles.actionRow}>
              {rideIsRecording ? (
                <DashboardButton
                  label="Jeda"
                  accessibilityLabel="Jeda"
                  onPress={onPause}
                  disabled={busy}
                />
              ) : (
                <DashboardButton
                  label={rideIsRecoverable ? 'Pulihkan' : 'Lanjutkan'}
                  accessibilityLabel={rideIsRecoverable ? 'Pulihkan' : 'Lanjutkan'}
                  onPress={onResume}
                  disabled={busy || Boolean(ride.recordingErrorMessage)}
                />
              )}
              <DashboardButton
                label={busy ? 'Menyimpan...' : 'Selesai'}
                accessibilityLabel="Selesai"
                onPress={onFinish}
                disabled={busy || Boolean(ride.recordingErrorMessage)}
                emphasized
              />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

function InstrumentMetric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.instrumentMetric}>
      <Text style={styles.instrumentLabel}>{label}</Text>
      <Text style={styles.instrumentMetricValue} adjustsFontSizeToFit numberOfLines={1}>{value}</Text>
    </View>
  );
}

function Metric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <View style={[styles.metric, compact ? styles.expandedMetric : null]}>
      <Text adjustsFontSizeToFit minimumFontScale={0.8} numberOfLines={1} style={styles.metricValue}>{value}</Text>
      <Text numberOfLines={1} style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function DashboardButton({
  label,
  icon,
  accessibilityLabel,
  onPress,
  disabled = false,
  emphasized = false,
  active = false,
  square = false,
  compact = false,
}: {
  label: string;
  icon?: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  emphasized?: boolean;
  active?: boolean;
  square?: boolean;
  compact?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact ? styles.compactButton : null,
        square ? styles.squareButton : null,
        emphasized ? styles.emphasizedButton : null,
        active ? styles.activeButton : null,
        disabled ? styles.disabledButton : null,
        pressed ? styles.pressedButton : null,
      ]}
    >
      {icon ? (
        <SFIcon name={icon} color={emphasized ? AmoledTheme.textPrimary : '#FFFFFF'} size={17} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            emphasized ? styles.emphasizedButtonText : null,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

function formatSpeed(speedMetersPerSecond: number | null | undefined) {
  if (speedMetersPerSecond == null || !Number.isFinite(speedMetersPerSecond)) return '—';
  const speedKilometersPerHour = Math.round(speedMetersPerSecond * 36) / 10;
  return (speedKilometersPerHour === 0 ? 0 : speedKilometersPerHour).toLocaleString('id-ID', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  });
}

function formatSpeedKmh(speedKmh: number) {
  return speedKmh.toLocaleString('id-ID', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  });
}

function formatSignedElevationMeters(elevationMeters: number) {
  const direction = elevationMeters > 0 ? '+' : elevationMeters < 0 ? '−' : '';
  return `${direction}${Math.abs(elevationMeters).toLocaleString('id-ID', { maximumFractionDigits: 1 })}`;
}

function getElevationSourceLabel(ride: RideSnapshot) {
  if (ride.barometerStatus === 'simulated') return 'Barometer simulasi';
  if (ride.elevationSource === 'barometer_gps') return 'Barometer + GPS';
  if (ride.relativeElevationMeters != null) {
    return ride.elevationSource === 'gps' ? 'GPS absolut · baro relatif' : 'Baro relatif · GPS belum ada';
  }

  switch (ride.barometerStatus) {
    case 'starting': return ride.elevationSource === 'gps' ? 'GPS · barometer menunggu' : 'Barometer menunggu';
    case 'active': return ride.elevationSource === 'gps' ? 'GPS · barometer aktif' : 'Barometer aktif';
    case 'error': return ride.elevationSource === 'gps' ? 'GPS · barometer gagal' : 'Barometer gagal';
    case 'unavailable': return ride.elevationSource === 'gps' ? 'GPS saja' : 'Barometer tidak tersedia';
    default: return ride.elevationSource === 'gps' ? 'Elevasi GPS' : 'Menunggu elevasi';
  }
}

function formatDistance(distanceMeters = 0) {
  return `${(distanceMeters / 1000).toLocaleString('id-ID', { maximumFractionDigits: 2 })} km`;
}

function formatTerrainDistance(distanceMeters: number) {
  if (distanceMeters < 1_000) return `${Math.round(distanceMeters)} m`;
  return `${(distanceMeters / 1_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} km`;
}

function formatDuration(seconds = 0) {
  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainingSeconds = wholeSeconds % 60;
  return [hours, minutes, remainingSeconds].map(value => String(value).padStart(2, '0')).join(':');
}

const styles = StyleSheet.create({
  pageTabs: { flexDirection: 'row', gap: 6, marginTop: 10, marginBottom: 4 },
  pageTab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: AmoledTheme.borderDefault },
  pageTabSelected: { borderBottomColor: AmoledTheme.accentOrange },
  pageTabLabel: { color: AmoledTheme.textSecondary, fontSize: 15, fontWeight: '700' },
  pageTabLabelSelected: { color: AmoledTheme.textPrimary },
  instrumentPage: { paddingVertical: 14 },
  instrumentLabel: { color: AmoledTheme.textSecondary, fontSize: 15, fontWeight: '600' },
  instrumentSpeed: { color: AmoledTheme.textPrimary, fontSize: 64, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: -1 },
  instrumentUnit: { color: AmoledTheme.textSecondary, fontSize: 18, fontWeight: '600' },
  instrumentHint: { color: AmoledTheme.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 6 },
  instrumentEmpty: { color: AmoledTheme.textPrimary, fontSize: 24, fontWeight: '700', marginTop: 12 },
  instrumentGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: AmoledTheme.borderDefault },
  instrumentMetric: { width: '50%', minHeight: 82, paddingVertical: 8, paddingRight: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: AmoledTheme.borderDefault },
  instrumentMetricValue: { color: AmoledTheme.textPrimary, fontSize: 27, fontWeight: '700', fontVariant: ['tabular-nums'] },
  terrainClimbAlert: {
    backgroundColor: 'rgba(245, 158, 11, 0.10)',
    borderColor: 'rgba(245, 158, 11, 0.55)',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  terrainClimbHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  terrainClimbTitle: {
    color: AmoledTheme.accentYellow,
    flex: 1,
    fontSize: 14,
    fontWeight: '800',
  },
  terrainClimbDistance: {
    color: AmoledTheme.textPrimary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  terrainClimbMetrics: {
    color: AmoledTheme.textPrimary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  terrainClimbSource: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
  },
  autoPauseRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
    marginTop: 4,
    minHeight: 38,
  },
  autoPauseLabel: { color: AmoledTheme.textSecondary, fontSize: 12, fontWeight: '600' },
  heartRateRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  heartRateValue: { color: AmoledTheme.textPrimary, fontSize: 28, fontWeight: '600', fontVariant: ['tabular-nums'] },
  heartRateStatus: { color: AmoledTheme.textSecondary, fontSize: 12, flex: 1 },

  bottomArea: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  mapControlsRow: {
    alignItems: 'flex-end',
    marginBottom: 12,
    paddingHorizontal: 16,
  },
  mapControlsStack: {
    alignItems: 'flex-end',
    gap: 8,
  },
  routeBackMapButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.overlayBackground,
    borderColor: AmoledTheme.accentOrange,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 14,
  },
  routeBackMapButtonDisabled: {
    opacity: 0.55,
  },
  routeBackMapButtonPressed: {
    opacity: 0.75,
  },
  routeBackMapButtonLabel: {
    color: AmoledTheme.textPrimary,
    fontSize: 14,
    fontWeight: '700',
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
  card: {
    backgroundColor: AmoledTheme.card,
    borderColor: AmoledTheme.borderDefault,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
  },
  instrumentCard: {
    flex: 1,
  },
  handleTouchArea: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  handle: {
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 2.5,
    height: 5,
    width: 38,
  },
  headingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  statusIndicatorBlock: {
    alignItems: 'center',
    flexDirection: 'row',
    flex: 1,
    gap: 8,
    minWidth: 0,
  },
  statusDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  recordingDot: {
    backgroundColor: AmoledTheme.accentGreen,
  },
  pausedDot: {
    backgroundColor: AmoledTheme.accentYellow,
  },
  recoveryDot: {
    backgroundColor: AmoledTheme.accentRed,
  },
  statusText: {
    color: AmoledTheme.textPrimary,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.2,
    minWidth: 0,
  },
  sourceBadge: {
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 140,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  sourceText: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    fontWeight: '500',
    maxWidth: 124,
  },
  primaryMetrics: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  mapSpeedCell: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  mapSecondaryReadings: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  mapReadingCell: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  mapReadingLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  mapReadingValue: {
    color: AmoledTheme.textPrimary,
    fontSize: 24,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  mapReadingHint: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  speedColumn: {
    alignItems: 'flex-start',
    flexShrink: 1,
    minWidth: 0,
  },
  speedBlock: {
    alignItems: 'baseline',
    flexDirection: 'row',
    flexShrink: 0,
    gap: 4,
  },
  primaryValue: {
    color: AmoledTheme.textPrimary,
    fontSize: 46,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    letterSpacing: -1,
  },
  speedUnit: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  averageSpeedLabel: {
    color: AmoledTheme.accentOrange,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    marginTop: -2,
  },
  gradePill: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minWidth: 58,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  gradePillText: {
    fontSize: 17,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  relativeElevationLabel: {
    color: AmoledTheme.accentOrange,
    fontSize: 10,
    fontWeight: '600',
    marginTop: 2,
  },
  metricLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
  },
  secondaryMetrics: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
    marginTop: 8,
  },
  expandedMetrics: {
    borderColor: AmoledTheme.divider,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
    marginTop: 10,
    paddingTop: 10,
  },
  metric: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    minWidth: 0,
    minHeight: 72,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  expandedMetric: {
    flexBasis: '47%',
    flexGrow: 0,
    maxWidth: '48%',
    minHeight: 64,
  },
  metricValue: {
    color: AmoledTheme.textPrimary,
    fontSize: 24,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  hintText: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 10,
  },
  errorText: {
    color: AmoledTheme.accentRed,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 10,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  button: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 14,
  },
  squareButton: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    borderWidth: 0,
    flex: 0,
    minHeight: 48,
    minWidth: 48,
  },
  compactButton: {
    flex: 0,
    minHeight: 38,
    paddingHorizontal: 14,
  },
  emphasizedButton: {
    backgroundColor: AmoledTheme.accentOrange,
    borderColor: AmoledTheme.accentOrange,
    shadowColor: AmoledTheme.accentOrange,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
  },
  activeButton: {
    backgroundColor: AmoledTheme.accentOrange,
    borderColor: AmoledTheme.accentOrange,
  },
  disabledButton: {
    opacity: 0.4,
  },
  pressedButton: {
    opacity: 0.75,
  },
  buttonText: {
    color: AmoledTheme.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  emphasizedButtonText: {
    color: '#FFFFFF',
  },
  minimizedContent: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  minimizedMetricsGroup: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 8,
  },
  minimizedSpeedColumn: {
    alignItems: 'flex-start',
    flex: 1,
    minWidth: 0,
  },
  minimizedSpeedValue: {
    color: AmoledTheme.textPrimary,
    fontSize: 24,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
  },
  minimizedSpeedUnit: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  minimizedDetails: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 10,
  },
  minimizedMetricItem: {
    alignItems: 'flex-start',
    flex: 1,
    minWidth: 0,
  },
  minimizedMetricValue: {
    color: AmoledTheme.textPrimary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  minimizedMetricLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 10,
    fontWeight: '600',
  },
  minimizedActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginLeft: 8,
  },
  minimizedActionBtn: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  minimizedActionBtnPressed: {
    opacity: 0.6,
  },
  minimizedActionBtnIcon: {
    color: AmoledTheme.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  headingRightBlock: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 0,
    gap: 6,
  },
  minimizeBtn: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  minimizeBtnText: {
    color: AmoledTheme.textSecondary,
    fontSize: 9,
    fontWeight: '700',
  },
});
