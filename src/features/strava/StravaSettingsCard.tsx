import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { AmoledTheme } from '../../theme/colors';
import { SFIcon } from '../../components/SFIcon';
import type { StravaAthlete } from './stravaTypes';

interface StravaSettingsCardProps {
  isConnected: boolean;
  athlete: StravaAthlete | null;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
}

export function StravaSettingsCard({ isConnected, athlete, onConnect, onDisconnect }: StravaSettingsCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const athleteName = athlete ? `${athlete.firstname} ${athlete.lastname}`.trim() : '';

  async function handleConnect() {
    setConnecting(true);
    try {
      await onConnect();
    } catch (error) {
      Alert.alert('Gagal Terhubung', error instanceof Error ? error.message : 'Gagal membuka halaman otorisasi Strava.');
    } finally {
      setConnecting(false);
    }
  }

  function handleConfirmDisconnect() {
    Alert.alert(
      'Putuskan Akun Strava?',
      'CycleComp tidak dapat mengunggah perjalanan ke Strava sampai akun dihubungkan kembali.',
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Putuskan', style: 'destructive', onPress: () => onDisconnect() },
      ],
    );
  }

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Strava"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(current => !current)}
        style={({ pressed }) => [styles.heading, pressed && styles.pressed]}
      >
        <View style={styles.headingText}>
          <Text style={styles.title}>Strava</Text>
          <Text style={styles.summary}>
            {isConnected ? (athleteName ? `Terhubung sebagai ${athleteName}` : 'Terhubung') : 'Belum terhubung'}
          </Text>
        </View>
        <SFIcon name={expanded ? 'chevron.up' : 'chevron.down'} color={AmoledTheme.textSecondary} size={16} />
      </Pressable>

      {expanded ? (
        <View style={styles.details}>
          <Text style={styles.sectionLabel}>INTEGRASI AKUN</Text>
          <View style={styles.statusCard}>
            <Text style={[styles.status, isConnected && styles.connectedStatus]}>
              {isConnected ? 'TERHUBUNG' : 'BELUM TERHUBUNG'}
            </Text>
            {isConnected && athleteName ? <Text style={styles.athleteName}>{athleteName}</Text> : null}
            <Text style={styles.description}>
              {isConnected
                ? 'Rekaman dapat diunggah dari detail Riwayat.'
                : 'Hubungkan akun untuk mengunggah rekaman dari Riwayat.'}
            </Text>
          </View>
          {!isConnected ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hubungkan ke akun Strava"
              disabled={connecting}
              onPress={handleConnect}
              style={({ pressed }) => [styles.connectButton, pressed && styles.pressed, connecting && styles.disabled]}
            >
              {connecting ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}
              <Text style={styles.connectButtonText}>{connecting ? 'Membuka Strava...' : 'Hubungkan ke Strava'}</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Putuskan hubungan dengan Strava"
              onPress={handleConfirmDisconnect}
              style={({ pressed }) => [styles.disconnectButton, pressed && styles.pressed]}
            >
              <Text style={styles.disconnectButtonText}>Putuskan akun</Text>
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomColor: AmoledTheme.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  heading: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 76,
    paddingVertical: 12,
  },
  headingText: { flex: 1, paddingRight: 12 },
  title: { color: AmoledTheme.textPrimary, fontSize: 17, fontWeight: '700' },
  summary: { color: AmoledTheme.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 4 },
  details: { paddingBottom: 20, paddingTop: 4 },
  sectionLabel: {
    color: AmoledTheme.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  statusCard: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderDefault,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
  },
  status: { color: AmoledTheme.textSecondary, fontSize: 14, fontWeight: '700' },
  connectedStatus: { color: AmoledTheme.accentGreen },
  athleteName: { color: AmoledTheme.textPrimary, fontSize: 22, fontWeight: '700', marginTop: 8 },
  description: { color: AmoledTheme.textSecondary, fontSize: 15, lineHeight: 22, marginTop: 8 },
  connectButton: {
    alignItems: 'center',
    backgroundColor: '#FC4C02',
    borderRadius: 10,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 50,
    paddingHorizontal: 16,
  },
  connectButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  disconnectButton: {
    alignItems: 'center',
    borderColor: AmoledTheme.accentRed,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 50,
  },
  disconnectButtonText: { color: AmoledTheme.accentRed, fontSize: 16, fontWeight: '700' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.6 },
});
