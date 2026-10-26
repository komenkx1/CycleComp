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

export function StravaSettingsCard({
  isConnected,
  athlete,
  onConnect,
  onDisconnect,
}: StravaSettingsCardProps) {
  const [connecting, setConnecting] = useState(false);

  async function handleConnect() {
    setConnecting(true);
    try {
      await onConnect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal membuka halaman otorisasi Strava.';
      Alert.alert('Gagal Terhubung', msg);
    } finally {
      setConnecting(false);
    }
  }

  function handleConfirmDisconnect() {
    Alert.alert(
      'Putuskan Akun Strava?',
      'CycleComp tidak akan lagi dapat mengunggah rekaman gowes secara otomatis sampai Anda menghubungkan kembali.',
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Putuskan',
          style: 'destructive',
          onPress: () => onDisconnect(),
        },
      ],
    );
  }

  return (
    <View style={styles.cardContainer}>
      <View style={styles.cardHeader}>
        <View style={styles.iconCircle}>
          <SFIcon name="arrow.up.circle.fill" color="#FC4C02" size={20} />
        </View>
        <View style={styles.headerTitleCol}>
          <Text style={styles.cardTitle}>Strava</Text>
          <Text style={styles.cardSubtitle}>
            Sinkronkan rekaman gowes, elevasi barometer & detak jantung ke feed Strava
          </Text>
        </View>
        <View
          style={[
            styles.statusBadge,
            isConnected ? styles.statusBadgeConnected : styles.statusBadgeIdle,
          ]}
        >
          <Text
            style={[
              styles.statusBadgeText,
              isConnected ? styles.statusBadgeTextConnected : styles.statusBadgeTextIdle,
            ]}
          >
            {isConnected ? 'TERHUBUNG' : 'BELUM TERHUBUNG'}
          </Text>
        </View>
      </View>

      {isConnected && athlete ? (
        <View style={styles.athleteProfileBox}>
          <View style={styles.athleteAvatarCircle}>
            <SFIcon name="person.crop.circle.fill" color={AmoledTheme.textPrimary} size={30} />
          </View>
          <View style={styles.athleteInfoCol}>
            <Text style={styles.athleteName}>
              {`${athlete.firstname} ${athlete.lastname}`.trim() || 'Atlet Strava'}
            </Text>
            <Text style={styles.athleteIdText}>ID Atlet Strava: #{athlete.id}</Text>
          </View>
          <View style={styles.activeCheckBadge}>
            <SFIcon name="checkmark.circle.fill" color={AmoledTheme.accentGreen} size={16} />
          </View>
        </View>
      ) : null}

      {/* Actions */}
      <View style={styles.actionsRow}>
        {!isConnected ? (
          <View style={styles.connectContainer}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hubungkan ke akun Strava"
              disabled={connecting}
              onPress={handleConnect}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.primaryButtonPressed,
                connecting && styles.buttonDisabled,
              ]}
            >
              {connecting ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <SFIcon name="link" color="#FFFFFF" size={16} />
              )}
              <Text style={styles.primaryButtonText}>
                {connecting ? 'Membuka Strava...' : 'Hubungkan ke Strava'}
              </Text>
            </Pressable>
            <Text style={styles.hintText}>
              Bebas login menggunakan Google, Apple, atau akun Strava Anda
            </Text>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Putuskan hubungan dengan Strava"
            onPress={handleConfirmDisconnect}
            style={({ pressed }) => [
              styles.disconnectButton,
              pressed && styles.disconnectButtonPressed,
            ]}
          >
            <SFIcon name="link.badge.plus" color={AmoledTheme.accentRed} size={14} />
            <Text style={styles.disconnectButtonText}>Putuskan Akun</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cardContainer: {
    backgroundColor: AmoledTheme.surfaceElevated,
    borderColor: AmoledTheme.borderSubtle,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 12,
    padding: 14,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconCircle: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: 'rgba(252, 76, 2, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitleCol: {
    flex: 1,
  },
  cardTitle: {
    color: AmoledTheme.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  cardSubtitle: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    marginTop: 2,
    lineHeight: 15,
  },
  statusBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  statusBadgeConnected: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  statusBadgeIdle: {
    backgroundColor: 'rgba(148, 163, 184, 0.1)',
    borderColor: 'rgba(148, 163, 184, 0.25)',
  },
  statusBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  statusBadgeTextConnected: {
    color: AmoledTheme.accentGreen,
  },
  statusBadgeTextIdle: {
    color: AmoledTheme.textSecondary,
  },
  athleteProfileBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: AmoledTheme.surfaceInteractive,
    borderColor: AmoledTheme.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
    gap: 10,
  },
  athleteAvatarCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  athleteInfoCol: {
    flex: 1,
  },
  athleteName: {
    color: AmoledTheme.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  athleteIdText: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  activeCheckBadge: {
    padding: 4,
  },
  actionsRow: {
    marginTop: 12,
  },
  connectContainer: {
    width: '100%',
    alignItems: 'center',
    gap: 6,
  },
  primaryButton: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#FC4C02',
    borderRadius: 10,
    minHeight: 44,
    paddingHorizontal: 16,
    shadowColor: '#FC4C02',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
  primaryButtonPressed: {
    opacity: 0.85,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  hintText: {
    color: AmoledTheme.textSecondary,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 2,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  disconnectButton: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 38,
    paddingHorizontal: 10,
  },
  disconnectButtonPressed: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
  },
  disconnectButtonText: {
    color: AmoledTheme.accentRed,
    fontSize: 12,
    fontWeight: '600',
  },
});
