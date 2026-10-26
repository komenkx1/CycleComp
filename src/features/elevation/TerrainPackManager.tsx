import { useCallback, useEffect, useRef, useState } from 'react';

import type { RouteBounds } from '../../domain/routes/gpx/GpxRoute';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { SFIcon } from '../../components/SFIcon';
import { AmoledTheme } from '../../theme/colors';
import {
  cancelTerrainPackDownload,
  downloadAndInstallTerrainPack,
  fetchRemoteTerrainCatalog,
  getTerrainGridPackInventory,
  getTerrainPackDownloadStates,
  pickAndInstallTerrainGridPack,
  removeTerrainGridPack,
  subscribeToTerrainPackDownloadStates,
  type TerrainCatalog,
  type TerrainCatalogChunk,
  type TerrainDownloadState,
  type TerrainGridPackInventory,
  type TerrainGridPackSummary,
} from './terrainGridPackService';
import {
  boundsCoveredByRegions,
  boundsOverlap,
  terrainMapAreaAvailability,
} from './terrainMapAreaCoverage';
import {
  getTerrainAreaReceipts,
  pauseTerrainAreaTransfer,
  restoreTerrainAreaTransfer,
  startTerrainAreaTransfer,
  subscribeToTerrainAreaTransfer,
  terrainAreaReceiptInstalled,
  type TerrainAreaReceipt,
  type TerrainAreaTransfer,
} from './terrainAreaTransfer';

type TerrainPackManagerProps = {
  mapAreaBounds?: RouteBounds[];
};

export function TerrainPackManager({ mapAreaBounds }: TerrainPackManagerProps) {
  const [expanded, setExpanded] = useState(false);
  const [inventory, setInventory] = useState<TerrainGridPackInventory | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isChangingPack, setIsChangingPack] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Remote catalog states
  const [remoteCatalog, setRemoteCatalog] = useState<TerrainCatalog | null>(null);
  const [isCatalogLoading, setIsCatalogLoading] = useState(false);
  const [catalogMessage, setCatalogMessage] = useState<string | null>(null);
  const [areaTransfer, setAreaTransfer] = useState<TerrainAreaTransfer | null>(null);
  const [areaReceipts, setAreaReceipts] = useState<TerrainAreaReceipt[]>([]);
  const areaTransferRef = useRef<TerrainAreaTransfer | null>(null);
  const [showPackageDetails, setShowPackageDetails] = useState(false);
  const [downloadingChunkID, setDownloadingChunkID] = useState<string | null>(null);
  const [cancellingChunkID, setCancellingChunkID] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const activeDownload = useRef<{ chunkID: string } | null>(null);
  const [nativeDownloads, setNativeDownloads] = useState<TerrainDownloadState[]>([]);
  const nativeDownloadsRef = useRef<TerrainDownloadState[]>([]);
  const refreshDownloadStates = useRef<(() => Promise<void>) | null>(null);
  const [isRestoringDownloads, setIsRestoringDownloads] = useState(true);

  const refreshInventory = useCallback(async () => {
    setIsLoading(true);
    try {
      setInventory(await getTerrainGridPackInventory());
      setAreaReceipts(getTerrainAreaReceipts());
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Data medan belum dapat diperiksa.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshRemoteCatalog = useCallback(async () => {
    setIsCatalogLoading(true);
    setCatalogMessage(null);
    try {
      const catalog = await fetchRemoteTerrainCatalog();
      const preparedCatalog = areaTransferRef.current?.catalog;
      if (!catalog && !preparedCatalog) {
        setRemoteCatalog(null);
        setCatalogMessage('Katalog medan online belum dipublikasikan di server.');
      } else {
        setRemoteCatalog(preparedCatalog ? mergeTerrainCatalogs(catalog, preparedCatalog) : catalog);
        setCatalogMessage(null);
      }
    } catch (error) {
      setRemoteCatalog(null);
      setCatalogMessage(
        error instanceof Error ? error.message : 'Katalog server tidak dapat diakses.',
      );
    } finally {
      setIsCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshInventory();
  }, [refreshInventory]);

  useEffect(() => {
    let observedCatalog: TerrainCatalog | null = null;
    let observedPhase: TerrainAreaTransfer['phase'] | null = null;
    const unsubscribe = subscribeToTerrainAreaTransfer(transfer => {
      const previousPhase = observedPhase;
      observedPhase = transfer?.phase ?? null;
      areaTransferRef.current = transfer;
      setAreaTransfer(transfer);
      const areaCatalog = transfer?.catalog;
      if (areaCatalog && areaCatalog !== observedCatalog) {
        observedCatalog = areaCatalog;
        setRemoteCatalog(current => mergeTerrainCatalogs(current, areaCatalog));
        setCatalogMessage(null);
      }
      if (previousPhase && previousPhase !== transfer?.phase &&
        (transfer?.phase === 'completed' || transfer?.phase === 'paused' || transfer?.phase === 'failed')) {
        refreshInventory();
      }
    });
    restoreTerrainAreaTransfer();
    return unsubscribe;
  }, [refreshInventory]);

  useEffect(() => {
    let isMounted = true;
    let downloadStateRevision = 0;

    function applyDownloadStates(downloads: TerrainDownloadState[]) {
      if (!isMounted) {
        return;
      }
      const previousDownloads = nativeDownloadsRef.current;
      nativeDownloadsRef.current = downloads;
      setNativeDownloads(downloads);
      setIsRestoringDownloads(false);

      if (
        downloads.some(download => download.state === 'completed' && !previousDownloads.some(
          previous => previous.operationID === download.operationID && previous.state === 'completed',
        )) ||
        previousDownloads.some(previous => isActiveDownload(previous) && !downloads.some(
          download => download.operationID === previous.operationID && isActiveDownload(download),
        ))
      ) {
        refreshInventory();
      }

      const failedDownload = downloads.find(download => download.state === 'failed' && download.error);
      if (failedDownload) {
        setErrorMessage(failedDownload.error);
      }
    }

    async function restoreDownloadStates() {
      const queryRevision = ++downloadStateRevision;
      try {
        const downloads = await getTerrainPackDownloadStates();
        if (queryRevision === downloadStateRevision) {
          applyDownloadStates(downloads);
        }
      } catch (error) {
        if (isMounted && queryRevision === downloadStateRevision) {
          setIsRestoringDownloads(false);
          setErrorMessage(error instanceof Error ? error.message : 'Status unduhan belum dapat diperiksa.');
        }
      }
    }

    refreshDownloadStates.current = restoreDownloadStates;

    let unsubscribe = () => {};
    try {
      unsubscribe = subscribeToTerrainPackDownloadStates(
        downloads => {
          downloadStateRevision += 1;
          applyDownloadStates(downloads);
        },
        error => {
          downloadStateRevision += 1;
          if (isMounted) {
            setIsRestoringDownloads(false);
            setErrorMessage(error.message);
          }
        },
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Perubahan status unduhan belum dapat dipantau.');
    }
    const appStateSubscription = AppState.addEventListener('change', appState => {
      if (appState === 'active') {
        restoreDownloadStates();
        refreshInventory();
      }
    });
    restoreDownloadStates();
    return () => {
      isMounted = false;
      refreshDownloadStates.current = null;
      unsubscribe();
      appStateSubscription.remove();
    };
  }, [refreshInventory]);

  useEffect(() => {
    if (expanded) {
      refreshRemoteCatalog();
    }
  }, [expanded, refreshRemoteCatalog]);

  async function handleDownloadPack(chunk: TerrainCatalogChunk) {
    if (!remoteCatalog || activeDownload.current !== null ||
      isRestoringDownloads || nativeDownloadsRef.current.some(isActiveDownload)) {
      return;
    }
    const downloadOperation = { chunkID: chunk.chunkId };
    activeDownload.current = downloadOperation;
    setDownloadingChunkID(chunk.chunkId);
    setDownloadProgress(0);
    setErrorMessage(null);

    try {
      await downloadAndInstallTerrainPack(
        {
          releaseID: chunk.releaseId ?? remoteCatalog.releaseId,
          chunkID: chunk.chunkId,
          databaseSha256: chunk.databaseSha256,
        },
        progressEvent => {
          if (activeDownload.current === downloadOperation) {
            setDownloadProgress(progressEvent.progress);
          }
        },
      );
      await refreshInventory();
      setErrorMessage(null);
    } catch (error) {
      const isCancelled = typeof error === 'object' && error !== null &&
        'code' in error && error.code === 'download_cancelled';
      if (!isCancelled) {
        setErrorMessage(
          error instanceof Error ? error.message : 'Unduhan paket medan gagal.',
        );
      }
    } finally {
      if (activeDownload.current === downloadOperation) {
        activeDownload.current = null;
        setCancellingChunkID(null);
        setDownloadingChunkID(null);
        setDownloadProgress(0);
      }
    }
  }

  async function handleCancelDownload(chunkID: string) {
    const downloadOperation = activeDownload.current;
    const recoveredDownload = nativeDownloadsRef.current.find(
      download => download.chunkID === chunkID && isActiveDownload(download),
    );
    if ((!downloadOperation && !recoveredDownload) ||
      (downloadOperation && downloadOperation.chunkID !== chunkID) || cancellingChunkID !== null) {
      return;
    }
    setCancellingChunkID(chunkID);
    try {
      await cancelTerrainPackDownload(chunkID);
      if (!downloadOperation && activeDownload.current === null) {
        await refreshDownloadStates.current?.();
        if (activeDownload.current === null) {
          setCancellingChunkID(currentChunkID => currentChunkID === chunkID ? null : currentChunkID);
        }
      }
    } catch (error) {
      if (activeDownload.current === downloadOperation) {
        setErrorMessage(
          error instanceof Error ? error.message : 'Unduhan paket medan belum dapat dibatalkan.',
        );
        setCancellingChunkID(null);
      }
    }
  }

  async function importTerrainPack() {
    setIsChangingPack(true);
    try {
      const installedPack = await pickAndInstallTerrainGridPack();
      if (installedPack) {
        setInventory(await getTerrainGridPackInventory());
        setErrorMessage(null);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Paket medan tidak dapat dipasang.');
    } finally {
      setIsChangingPack(false);
    }
  }

  function confirmRemovePack(pack: TerrainGridPackSummary) {
    Alert.alert(
      'Hapus paket medan?',
      `Data ${pack.packID} akan dihapus dari penyimpanan iPhone.`,
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Hapus',
          style: 'destructive',
          onPress: () => removeInstalledPack(pack.packID),
        },
      ],
    );
  }

  async function removeInstalledPack(packID: string) {
    setIsChangingPack(true);
    try {
      await removeTerrainGridPack(packID);
      await refreshInventory();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Paket medan tidak dapat dihapus.');
    } finally {
      setIsChangingPack(false);
    }
  }

  const canInstallPack = inventory !== null && (
    inventory.trustedSigningKeyCount > 0 || inventory.allowUnsignedPilot
  );

  const installedPacksByID = new Map(inventory?.packs.map(p => [p.packID, p]) ?? []);
  const installedTerrainBounds = inventory?.packs.map(pack => pack.requestedBoundsWgs84) ?? [];
  const installedAreaReceipts = areaReceipts.filter(receipt =>
    terrainAreaReceiptInstalled(receipt, inventory?.packs ?? []),
  );
  const downloadedMapAreaCount = mapAreaBounds?.filter(bounds =>
    boundsCoveredByRegions(bounds, installedTerrainBounds) ||
    installedAreaReceipts.some(receipt =>
      receipt.bounds.every((coordinate, index) => coordinate === bounds[index]),
    ),
  ).length ?? 0;
  const catalogChunksForSavedAreas = remoteCatalog?.chunks.filter(chunk =>
    chunk.hasElevationGrid && (
      mapAreaBounds === undefined || mapAreaBounds.some(areaBounds =>
        boundsOverlap(areaBounds, chunk.requestedBoundsWgs84),
      )
    ),
  ) ?? [];
  const completeCatalogTerrainBounds = remoteCatalog?.chunks
    .filter(hasCompleteElevationGrid)
    .map(chunk => chunk.requestedBoundsWgs84) ?? [];
  const partialCatalogTerrainBounds = remoteCatalog?.chunks
    .filter(chunk => chunk.hasElevationGrid && !hasCompleteElevationGrid(chunk))
    .map(chunk => chunk.requestedBoundsWgs84) ?? [];
  const areaTransferBusy = areaTransfer !== null &&
    ['preparing', 'downloading', 'pausing'].includes(areaTransfer.phase);
  const hasActiveDownload = areaTransferBusy || downloadingChunkID !== null || cancellingChunkID !== null ||
    isRestoringDownloads || nativeDownloads.some(isActiveDownload);

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(currentExpanded => !currentExpanded)}
        style={({ pressed }) => [styles.heading, pressed && styles.pressed]}
      >
        <View style={styles.headingText}>
          <Text style={styles.eyebrow}>DATA MEDAN</Text>
          <Text style={styles.title}>Elevasi offline</Text>
          <Text style={styles.summary}>
            {inventory
              ? mapAreaBounds
                ? `${downloadedMapAreaCount} dari ${mapAreaBounds.length} area terunduh`
                : `${inventory.packs.length} paket tersimpan`
              : 'Periksa paket elevasi lokal'}
          </Text>
        </View>
        {isLoading
          ? <ActivityIndicator color={AmoledTheme.accentOrange} />
          : <SFIcon
              name={expanded ? 'chevron.up' : 'chevron.down'}
              color={AmoledTheme.textSecondary}
              size={16}
            />}
      </Pressable>

      {expanded ? (
        <View style={styles.details}>
          <Text style={styles.description}>
            Paket elevasi tersimpan dibaca di perangkat dan tidak membutuhkan jaringan saat dipakai.
          </Text>

          {inventory?.allowUnsignedPilot ? (
            <View style={styles.notice}>
              <SFIcon name="exclamationmark.triangle.fill" color={AmoledTheme.accentYellow} size={15} />
              <Text style={styles.noticeText}>
                Build uji ini menerima paket pilot tanpa tanda tangan. Paket tersebut belum tepercaya untuk rilis.
              </Text>
            </View>
          ) : inventory?.trustedSigningKeyCount === 0 ? (
            <View style={styles.notice}>
              <SFIcon name="lock.fill" color={AmoledTheme.textSecondary} size={14} />
              <Text style={styles.noticeText}>
                Kunci publik rilis belum tersedia di build ini; paket bertanda tangan belum dapat dipasang.
              </Text>
            </View>
          ) : null}

          {/* Section 1: Remote Catalog (Online Download) */}
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>ELEVASI AREA PETA</Text>
            <Pressable
              accessibilityLabel="Perbarui katalog server"
              accessibilityRole="button"
              disabled={isCatalogLoading}
              onPress={refreshRemoteCatalog}
              style={({ pressed }) => [styles.refreshCatalogButton, pressed && styles.pressed]}
            >
              {isCatalogLoading ? (
                <ActivityIndicator color={AmoledTheme.accentOrange} size="small" />
              ) : (
                <SFIcon name="arrow.clockwise" color={AmoledTheme.textSecondary} size={13} />
              )}
            </Pressable>
          </View>

          {isCatalogLoading && !remoteCatalog ? (
            <View style={styles.catalogLoadingRow}>
              <ActivityIndicator color={AmoledTheme.accentOrange} size="small" />
              <Text style={styles.catalogLoadingText}>Memeriksa katalog server…</Text>
            </View>
          ) : null}

          {catalogMessage ? (
            <View style={styles.catalogMessageCard}>
              <SFIcon name="cloud" color={AmoledTheme.textTertiary} size={16} />
              <Text style={styles.catalogMessageText}>{catalogMessage}</Text>
            </View>
          ) : null}

          {mapAreaBounds === undefined ? null : (
            <View accessibilityLiveRegion="polite" style={styles.mapAreaSection}>
              <Text style={styles.sectionTitle}>MENGIKUTI PETA OFFLINE</Text>
              {mapAreaBounds.length === 0 ? (
                <Text style={styles.mapAreaMessage}>
                  Unduh area peta terlebih dahulu. Paket elevasi akan ditampilkan sesuai area yang tersimpan.
                </Text>
              ) : mapAreaBounds.map((areaBounds, areaIndex) => {
                const availability = terrainMapAreaAvailability(
                  areaBounds,
                  installedTerrainBounds,
                  completeCatalogTerrainBounds,
                  partialCatalogTerrainBounds,
                );
                const areaReceipt = installedAreaReceipts.find(receipt =>
                  receipt.bounds.every((coordinate, index) => coordinate === areaBounds[index]),
                );
                const statusText = areaReceipt && availability !== 'installed'
                  ? 'Terunduh · cakupan sebagian'
                  : !remoteCatalog && isCatalogLoading && availability !== 'installed'
                  ? 'Memeriksa paket elevasi…'
                  : terrainAreaStatusText(availability, !remoteCatalog && !isCatalogLoading);

                return (
                  <View key={`${areaIndex}-${areaBounds.join('-')}`}>
                    <View style={styles.mapAreaRow}>
                      <View style={styles.mapAreaTextColumn}>
                        <Text style={styles.mapAreaTitle}>Area peta {areaIndex + 1}</Text>
                        <Text numberOfLines={1} style={styles.mapAreaBounds}>
                          {formatAreaBounds(areaBounds)}
                        </Text>
                      </View>
                      <Text
                        accessibilityLabel={`Area peta ${areaIndex + 1}: ${statusText}`}
                        style={[
                          styles.mapAreaStatus,
                          availability === 'unavailable' ? styles.mapAreaStatusUnavailable : null,
                        ]}
                      >
                        {statusText}
                      </Text>
                    </View>
                    <TerrainAreaDownloadControls
                      transfer={areaTransfer?.bounds.every((coordinate, index) => coordinate === areaBounds[index])
                        ? areaTransfer : null}
                      installed={availability === 'installed' || Boolean(areaReceipt)}
                      storedBytes={areaReceipt?.totalBytes}
                      disabled={isChangingPack || hasActiveDownload || !canInstallPack}
                      onStart={() => {
                        setErrorMessage(null);
                        startTerrainAreaTransfer(areaBounds, `Area peta ${areaIndex + 1}`)
                          .catch(error => setErrorMessage(error instanceof Error ? error.message : 'Elevasi belum dapat diunduh.'));
                      }}
                    />
                  </View>
                );
              })}
            </View>
          )}

          {mapAreaBounds && mapAreaBounds.length > 0 && remoteCatalog &&
          catalogChunksForSavedAreas.length === 0 ? (
            <View style={styles.catalogMessageCard}>
              <SFIcon name="mountain.2" color={AmoledTheme.textTertiary} size={16} />
              <Text style={styles.catalogMessageText}>
                Paket elevasi untuk area ini belum tersedia. Siapkan dari data medan nasional di server.
              </Text>
            </View>
          ) : null}

          {errorMessage ? <Text accessibilityRole="alert" style={styles.errorText}>{errorMessage}</Text> : null}
          {mapAreaBounds !== undefined ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Detail paket elevasi" accessibilityState={{ expanded: showPackageDetails }}
              onPress={() => setShowPackageDetails(current => !current)} style={styles.prepareAreaButton}>
              <Text style={styles.prepareAreaButtonText}>{showPackageDetails ? 'Tutup detail paket' : 'Detail paket & penyimpanan'}</Text>
              <SFIcon name={showPackageDetails ? 'chevron.up' : 'chevron.down'} color={AmoledTheme.textSecondary} size={12} />
            </Pressable>
          ) : null}

          {mapAreaBounds === undefined || showPackageDetails ? <>

          {nativeDownloads.filter(download => isActiveDownload(download) &&
            !remoteCatalog?.chunks.some(chunk => chunk.chunkId === download.chunkID),
          ).map(download => (
            <View key={download.operationID} style={styles.chunkRow}>
              <View style={styles.chunkTextContainer}>
                <Text numberOfLines={1} style={styles.chunkTitle}>{download.chunkID}</Text>
                <Text style={styles.chunkDetails}>Unduhan berlangsung</Text>
              </View>
              <TerrainDownloadProgressControls
                progress={download.progress}
                isCancelling={cancellingChunkID === download.chunkID || download.state === 'cancelling'}
                isInstalling={download.state === 'installing'}
                onCancel={() => handleCancelDownload(download.chunkID)}
              />
            </View>
          ))}

          {catalogChunksForSavedAreas.map(chunk => {
            const installedPack = installedPacksByID.get(chunk.packId);
            const isInstalled = Boolean(installedPack);
            const hasUpdate = Boolean(
              installedPack &&
              installedPack.databaseSha256 &&
              chunk.databaseSha256 &&
              installedPack.databaseSha256.toLowerCase() !== chunk.databaseSha256.toLowerCase(),
            );
            const recoveredDownload = nativeDownloads.find(
              download => download.chunkID === chunk.chunkId && isActiveDownload(download),
            );
            const isDownloading = downloadingChunkID === chunk.chunkId || recoveredDownload !== undefined;
            const isCancelling = cancellingChunkID === chunk.chunkId || recoveredDownload?.state === 'cancelling';
            const isInstalling = recoveredDownload?.state === 'installing';
            const displayedProgress = recoveredDownload?.progress ?? downloadProgress;
            const sizeMegabytes = (chunk.databaseSizeBytes / (1024 * 1024)).toFixed(1);
            const coveredMapAreaCount = mapAreaBounds?.filter(areaBounds =>
              boundsCoveredByRegions(areaBounds, [chunk.requestedBoundsWgs84]),
            ).length;
            const mapAreaCoverageLabel = coveredMapAreaCount == null
              ? null
              : coveredMapAreaCount > 0
              ? `Mencakup ${coveredMapAreaCount} area peta`
              : 'Hanya sebagian cakupan area';

            return (
              <View key={chunk.chunkId} style={styles.chunkRow}>
                <View style={styles.chunkTextContainer}>
                  <Text numberOfLines={1} style={styles.chunkTitle}>{chunk.chunkId}</Text>
                  <Text style={styles.chunkDetails}>
                    {[mapAreaCoverageLabel, chunk.verticalDatum, `${sizeMegabytes} MB`]
                      .filter(Boolean).join(' · ')}
                  </Text>
                  <View style={styles.tagRow}>
                    {chunk.hasElevationGrid ? (
                      <View style={styles.tagBadge}>
                        <Text style={styles.tagText}>Grid</Text>
                      </View>
                    ) : null}
                    {chunk.hasRoadGraph ? (
                      <View style={styles.tagBadge}>
                        <Text style={styles.tagText}>Jalan & Tanjakan</Text>
                      </View>
                    ) : null}
                  </View>
                </View>

                {isDownloading ? (
                  <TerrainDownloadProgressControls
                    progress={displayedProgress}
                    isCancelling={isCancelling}
                    isInstalling={isInstalling}
                    onCancel={() => handleCancelDownload(chunk.chunkId)}
                  />
                ) : hasUpdate ? (
                  <Pressable
                    accessibilityLabel={`Perbarui paket ${chunk.chunkId}`}
                    accessibilityRole="button"
                    disabled={
                      !canInstallPack ||
                      isChangingPack ||
                      hasActiveDownload
                    }
                    onPress={() => handleDownloadPack(chunk)}
                    style={({ pressed }) => [
                      styles.downloadButton,
                      (!canInstallPack ||
                        isChangingPack ||
                        hasActiveDownload) &&
                        styles.disabledButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <SFIcon name="arrow.triangle.2.circlepath" color={AmoledTheme.accentOrange} size={16} />
                    <Text style={styles.downloadButtonText}>Perbarui</Text>
                  </Pressable>
                ) : isInstalled ? (
                  <View style={styles.installedBadge}>
                    <SFIcon name="checkmark.circle.fill" color={AmoledTheme.accentGreen} size={16} />
                    <Text style={styles.installedBadgeText}>Terpasang</Text>
                  </View>
                ) : (
                  <Pressable
                    accessibilityLabel={`Unduh paket ${chunk.chunkId}`}
                    accessibilityRole="button"
                    disabled={
                      !canInstallPack ||
                      isChangingPack ||
                      hasActiveDownload
                    }
                    onPress={() => handleDownloadPack(chunk)}
                    style={({ pressed }) => [
                      styles.downloadButton,
                      (!canInstallPack ||
                        isChangingPack ||
                        hasActiveDownload) &&
                        styles.disabledButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <SFIcon name="arrow.down.circle" color={AmoledTheme.accentOrange} size={16} />
                    <Text style={styles.downloadButtonText}>Unduh</Text>
                  </Pressable>
                )}
              </View>
            );
          })}

          {/* Section 2: Installed Packs (Local Offline Storage) */}
          <Text style={[styles.sectionTitle, styles.sectionTitleSpaced]}>
            PAKET TERSIMPAN LOKAL
          </Text>

          {inventory?.packs.length === 0 ? (
            <Text style={styles.emptyInventoryText}>Belum ada paket medan yang dipasang.</Text>
          ) : null}

          {inventory?.packs.map(pack => (
            <View key={pack.packID} style={styles.packRow}>
              <View style={styles.packText}>
                <Text numberOfLines={1} style={styles.packName}>{pack.packID}</Text>
                <Text style={styles.packDetails}>
                  {pack.verticalDatum} · {pack.signatureStatus === 'signed' ? 'Terverifikasi' : 'Pilot'}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={`Hapus paket ${pack.packID}`}
                accessibilityRole="button"
                disabled={isChangingPack || hasActiveDownload}
                onPress={() => confirmRemovePack(pack)}
                style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}
              >
                <SFIcon name="trash" color={AmoledTheme.accentRed} size={16} />
              </Pressable>
            </View>
          ))}

          {(inventory?.unavailablePackageCount ?? 0) > 0 ? (
            <Text style={styles.errorText}>
              {inventory?.unavailablePackageCount} folder paket tidak lolos verifikasi dan tidak dipakai.
            </Text>
          ) : null}

          {/* Section 3: Manual File Import */}
          <Pressable
            accessibilityRole="button"
            disabled={!canInstallPack || isChangingPack || hasActiveDownload}
            onPress={importTerrainPack}
            style={({ pressed }) => [
              styles.importButton,
              (!canInstallPack || isChangingPack || hasActiveDownload) && styles.disabledButton,
              pressed && canInstallPack && styles.pressed,
            ]}
          >
            {isChangingPack
              ? <ActivityIndicator color={AmoledTheme.background} />
              : <SFIcon name="folder.badge.plus" color={AmoledTheme.background} size={17} />}
            <Text style={styles.importButtonText}>
              {isChangingPack ? 'Memproses paket…' : 'Impor paket dari File'}
            </Text>
          </Pressable>
          </> : null}
        </View>
      ) : null}
    </View>
  );
}

function TerrainAreaDownloadControls({ transfer, installed, storedBytes, disabled, onStart }: {
  transfer: TerrainAreaTransfer | null;
  installed: boolean;
  storedBytes?: number;
  disabled: boolean;
  onStart: () => void;
}) {
  const busy = transfer && ['preparing', 'downloading', 'pausing'].includes(transfer.phase);
  const preparation = transfer?.buildProgress;
  const preparationPercent = preparation
    ? Math.floor(preparation.completedChunks / preparation.totalChunks * 100) : 0;
  const downloadPercent = Math.floor((transfer?.progress ?? 0) * 100);
  const resume = transfer?.phase === 'failed' || transfer?.phase === 'paused';
  return (
    <View accessibilityLiveRegion="polite">
      {!busy && storedBytes !== undefined ? (
        <Text style={styles.mapAreaMessage}>{`${(storedBytes / 1_048_576).toFixed(1)} MB tersimpan di iPhone`}</Text>
      ) : null}
      {busy ? <>
        <View style={styles.areaBuildStatus}>
          <ActivityIndicator color={AmoledTheme.accentOrange} size="small" />
          <Text style={styles.areaBuildStatusText}>
            {transfer.phase === 'preparing'
              ? `Menyiapkan elevasi di server · ${preparationPercent}%`
              : transfer.phase === 'pausing' ? 'Menjeda unduhan…'
              : `Mengunduh elevasi · ${downloadPercent}%`}
          </Text>
          {transfer.phase === 'downloading' ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Jeda unduhan elevasi area"
              onPress={pauseTerrainAreaTransfer} style={styles.areaPauseButton}>
              <Text style={styles.prepareAreaButtonText}>Jeda</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.mapAreaMessage}>
          {transfer.phase === 'preparing'
            ? 'Unduhan ke iPhone dimulai otomatis setelah area siap.'
            : `${(transfer.completedBytes / 1_048_576).toFixed(1)} / ${(transfer.totalBytes / 1_048_576).toFixed(1)} MB`}
        </Text>
        {transfer.phase !== 'preparing' ? (
          <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: downloadPercent }}
            style={styles.areaProgressTrack}>
            <View style={[styles.areaProgressFill, { width: `${downloadPercent}%` }]} />
          </View>
        ) : null}
      </> : (
        <Pressable accessibilityRole="button" disabled={disabled} onPress={onStart}
          style={({ pressed }) => [styles.prepareAreaButton, disabled && styles.disabledButton, pressed && styles.pressed]}>
          <SFIcon name="square.and.arrow.down" color={AmoledTheme.accentOrange} size={15} />
          <Text style={styles.prepareAreaButtonText}>
            {resume ? 'Lanjutkan unduhan elevasi' : installed ? 'Periksa pembaruan elevasi' : 'Siapkan & unduh elevasi'}
          </Text>
        </Pressable>
      )}
      {transfer?.error ? <Text accessibilityRole="alert" style={styles.errorText}>{transfer.error}</Text> : null}
    </View>
  );
}

function isActiveDownload(download: TerrainDownloadState) {
  return download.state !== 'failed' && download.state !== 'completed';
}

function mergeTerrainCatalogs(
  currentCatalog: TerrainCatalog | null,
  areaCatalog: TerrainCatalog,
): TerrainCatalog {
  const chunksByID = new Map<string, TerrainCatalogChunk>();
  for (const chunk of currentCatalog?.chunks ?? []) {
    chunksByID.set(chunk.chunkId, chunk);
  }
  for (const areaChunk of areaCatalog.chunks) {
    const currentChunk = chunksByID.get(areaChunk.chunkId);
    if (currentChunk?.hasRoadGraph && !areaChunk.hasRoadGraph) {
      continue;
    }
    chunksByID.set(areaChunk.chunkId, {
      ...areaChunk,
      releaseId: areaChunk.releaseId ?? areaCatalog.releaseId,
    });
  }
  return {
    ...(currentCatalog ?? areaCatalog),
    chunks: Array.from(chunksByID.values()),
  };
}

function hasCompleteElevationGrid(chunk: TerrainCatalogChunk) {
  if (!chunk.hasElevationGrid) {
    return false;
  }
  if (typeof chunk.elevationCoverage === 'string') {
    return chunk.elevationCoverage === 'complete';
  }
  return chunk.elevationCoverage.status === 'complete' &&
    chunk.elevationCoverage.coverageFraction === 1;
}

function terrainAreaStatusText(
  availability: ReturnType<typeof terrainMapAreaAvailability>,
  catalogUnavailable: boolean,
) {
  switch (availability) {
    case 'installed': return 'Medan terpasang';
    case 'available': return 'Medan tersedia';
    case 'partial': return 'Cakupan medan sebagian';
    case 'unavailable': return catalogUnavailable ? 'Katalog belum tersedia' : 'Belum tersedia di server';
  }
}

function formatAreaBounds(bounds: RouteBounds) {
  const [west, south, east, north] = bounds;
  const formatLongitude = (longitude: number) =>
    `${Math.abs(longitude).toFixed(2)}° ${longitude < 0 ? 'BB' : 'BT'}`;
  const formatLatitude = (latitude: number) =>
    `${Math.abs(latitude).toFixed(2)}° ${latitude < 0 ? 'LS' : 'LU'}`;
  return `${formatLongitude(west)}–${formatLongitude(east)} · ${formatLatitude(south)}–${formatLatitude(north)}`;
}

function TerrainDownloadProgressControls({
  progress,
  isCancelling,
  isInstalling,
  onCancel,
}: {
  progress: number;
  isCancelling: boolean;
  isInstalling: boolean;
  onCancel: () => void;
}) {
  return (
    <View style={styles.downloadingContainer}>
      <Text style={styles.progressText}>
        {isCancelling ? 'Membatalkan…' : isInstalling ? 'Memasang…' : `${Math.round(progress * 100)}%`}
      </Text>
      <Pressable
        accessibilityLabel="Batalkan unduhan"
        accessibilityRole="button"
        disabled={isCancelling || isInstalling}
        onPress={onCancel}
        style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}
      >
        {isCancelling || isInstalling ? (
          <ActivityIndicator color={AmoledTheme.accentRed} size="small" />
        ) : (
          <SFIcon name="xmark.circle.fill" color={AmoledTheme.accentRed} size={18} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 14,
    paddingHorizontal: 14,
  },
  heading: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 76,
    paddingVertical: 10,
  },
  headingText: {
    flex: 1,
    paddingRight: 12,
  },
  eyebrow: {
    color: AmoledTheme.accentOrange,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
  },
  title: {
    color: AmoledTheme.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 3,
  },
  summary: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    marginTop: 3,
  },
  details: {
    borderTopColor: AmoledTheme.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingBottom: 14,
    paddingTop: 12,
  },
  description: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  notice: {
    alignItems: 'flex-start',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderRadius: 10,
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
    padding: 10,
  },
  noticeText: {
    color: AmoledTheme.textSecondary,
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
  },
  sectionHeaderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  mapAreaSection: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
    marginTop: 12,
    padding: 12,
  },
  areaPauseButton: {
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 12,
  },
  areaProgressTrack: {
    backgroundColor: AmoledTheme.borderSubtle,
    borderRadius: 3,
    height: 4,
    marginTop: 8,
    overflow: 'hidden',
  },
  areaProgressFill: {
    backgroundColor: AmoledTheme.accentOrange,
    height: 4,
  },
  mapAreaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  mapAreaTextColumn: {
    flex: 1,
    minWidth: 0,
  },
  mapAreaTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  mapAreaBounds: {
    color: AmoledTheme.textTertiary,
    fontSize: 10,
    marginTop: 2,
  },
  mapAreaStatus: {
    color: AmoledTheme.accentGreen,
    flexShrink: 0,
    fontSize: 10,
    fontWeight: '600',
    textAlign: 'right',
  },
  mapAreaStatusUnavailable: {
    color: AmoledTheme.textSecondary,
  },
  mapAreaMessage: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  sectionTitle: {
    color: AmoledTheme.textSecondary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  sectionTitleSpaced: {
    marginTop: 16,
  },
  refreshCatalogButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 28,
    minWidth: 28,
  },
  catalogLoadingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    paddingVertical: 4,
  },
  catalogLoadingText: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
  },
  catalogMessageCard: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderRadius: 10,
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    padding: 10,
  },
  catalogMessageText: {
    color: AmoledTheme.textSecondary,
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
  },
  prepareAreaButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  prepareAreaButtonText: {
    color: AmoledTheme.accentOrange,
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
  },
  areaBuildStatus: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    minHeight: 40,
    paddingHorizontal: 4,
  },
  areaBuildStatusText: {
    color: AmoledTheme.textSecondary,
    flex: 1,
    fontSize: 12,
  },
  chunkRow: {
    alignItems: 'center',
    borderBottomColor: AmoledTheme.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 64,
    paddingVertical: 8,
  },
  chunkTextContainer: {
    flex: 1,
    paddingRight: 10,
  },
  chunkTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  chunkDetails: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  tagRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  tagBadge: {
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  tagText: {
    color: AmoledTheme.textSecondary,
    fontSize: 9,
    fontWeight: '600',
  },
  installedBadge: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  installedBadgeText: {
    color: AmoledTheme.accentGreen,
    fontSize: 12,
    fontWeight: '700',
  },
  downloadingContainer: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  progressText: {
    color: AmoledTheme.accentOrange,
    fontSize: 12,
    fontWeight: '700',
  },
  cancelButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
    minWidth: 36,
  },
  downloadButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  downloadButtonText: {
    color: AmoledTheme.accentOrange,
    fontSize: 12,
    fontWeight: '700',
  },
  emptyInventoryText: {
    color: AmoledTheme.textTertiary,
    fontSize: 12,
    marginVertical: 8,
  },
  packRow: {
    alignItems: 'center',
    borderBottomColor: AmoledTheme.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 58,
  },
  packText: {
    flex: 1,
    paddingVertical: 8,
  },
  packName: {
    color: AmoledTheme.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  packDetails: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    marginTop: 3,
  },
  removeButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 44,
  },
  importButton: {
    alignItems: 'center',
    backgroundColor: AmoledTheme.accentOrange,
    borderRadius: 10,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: 14,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  importButtonText: {
    color: AmoledTheme.background,
    fontSize: 13,
    fontWeight: '800',
  },
  disabledButton: {
    opacity: 0.42,
  },
  pressed: {
    opacity: 0.68,
  },
  errorText: {
    color: AmoledTheme.accentRed,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 9,
  },
});
