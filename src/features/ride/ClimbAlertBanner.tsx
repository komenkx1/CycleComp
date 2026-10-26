import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  type ClimbAlertState,
  type ClimbSegment,
  type RouteSample,
  formatGradePercent,
  getGradeColor,
} from '../../domain/routes/elevation/routeElevationAnalysis';
import { AmoledTheme } from '../../theme/colors';
import { SFIcon } from '../../components/SFIcon';
import { ElevationProfileChart } from '../elevation/ElevationProfileChart';

type ClimbAlertBannerProps = {
  alert: ClimbAlertState;
  samples?: RouteSample[];
};

export function ClimbAlertBanner({ alert, samples }: ClimbAlertBannerProps) {
  const climb = alert.type === 'none' ? null : alert.climb;
  const climbSamples = useMemo(
    () => climb ? buildClimbProfileSamples(climb, samples) : [],
    [climb, samples],
  );
  if (alert.type === 'none') {
    return null;
  }

  const isOngoing = alert.type === 'active';
  const gradeColor = getGradeColor(
    isOngoing ? alert.currentGradePercent : alert.climb.averageGradePercent,
  );

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[
        styles.bannerCard,
        {
          borderColor: isOngoing ? gradeColor : AmoledTheme.accentYellow,
        },
      ]}
    >
      <View style={styles.topRow}>
        <View style={styles.badgeContainer}>
          <View
            style={[
              styles.alertBadge,
              {
                backgroundColor: isOngoing ? `${gradeColor}25` : 'rgba(245, 158, 11, 0.18)',
                borderColor: isOngoing ? gradeColor : AmoledTheme.accentYellow,
              },
            ]}
          >
            <SFIcon
              name={isOngoing ? 'mountain.2.fill' : 'exclamationmark.triangle.fill'}
              color={isOngoing ? gradeColor : AmoledTheme.accentYellow}
              size={14}
            />
            <Text
              style={[
                styles.alertBadgeText,
                { color: isOngoing ? gradeColor : AmoledTheme.accentYellow },
              ]}
            >{`TANJAKAN ${alert.climbIndex}/${alert.totalClimbs}`}</Text>
          </View>
        </View>

        <View style={styles.metricRight}>
          {isOngoing ? (
            <View style={styles.gradeBadgeBlock}>
              <Text style={styles.remainingDistanceText}>
                {formatDistanceLabel(alert.distanceRemainingMeters)} lagi
              </Text>
              <View
                style={[
                  styles.gradePill,
                  { backgroundColor: gradeColor },
                ]}
              >
                <Text style={styles.gradePillText}>
                  {formatGradePercent(alert.currentGradePercent)}
                </Text>
              </View>
            </View>
          ) : (
            <Text style={styles.upcomingDistanceText}>
              {formatDistanceLabel(alert.distanceToStartMeters)} di depan
            </Text>
          )}
        </View>
      </View>

      {/* 2D Mini Profile dengan Rider Dot (Signature Garmin ClimbPro) */}
      <View style={styles.progressContainer}>
        <ElevationProfileChart
          samples={climbSamples}
          height={48}
          showLabels={false}
          riderProgressPercent={isOngoing ? alert.progressPercent : null}
          barCount={32}
        />
      </View>

      <View style={styles.detailRow}>
        <Text numberOfLines={1} style={styles.detailText}>
          {isOngoing ? (
            <>
              Rata-rata{' '}
              <Text style={styles.detailHighlight}>
                {alert.climb.averageGradePercent}%
              </Text>{' '}
              · Maks{' '}
              <Text style={styles.detailHighlight}>
                {alert.climb.maxGradePercent}%
              </Text>{' '}
              · Sisa naik{' '}
              <Text style={styles.detailHighlight}>
                {alert.gainRemainingMeters === null ? '—' : `+${alert.gainRemainingMeters}`} m
              </Text>
            </>
          ) : (
            <>
              Panjang{' '}
              <Text style={styles.detailHighlight}>
                {formatDistanceLabel(alert.climb.distanceMeters)}
              </Text>{' '}
              @{' '}
              <Text style={styles.detailHighlight}>
                {alert.climb.averageGradePercent}%
              </Text>{' '}
              · Naik{' '}
              <Text style={styles.detailHighlight}>
                +{alert.climb.elevationGainMeters} m
              </Text>{' '}
              · Maks{' '}
              <Text style={styles.detailHighlight}>
                {alert.climb.maxGradePercent}%
              </Text>
            </>
          )}
        </Text>
      </View>
    </View>
  );
}

function formatDistanceLabel(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

export function buildClimbProfileSamples(
  climb: ClimbSegment,
  samples?: RouteSample[],
): RouteSample[] {
  if (samples && samples.length > 0) {
    const climbSamples = samples.filter(
      s =>
        s.distanceMeters >= climb.startDistanceMeters &&
        s.distanceMeters <= climb.endDistanceMeters &&
        s.elevationMeters !== null,
    );
    if (climbSamples.length >= 4) {
      return climbSamples;
    }
  }

  // Fallback kurva tanjakan sintetis realistis
  const startEle = climb.startElevationMeters ?? 50;
  const endEle = climb.endElevationMeters ?? (startEle + climb.elevationGainMeters);
  const count = 30;
  const stepDist = Math.max(10, climb.distanceMeters / count);
  const result: RouteSample[] = [];

  for (let i = 0; i <= count; i++) {
    const fraction = i / count;
    // kurva sigmoid natural tanjakan
    const curve = Math.sin(fraction * Math.PI * 0.5);
    const ele = startEle + (endEle - startEle) * curve;
    result.push({
      coordinate: climb.startCoordinate,
      distanceMeters: climb.startDistanceMeters + i * stepDist,
      elevationMeters: ele,
      gradePercent: climb.averageGradePercent,
    });
  }

  return result;
}

const styles = StyleSheet.create({
  bannerCard: {
    backgroundColor: AmoledTheme.card,
    borderRadius: 16,
    borderWidth: 1,
    marginHorizontal: 12,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.6,
    shadowRadius: 10,
  },
  topRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  badgeContainer: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  alertBadge: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  alertBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  metricRight: {
    alignItems: 'flex-end',
  },
  gradeBadgeBlock: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  remainingDistanceText: {
    color: AmoledTheme.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  upcomingDistanceText: {
    color: AmoledTheme.accentYellow,
    fontSize: 13,
    fontWeight: '700',
  },
  gradePill: {
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  gradePillText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  progressContainer: {
    marginVertical: 8,
  },
  progressBarTrack: {
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderRadius: 3,
    height: 5,
    overflow: 'hidden',
    width: '100%',
  },
  progressBarFill: {
    borderRadius: 3,
    height: '100%',
  },
  detailRow: {
    marginTop: 2,
  },
  detailText: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    fontWeight: '500',
  },
  detailHighlight: {
    color: AmoledTheme.textPrimary,
    fontWeight: '700',
  },
});
