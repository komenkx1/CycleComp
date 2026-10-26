import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { SFIcon } from '../../components/SFIcon';
import type { GpxRoute } from '../../domain/routes/gpx/GpxRoute';
import { analyzeRouteElevation } from '../../domain/routes/elevation/routeElevationAnalysis';
import { ElevationProfileChart } from '../elevation/ElevationProfileChart';
import { ClimbListSection } from '../elevation/ClimbListSection';
import { AmoledTheme } from '../../theme/colors';
import type { SavedRideFile } from '../ride/useRideTracking';
import type { SelectedRideDetail } from './useRideHistory';

export interface RideHistoryPanelProps {
  rides: SavedRideFile[];
  loading: boolean;
  selectedRide: SelectedRideDetail | null;
  loadingSelected: boolean;
  onSelectRide: (ride: SavedRideFile) => void;
  onClearSelectedRide: () => void;
  onFocusRoute?: (route: GpxRoute) => void;
  onDeleteRide: (ride: SavedRideFile) => void;
  onShareRide: (fileUrl: string) => void;
  onShareSensorTrace?: (fileUrl: string) => void;
  onUseAsNavRoute: (route: GpxRoute) => void;
  onUploadToStrava: (ride: SelectedRideDetail) => void;
  stravaConnected?: boolean;
  stravaUploadingFileId?: string | null;
  stravaUploadProgressMessage?: string | null;
  uploadedRides?: Record<string, number>;
  onOpenStravaActivity?: (activityId: number) => void;
}

function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleDateString('id-ID', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

export function RideHistoryPanel({
  rides,
  loading,
  selectedRide,
  loadingSelected,
  onSelectRide,
  onClearSelectedRide,
  onFocusRoute,
  onDeleteRide,
  onShareRide,
  onShareSensorTrace,
  onUseAsNavRoute,
  onUploadToStrava,
  stravaConnected = false,
  stravaUploadingFileId,
  stravaUploadProgressMessage,
  uploadedRides,
  onOpenStravaActivity,
}: RideHistoryPanelProps) {
  // Analyze elevation for selected ride if loaded
  const selectedElevationAnalysis = useMemo(() => {
    if (!selectedRide) return null;
    return analyzeRouteElevation(selectedRide.route);
  }, [selectedRide]);

  function confirmDelete(file: SavedRideFile) {
    Alert.alert(
      'Hapus Riwayat Perjalanan',
      `Yakin ingin menghapus file "${file.fileName}"? Data rute yang tersimpan akan dihapus secara permanen.`,
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Hapus',
          style: 'destructive',
          onPress: () => onDeleteRide(file),
        },
      ],
    );
  }

  // If a ride is currently selected, show the detail inspector
  if (selectedRide) {
    const { file, route } = selectedRide;
    const ascent = selectedElevationAnalysis?.totalAscentMeters ?? 0;
    const maxGrade = selectedElevationAnalysis?.maxGradePercent ?? 0;

    return (
      <View style={styles.detailContainer}>
        {/* Back navigation & Focus map */}
        <View style={styles.detailHeaderRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Kembali ke daftar riwayat"
            onPress={onClearSelectedRide}
            style={styles.backButton}
          >
            <SFIcon name="chevron.left" color={AmoledTheme.accentOrange} size={15} />
            <Text style={styles.backButtonText}>Daftar Riwayat</Text>
          </Pressable>
          {onFocusRoute ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Pusatkan peta ke rute ini"
              onPress={() => onFocusRoute(route)}
              style={styles.focusRouteButton}
            >
              <SFIcon name="location.north.line.fill" color={AmoledTheme.accentOrange} size={13} />
              <Text style={styles.focusRouteButtonText}>Fokus Peta</Text>
            </Pressable>
          ) : null}
        </View>

        {/* Header Title */}
        <View style={styles.detailHeader}>
          <Text style={styles.detailEyebrow}>DETAIL RIWAYAT GOWES</Text>
          <Text numberOfLines={2} style={styles.detailTitle}>
            {route.name && route.name !== file.fileName ? route.name : 'Perjalanan Tersimpan'}
          </Text>
          <Text style={styles.detailTimestamp}>{formatDate(file.createdAt)}</Text>
        </View>

        {/* 4-Stat Primary Metric Grid */}
        <View style={styles.statGrid}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>JARAK</Text>
            <Text style={styles.statValue}>{formatDistance(route.distanceMeters)}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>ELEVASI NAIK</Text>
            <Text style={[styles.statValue, { color: AmoledTheme.accentGreen }]}>+{ascent} m</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>GRADIEN MAX</Text>
            <Text style={styles.statValue}>{maxGrade.toFixed(1)}%</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>TITIK GPS</Text>
            <Text style={styles.statValue}>{route.pointCount.toLocaleString()}</Text>
          </View>
        </View>

        {/* Elevation Profile Chart */}
        {selectedElevationAnalysis && selectedElevationAnalysis.samples.length > 0 ? (
          <View style={styles.chartSection}>
            <Text style={styles.sectionHeaderLabel}>PROFIL ELEVASI JALUR</Text>
            <ElevationProfileChart
              samples={selectedElevationAnalysis.samples}
              height={85}
              interactive={true}
              showLabels={true}
            />
          </View>
        ) : null}

        {/* Climbs detected */}
        {selectedElevationAnalysis && selectedElevationAnalysis.climbs.length > 0 ? (
          <ClimbListSection
            climbs={selectedElevationAnalysis.climbs}
            maxGradePercent={selectedElevationAnalysis.maxGradePercent}
            totalAscentMeters={selectedElevationAnalysis.totalAscentMeters}
          />
        ) : null}

        {/* Actions Section */}
        <View style={styles.actionSection}>
          {uploadedRides?.[file.fileName] ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Buka rekaman ini di aplikasi Strava"
              onPress={() => onOpenStravaActivity && onOpenStravaActivity(uploadedRides[file.fileName])}
              style={[styles.stravaUploadButton, styles.stravaUploadButtonUploaded]}
            >
              <View style={[styles.stravaIconCircle, styles.stravaIconCircleUploaded]}>
                <SFIcon name="checkmark.seal.fill" color={AmoledTheme.accentGreen} size={20} />
              </View>
              <View style={styles.stravaButtonTextCol}>
                <Text style={styles.stravaButtonTitleUploaded}>
                  Terunggah ke Strava ✓
                </Text>
                <Text style={styles.stravaButtonSubtitleUploaded}>
                  ID #{uploadedRides[file.fileName]} · Ketuk untuk buka di Strava
                </Text>
              </View>
              <SFIcon name="arrow.up.right" color={AmoledTheme.accentGreen} size={15} />
            </Pressable>
          ) : stravaUploadingFileId === file.fileName ? (
            <View style={[styles.stravaUploadButton, styles.stravaUploadButtonBusy]}>
              <ActivityIndicator color="#FFFFFF" size="small" />
              <View style={styles.stravaButtonTextCol}>
                <Text style={styles.stravaButtonTitle}>Mengunggah ke Strava...</Text>
                <Text style={styles.stravaButtonSubtitle}>
                  {stravaUploadProgressMessage || 'Memproses file rute...'}
                </Text>
              </View>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Upload rekaman gowes ini ke Strava"
              onPress={() => onUploadToStrava(selectedRide)}
              style={styles.stravaUploadButton}
            >
              <View style={styles.stravaIconCircle}>
                <SFIcon name="arrow.up.circle.fill" color="#FFFFFF" size={18} />
              </View>
              <View style={styles.stravaButtonTextCol}>
                <Text style={styles.stravaButtonTitle}>
                  {stravaConnected ? 'Upload ke Akun Strava' : 'Hubungkan & Upload ke Strava'}
                </Text>
                <Text style={styles.stravaButtonSubtitle}>
                  Sync elevasi barometer, HR & rute ke feed Strava
                </Text>
              </View>
            </Pressable>
          )}

          {/* Secondary Actions Row */}
          <View style={styles.actionButtonsRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Gunakan rute ini untuk navigasi"
              onPress={() => onUseAsNavRoute(route)}
              style={styles.secondaryActionButton}
            >
              <SFIcon name="map.fill" color={AmoledTheme.textPrimary} size={16} />
              <Text style={styles.secondaryActionText}>Jadikan Rute</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Bagikan file GPX"
              onPress={() => onShareRide(file.fileUrl)}
              style={styles.secondaryActionButton}
            >
              <SFIcon name="square.and.arrow.up" color={AmoledTheme.textPrimary} size={16} />
              <Text style={styles.secondaryActionText}>Bagikan GPX</Text>
            </Pressable>

            {file.hasSensorTrace && onShareSensorTrace ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Bagikan trace diagnostik sensor"
                onPress={() => onShareSensorTrace(file.fileUrl)}
                style={styles.secondaryActionButton}
              >
                <SFIcon name="waveform.path.ecg" color={AmoledTheme.accentYellow} size={16} />
                <Text style={styles.secondaryActionText}>Sensor Trace</Text>
              </Pressable>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hapus rekaman ini"
              onPress={() => confirmDelete(file)}
              style={[styles.secondaryActionButton, styles.deleteActionButton]}
            >
              <SFIcon name="trash.fill" color={AmoledTheme.accentRed} size={16} />
              <Text style={[styles.secondaryActionText, { color: AmoledTheme.accentRed }]}>Hapus</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  // Otherwise, render list of saved rides
  return (
    <View style={styles.listContainer}>
      <View style={styles.listHeaderRow}>
        <View>
          <Text style={styles.detailEyebrow}>REKAMAN PERJALANAN</Text>
          <Text style={styles.listTitle}>Riwayat Gowes</Text>
        </View>
        <Text style={styles.countBadge}>{rides.length} Tersimpan</Text>
      </View>

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator color={AmoledTheme.accentOrange} size="small" />
          <Text style={styles.loadingText}>Memuat riwayat...</Text>
        </View>
      ) : rides.length === 0 ? (
        <View style={styles.emptyCard}>
          <SFIcon name="figure.outdoor.cycle" color={AmoledTheme.textSecondary} size={38} />
          <Text style={styles.emptyTitle}>Belum Ada Riwayat</Text>
          <Text style={styles.emptyDescription}>
            Setiap kali selesai bersepeda dan menekan tombol Selesai, rute dan data elevasi lengkap akan otomatis tersimpan di sini.
          </Text>
        </View>
      ) : (
        <View style={styles.cardsContainer}>
          {rides.map(ride => (
            <Pressable
              key={ride.id}
              accessibilityRole="button"
              accessibilityLabel={`Pilih riwayat gowes ${ride.fileName}`}
              onPress={() => onSelectRide(ride)}
              style={({ pressed }) => [
                styles.rideCard,
                pressed && styles.rideCardPressed,
              ]}
            >
              <View style={styles.rideCardTopRow}>
                <View style={styles.rideCardIcon}>
                  <SFIcon name="bicycle" color={AmoledTheme.accentOrange} size={18} />
                </View>
                <View style={styles.rideCardInfoCol}>
                  <Text numberOfLines={1} style={styles.rideCardDate}>
                    {formatDate(ride.createdAt)}
                  </Text>
                  <Text numberOfLines={1} style={styles.rideCardFileName}>
                    {ride.fileName}
                  </Text>
                </View>
                <View style={styles.badgeRow}>
                  {uploadedRides?.[ride.fileName] ? (
                    <View style={styles.stravaBadge}>
                      <Text style={styles.stravaBadgeText}>STRAVA ✓</Text>
                    </View>
                  ) : null}
                  <View style={styles.gpxBadge}>
                    <Text style={styles.gpxBadgeText}>GPX</Text>
                  </View>
                  {ride.hasSensorTrace ? (
                    <View style={styles.sensorBadge}>
                      <Text style={styles.sensorBadgeText}>TRACE</Text>
                    </View>
                  ) : null}
                </View>
              </View>

              <View style={styles.rideCardBottomRow}>
                <Text style={styles.rideCardFileSize}>
                  {(ride.fileSizeBytes / 1024).toFixed(1)} KB
                </Text>
                <View style={styles.viewTrackPrompt}>
                  <Text style={styles.viewTrackText}>Lihat di peta & statistik</Text>
                  <SFIcon name="chevron.right" color={AmoledTheme.accentOrange} size={12} />
                </View>
              </View>
            </Pressable>
          ))}
        </View>
      )}

      {loadingSelected ? (
        <View style={styles.modalLoadingOverlay}>
          <ActivityIndicator color={AmoledTheme.accentOrange} size="large" />
          <Text style={styles.modalLoadingText}>Membaca data rute & elevasi...</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  listContainer: {
    paddingVertical: 4,
  },
  listHeaderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  listTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 22,
    fontWeight: '700',
    marginTop: 2,
  },
  countBadge: {
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 12,
    borderWidth: 1,
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  centerBox: {
    alignItems: 'center',
    paddingVertical: 36,
  },
  loadingText: {
    color: AmoledTheme.textSecondary,
    fontSize: 13,
    marginTop: 10,
  },
  emptyCard: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 8,
    padding: 24,
  },
  emptyTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginTop: 12,
  },
  emptyDescription: {
    color: AmoledTheme.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 6,
    textAlign: 'center',
  },
  cardsContainer: {
    gap: 10,
  },
  rideCard: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 13,
  },
  rideCardPressed: {
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.accentOrange,
  },
  rideCardTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  rideCardIcon: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 82, 26, 0.12)',
    borderRadius: 10,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  rideCardInfoCol: {
    flex: 1,
  },
  rideCardDate: {
    color: AmoledTheme.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  rideCardFileName: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  badgeRow: {
    flexDirection: 'row',
    gap: 4,
  },
  gpxBadge: {
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  gpxBadgeText: {
    color: AmoledTheme.accentOrange,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  sensorBadge: {
    backgroundColor: 'rgba(234, 179, 8, 0.15)',
    borderColor: 'rgba(234, 179, 8, 0.4)',
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  sensorBadgeText: {
    color: AmoledTheme.accentYellow,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  rideCardBottomRow: {
    alignItems: 'center',
    borderTopColor: AmoledTheme.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
    paddingTop: 8,
  },
  rideCardFileSize: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  viewTrackPrompt: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  viewTrackText: {
    color: AmoledTheme.accentOrange,
    fontSize: 12,
    fontWeight: '600',
  },

  // Detail View Styles
  detailContainer: {
    paddingVertical: 4,
  },
  detailHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  backButtonText: {
    color: AmoledTheme.accentOrange,
    fontSize: 12,
    fontWeight: '700',
  },
  focusRouteButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  focusRouteButtonText: {
    color: AmoledTheme.accentOrange,
    fontSize: 12,
    fontWeight: '700',
  },
  detailHeader: {
    marginBottom: 12,
  },
  detailEyebrow: {
    color: AmoledTheme.accentOrange,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  detailTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 22,
    fontWeight: '700',
    marginTop: 2,
  },
  detailTimestamp: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    marginTop: 4,
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
  },
  statCard: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    minWidth: '45%',
    padding: 10,
  },
  statLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  statValue: {
    color: AmoledTheme.textPrimary,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    marginTop: 3,
  },
  chartSection: {
    marginBottom: 14,
  },
  sectionHeaderLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  actionSection: {
    marginTop: 6,
  },
  stravaUploadButton: {
    alignItems: 'center',
    backgroundColor: '#FC4C02', // Official Strava Orange
    borderRadius: 14,
    flexDirection: 'row',
    gap: 12,
    marginBottom: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowColor: '#FC4C02',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  stravaUploadButtonUploaded: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderColor: 'rgba(16, 185, 129, 0.4)',
    borderWidth: 1,
    shadowOpacity: 0,
  },
  stravaUploadButtonBusy: {
    backgroundColor: 'rgba(252, 76, 2, 0.85)',
  },
  stravaIconCircle: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  stravaIconCircleUploaded: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
  },
  stravaButtonTextCol: {
    flex: 1,
  },
  stravaButtonTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  stravaButtonTitleUploaded: {
    color: AmoledTheme.accentGreen,
    fontSize: 15,
    fontWeight: '800',
  },
  stravaButtonSubtitle: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 11,
    marginTop: 2,
  },
  stravaButtonSubtitleUploaded: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  stravaBadge: {
    backgroundColor: 'rgba(252, 76, 2, 0.15)',
    borderColor: 'rgba(252, 76, 2, 0.4)',
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  stravaBadgeText: {
    color: '#FC4C02',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  actionButtonsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  secondaryActionButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minWidth: '45%',
    paddingVertical: 11,
  },
  secondaryActionText: {
    color: AmoledTheme.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
  deleteActionButton: {
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  modalLoadingOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    borderRadius: 16,
  },
  modalLoadingText: {
    color: AmoledTheme.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 10,
  },
});
