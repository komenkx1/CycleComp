import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { NavigationGuidanceBanner } from '../src/features/navigation/NavigationGuidanceBanner';
import { ClimbAlertBanner, buildClimbProfileSamples } from '../src/features/ride/ClimbAlertBanner';
import type { TurnInstruction } from '../src/domain/routes/navigation/routeNavigationGuidance';
import type { ClimbAlertState } from '../src/domain/routes/elevation/routeElevationAnalysis';

describe('NavigationGuidanceBanner', () => {
  const turnInstruction: TurnInstruction = {
    type: 'right',
    title: 'Belok kanan',
    description: 'Ikuti rute ke depan',
    distanceMeters: 150,
    coordinate: [115.2, -8.6],
    thenManeuver: {
      type: 'left',
      label: 'Belok kiri',
    },
  };

  const noClimb: ClimbAlertState = {
    type: 'none',
    currentGradePercent: null,
    currentElevationMeters: null,
    nextClimbDistanceMeters: null,
    totalClimbs: 0,
  };

  test('prioritizes the off-route warning and keeps it visible when collapsed', () => {
    let screen!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => { screen = ReactTestRenderer.create(
      <NavigationGuidanceBanner instruction={turnInstruction} climbAlert={noClimb} hasRoute isOffRoute />,
    ); });
    expect(screen.root.findByProps({ children: 'Keluar dari rute' })).toBeTruthy();
    expect(screen.root.findByProps({ children: 'Kembali ke garis rute' })).toBeTruthy();
    expect(screen.root.findAllByProps({ children: 'Belok kanan' })).toHaveLength(0);
    ReactTestRenderer.act(() => screen.root.findByProps({ accessibilityLabel: 'Perkecil panduan' }).props.onPress());
    expect(screen.root.findByProps({ children: 'Keluar dari rute · kembali ke garis rute' })).toBeTruthy();
    ReactTestRenderer.act(() => screen.unmount());
  });

  test('shows remaining distance separately from the next turn', () => {
    let screen: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => { screen = ReactTestRenderer.create(
      <NavigationGuidanceBanner instruction={turnInstruction} climbAlert={noClimb} hasRoute distanceToFinishMeters={2350} />,
    ); });
    expect(screen!.root.findByProps({ testID: 'navigation-distance-to-finish' }).props.children).toBe('Sisa ke finish: 2,4 km');
    ReactTestRenderer.act(() => screen!.unmount());
  });

  const upcomingClimb: ClimbAlertState = {
    type: 'upcoming',
    climbIndex: 1,
    totalClimbs: 2,
    distanceToStartMeters: 250,
    currentGradePercent: null,
    currentElevationMeters: 45,
    climb: {
      id: 1,
      startDistanceMeters: 1000,
      endDistanceMeters: 1800,
      distanceMeters: 800,
      elevationGainMeters: 62,
      averageGradePercent: 7.8,
      maxGradePercent: 12.5,
      startElevationMeters: 45,
      endElevationMeters: 107,
      startCoordinate: [115.2, -8.6],
      endCoordinate: [115.21, -8.61],
    },
  };

  test('uses only recorded route samples for a climb profile', () => {
    if (upcomingClimb.type !== 'upcoming') throw new Error('Expected upcoming climb');
    const climb = upcomingClimb.climb;
    expect(buildClimbProfileSamples(climb)).toEqual([]);
    const routeSamples = [
      { coordinate: climb.startCoordinate, distanceMeters: 1000, elevationMeters: 45, gradePercent: 7 },
      { coordinate: climb.endCoordinate, distanceMeters: 1800, elevationMeters: 107, gradePercent: 8 },
    ];
    expect(buildClimbProfileSamples(climb, routeSamples)).toEqual(routeSamples);
  });

  test('keeps hook order when a climb appears and disappears', () => {
    let screen!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      screen = ReactTestRenderer.create(<ClimbAlertBanner alert={noClimb} />);
    });
    ReactTestRenderer.act(() => { screen.update(<ClimbAlertBanner alert={upcomingClimb} />); });
    expect(screen.toJSON()).not.toBeNull();
    ReactTestRenderer.act(() => { screen.update(<ClimbAlertBanner alert={noClimb} />); });
    expect(screen.toJSON()).toBeNull();
    ReactTestRenderer.act(() => screen.unmount());
  });

  test('does not claim a ride is recording when recovery is required', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <NavigationGuidanceBanner instruction={null} climbAlert={noClimb} needsRecovery />,
      );
    });
    expect(renderer!.root.findByProps({ children: 'Perlu dipulihkan' })).toBeTruthy();
    expect(renderer!.root.findByProps({ children: 'Pulihkan perjalanan untuk melanjutkan' })).toBeTruthy();
    ReactTestRenderer.act(() => renderer!.unmount());
  });

  test('renders Google Maps turn maneuver, distance, and Then preview pill', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <NavigationGuidanceBanner
          instruction={turnInstruction}
          climbAlert={noClimb}
          routeName="Tour de Bali"
          accuracyMeters={5}
        />,
      );
    });

    expect(renderer!.root.findByProps({ children: 'Dalam 150 m' })).toBeTruthy();
    expect(renderer!.root.findByProps({ children: 'Belok kanan' })).toBeTruthy();
    expect(renderer!.root.findByProps({ children: 'Lalu' })).toBeTruthy();
    expect(renderer!.root.findByProps({ children: '±5m' })).toBeTruthy();
  });

  test('displays upcoming climb warning with gradient percentage and category', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <NavigationGuidanceBanner
          instruction={turnInstruction}
          climbAlert={upcomingClimb}
        />,
      );
    });

    expect(renderer!.root.findByProps({ children: 'PERINGATAN TANJAKAN' })).toBeTruthy();
    expect(renderer!.root.findByProps({ children: '+7.8%' })).toBeTruthy();
    expect(renderer!.root.findByProps({ children: 'Tanjakan sedang' })).toBeTruthy();
    expect(renderer!.root.findByProps({ children: '250 m' })).toBeTruthy();
  });

  test('supports collapsing to ultra-compact bar and expanding back', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <NavigationGuidanceBanner
          instruction={turnInstruction}
          climbAlert={noClimb}
        />,
      );
    });

    // Tap collapse button
    ReactTestRenderer.act(() => {
      renderer!.root.findByProps({ accessibilityLabel: 'Perkecil panduan' }).props.onPress();
    });

    expect(renderer!.root.findByProps({ accessibilityLabel: 'Buka panduan navigasi' })).toBeTruthy();
    expect(renderer!.root.findByProps({ children: '150 m · Belok kanan' })).toBeTruthy();

    // Tap to expand again
    ReactTestRenderer.act(() => {
      renderer!.root.findByProps({ accessibilityLabel: 'Buka panduan navigasi' }).props.onPress();
    });

    expect(renderer!.root.findByProps({ children: 'Dalam 150 m' })).toBeTruthy();
  });
});
