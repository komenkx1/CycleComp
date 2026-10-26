import React, { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { AmoledTheme } from '../../theme/colors';
import { SFIcon } from '../../components/SFIcon';
import type { StravaConfig } from './stravaTypes';

interface StravaConfigModalProps {
  visible: boolean;
  config: StravaConfig;
  onSave: (clientId: string, clientSecret: string) => Promise<boolean>;
  onClose: () => void;
}

export function StravaConfigModal({
  visible,
  config,
  onSave,
  onClose,
}: StravaConfigModalProps) {
  const [clientId, setClientId] = useState(config.clientId || '');
  const [clientSecret, setClientSecret] = useState(config.clientSecret || '');
  const [saving, setSaving] = useState(false);

  // Sync state if config prop changes
  React.useEffect(() => {
    setClientId(config.clientId || '');
    setClientSecret(config.clientSecret || '');
  }, [config]);

  async function handleSave() {
    const trimmedId = clientId.trim();
    const trimmedSecret = clientSecret.trim();

    if (!trimmedId || !trimmedSecret) {
      Alert.alert(
        'Kredensial Belum Lengkap',
        'Harap masukkan Client ID dan Client Secret dari akun Strava Anda.',
      );
      return;
    }

    setSaving(true);
    try {
      await onSave(trimmedId, trimmedSecret);
      Alert.alert('Berhasil', 'Kredensial Strava API berhasil disimpan.');
      onClose();
    } catch {
      Alert.alert('Gagal', 'Terjadi kesalahan saat menyimpan kredensial.');
    } finally {
      setSaving(false);
    }
  }

  function openStravaApiSettings() {
    Linking.openURL('https://www.strava.com/settings/api');
  }

  return (
    <Modal
      animationType="slide"
      transparent={true}
      visible={visible}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.modalOverlay}
      >
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.modalContentCard}>
          <View style={styles.sheetHandle} />

          <View style={styles.headerRow}>
            <View style={styles.headerIconCircle}>
              <SFIcon name="key.fill" color={AmoledTheme.accentOrange} size={18} />
            </View>
            <View style={styles.headerTitleCol}>
              <Text style={styles.headerTitle}>Kredensial Strava API</Text>
              <Text style={styles.headerSubtitle}>Konfigurasi Client ID & Secret Anda</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Tutup dialog"
              onPress={onClose}
              style={styles.closeButton}
            >
              <SFIcon name="xmark" color={AmoledTheme.textSecondary} size={14} />
            </Pressable>
          </View>

          <ScrollView style={styles.scrollView} keyboardShouldPersistTaps="handled">
            {/* Instruction box */}
            <View style={styles.instructionBox}>
              <Text style={styles.instructionTitle}>Cara Mendapatkan Kredensial:</Text>
              <Text style={styles.instructionText}>
                1. Buka akun Anda di <Text style={styles.linkText} onPress={openStravaApiSettings}>strava.com/settings/api</Text>.
              </Text>
              <Text style={styles.instructionText}>
                2. Buat aplikasi: isi Category "Cycling", dan pada <Text style={styles.boldText}>"Authorization Callback Domain"</Text> ketik: <Text style={styles.codeBadge}>cyclecomp</Text> (atau <Text style={styles.codeBadge}>localhost</Text>).
              </Text>
              <Text style={styles.instructionText}>
                3. Salin <Text style={styles.boldText}>Client ID</Text> dan <Text style={styles.boldText}>Client Secret</Text> ke formulir di bawah ini.
              </Text>
            </View>

            {/* Inputs */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>CLIENT ID</Text>
              <TextInput
                value={clientId}
                onChangeText={setClientId}
                placeholder="Contoh: 123456"
                placeholderTextColor={AmoledTheme.textDisabled}
                keyboardType="numeric"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.textInput}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>CLIENT SECRET</Text>
              <TextInput
                value={clientSecret}
                onChangeText={setClientSecret}
                placeholder="Contoh: a1b2c3d4e5f6..."
                placeholderTextColor={AmoledTheme.textDisabled}
                secureTextEntry={false}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.textInput}
              />
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Buka pengaturan API Strava di Safari"
              onPress={openStravaApiSettings}
              style={styles.externalLinkButton}
            >
              <SFIcon name="safari" color={AmoledTheme.accentOrange} size={15} />
              <Text style={styles.externalLinkText}>Buka strava.com/settings/api</Text>
            </Pressable>

            {/* Save Button */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Simpan kredensial Strava"
              disabled={saving}
              onPress={handleSave}
              style={({ pressed }) => [
                styles.saveButton,
                pressed && styles.saveButtonPressed,
                saving && styles.saveButtonDisabled,
              ]}
            >
              <Text style={styles.saveButtonText}>
                {saving ? 'Menyimpan...' : 'Simpan Kredensial'}
              </Text>
            </Pressable>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
  },
  modalContentCard: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderTopColor: AmoledTheme.borderSubtle,
    paddingTop: 12,
    paddingHorizontal: 20,
    paddingBottom: 36,
    maxHeight: '85%',
  },
  sheetHandle: {
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderRadius: 3,
    height: 4,
    marginBottom: 16,
    width: 38,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 12,
  },
  headerIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 82, 26, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitleCol: {
    flex: 1,
  },
  headerTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 17,
    fontWeight: '700',
  },
  headerSubtitle: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: AmoledTheme.surfaceInteractive,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollView: {
    marginTop: 4,
  },
  instructionBox: {
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderSubtle,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
    gap: 6,
  },
  instructionTitle: {
    color: AmoledTheme.accentOrange,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 2,
  },
  instructionText: {
    color: AmoledTheme.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  linkText: {
    color: AmoledTheme.accentOrange,
    textDecorationLine: 'underline',
  },
  boldText: {
    color: AmoledTheme.textPrimary,
    fontWeight: '700',
  },
  codeBadge: {
    color: '#00E5FF',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '700',
  },
  inputGroup: {
    marginBottom: 14,
  },
  inputLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  textInput: {
    backgroundColor: '#000000',
    borderColor: AmoledTheme.borderDefault,
    borderWidth: 1,
    borderRadius: 10,
    color: AmoledTheme.textPrimary,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  externalLinkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginBottom: 18,
    paddingVertical: 4,
  },
  externalLinkText: {
    color: AmoledTheme.accentOrange,
    fontSize: 13,
    fontWeight: '600',
  },
  saveButton: {
    backgroundColor: AmoledTheme.accentOrange,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
    marginBottom: 10,
  },
  saveButtonPressed: {
    opacity: 0.8,
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
});
