import React from 'react';
import { Alert } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

import { StravaSettingsCard } from '../src/features/strava/StravaSettingsCard';

describe('StravaSettingsCard', () => {
  it('shows a disconnected summary and connects from the expanded section', async () => {
    const connect = jest.fn().mockResolvedValue(undefined);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<StravaSettingsCard isConnected={false} athlete={null} onConnect={connect} onDisconnect={jest.fn()} />);
    });
    expect(renderer.root.findByProps({ children: 'Belum terhubung' })).toBeTruthy();
    await act(async () => { renderer.root.findByProps({ accessibilityLabel: 'Strava' }).props.onPress(); });
    await act(async () => { await renderer.root.findByProps({ accessibilityLabel: 'Hubungkan ke akun Strava' }).props.onPress(); });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('asks before disconnecting a connected account', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const disconnect = jest.fn().mockResolvedValue(undefined);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<StravaSettingsCard isConnected athlete={null} onConnect={jest.fn()} onDisconnect={disconnect} />);
    });
    await act(async () => { renderer.root.findByProps({ accessibilityLabel: 'Strava' }).props.onPress(); });
    await act(async () => { renderer.root.findByProps({ accessibilityLabel: 'Putuskan hubungan dengan Strava' }).props.onPress(); });
    expect(alert).toHaveBeenCalledWith('Putuskan Akun Strava?', expect.any(String), expect.arrayContaining([
      expect.objectContaining({ text: 'Batal' }),
      expect.objectContaining({ text: 'Putuskan', style: 'destructive' }),
    ]));
    expect(disconnect).not.toHaveBeenCalled();
    alert.mockRestore();
  });
});
