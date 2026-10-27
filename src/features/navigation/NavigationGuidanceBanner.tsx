import { useMemo, useState } from 'react';
import {
  LayoutAnimation,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { TurnInstruction } from '../../domain/routes/navigation/routeNavigationGuidance';
import { formatNavigationDistance } from '../../domain/routes/navigation/routeNavigationGuidance';
import {
  type ClimbAlertState,
  formatGradePercent,
  getGradeColor,
  getGradeLabel,
  getShortGradeLabel,
} from '../../domain/routes/elevation/routeElevationAnalysis';
import { AmoledTheme } from '../../theme/colors';
import { SFIcon, navigationSymbolName } from '../../components/SFIcon';
import { ElevationProfileChart } from '../elevation/ElevationProfileChart';
import { buildClimbProfileSamples } from '../ride/ClimbAlertBanner';

type NavigationGuidanceBannerProps = {
  instruction: TurnInstruction | null;
  climbAlert: ClimbAlertState;
  routeName?: string;
  isPaused?: boolean;
  needsRecovery?: boolean;
  accuracyMeters?: number | null;
  soundEnabled?: boolean;
  onToggleSound?: () => void;
};

// Google Maps Iconic Navigation Teal (#00594C)
const NAV_TEAL_BG = '#00594C';
const NAV_TEAL_BORDER = 'rgba(16, 185, 129, 0.35)';
const THEN_PILL_BG = 'rgba(0, 0, 0, 0.35)';

export function NavigationGuidanceBanner({
  instruction,
  climbAlert,
  routeName,
  isPaused = false,
  needsRecovery = false,
  accuracyMeters = null,
  soundEnabled = true,
  onToggleSound,
}: NavigationGuidanceBannerProps) {
  const [collapsed, setCollapsed] = useState(false);

  const toggleCollapsed = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCollapsed(prev => !prev);
  };

  const hasClimb = climbAlert.type === 'active' || climbAlert.type === 'upcoming';

  const climbGrade = useMemo(() => {
    if (climbAlert.type === 'active') {
      return climbAlert.currentGradePercent ?? climbAlert.climb.averageGradePercent;
    }
    if (climbAlert.type === 'upcoming') {
      return climbAlert.climb.averageGradePercent;
    }
    return 0;
  }, [climbAlert]);

  const climbGradeColor = useMemo(() => getGradeColor(climbGrade), [climbGrade]);

  // Collapsed state: ultra-compact bar
  if (collapsed) {
    return (
      <View style={styles.container}>
        <Pressable
          accessibilityHint="Ketuk untuk membuka rincian panduan navigasi"
          accessibilityLabel="Buka panduan navigasi"
          accessibilityRole="button"
          onPress={toggleCollapsed}
          style={[styles.card, styles.collapsedCard]}
        >
          <View style={styles.collapsedRow}>
            <SFIcon
              name={instruction ? navigationSymbolName(instruction.type) : 'location.north.fill'}
              size={20}
            />
            <View style={styles.collapsedTextCol}>
              <Text numberOfLines={1} style={styles.collapsedMainText}>
                {instruction
                  ? `${formatNavigationDistance(instruction.distanceMeters)} · ${instruction.title}`
                  : `Navigasi Bebas · ${needsRecovery ? 'Perlu dipulihkan' : isPaused ? 'Jeda' : 'Merekam'}`}
              </Text>
              {hasClimb ? (
                <Text numberOfLines={1} style={styles.collapsedClimbText}>
                  {`Tanjakan ${formatGradePercent(climbGrade)} (${getGradeLabel(climbGrade)})`}
                </Text>
              ) : null}
            </View>
            <Text style={styles.expandChevron}>▼</Text>
          </View>
        </Pressable>
      </View>
    );
  }

  // Fallback when no GPX route is loaded (Free-Ride Mode)
  if (!instruction) {
    return (
      <View style={styles.container}>
        <View style={styles.card}>
          <View style={styles.mainRow}>
            <View style={styles.iconColumn}>
              <View style={styles.freeRideIconContainer}>
                <SFIcon name="location.north.fill" size={24} />
              </View>
            </View>
            <View style={styles.contentColumn}>
              <View style={styles.titleRow}>
                <Text numberOfLines={1} style={styles.distanceText}>
                  Navigasi Bebas
                </Text>
                <View style={styles.headerRightControls}>
                  {accuracyMeters != null ? (
                    <View style={styles.accuracyBadge}>
                      <Text style={styles.accuracyText}>{`±${Math.round(accuracyMeters)}m`}</Text>
                    </View>
                  ) : null}
                  <View style={styles.statusBadges}>
                    <View
                      style={[
                        styles.statusDot,
                        isPaused || needsRecovery ? styles.pausedDot : styles.liveDot,
                      ]}
                    />
                    <Text style={styles.statusLabel}>
                      {needsRecovery ? 'Perlu dipulihkan' : isPaused ? 'Jeda' : 'Merekam'}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityHint="Perkecil banner panduan navigasi"
                    accessibilityLabel="Perkecil panduan"
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={toggleCollapsed}
                    style={styles.collapseButton}
                  >
                    <Text style={styles.collapseButtonText}>▲</Text>
                  </Pressable>
                </View>
              </View>
              <Text numberOfLines={1} style={styles.instructionText}>
                {routeName ?? (needsRecovery ? 'Pulihkan perjalanan untuk melanjutkan' : isPaused ? 'Perekaman dijeda' : 'Merekam rute GPS tanpa GPX')}
              </Text>
            </View>
          </View>

          {hasClimb ? (
            <ClimbAlertRow alert={climbAlert} gradeColor={climbGradeColor} />
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        {/* Top guidance row (Google Maps Style) */}
        <View style={styles.mainRow}>
          {/* Left: Big maneuver arrow & "Then / Lalu" pill */}
          <View style={styles.iconColumn}>
            <View style={styles.turnIconCircle}>
              <SFIcon name={navigationSymbolName(instruction.type)} size={34} />
            </View>
            {instruction.thenManeuver ? (
              <View style={styles.thenPill}>
                <Text style={styles.thenPrefix}>Lalu</Text>
                <SFIcon name={navigationSymbolName(instruction.thenManeuver.type)} size={17} />
              </View>
            ) : null}
          </View>

          {/* Right: Distance & Street / Maneuver Text */}
          <View style={styles.contentColumn}>
            <View style={styles.titleRow}>
              <Text style={styles.distanceText}>
                {instruction.distanceMeters < 30
                  ? 'Sekarang'
                  : `Dalam ${formatNavigationDistance(instruction.distanceMeters)}`}
              </Text>
              <View style={styles.headerRightControls}>
                {onToggleSound ? (
                  <Pressable
                    accessibilityHint="Nyalakan atau bisukan nada panduan Garmin"
                    accessibilityLabel={soundEnabled ? 'Matikan suara beeper' : 'Nyalakan suara beeper'}
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={onToggleSound}
                    style={styles.audioButton}
                  >
                    <SFIcon name={soundEnabled ? 'speaker.wave.2.fill' : 'speaker.slash.fill'} size={17} />
                  </Pressable>
                ) : null}
                {accuracyMeters != null ? (
                  <View style={styles.accuracyBadge}>
                    <Text style={styles.accuracyText}>{`±${Math.round(accuracyMeters)}m`}</Text>
                  </View>
                ) : null}
                <Pressable
                  accessibilityHint="Perkecil banner panduan navigasi"
                  accessibilityLabel="Perkecil panduan"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={toggleCollapsed}
                  style={styles.collapseButton}
                >
                  <Text style={styles.collapseButtonText}>▲</Text>
                </Pressable>
              </View>
            </View>

            <Text numberOfLines={2} style={styles.instructionText}>
              {instruction.title}
            </Text>

            <Text numberOfLines={1} style={styles.descriptionSubText}>
              {instruction.description}
            </Text>
          </View>
        </View>

        {/* Integrated Climb Alert Warning Section */}
        {hasClimb ? (
          <ClimbAlertRow alert={climbAlert} gradeColor={climbGradeColor} />
        ) : null}
      </View>
    </View>
  );
}

/**
 * Komponen sub-baris peringatan tanjakan di dalam banner Google Maps.
 * Menampilkan kecuraman persen, jarak ke tanjakan, elevasi naik, dan progress.
 */
function ClimbAlertRow({
  alert,
  gradeColor,
}: {
  alert: ClimbAlertState;
  gradeColor: string;
}) {
  const climb = alert.type === 'none' ? null : alert.climb;
  const climbSamples = useMemo(
    () => climb ? buildClimbProfileSamples(climb) : [],
    [climb],
  );
  if (alert.type === 'none') {
    return null;
  }

  const isActive = alert.type === 'active';
  return (
    <View
      style={[
        styles.climbAlertContainer,
        {
          borderColor: isActive ? gradeColor : AmoledTheme.accentYellow,
          backgroundColor: isActive ? 'rgba(0, 0, 0, 0.45)' : 'rgba(245, 158, 11, 0.14)',
        },
      ]}
    >
      <View style={styles.climbAlertTopRow}>
        <View style={styles.climbTagGroup}>
          <SFIcon
            name={isActive ? 'mountain.2.fill' : 'exclamationmark.triangle.fill'}
            color={isActive ? gradeColor : AmoledTheme.accentYellow}
            size={16}
          />
          <View
            style={[
              styles.climbCategoryBadge,
              { backgroundColor: gradeColor },
            ]}
          >
            <Text style={styles.climbCategoryBadgeText}>
              {isActive
                ? `TANJAKAN ${alert.climbIndex}/${alert.totalClimbs}`
                : `PERINGATAN TANJAKAN`}
            </Text>
          </View>
        </View>

        <View style={styles.climbGradeValueBlock}>
          <Text
            style={[
              styles.climbGradeNumber,
              { color: isActive ? gradeColor : AmoledTheme.accentYellow },
            ]}
          >
            {formatGradePercent(
              isActive ? alert.currentGradePercent : alert.climb.averageGradePercent,
            )}
          </Text>
          <Text style={styles.climbGradeLabel}>
            {getShortGradeLabel(
              isActive
                ? (alert.currentGradePercent ?? alert.climb.averageGradePercent)
                : alert.climb.averageGradePercent,
            )}
          </Text>
        </View>
      </View>

      {/* 2D Mini Profile dengan Rider Dot saat sedang menanjak aktif */}
      {isActive ? (
        <View style={styles.climbMiniProfileWrap}>
          <ElevationProfileChart
            samples={climbSamples}
            height={40}
            showLabels={false}
            riderProgressPercent={alert.progressPercent}
            barCount={28}
          />
        </View>
      ) : null}

      {/* Deskripsi tanjakan dan jarak */}
      <View style={styles.climbDetailRow}>
        <Text numberOfLines={1} style={styles.climbDetailText}>
          {isActive ? (
            <>
              Sisa{' '}
              <Text style={styles.climbHighlight}>
                {formatNavigationDistance(alert.distanceRemainingMeters)}
              </Text>{' '}
              · Naik{' '}
              <Text style={styles.climbHighlight}>
                {alert.gainRemainingMeters === null ? '—' : `+${alert.gainRemainingMeters}`}m
              </Text>{' '}
              · Maks{' '}
              <Text style={styles.climbHighlight}>
                {alert.climb.maxGradePercent}%
              </Text>
            </>
          ) : (
            <>
              Mulai dalam{' '}
              <Text style={styles.climbHighlightYellow}>
                {formatNavigationDistance(alert.distanceToStartMeters)}
              </Text>{' '}
              · Panjang {formatNavigationDistance(alert.climb.distanceMeters)} · Naik +
              {alert.climb.elevationGainMeters}m (Maks {alert.climb.maxGradePercent}%)
            </>
          )}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'stretch',
    marginHorizontal: 12,
    marginTop: 4,
    zIndex: 99,
  },
  card: {
    backgroundColor: NAV_TEAL_BG,
    borderColor: NAV_TEAL_BORDER,
    borderRadius: 18,
    borderWidth: 1.5,
    overflow: 'hidden',
    padding: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.55,
    shadowRadius: 10,
    width: '100%',
  },
  collapsedCard: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  collapsedRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  collapsedIcon: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '900',
  },
  collapsedTextCol: {
    flex: 1,
    minWidth: 0,
  },
  collapsedMainText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  collapsedClimbText: {
    color: AmoledTheme.accentYellow,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 1,
  },
  expandChevron: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: 4,
  },
  mainRow: {
    alignItems: 'center',
    flexDirection: 'row',
    width: '100%',
  },
  iconColumn: {
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    minWidth: 44,
  },
  turnIconCircle: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  turnIcon: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '900',
    textAlign: 'center',
  },
  freeRideIconContainer: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  freeRideIcon: {
    fontSize: 24,
  },
  thenPill: {
    alignItems: 'center',
    backgroundColor: THEN_PILL_BG,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 4,
    marginTop: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  thenPrefix: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 10,
    fontWeight: '600',
  },
  thenIcon: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  contentColumn: {
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
  },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
  },
  distanceText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  headerRightControls: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  accuracyBadge: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  accuracyText: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 10,
    fontWeight: '600',
  },
  collapseButton: {
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    borderRadius: 12,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
  },
  collapseButtonText: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 10,
    fontWeight: '700',
  },
  instructionText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    marginTop: 1,
    lineHeight: 19,
  },
  descriptionSubText: {
    color: 'rgba(255, 255, 255, 0.78)',
    fontSize: 12,
    marginTop: 2,
  },
  statusBadges: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  statusDot: {
    borderRadius: 4,
    height: 7,
    width: 7,
  },
  liveDot: {
    backgroundColor: AmoledTheme.accentGreen,
  },
  pausedDot: {
    backgroundColor: AmoledTheme.accentYellow,
  },
  statusLabel: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 11,
    fontWeight: '700',
  },
  climbAlertContainer: {
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  climbAlertTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  climbTagGroup: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  climbIcon: {
    fontSize: 14,
  },
  climbCategoryBadge: {
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 1.5,
  },
  climbCategoryBadgeText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  climbGradeValueBlock: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  climbGradeNumber: {
    fontSize: 13,
    fontWeight: '800',
  },
  climbGradeLabel: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
  },
  climbMiniProfileWrap: {
    marginVertical: 4,
    width: '100%',
  },
  climbProgressBarTrack: {
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 2,
    height: 4,
    marginTop: 5,
    overflow: 'hidden',
    width: '100%',
  },
  climbProgressBarFill: {
    borderRadius: 2,
    height: '100%',
  },
  climbDetailRow: {
    marginTop: 3,
  },
  climbDetailText: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 11,
    fontWeight: '500',
  },
  climbHighlight: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  climbHighlightYellow: {
    color: AmoledTheme.accentYellow,
    fontWeight: '700',
  },
  audioButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    borderRadius: 14,
    height: 28,
    justifyContent: 'center',
    marginRight: 4,
    width: 28,
  },
  audioButtonText: {
    fontSize: 13,
  },
});
