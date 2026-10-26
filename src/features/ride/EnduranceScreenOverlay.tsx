import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { TurnInstruction } from '../../domain/routes/navigation/routeNavigationGuidance';
import { formatNavigationDistance } from '../../domain/routes/navigation/routeNavigationGuidance';
import type { ClimbAlertState } from '../../domain/routes/elevation/routeElevationAnalysis';
import { formatGradePercent, getGradeColor } from '../../domain/routes/elevation/routeElevationAnalysis';
import { AmoledTheme } from '../../theme/colors';
import { SFIcon, navigationSymbolName } from '../../components/SFIcon';
import { calculateAverageSpeedKmh } from '../../domain/ride/rideMetrics';

type EnduranceScreenOverlayProps = {
  visible: boolean;
  speedKmh?: number | null;
  heartRateBpm?: number | null;
  elapsedSeconds?: number;
  distanceMeters?: number;
  movingSeconds?: number;
  totalAscentMeters?: number | null;
  liveGradePercent?: number | null;
  liveGradeSource?: 'barometer' | 'gps' | null;
  routeProfileAvailable?: boolean;
  turnInstruction?: TurnInstruction | null;
  climbAlert?: ClimbAlertState;
  terrainClimbStatus?: 'unavailable' | 'unknown' | 'none' | 'upcoming' | 'active' | null;
  terrainClimbDistanceToStartMeters?: number | null;
  terrainClimbAverageGradePercent?: number | null;
  onWakeUp: () => void;
  onDisableEndurance: () => void;
};

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

export function EnduranceScreenOverlay({
  visible,
  speedKmh = 0,
  heartRateBpm,
  elapsedSeconds = 0,
  distanceMeters = 0,
  movingSeconds = 0,
  totalAscentMeters = null,
  liveGradePercent = null,
  liveGradeSource = null,
  routeProfileAvailable = false,
  turnInstruction,
  climbAlert,
  terrainClimbStatus = null,
  terrainClimbDistanceToStartMeters = null,
  terrainClimbAverageGradePercent = null,
  onWakeUp,
  onDisableEndurance,
}: EnduranceScreenOverlayProps) {
  const insets = useSafeAreaInsets();

  if (!visible) return null;

  const hasGpxClimb = climbAlert?.type === 'active' || climbAlert?.type === 'upcoming';
  const hasTerrainClimb = !hasGpxClimb && (terrainClimbStatus === 'active' || terrainClimbStatus === 'upcoming');
  const hasClimb = hasGpxClimb || hasTerrainClimb;
  const averageSpeedKmh = calculateAverageSpeedKmh(distanceMeters, movingSeconds);
  const averageSpeedLabel = averageSpeedKmh == null
    ? 'RATA-RATA —'
    : `RATA-RATA ${averageSpeedKmh.toLocaleString('id-ID', {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
    })} KM/JAM`;
  const climbGrade = hasGpxClimb
    ? (climbAlert?.type === 'active'
      ? climbAlert.currentGradePercent ?? climbAlert.climb.averageGradePercent
      : climbAlert?.type === 'upcoming'
      ? climbAlert.climb.averageGradePercent
      : 0)
    : (terrainClimbAverageGradePercent ?? 0);
  const climbTitle = hasGpxClimb
    ? (climbAlert?.type === 'active'
      ? `Tanjakan #${climbAlert.climbIndex}`
      : `Tanjakan ${climbAlert?.type === 'upcoming' ? climbAlert.distanceToStartMeters : 0}m lagi`)
    : (terrainClimbStatus === 'active'
      ? 'Tanjakan di Depan'
      : `Tanjakan ${Math.round(terrainClimbDistanceToStartMeters ?? 0)}m lagi`);

  return (
    <Pressable
      accessibilityHint="Ketuk layar untuk menampilkan peta kembali"
      accessibilityLabel="Layar hemat daya AMOLED aktif. Ketuk untuk membangunkan peta."
      onPress={onWakeUp}
      style={[
        styles.container,
        {
          paddingTop: Math.max(insets.top, 16) + 8,
          paddingBottom: Math.max(insets.bottom, 16) + 12,
        },
      ]}
    >
      {/* Top Status Capsule */}
      <View style={styles.topStatusRow}>
        <View style={styles.enduranceBadge}>
          <SFIcon name="bolt.fill" color={AmoledTheme.accentYellow} size={15} />
          <Text style={styles.enduranceBadgeText}>AMOLED ENDURANCE MODE</Text>
        </View>
        <Pressable
          accessibilityHint="Matikan mode hemat baterai"
          accessibilityLabel="Matikan hemat baterai"
          onPress={onDisableEndurance}
          style={styles.exitButton}
        >
          <Text style={styles.exitButtonText}>Matikan ✕</Text>
        </Pressable>
      </View>

      {/* Main Giant Speed Display */}
      <View style={styles.speedSection}>
        <Text
          adjustsFontSizeToFit
          minimumFontScale={0.7}
          numberOfLines={1}
          style={styles.speedNumber}
        >
          {speedKmh == null ? '—' : speedKmh.toFixed(1).replace('.', ',')}
        </Text>
        <Text style={styles.speedUnit}>KM/JAM</Text>
        <Text testID="endurance-average-speed" style={styles.averageSpeedText}>
          {averageSpeedLabel}
        </Text>
      </View>

      {heartRateBpm != null ? <Text style={styles.heartRateText}>{heartRateBpm} bpm</Text> : null}

      <View style={styles.liveGradeRow}>
        <SFIcon name="mountain.2.fill" color={getGradeColor(liveGradePercent)} size={16} />
        <Text style={[styles.liveGradeText, { color: getGradeColor(liveGradePercent) }]}>
          {liveGradePercent == null
            ? 'Gradien aktual —'
            : `Gradien aktual ${formatGradePercent(liveGradePercent)} · ${liveGradeSource === 'gps' ? 'GPS' : 'barometer'}`}
        </Text>
      </View>

      {/* Turn or Climb Next Action HUD */}
      {turnInstruction && turnInstruction.type !== 'straight' ? (
        <View style={styles.nextActionPill}>
          <SFIcon name={navigationSymbolName(turnInstruction.type)} size={34} />
          <View style={styles.turnTextCol}>
            <Text numberOfLines={1} style={styles.turnTitle}>
              {turnInstruction.title}
            </Text>
            <Text style={styles.turnDistance}>
              {formatNavigationDistance(turnInstruction.distanceMeters)}
            </Text>
          </View>
        </View>
      ) : hasClimb ? (
        <View
          style={[
            styles.nextActionPill,
            { borderColor: getGradeColor(climbGrade) },
          ]}
        >
          <SFIcon name="mountain.2.fill" color={getGradeColor(climbGrade)} size={30} />
          <View style={styles.turnTextCol}>
            <Text numberOfLines={1} style={styles.turnTitle}>
              {climbTitle}
            </Text>
            <Text
              style={[
                styles.turnDistance,
                { color: getGradeColor(climbGrade) },
              ]}
            >
              {formatGradePercent(climbGrade)}
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.straightPill}>
          <Text style={styles.straightText}>
            {routeProfileAvailable ? 'Tidak ada tanjakan dekat' : 'Mode bebas · tanpa profil rute'}
          </Text>
        </View>
      )}

      {/* Bottom Cycling Telemetry */}
      <View style={styles.bottomStatsRow}>
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>WAKTU</Text>
          <Text style={styles.statValue}>{formatDuration(elapsedSeconds)}</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>JARAK</Text>
          <Text style={styles.statValue}>
            {(distanceMeters / 1000).toFixed(1).replace('.', ',')}{' '}
            <Text style={styles.statUnit}>km</Text>
          </Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>ELEVASI</Text>
          <Text style={styles.statValue}>
            {`${totalAscentMeters == null ? '—' : `+${Math.round(totalAscentMeters)}`} `}
            <Text style={styles.statUnit}>m</Text>
          </Text>
        </View>
      </View>

      <Text style={styles.tapToPeekHint}>
        Ketuk layar di mana saja untuk mengintip peta
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  heartRateText: { color: AmoledTheme.textPrimary, fontSize: 28, fontWeight: '600', textAlign: 'center', marginBottom: 16 },
  liveGradeRow: { alignItems: 'center', flexDirection: 'row', gap: 7, justifyContent: 'center' },
  liveGradeText: { fontSize: 14, fontVariant: ['tabular-nums'], fontWeight: '700' },

  container: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: '#000000',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    zIndex: 999,
  },
  topStatusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
  },
  enduranceBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(48, 209, 88, 0.12)',
    borderColor: 'rgba(48, 209, 88, 0.28)',
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  enduranceDot: {
    fontSize: 12,
  },
  enduranceBadgeText: {
    color: AmoledTheme.accentGreen,
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  exitButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  exitButtonText: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  speedSection: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 12,
  },
  speedNumber: {
    color: '#FFFFFF',
    fontSize: 96,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    letterSpacing: -4,
    lineHeight: 100,
  },
  speedUnit: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginTop: -4,
  },
  averageSpeedText: {
    color: AmoledTheme.accentOrange,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    marginTop: 10,
  },
  nextActionPill: {
    alignItems: 'center',
    backgroundColor: '#0C0C0E',
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 14,
    maxWidth: 340,
    paddingHorizontal: 18,
    paddingVertical: 12,
    width: '100%',
  },
  turnIcon: {
    color: AmoledTheme.accentOrange,
    fontSize: 28,
    fontWeight: '800',
  },
  turnTextCol: {
    flex: 1,
  },
  turnTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
  },
  turnDistance: {
    color: AmoledTheme.accentOrange,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
  },
  straightPill: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  straightText: {
    color: AmoledTheme.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  bottomStatsRow: {
    alignItems: 'center',
    backgroundColor: '#0C0C0E',
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 14,
    width: '100%',
  },
  statBox: {
    alignItems: 'center',
    flex: 1,
  },
  statLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  statValue: {
    color: '#FFFFFF',
    fontSize: 17,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  statUnit: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    fontWeight: '500',
  },
  statDivider: {
    backgroundColor: AmoledTheme.borderSubtle,
    height: 24,
    width: StyleSheet.hairlineWidth,
  },
  tapToPeekHint: {
    color: AmoledTheme.textTertiary,
    fontSize: 11,
    fontWeight: '500',
    marginTop: 8,
  },
});
