import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { GpxRoute } from '../../domain/routes/gpx/GpxRoute';
import {
  gmapsLinkToGpxRoute,
  type ConversionProgress,
} from '../../domain/routes/search/gmapsLinkToGpxRoute';
import { AmoledTheme } from '../../theme/colors';
import { SFIcon } from '../../components/SFIcon';
import { AmoledSwitch } from '../../components/AmoledSwitch';

interface GmapsLinkModalProps {
  visible: boolean;
  onClose: () => void;
  onRouteCreated: (route: GpxRoute) => void;
  userCoordinate?: [number, number] | null;
  startFromCurrentPosition?: boolean;
}

type PipelineStep = 'idle' | 'resolving' | 'geocoding' | 'routing' | 'elevation' | 'building' | 'done' | 'error';

const STEP_ORDER: Record<PipelineStep, number> = {
  idle: 0,
  resolving: 1,
  geocoding: 2,
  routing: 3,
  elevation: 4,
  building: 5,
  done: 6,
  error: -1,
};

export function GmapsLinkModal({
  visible,
  onClose,
  onRouteCreated,
  userCoordinate,
  startFromCurrentPosition = false,
}: GmapsLinkModalProps) {
  const insets = useSafeAreaInsets();
  const [urlInput, setUrlInput] = useState('');
  const [currentStep, setCurrentStep] = useState<PipelineStep>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [useCurrentPosition, setUseCurrentPosition] = useState(startFromCurrentPosition);

  useEffect(() => {
    if (visible) setUseCurrentPosition(startFromCurrentPosition);
  }, [visible, startFromCurrentPosition]);

  const isProcessing = currentStep !== 'idle' && currentStep !== 'done' && currentStep !== 'error';
  const stepIndex = STEP_ORDER[currentStep];

  function resetState() {
    setUrlInput('');
    setCurrentStep('idle');
    setStatusMessage('');
    setErrorMessage(null);
  }

  function handleClose() {
    if (isProcessing) return;
    resetState();
    onClose();
  }

  async function handleConvert() {
    const trimmed = urlInput.trim();
    if (!trimmed) return;

    setErrorMessage(null);
    setCurrentStep('resolving');
    setStatusMessage('Membaca link Google Maps…');

    try {
      const route = await gmapsLinkToGpxRoute(
        trimmed,
        (progress: ConversionProgress) => {
          setCurrentStep(progress.step);
          setStatusMessage(progress.message);
        },
        userCoordinate,
        {},
        useCurrentPosition,
      );

      setCurrentStep('done');
      setStatusMessage('Rute berhasil dibuat!');
      resetState();
      onRouteCreated(route);
      onClose();
    } catch (err) {
      setCurrentStep('error');
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Terjadi kesalahan saat memproses rute. Pastikan link Google Maps valid.',
      );
    }
  }

  return (
    <Modal
      animationType="slide"
      transparent
      visible={visible}
      onRequestClose={handleClose}
    >
      <View style={styles.backdrop}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.keyboardContainer}
        >
          <View style={[styles.card, { paddingTop: Math.max(insets.top, 20) + 16, paddingBottom: Math.max(insets.bottom, 20) }]}>
            {/* Header */}
            <View style={styles.headerRow}>
              <View style={styles.headerTitleBlock}>
                <Text style={styles.badgeLabel}>RUTE SEPEDA DARI LINK</Text>
                <Text style={styles.title}>Buat Rute dari Google Maps</Text>
              </View>
              <Pressable
                accessibilityLabel="Tutup dialog"
                accessibilityRole="button"
                disabled={isProcessing}
                onPress={handleClose}
                style={({ pressed }) => [
                  styles.closeButton,
                  pressed && styles.closeButtonPressed,
                  isProcessing && styles.closeButtonDisabled,
                ]}
              >
                <Text style={styles.closeButtonText}>✕</Text>
              </Pressable>
            </View>

            <ScrollView
              bounces={false}
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Description */}
              <Text style={styles.description}>
                Titik awal, tujuan, dan singgah dibaca dari link Google Maps. Jalur sepeda
                dihitung ulang oleh OSRM dan dapat berbeda dari Google Maps. Untuk mengikuti
                garis tertentu, impor file GPX yang berisi jalur tersebut.
              </Text>

              {startFromCurrentPosition ? (
                <View style={styles.originChoice}>
                  <View style={styles.originChoiceText}>
                    <Text style={styles.inputLabel}>Mulai dari lokasi saat ini</Text>
                    <Text style={styles.description}>Saat aktif, titik awal dalam link diganti lokasi sekarang. Matikan untuk memakai titik awal link jika tersedia.</Text>
                  </View>
                  <AmoledSwitch accessibilityLabel="Mulai rute dari lokasi saat ini" value={useCurrentPosition} onValueChange={setUseCurrentPosition} disabled={isProcessing} />
                </View>
              ) : null}

              {/* Input Area */}
              <Text style={styles.inputLabel}>LINK GOOGLE MAPS</Text>
              <View style={styles.inputContainer}>
                <TextInput
                  accessibilityLabel="Input link Google Maps"
                  autoCapitalize="none"
                  autoCorrect={false}
                  clearButtonMode="while-editing"
                  editable={!isProcessing}
                  keyboardType="url"
                  multiline={false}
                  onChangeText={text => {
                    setUrlInput(text);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  placeholder="https://maps.app.goo.gl/... atau google.com/maps/dir/..."
                  placeholderTextColor={AmoledTheme.textTertiary}
                  returnKeyType="go"
                  onSubmitEditing={handleConvert}
                  selectTextOnFocus
                  style={styles.textInput}
                  value={urlInput}
                />
                {urlInput.length > 0 && !isProcessing && (
                  <Pressable
                    accessibilityLabel="Hapus teks"
                    accessibilityRole="button"
                    onPress={() => setUrlInput('')}
                    style={styles.clearInputButton}
                  >
                    <Text style={styles.clearInputText}>✕</Text>
                  </Pressable>
                )}
              </View>

              {/* Progress Panel */}
              {isProcessing && (
                <View style={styles.progressCard}>
                  <View style={styles.progressHeader}>
                    <ActivityIndicator color={AmoledTheme.accentOrange} size="small" />
                    <Text style={styles.progressMessage}>{statusMessage}</Text>
                  </View>
                  <View style={styles.stepsList}>
                    <StepItem
                      active={stepIndex === 1}
                      done={stepIndex > 1}
                      label="1. Membaca link & titik arah (Waypoints)"
                    />
                    <StepItem
                      active={stepIndex === 2}
                      done={stepIndex > 2}
                      label="2. Menemukan koordinat lokasi"
                    />
                    <StepItem
                      active={stepIndex === 3}
                      done={stepIndex > 3}
                      label="3. Menghitung rute sepeda OSRM"
                    />
                    <StepItem
                      active={stepIndex === 4}
                      done={stepIndex > 4}
                      label="4. Mengambil data elevasi Open-Meteo"
                    />
                    <StepItem
                      active={stepIndex === 5}
                      done={stepIndex > 5}
                      label="5. Menyusun GPX dengan profil tanjakan"
                    />
                  </View>
                </View>
              )}

              {/* Error Box */}
              {errorMessage && (
                <View style={styles.errorBox}>
                  <SFIcon name="exclamationmark.triangle.fill" color={AmoledTheme.accentYellow} size={20} />
                  <View style={styles.errorTextContainer}>
                    <Text style={styles.errorTitle}>Gagal Membuat Rute</Text>
                    <Text style={styles.errorMessage}>{errorMessage}</Text>
                  </View>
                </View>
              )}

              {/* Action Button */}
              {!isProcessing && (
                <Pressable
                  accessibilityLabel="Konversi link menjadi rute GPX"
                  accessibilityRole="button"
                  disabled={urlInput.trim().length === 0}
                  onPress={handleConvert}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    urlInput.trim().length === 0 && styles.primaryButtonDisabled,
                    pressed && styles.primaryButtonPressed,
                  ]}
                >
                  <Text style={[styles.primaryButtonText, urlInput.trim().length === 0 && styles.primaryButtonTextDisabled]}>
                    {errorMessage ? 'Coba Lagi' : 'Buat Rute Sepeda'}
                  </Text>
                </Pressable>
              )}

              {/* Tips Section */}
              <View style={styles.tipsSection}>
                <View style={styles.tipsHeading}>
                  <SFIcon name="lightbulb" color={AmoledTheme.accentYellow} size={16} />
                  <Text style={styles.tipsTitle}>CARA MEMBUAT LINK DI GOOGLE MAPS:</Text>
                </View>
                <Text style={styles.tipText}>
                  1. Buka aplikasi Google Maps atau browser.
                </Text>
                <Text style={styles.tipText}>
                  2. Pilih tujuan dan tap <Text style={styles.tipHighlight}>Rute (Directions)</Text>.
                </Text>
                <Text style={styles.tipText}>
                  3. Pilih titik awal dan tambahkan titik singgah pada ruas yang ingin dilewati. Jalur tetap bisa berbeda.
                </Text>
                <Text style={styles.tipText}>
                  4. Tap menu titik tiga (⋮) atau tombol <Text style={styles.tipHighlight}>Bagikan (Share)</Text> lalu pilih <Text style={styles.tipHighlight}>Salin link</Text>.
                </Text>
                <Text style={styles.tipText}>
                  5. Tempel link tersebut pada kotak di atas.
                </Text>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function StepItem({
  label,
  active,
  done,
}: {
  label: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <View style={styles.stepItemRow}>
      <View style={styles.stepIcon}>
        {done ? (
          <SFIcon name="checkmark" color={AmoledTheme.accentGreen} size={12} />
        ) : active ? (
          <ActivityIndicator color={AmoledTheme.accentBlue} size="small" />
        ) : (
          <SFIcon name="circle" color={AmoledTheme.textTertiary} size={10} />
        )}
      </View>
      <Text
        style={[
          styles.stepLabel,
          done && styles.stepLabelDone,
          active && styles.stepLabelActive,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  originChoice: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 12 },
  originChoiceText: { flex: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: AmoledTheme.modalBackdrop,
    justifyContent: 'flex-end',
  },
  keyboardContainer: {
    flex: 1,
    width: '100%',
  },
  card: {
    backgroundColor: AmoledTheme.background,
    flex: 1,
    paddingHorizontal: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  headerTitleBlock: {
    flex: 1,
    marginRight: 12,
  },
  badgeLabel: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
    color: AmoledTheme.accentOrange,
    textTransform: 'uppercase',
    marginBottom: 3,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: AmoledTheme.textPrimary,
  },
  closeButton: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: AmoledTheme.surfaceInteractive,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonPressed: {
    backgroundColor: AmoledTheme.surfaceInteractiveActive,
  },
  closeButtonDisabled: {
    opacity: 0.4,
  },
  closeButtonText: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  scrollContent: {
    paddingBottom: 16,
  },
  description: {
    fontSize: 16,
    color: AmoledTheme.textSecondary,
    lineHeight: 23,
    marginBottom: 20,
  },
  inputLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  inputContainer: {
    position: 'relative',
    marginBottom: 16,
  },
  textInput: {
    backgroundColor: AmoledTheme.background,
    borderWidth: 1,
    borderColor: AmoledTheme.borderEmphasized,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    paddingRight: 40,
    fontSize: 16,
    minHeight: 56,
    color: AmoledTheme.textPrimary,
  },
  clearInputButton: {
    position: 'absolute',
    right: 4,
    top: 4,
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: AmoledTheme.surfaceInteractive,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearInputText: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  progressCard: {
    backgroundColor: AmoledTheme.background,
    borderWidth: 1,
    borderColor: AmoledTheme.accentOrangeGlow,
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
  },
  progressHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  progressMessage: {
    marginLeft: 10,
    fontSize: 14,
    fontWeight: '600',
    color: AmoledTheme.accentOrange,
    flex: 1,
  },
  stepsList: {
    gap: 8,
  },
  stepItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepIcon: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
    marginRight: 8,
  },
  stepLabel: {
    flex: 1,
    fontSize: 14,
    color: AmoledTheme.textTertiary,
  },
  stepLabelDone: {
    color: AmoledTheme.textSecondary,
  },
  stepLabelActive: {
    color: AmoledTheme.textPrimary,
    fontWeight: '600',
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(255, 69, 58, 0.12)',
    borderWidth: 1,
    borderColor: AmoledTheme.accentRed,
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  errorIcon: {
    fontSize: 18,
    marginRight: 10,
  },
  errorTextContainer: {
    flex: 1,
  },
  errorTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: AmoledTheme.accentRed,
    marginBottom: 2,
  },
  errorMessage: {
    fontSize: 14,
    color: AmoledTheme.textPrimary,
    lineHeight: 20,
  },
  primaryButton: {
    backgroundColor: AmoledTheme.accentOrange,
    borderRadius: 14,
    paddingVertical: 14,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  primaryButtonDisabled: {
    backgroundColor: AmoledTheme.surfaceInteractive,
  },
  primaryButtonPressed: {
    opacity: 0.85,
  },
  primaryButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#000000',
    letterSpacing: 0.3,
  },
  primaryButtonTextDisabled: {
    color: AmoledTheme.textSecondary,
  },
  tipsSection: {
    backgroundColor: AmoledTheme.background,
    borderWidth: 1,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 12,
    padding: 14,
  },
  tipsTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: AmoledTheme.textSecondary,
    letterSpacing: 0.8,
  },
  tipsHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
    marginBottom: 8,
  },
  tipText: {
    fontSize: 14,
    color: AmoledTheme.textTertiary,
    lineHeight: 21,
    marginBottom: 4,
  },
  tipHighlight: {
    color: AmoledTheme.textPrimary,
    fontWeight: '600',
  },
});
