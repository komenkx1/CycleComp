import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  LayoutChangeEvent,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';

import {
  type RouteSample,
  getGradeColor,
} from '../../domain/routes/elevation/routeElevationAnalysis';
import { AmoledTheme } from '../../theme/colors';
import { SFIcon } from '../../components/SFIcon';

export interface ElevationBarBucket {
  distanceMeters: number;
  elevationMeters: number | null;
  gradePercent: number | null;
  color: string;
}

export interface ElevationProfileChartProps {
  samples: RouteSample[];
  height?: number;
  riderProgressPercent?: number | null;
  interactive?: boolean;
  minElevationOverride?: number | null;
  maxElevationOverride?: number | null;
  barCount?: number;
  showLabels?: boolean;
  style?: StyleProp<ViewStyle>;
  onScrubDistance?: (distanceMeters: number | null) => void;
}

const DEFAULT_BAR_COUNT = 55;
const DEFAULT_HEIGHT = 80;

export function ElevationProfileChart({
  samples,
  height = DEFAULT_HEIGHT,
  riderProgressPercent = null,
  interactive = false,
  minElevationOverride = null,
  maxElevationOverride = null,
  barCount = DEFAULT_BAR_COUNT,
  showLabels = true,
  style,
  onScrubDistance,
}: ElevationProfileChartProps) {
  const chartAreaRef = useRef<React.ElementRef<typeof View>>(null);
  const [chartFrame, setChartFrame] = useState({ left: 0, width: 0 });
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);

  const validSamples = useMemo(
    () => samples.filter(s => s.elevationMeters !== null),
    [samples],
  );

  const { buckets, minEle, maxEle, totalDistanceMeters, peakIndex } = useMemo(() => {
    if (validSamples.length === 0) {
      return {
        buckets: [],
        minEle: 0,
        maxEle: 0,
        totalDistanceMeters: 0,
        peakIndex: -1,
      };
    }

    const firstDist = samples[0]?.distanceMeters ?? validSamples[0].distanceMeters;
    const lastDist = samples.at(-1)?.distanceMeters ?? validSamples.at(-1)!.distanceMeters;
    const totalDist = Math.max(1, lastDist - firstDist);

    let observedMin = minElevationOverride ?? Infinity;
    let observedMax = maxElevationOverride ?? -Infinity;

    if (minElevationOverride === null || maxElevationOverride === null) {
      for (const s of validSamples) {
        const ele = s.elevationMeters!;
        if (ele < observedMin) observedMin = ele;
        if (ele > observedMax) observedMax = ele;
      }
    }

    // Hindari pembagian dengan 0 jika rute benar-benar datar
    if (observedMax <= observedMin) {
      observedMax = observedMin + 10;
    }

    // Bagi rute menjadi N bucket yang terdistribusi merata sepanjang jarak
    const targetBars = Math.max(10, Math.min(100, barCount));
    const step = totalDist / targetBars;
    const generatedBuckets: ElevationBarBucket[] = [];
    const samplesByBar = Array.from({ length: targetBars }, () => [] as RouteSample[]);
    let highestEle = -Infinity;
    let highestIdx = -1;

    for (const sample of samples) {
      const barIndex = Math.min(
        targetBars - 1,
        Math.max(0, Math.floor(((sample.distanceMeters - firstDist) / totalDist) * targetBars)),
      );
      samplesByBar[barIndex]?.push(sample);
    }

    for (const sample of validSamples) {
      if (sample.elevationMeters !== null && sample.elevationMeters > highestEle) {
        highestEle = sample.elevationMeters;
        highestIdx = Math.min(
          targetBars - 1,
          Math.max(0, Math.floor(((sample.distanceMeters - firstDist) / totalDist) * targetBars)),
        );
      }
    }

    for (let b = 0; b < targetBars; b++) {
      const midDist = firstDist + (b + 0.5) * step;
      const elevationSamplesInBar = (samplesByBar[b] ?? []).filter(
        sample => sample.elevationMeters !== null,
      );
      const averageElevation = elevationSamplesInBar.length > 0
        ? elevationSamplesInBar.reduce((sum, sample) => sum + (sample.elevationMeters ?? 0), 0) /
          elevationSamplesInBar.length
        : null;
      const lastGradeSample = elevationSamplesInBar
        .filter(sample => sample.gradePercent !== null)
        .at(-1);
      const grade = lastGradeSample?.gradePercent ?? null;

      generatedBuckets.push({
        distanceMeters: midDist,
        elevationMeters: averageElevation,
        gradePercent: grade,
        color: getGradeColor(grade),
      });
    }

    return {
      buckets: generatedBuckets,
      minEle: Math.floor(observedMin),
      maxEle: Math.ceil(observedMax),
      totalDistanceMeters: totalDist,
      peakIndex: highestIdx,
    };
  }, [samples, validSamples, minElevationOverride, maxElevationOverride, barCount]);

  const scrubPanResponder = useMemo(() => {
    if (!interactive) return null;

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: evt => {
        updateScrubFromPageX(evt.nativeEvent.pageX);
      },
      onPanResponderMove: evt => {
        updateScrubFromPageX(evt.nativeEvent.pageX);
      },
      onPanResponderRelease: () => {
        setScrubIndex(null);
        onScrubDistance?.(null);
      },
      onPanResponderTerminate: () => {
        setScrubIndex(null);
        onScrubDistance?.(null);
      },
    });

    function updateScrubFromPageX(pageX: number) {
      if (chartFrame.width <= 0 || buckets.length === 0) return;
      const chartX = Math.max(0, Math.min(chartFrame.width, pageX - chartFrame.left));
      const idx = Math.min(
        buckets.length - 1,
        Math.floor((chartX / chartFrame.width) * buckets.length),
      );
      setScrubIndex(idx);
      onScrubDistance?.(buckets[idx].distanceMeters);
    }
  }, [interactive, chartFrame, buckets, onScrubDistance]);

  const measureChartArea = useCallback((event: LayoutChangeEvent) => {
    const laidOutWidth = event.nativeEvent.layout.width;
    setChartFrame(previous =>
      previous.width === laidOutWidth ? previous : { ...previous, width: laidOutWidth },
    );
    chartAreaRef.current?.measureInWindow((left, _top, width) => {
      setChartFrame(previous =>
        previous.left === left && previous.width === width
          ? previous
          : { left, width },
      );
    });
  }, []);

  if (buckets.length === 0) {
    return (
      <View style={[styles.emptyContainer, { height }, style]}>
        <Text style={styles.emptyText}>Data elevasi tidak tersedia</Text>
      </View>
    );
  }

  const eleRange = Math.max(1, maxEle - minEle);
  const chartHeight = Math.max(30, height - (showLabels ? 22 : 0));

  // Hitung posisi Rider Dot (jika riderProgressPercent diset)
  let riderBarIndex = -1;
  let riderDotBottom = 0;
  if (riderProgressPercent !== null && riderProgressPercent >= 0) {
    const clampedProgress = Math.min(100, Math.max(0, riderProgressPercent));
    riderBarIndex = Math.min(
      buckets.length - 1,
      Math.round((clampedProgress / 100) * (buckets.length - 1)),
    );
    const targetBucket = buckets[riderBarIndex];
    const heightFraction = Math.max(
      0.08,
      ((targetBucket.elevationMeters ?? minEle) - minEle) / eleRange,
    );
    riderDotBottom = heightFraction * (chartHeight - 10);
  }

  const activeScrubBucket = scrubIndex !== null ? buckets[scrubIndex] : null;

  return (
    <View
      style={[styles.container, style]}
    >
      {/* Header Label Elevasi */}
      {showLabels ? (
        <View style={styles.labelRow}>
          <Text style={styles.elevationBoundaryText}>
            {`Min ${minEle} m`}
          </Text>
          {activeScrubBucket ? (
            <View style={styles.scrubIndicatorBadge}>
              <Text style={styles.scrubIndicatorText}>
                {`${(activeScrubBucket.distanceMeters / 1000).toFixed(1)} km · ${activeScrubBucket.elevationMeters === null ? '—' : `${Math.round(activeScrubBucket.elevationMeters)} m`} · ${activeScrubBucket.gradePercent === null ? '—' : `${activeScrubBucket.gradePercent > 0 ? '+' : ''}${activeScrubBucket.gradePercent}%`}`}
              </Text>
            </View>
          ) : (
            <View style={styles.peakElevationLabel}>
              <SFIcon name="mountain.2.fill" color={AmoledTheme.accentYellow} size={13} />
              <Text style={styles.peakElevationText}>{`Puncak ${maxEle} m`}</Text>
            </View>
          )}
        </View>
      ) : null}

      {/* Area Bar Grafik 2D */}
      <View
        testID="elevation-profile-chart"
        ref={chartAreaRef}
        onLayout={measureChartArea}
        style={[styles.chartArea, { height: chartHeight }]}
        {...(scrubPanResponder ? scrubPanResponder.panHandlers : {})}
      >
        <View style={styles.barsRow}>
          {buckets.map((bucket, index) => {
            const heightFraction = bucket.elevationMeters === null
              ? 0
              : Math.max(0.08, (bucket.elevationMeters - minEle) / eleRange);
            const barHeight = heightFraction * (chartHeight - 6);
            const isPeak = index === peakIndex;
            const isScrubbed = index === scrubIndex;
            const isPastRider = riderBarIndex >= 0 && index <= riderBarIndex;

            return (
              <View
                key={index}
                style={[
                  styles.barColumn,
                  {
                    height: barHeight,
                    backgroundColor: bucket.color,
                    opacity: bucket.elevationMeters === null ? 0 : isScrubbed ? 1 : isPastRider ? 1 : 0.85,
                  },
                ]}
              >
                {isPeak && !activeScrubBucket ? (
                  <View style={styles.peakDotIndicator} />
                ) : null}
              </View>
            );
          })}
        </View>

        {/* Garis Dasar Baseline */}
        <View style={styles.baselineTrack} />

        {/* Rider Dot (Garmin ClimbPro Signature Feature) */}
        {riderBarIndex >= 0 && chartFrame.width > 0 ? (
          <View
            pointerEvents="none"
            style={[
              styles.riderDotAnchor,
              {
                left:
                  ((riderBarIndex + 0.5) / buckets.length) * chartFrame.width - 7,
                bottom: riderDotBottom - 2,
              },
            ]}
          >
            <View style={styles.riderDotPulseHalo} />
            <View style={styles.riderDotCore} />
          </View>
        ) : null}

        {/* Scrub Vertical Line */}
        {scrubIndex !== null && chartFrame.width > 0 ? (
          <View
            pointerEvents="none"
            style={[
              styles.scrubVerticalLine,
              {
                left: ((scrubIndex + 0.5) / buckets.length) * chartFrame.width,
              },
            ]}
          />
        ) : null}
      </View>

      {/* Footer Label Jarak (0 km s.d. Total) */}
      {showLabels ? (
        <View style={styles.distanceFooterRow}>
          <Text style={styles.distanceFooterText}>0 km</Text>
          <Text style={styles.distanceFooterText}>
            {`${(totalDistanceMeters / 1000).toFixed(1)} km`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    padding: 10,
    width: '100%',
  },
  emptyContainer: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceElevated,
    borderRadius: 12,
    justifyContent: 'center',
    padding: 12,
  },
  emptyText: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
  },
  labelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  elevationBoundaryText: {
    color: AmoledTheme.textSecondary,
    fontSize: 10,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  peakElevationText: {
    color: AmoledTheme.textPrimary,
    fontSize: 10,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  peakElevationLabel: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  scrubIndicatorBadge: {
    backgroundColor: AmoledTheme.accentOrange,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  scrubIndicatorText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  chartArea: {
    justifyContent: 'flex-end',
    position: 'relative',
    width: '100%',
  },
  barsRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    height: '100%',
    width: '100%',
  },
  barColumn: {
    borderTopLeftRadius: 1.5,
    borderTopRightRadius: 1.5,
    flex: 1,
    marginHorizontal: 0.5,
    position: 'relative',
  },
  peakDotIndicator: {
    alignSelf: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 2,
    height: 3,
    position: 'absolute',
    top: -5,
    width: 3,
  },
  baselineTrack: {
    backgroundColor: AmoledTheme.borderSubtle,
    bottom: 0,
    height: 1.5,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  riderDotAnchor: {
    alignItems: 'center',
    height: 18,
    justifyContent: 'center',
    position: 'absolute',
    width: 18,
    zIndex: 10,
  },
  riderDotPulseHalo: {
    backgroundColor: 'rgba(255, 82, 26, 0.35)',
    borderColor: '#FF521A',
    borderRadius: 9,
    borderWidth: 1.5,
    height: 18,
    position: 'absolute',
    width: 18,
  },
  riderDotCore: {
    backgroundColor: '#FFFFFF',
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  scrubVerticalLine: {
    backgroundColor: '#FFFFFF',
    bottom: 0,
    position: 'absolute',
    top: 0,
    width: 1.5,
    zIndex: 5,
  },
  distanceFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  distanceFooterText: {
    color: AmoledTheme.textSecondary,
    fontSize: 9,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
});
