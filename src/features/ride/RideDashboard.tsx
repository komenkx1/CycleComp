import { useEffect, useMemo, useState } from 'react';
import {
  LayoutAnimation,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
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
  formatGradePercent,
  getGradeColor,
  getShortGradeLabel,
} from '../../domain/routes/elevation/routeElevationAnalysis';

type RideDashboardProps = {
  visible?: boolean;
  ride: RideSnapshot;
  busy: boolean;
  error: string | null;
  following: boolean;
  currentGrade?: number | null;
  currentGradeSource?: 'barometer' | 'gps' | null;
  climbAlert?: ClimbAlertState;
  povMode?: '3d' | '2d';
  onTogglePov?: () => void;
  enduranceActive?: boolean;
  onToggleEndurance?: () => void;
  canRouteBack?: boolean;
  routeBackBusy?: boolean;
  onRouteBack?: () => void;
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
  povMode = '3d',
  onTogglePov,
  enduranceActive = false,
  onToggleEndurance,
  canRouteBack = false,
  routeBackBusy = false,
  onRouteBack,
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
  const [currentTime, setCurrentTime] = useState(Date.now);
  const [lastKnownSpeed, setLastKnownSpeed] = useState<number | null>(null);
  const insets = useSafeAreaInsets();
  const fixAgeMilliseconds = ride.lastFixAt ? currentTime - Date.parse(ride.lastFixAt) : Infinity;
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
    const estimatedHeight = minimized ? 96 : (expanded ? 590 : 340) + (showsOfflineTerrainClimb ? 74 : 0);
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

  const rideIsRecording = ride.status === 'active';
  const rideIsRecoverable = ride.status === 'recoveryNeeded';
  const elapsedSeconds = rideElapsedSeconds(ride, currentTime);
  const timerSeconds = rideDurationSeconds(ride, currentTime);
  const heartRateAgeMilliseconds = ride.heartRateRecordedAt ? currentTime - Date.parse(ride.heartRateRecordedAt) : Infinity;
  const recentHeartRate = heartRateAgeMilliseconds >= 0 && heartRateAgeMilliseconds <= 15000;
  const displayedHeartRate = rideIsRecording && recentHeartRate ? ride.heartRateBpm : null;
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

  if (!visible) { return null; }

  return (
    <View pointerEvents="box-none" style={styles.bottomArea}>
      <View pointerEvents="box-none" style={styles.mapControlsRow}>
        <View style={styles.mapControlsStack}>
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
      </View>
      <View
        onLayout={e => {
          const h = e.nativeEvent.layout.height;
          if (h > 0) {
            onHeightChange?.(h);
          }
        }}
        style={[styles.card, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}
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
          <View style={styles.minimizedContent}>
            <View style={styles.minimizedMetricsGroup}>
              <View style={styles.minimizedSpeedColumn}>
                <View style={styles.minimizedSpeedBlock}>
                  <Text style={styles.minimizedSpeedValue}>{formatSpeed(currentSpeed)}</Text>
                  <Text style={styles.minimizedSpeedUnit}>km/j</Text>
                </View>
                <Text
                  numberOfLines={1}
                  testID="ride-average-speed"
                  style={styles.minimizedAverageSpeed}
                >
                  {averageSpeedLabel}
                </Text>
              </View>
              <View
                style={[
                  styles.gradePill,
                  styles.minimizedGradePill,
                  {
                    backgroundColor: `${getGradeColor(currentGrade)}24`,
                    borderColor: getGradeColor(currentGrade),
                  },
                ]}
              >
                <Text style={[styles.gradePillText, { color: getGradeColor(currentGrade) }]}>
                  {formatGradePercent(currentGrade)}
                </Text>
              </View>
              <View style={styles.minimizedDivider} />
              <View style={styles.minimizedMetricItem}>
                <Text style={styles.minimizedMetricValue}>{formatDistance(ride.distanceMeters)}</Text>
                <Text style={styles.minimizedMetricLabel}>Jarak</Text>
              </View>
              <View style={styles.minimizedDivider} />
              <View style={styles.minimizedMetricItem}>
                <Text style={styles.minimizedMetricValue}>{formatDuration(elapsedSeconds)}</Text>
                <Text style={styles.minimizedMetricLabel}>Waktu</Text>
              </View>
            </View>

            <View style={styles.minimizedActions}>
              <Pressable
                accessibilityLabel={rideIsRecording ? 'Jeda' : 'Lanjutkan'}
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
                    : rideIsRecording
                    ? 'Merekam perjalanan'
                    : ride.autoPaused ? 'Jeda otomatis · menunggu gerak' : 'Perjalanan dijeda'}
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
            <View style={styles.primaryMetrics}>
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
              <View style={styles.gradeBlock}>
                <View
                  style={[
                    styles.gradePill,
                    {
                      backgroundColor: `${getGradeColor(displayedGrade)}24`,
                      borderColor: getGradeColor(displayedGrade),
                    },
                  ]}
                >
                  <Text
                    testID="ride-live-grade"
                    style={[
                      styles.gradePillText,
                      { color: getGradeColor(displayedGrade) },
                    ]}
                  >
                    {formatGradePercent(displayedGrade)}
                  </Text>
                </View>
                <Text
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  style={styles.gradeLabel}
                >
                  {currentGradeSource
                    ? `${getShortGradeLabel(currentGrade)} · ${currentGradeSource === 'barometer' ? 'barometer' : 'GPS'}`
                    : 'Mengukur gradien'}
                </Text>
              </View>
              <View style={styles.elevationBlock}>
                <Text style={styles.elevationValue}>
                  {ride.elevationMeters == null
                    ? '—'
                    : Math.round(ride.elevationMeters).toLocaleString('id-ID')}
                </Text>
                <Text style={styles.metricLabel}>
                  {ride.elevationSource === 'barometer_gps'
                    ? 'elevasi absolut (m)'
                    : ride.elevationSource === 'gps' ? 'elevasi GPS (m)' : 'elevasi (m)'}
                </Text>
                {ride.relativeElevationMeters == null ? null : (
                  <Text testID="ride-relative-elevation" style={styles.relativeElevationLabel}>
                    Baro Δ {formatSignedElevationMeters(ride.relativeElevationMeters)} m
                  </Text>
                )}
              </View>
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
                  ? `Sisa ${formatTerrainDistance(ride.terrainClimbDistanceRemainingMeters ?? 0)}`
                  : `${Math.round(ride.terrainClimbDistanceToStartMeters ?? 0)} m lagi`}
              </Text>
            </View>
            <Text style={styles.terrainClimbMetrics}>
              {`+${Math.round(ride.terrainClimbElevationGainMeters ?? 0)} m · rata-rata ${formatGradePercent(ride.terrainClimbAverageGradePercent ?? null)} · maks ${formatGradePercent(ride.terrainClimbMaxGradePercent ?? null)}`}
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
        <View style={styles.secondaryMetrics}>
          <Metric label="Jarak" value={formatDistance(ride.distanceMeters)} />
          <Metric
            label="Total naik"
            value={ride.elevationDataAvailable === false ? '— m' : `${Math.round(ride.ascentMeters ?? 0)} m`}
          />
          <Metric label="Waktu total" value={formatDuration(elapsedSeconds)} />
        </View>
        {expanded ? (
          <View style={styles.expandedMetrics}>
            <Metric compact label="Bergerak" value={formatDuration(ride.movingSeconds)} />
            <Metric compact label="Timer aktif" value={formatDuration(timerSeconds)} />
            <Metric
              compact
              label="Total turun"
              value={ride.elevationDataAvailable === false ? '— m' : `${Math.round(ride.descentMeters ?? 0)} m`}
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
        {error ? (
          <Text accessibilityLiveRegion="assertive" style={styles.errorText}>
            {error}
          </Text>
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
    fontSize: 12,
    fontWeight: '800',
  },
  terrainClimbDistance: {
    color: AmoledTheme.textPrimary,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  terrainClimbMetrics: {
    color: AmoledTheme.textPrimary,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  terrainClimbSource: {
    color: AmoledTheme.textSecondary,
    fontSize: 10,
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
    fontSize: 13,
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
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
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
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  averageSpeedLabel: {
    color: AmoledTheme.accentOrange,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    marginTop: -2,
  },
  gradeBlock: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'flex-end',
    marginHorizontal: 8,
    minWidth: 0,
    paddingBottom: 4,
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
  gradeLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
    textAlign: 'center',
  },
  elevationBlock: {
    alignItems: 'flex-end',
    flexShrink: 0,
    maxWidth: 106,
    minWidth: 68,
  },
  elevationValue: {
    color: AmoledTheme.textPrimary,
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    letterSpacing: -0.5,
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
    gap: 8,
    justifyContent: 'space-between',
    marginTop: 12,
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
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    minWidth: 0,
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
    fontSize: 16,
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
    minHeight: 38,
    minWidth: 38,
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
    gap: 6,
  },
  minimizedSpeedColumn: {
    alignItems: 'flex-start',
    flexShrink: 1,
    minWidth: 0,
  },
  minimizedSpeedBlock: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 2,
  },
  minimizedSpeedValue: {
    color: AmoledTheme.textPrimary,
    fontSize: 22,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
  },
  minimizedSpeedUnit: {
    color: AmoledTheme.textSecondary,
    fontSize: 10,
    fontWeight: '600',
  },
  minimizedAverageSpeed: {
    color: AmoledTheme.accentOrange,
    fontSize: 9,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    maxWidth: 96,
  },
  minimizedGradePill: {
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  minimizedDivider: {
    backgroundColor: AmoledTheme.divider,
    height: 18,
    width: StyleSheet.hairlineWidth,
  },
  minimizedMetricItem: {
    alignItems: 'flex-start',
  },
  minimizedMetricValue: {
    color: AmoledTheme.textPrimary,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  minimizedMetricLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 9,
    fontWeight: '500',
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
    height: 34,
    justifyContent: 'center',
    width: 34,
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
