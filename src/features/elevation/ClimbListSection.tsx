import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  type ClimbSegment,
  formatGradePercent,
  getGradeColor,
} from '../../domain/routes/elevation/routeElevationAnalysis';
import { AmoledTheme } from '../../theme/colors';
import { SFIcon } from '../../components/SFIcon';

export interface ClimbListSectionProps {
  climbs: ClimbSegment[];
  maxGradePercent: number | null;
  totalAscentMeters: number;
  selectedClimbId?: number | null;
  onSelectClimb?: (climb: ClimbSegment) => void;
}

export function ClimbListSection({
  climbs,
  maxGradePercent,
  totalAscentMeters,
  selectedClimbId = null,
  onSelectClimb,
}: ClimbListSectionProps) {
  if (climbs.length === 0) {
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.titleWithIcon}>
          <SFIcon name="mountain.2.fill" color={AmoledTheme.accentYellow} size={15} />
          <Text style={styles.headerTitle}>{`TANJAKAN RUTE (${climbs.length})`}</Text>
        </View>
        <Text style={styles.headerSummary}>
          {`+${totalAscentMeters}m${maxGradePercent !== null ? ` · Maks ${maxGradePercent}%` : ''}`}
        </Text>
      </View>

      <View style={styles.climbList}>
        {climbs.map((climb, index) => {
          const isSelected = selectedClimbId === climb.id;
          const avgGradeColor = getGradeColor(climb.averageGradePercent);
          const maxGradeColor = getGradeColor(climb.maxGradePercent);
          const startKm = (climb.startDistanceMeters / 1000).toFixed(1);
          const lengthKm = (climb.distanceMeters / 1000).toFixed(1);

          return (
            <Pressable
              key={climb.id}
              accessibilityLabel={`Tanjakan ${index + 1} dari ${climbs.length}, panjang ${lengthKm} kilometer, elevasi naik ${climb.elevationGainMeters} meter`}
              accessibilityRole={onSelectClimb ? 'button' : undefined}
              disabled={!onSelectClimb}
              onPress={() => onSelectClimb?.(climb)}
              style={({ pressed }) => [
                styles.climbCard,
                isSelected && styles.climbCardSelected,
                pressed && styles.climbCardPressed,
              ]}
            >
              {/* Top Row: Index Badge & Start Distance */}
              <View style={styles.cardTopRow}>
                <View
                  style={[
                    styles.climbIndexPill,
                    {
                      backgroundColor: `${avgGradeColor}25`,
                      borderColor: avgGradeColor,
                    },
                  ]}
                >
                  <Text style={[styles.climbIndexPillText, { color: avgGradeColor }]}>
                    {`Tanjakan ${index + 1}/${climbs.length}`}
                  </Text>
                </View>
                <Text style={styles.startDistanceText}>
                  {`km ${startKm}`}
                </Text>
              </View>

              {/* Main Gain Stat */}
              <View style={styles.cardGainRow}>
                <Text style={styles.gainNumberText}>
                  {`+${climb.elevationGainMeters}`}
                  <Text style={styles.gainUnitText}> m</Text>
                </Text>
                <Text style={styles.climbLengthText}>
                  {`${lengthKm} km`}
                </Text>
              </View>

              {/* Gradient Badges Row */}
              <View style={styles.cardGradeRow}>
                <View style={styles.gradeBadge}>
                  <Text style={styles.gradeBadgeLabel}>Rata-rata</Text>
                  <Text style={[styles.gradeBadgeValue, { color: avgGradeColor }]}>
                    {formatGradePercent(climb.averageGradePercent)}
                  </Text>
                </View>
                <View style={styles.gradeBadge}>
                  <Text style={styles.gradeBadgeLabel}>Maks</Text>
                  <Text style={[styles.gradeBadgeValue, { color: maxGradeColor }]}>
                    {formatGradePercent(climb.maxGradePercent)}
                  </Text>
                </View>
              </View>

              {/* Focus on Map Action */}
              {onSelectClimb ? (
                <View style={styles.cardActionRow}>
                  <Text style={styles.cardActionText}>⌖ Fokus di peta</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 10,
    width: '100%',
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  titleWithIcon: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  headerTitle: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  headerSummary: {
    color: AmoledTheme.textPrimary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  climbList: {
    gap: 10,
  },
  climbCard: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 120,
    padding: 16,
    width: '100%',
  },
  climbCardSelected: {
    borderColor: AmoledTheme.accentOrange,
    borderWidth: 1.5,
  },
  climbCardPressed: {
    opacity: 0.8,
  },
  cardTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  climbIndexPill: {
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  climbIndexPillText: {
    fontSize: 14,
    fontWeight: '700',
  },
  startDistanceText: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  cardGainRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  gainNumberText: {
    color: AmoledTheme.textPrimary,
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
  },
  gainUnitText: {
    color: AmoledTheme.textSecondary,
    fontSize: 16,
    fontWeight: '600',
  },
  climbLengthText: {
    color: AmoledTheme.textSecondary,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  cardGradeRow: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderRadius: 8,
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 10,
    paddingVertical: 8,
  },
  gradeBadge: {
    alignItems: 'center',
  },
  gradeBadgeLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    marginBottom: 1,
  },
  gradeBadgeValue: {
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  cardActionRow: {
    alignItems: 'center',
    borderTopColor: AmoledTheme.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
  },
  cardActionText: {
    color: AmoledTheme.accentOrange,
    fontSize: 14,
    fontWeight: '600',
  },
});
