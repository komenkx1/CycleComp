import React, { useMemo } from 'react';
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
import { summarizeEstimatedPower } from './ridePowerSummary';

export interface RideHistoryPanelProps {
  rides: SavedRideFile[];
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
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
  error,
  onRetry,
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
  const estimatedPowerSummary = useMemo(
    () => selectedRide ? summarizeEstimatedPower(selectedRide.rawGpxXml) : null,
    [selectedRide],
  );

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
    const hasElevationProfile = (selectedElevationAnalysis?.samples.filter(sample => sample.elevationMeters !== null).length ?? 0) >= 2;
    const ascent = hasElevationProfile ? selectedElevationAnalysis?.totalAscentMeters : null;
    const maxGrade = hasElevationProfile ? selectedElevationAnalysis?.maxGradePercent : null;

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
            <SFIcon
              name="chevron.left"
              color={AmoledTheme.accentOrange}
              size={15}
            />
            <Text style={styles.backButtonText}>Daftar Riwayat</Text>
          </Pressable>
          {onFocusRoute ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Pusatkan peta ke rute ini"
              onPress={() => onFocusRoute(route)}
              style={styles.focusRouteButton}
            >
              <SFIcon
                name="location.north.line.fill"
                color={AmoledTheme.accentOrange}
                size={13}
              />
              <Text style={styles.focusRouteButtonText}>Fokus Peta</Text>
            </Pressable>
          ) : null}
        </View>

        {/* Header Title */}
        <View style={styles.detailHeader}>
          <Text style={styles.detailEyebrow}>DETAIL RIWAYAT GOWES</Text>
          <Text numberOfLines={2} style={styles.detailTitle}>
            {route.name && route.name !== file.fileName
              ? route.name
              : 'Perjalanan Tersimpan'}
          </Text>
          <Text style={styles.detailTimestamp}>
            {formatDate(file.createdAt)}
          </Text>
        </View>

        {error ? (
          <Text accessibilityLiveRegion="assertive" style={styles.errorText}>
            {error}
          </Text>
        ) : null}

        {/* 4-Stat Primary Metric Grid */}
        <View style={styles.statGrid}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>JARAK</Text>
            <Text style={styles.statValue}>
              {formatDistance(route.distanceMeters)}
            </Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>ELEVASI NAIK</Text>
            <Text
              style={[styles.statValue, { color: AmoledTheme.accentGreen }]}
            >
              {ascent == null ? '—' : `+${ascent} m`}
            </Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>GRADIEN MAX</Text>
            <Text style={styles.statValue}>
              {maxGrade == null ? '—' : `${maxGrade.toFixed(1)}%`}
            </Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>TITIK GPS</Text>
            <Text style={styles.statValue}>
              {route.pointCount.toLocaleString()}
            </Text>
          </View>
        </View>

        {estimatedPowerSummary ? (
          <View style={styles.chartSection}>
            <Text style={styles.sectionHeaderLabel}>POWER · ESTIMASI</Text>
            <Text testID="ride-history-power" style={styles.statValue}>
              {estimatedPowerSummary.averageWatts == null ? '—' : `${Math.round(estimatedPowerSummary.averageWatts)} W`}
            </Text>
            <Text style={styles.detailActionHint}>
              Rata-rata sampel valid · {Math.round(estimatedPowerSummary.coveredSeconds)} detik tercakup; waktu tanpa data tidak dihitung.
            </Text>
          </View>
        ) : null}

        {/* Elevation Profile Chart */}
        {selectedElevationAnalysis && hasElevationProfile ? (
          <View style={styles.chartSection}>
            <Text style={styles.sectionHeaderLabel}>PROFIL ELEVASI JALUR</Text>
            <ElevationProfileChart
              samples={selectedElevationAnalysis.samples}
              height={85}
              interactive={true}
              showLabels={true}
            />
          </View>
        ) : (
          <View style={styles.chartSection}>
            <Text style={styles.sectionHeaderLabel}>PROFIL ELEVASI JALUR</Text>
            <Text style={styles.detailActionHint}>
              Profil elevasi tidak tersedia.
            </Text>
          </View>
        )}

        {/* Climbs detected */}
        {selectedElevationAnalysis &&
        selectedElevationAnalysis.climbs.length > 0 ? (
          <ClimbListSection
            climbs={selectedElevationAnalysis.climbs}
            maxGradePercent={selectedElevationAnalysis.maxGradePercent}
            totalAscentMeters={selectedElevationAnalysis.totalAscentMeters}
          />
        ) : null}

        {/* Actions Section */}
        <View style={styles.actionSection}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Gunakan rute ini untuk navigasi"
            onPress={() => onUseAsNavRoute(route)}
            style={styles.primaryActionButton}
          >
            <Text style={styles.primaryActionText}>Jadikan rute</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Bagikan file GPX"
            onPress={() => onShareRide(file.fileUrl)}
            style={styles.secondaryActionButton}
          >
            <Text style={styles.secondaryActionText}>Bagikan GPX</Text>
          </Pressable>
          {uploadedRides?.[file.fileName] ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Buka rekaman ini di aplikasi Strava"
              onPress={() =>
                onOpenStravaActivity &&
                onOpenStravaActivity(uploadedRides[file.fileName])
              }
              style={[
                styles.stravaUploadButton,
                styles.stravaUploadButtonUploaded,
              ]}
            >
              <View style={styles.stravaIconCircle}>
                <SFIcon
                  name="checkmark.seal.fill"
                  color={AmoledTheme.accentGreen}
                  size={20}
                />
              </View>
              <View style={styles.stravaButtonTextCol}>
                <Text style={styles.stravaButtonTitleUploaded}>
                  Terunggah ke Strava ✓
                </Text>
                <Text style={styles.stravaButtonSubtitleUploaded}>
                  ID #{uploadedRides[file.fileName]} · Ketuk untuk buka di
                  Strava
                </Text>
              </View>
              <SFIcon
                name="arrow.up.right"
                color={AmoledTheme.accentGreen}
                size={15}
              />
            </Pressable>
          ) : stravaUploadingFileId === file.fileName ? (
            <View
              style={[styles.stravaUploadButton, styles.stravaUploadButtonBusy]}
            >
              <ActivityIndicator color="#FFFFFF" size="small" />
              <View style={styles.stravaButtonTextCol}>
                <Text style={styles.stravaButtonTitle}>
                  Mengunggah ke Strava...
                </Text>
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
                  {stravaConnected
                    ? 'Upload ke Akun Strava'
                    : 'Hubungkan & Upload ke Strava'}
                </Text>
                <Text style={styles.stravaButtonSubtitle}>
                  Unggah file GPX perjalanan ke Strava
                </Text>
              </View>
            </Pressable>
          )}

          {file.hasSensorTrace && onShareSensorTrace ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Bagikan trace diagnostik sensor"
              onPress={() => onShareSensorTrace(file.fileUrl)}
              style={styles.detailActionRow}
            >
              <View style={styles.detailActionText}>
                <Text style={styles.secondaryActionText}>
                  Bagikan diagnostik
                </Text>
                <Text style={styles.detailActionHint}>
                  Trace sensor tersedia
                </Text>
              </View>
              <SFIcon
                name="chevron.right"
                color={AmoledTheme.textSecondary}
                size={15}
              />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Hapus rekaman ini"
            onPress={() => confirmDelete(file)}
            style={styles.detailActionRow}
          >
            <View style={styles.detailActionText}>
              <Text style={styles.deleteActionText}>Hapus perjalanan</Text>
              <Text style={styles.detailActionHint}>
                Konfirmasi sebelum menghapus
              </Text>
            </View>
            <SFIcon
              name="chevron.right"
              color={AmoledTheme.accentRed}
              size={15}
            />
          </Pressable>
        </View>
      </View>
    );
  }

  // Otherwise, render list of saved rides
  return (
    <View style={styles.listContainer}>
      <View style={styles.listHeaderRow}>
        <Text style={styles.listTitle}>Riwayat Gowes</Text>
        <Text style={styles.listSubtitle}>
          {rides.length} perjalanan tersimpan
        </Text>
      </View>
      {error ? (
        <View>
          <Text accessibilityLiveRegion="assertive" style={styles.errorText}>
            {error}
          </Text>
          {onRetry ? (
            <Pressable
              accessibilityRole="button"
              onPress={onRetry}
              style={styles.secondaryActionButton}
            >
              <Text style={styles.secondaryActionText}>Muat ulang riwayat</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator color={AmoledTheme.accentOrange} size="small" />
          <Text style={styles.loadingText}>Memuat riwayat...</Text>
        </View>
      ) : rides.length === 0 && !error ? (
        <View style={styles.emptyCard}>
          <SFIcon
            name="figure.outdoor.cycle"
            color={AmoledTheme.textSecondary}
            size={38}
          />
          <Text style={styles.emptyTitle}>Belum Ada Riwayat</Text>
          <Text style={styles.emptyDescription}>
            Perjalanan yang tersimpan akan muncul di sini setelah ride selesai.
          </Text>
        </View>
      ) : rides.length > 0 ? (
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
              <View style={styles.rideCardInfoCol}>
                <Text style={styles.rideCardDate}>
                  {formatDate(ride.createdAt)}
                </Text>
                <Text style={styles.rideCardFileName}>{ride.fileName}</Text>
                <Text style={styles.rideCardStatus}>
                  GPX{uploadedRides?.[ride.fileName] ? ' · Strava ✓' : ''}
                  {ride.hasSensorTrace ? ' · Trace sensor' : ''}
                </Text>
              </View>
              <SFIcon
                name="chevron.right"
                color={AmoledTheme.textSecondary}
                size={16}
              />
            </Pressable>
          ))}
        </View>
      ) : null}

      {loadingSelected ? (
        <View style={styles.modalLoadingOverlay}>
          <ActivityIndicator color={AmoledTheme.accentOrange} size="large" />
          <Text style={styles.modalLoadingText}>
            Membaca data rute & elevasi...
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  listContainer: { paddingVertical: 4 },
  listHeaderRow: { marginBottom: 20 },
  listTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 28,
    fontWeight: '700',
  },
  listSubtitle: {
    color: AmoledTheme.textSecondary,
    fontSize: 16,
    marginTop: 5,
  },
  centerBox: { alignItems: 'center', paddingVertical: 36 },
  loadingText: {
    color: AmoledTheme.textSecondary,
    fontSize: 16,
    marginTop: 10,
  },
  errorText: {
    color: AmoledTheme.accentRed,
    fontSize: 15,
    lineHeight: 21,
    marginBottom: 14,
  },
  emptyCard: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 24,
  },
  emptyTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 20,
    fontWeight: '700',
    marginTop: 12,
  },
  emptyDescription: {
    color: AmoledTheme.textSecondary,
    fontSize: 16,
    lineHeight: 22,
    marginTop: 8,
    textAlign: 'center',
  },
  cardsContainer: { gap: 10 },
  rideCard: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    minHeight: 88,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rideCardPressed: { backgroundColor: AmoledTheme.surfaceInteractive },
  rideCardInfoCol: { flex: 1, minWidth: 0 },
  rideCardDate: {
    color: AmoledTheme.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  rideCardFileName: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    marginTop: 4,
  },
  rideCardStatus: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    marginTop: 4,
  },
  detailContainer: { paddingVertical: 4 },
  detailHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  backButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    minHeight: 48,
    paddingRight: 12,
  },
  backButtonText: {
    color: AmoledTheme.accentOrange,
    fontSize: 16,
    fontWeight: '700',
  },
  focusRouteButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    minHeight: 48,
    paddingLeft: 12,
  },
  focusRouteButtonText: {
    color: AmoledTheme.accentOrange,
    fontSize: 16,
    fontWeight: '700',
  },
  detailHeader: { marginBottom: 20 },
  detailEyebrow: {
    color: AmoledTheme.accentOrange,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
  },
  detailTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 28,
    fontWeight: '700',
    marginTop: 4,
  },
  detailTimestamp: {
    color: AmoledTheme.textSecondary,
    fontSize: 16,
    marginTop: 6,
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 20,
  },
  statCard: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    minHeight: 96,
    minWidth: '45%',
    padding: 14,
  },
  statLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    fontWeight: '700',
  },
  statValue: {
    color: AmoledTheme.textPrimary,
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    marginTop: 6,
  },
  chartSection: { marginBottom: 18 },
  sectionHeaderLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  actionSection: { marginTop: 8 },
  primaryActionButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.accentOrange,
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 52,
    marginBottom: 10,
    padding: 12,
  },
  primaryActionText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  secondaryActionButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 52,
    marginBottom: 10,
    padding: 12,
  },
  secondaryActionText: {
    color: AmoledTheme.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  stravaUploadButton: {
    alignItems: 'center',
    backgroundColor: '#FC4C02',
    borderRadius: 10,
    flexDirection: 'row',
    gap: 12,
    marginBottom: 10,
    minHeight: 56,
    padding: 14,
  },
  stravaUploadButtonUploaded: {
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderWidth: 1,
  },
  stravaUploadButtonBusy: { backgroundColor: 'rgba(252, 76, 2, 0.85)' },
  stravaIconCircle: {
    alignItems: 'center',
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  stravaButtonTextCol: { flex: 1 },
  stravaButtonTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  stravaButtonTitleUploaded: {
    color: AmoledTheme.accentGreen,
    fontSize: 16,
    fontWeight: '700',
  },
  stravaButtonSubtitle: { color: '#FFFFFF', fontSize: 14, marginTop: 3 },
  stravaButtonSubtitleUploaded: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    marginTop: 3,
  },
  detailActionRow: {
    alignItems: 'center',
    borderTopColor: AmoledTheme.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    minHeight: 68,
    paddingVertical: 12,
  },
  detailActionText: { flex: 1 },
  detailActionHint: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    marginTop: 3,
  },
  deleteActionText: {
    color: AmoledTheme.accentRed,
    fontSize: 16,
    fontWeight: '600',
  },
  modalLoadingOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    borderRadius: 12,
  },
  modalLoadingText: {
    color: AmoledTheme.textPrimary,
    fontSize: 16,
    fontWeight: '600',
    marginTop: 10,
  },
});
