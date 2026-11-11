import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { RideDashboard } from '../src/features/ride/RideDashboard';
import type { RideSnapshot } from '../src/features/ride/useRideTracking';
import type { ClimbAlertState } from '../src/domain/routes/elevation/routeElevationAnalysis';

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

const activeRide: RideSnapshot = {
  status: 'active',
  speedMetersPerSecond: 5,
  elevationMeters: 412,
  elevationSource: 'barometer_gps',
  distanceMeters: 2500,
  ascentMeters: 83,
  descentMeters: 12,
  elevationDataAvailable: true,
  durationSeconds: 1800,
  movingSeconds: 1500,
  horizontalAccuracyMeters: 7,
  lastFixAt: new Date().toISOString(),
  pointCount: 50,
};

test('switches ride pages while keeping recording controls and errors visible', async () => {
  const onPause = jest.fn();
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <RideDashboard
        ride={activeRide}
        busy={false}
        error="Masalah penyimpanan"
        following
        onRecenter={jest.fn()}
        onZoomIn={jest.fn()}
        onZoomOut={jest.fn()}
        onPause={onPause}
        onResume={jest.fn()}
        onFinish={jest.fn()}
      />,
    );
  });

  await ReactTestRenderer.act(() => {
    renderer!.root.findByProps({ accessibilityLabel: 'Halaman Data' }).props.onPress();
  });
  expect(renderer!.root.findByProps({ testID: 'ride-data-page' })).toBeTruthy();
  expect(renderer!.root.findByProps({ children: 'Masalah penyimpanan' })).toBeTruthy();
  await ReactTestRenderer.act(() => {
    renderer!.root.findByProps({ accessibilityLabel: 'Jeda' }).props.onPress();
    renderer!.root.findByProps({ accessibilityLabel: 'Halaman Tanjakan' }).props.onPress();
  });
  expect(onPause).toHaveBeenCalledTimes(1);
  expect(renderer!.root.findByProps({ testID: 'ride-climb-page' })).toBeTruthy();
  expect(renderer!.root.findByProps({ children: 'Belum ada tanjakan tersedia' })).toBeTruthy();
  expect(renderer!.root.findByProps({ accessibilityLabel: 'Selesai' })).toBeTruthy();
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('shows estimated power only while the GPS sample is fresh', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  const controls = { onRecenter: jest.fn(), onZoomIn: jest.fn(), onZoomOut: jest.fn(), onPause: jest.fn(), onResume: jest.fn(), onFinish: jest.fn() };
  const ride = { ...activeRide, lastFixAt: new Date().toISOString(), virtualPowerMassKg: 85, virtualPowerWatts: 151.7 };
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<RideDashboard ride={ride} busy={false} error={null} following {...controls} />);
  });
  await ReactTestRenderer.act(() => { renderer!.root.findByProps({ accessibilityLabel: 'Halaman Data' }).props.onPress(); });
  expect(renderer!.root.findByProps({ label: 'Power · estimasi' }).props.value).toBe('152 W');
  await ReactTestRenderer.act(() => { renderer!.root.findByProps({ accessibilityLabel: 'Halaman Peta' }).props.onPress(); });
  expect(renderer!.root.findByProps({ testID: 'ride-map-power' }).props.children[0]).toBe(152);
  await ReactTestRenderer.act(() => {
    renderer!.update(<RideDashboard ride={{ ...ride, lastFixAt: new Date(Date.now() - 120_000).toISOString() }} busy={false} error={null} following {...controls} />);
  });
  expect(renderer!.root.findByProps({ testID: 'ride-map-power' }).props.children[0]).toBe('—');
  await ReactTestRenderer.act(() => { renderer!.root.findByProps({ accessibilityLabel: 'Halaman Data' }).props.onPress(); });
  expect(renderer!.root.findByProps({ label: 'Power · estimasi' }).props.value).toBe('—');
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('keeps heart rate and estimated power visible alongside a terrain climb', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<RideDashboard ride={{ ...activeRide, lastFixAt: new Date().toISOString(), terrainClimbStatus: 'upcoming', terrainClimbDistanceToStartMeters: 150, virtualPowerMassKg: 85, virtualPowerWatts: 180, watchHeartRateEnabled: true, heartRateBpm: 143, heartRateRecordedAt: new Date().toISOString() }} busy={false} error={null} following onRecenter={jest.fn()} onZoomIn={jest.fn()} onZoomOut={jest.fn()} onPause={jest.fn()} onResume={jest.fn()} onFinish={jest.fn()} />);
  });
  await ReactTestRenderer.act(() => { renderer!.root.findByProps({ accessibilityLabel: 'Halaman Tanjakan' }).props.onPress(); });
  expect(renderer!.root.findByProps({ label: 'Power · estimasi' }).props.value).toBe('180 W');
  expect(renderer!.root.findByProps({ label: 'HR · Watch 5' }).props.value).toBe('143 bpm');
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('moves from map to data after a horizontal swipe', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <RideDashboard ride={activeRide} busy={false} error={null} following
        onRecenter={jest.fn()} onZoomIn={jest.fn()} onZoomOut={jest.fn()}
        onPause={jest.fn()} onResume={jest.fn()} onFinish={jest.fn()} />,
    );
  });
  const swipeArea = renderer!.root.findByProps({ testID: 'ride-page-swipe' });
  await ReactTestRenderer.act(() => {
    swipeArea.props.onTouchStart({ nativeEvent: { pageX: 180, pageY: 100 } });
    swipeArea.props.onTouchEnd({ nativeEvent: { pageX: 130, pageY: 240 } });
  });
  expect(renderer!.root.findAllByProps({ testID: 'ride-data-page' })).toHaveLength(0);
  await ReactTestRenderer.act(() => {
    swipeArea.props.onTouchStart({ nativeEvent: { pageX: 180, pageY: 100 } });
    swipeArea.props.onTouchEnd({ nativeEvent: { pageX: 40, pageY: 102 } });
  });
  expect(renderer!.root.findByProps({ testID: 'ride-data-page' })).toBeTruthy();
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('shows recorded ride metrics and working ride controls', async () => {
  const onPause = jest.fn();
  const onFinish = jest.fn();
  const onRecenter = jest.fn();
  let renderer: ReactTestRenderer.ReactTestRenderer;

  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <RideDashboard
        ride={activeRide}
        busy={false}
        error={null}
        following={false}
        onRecenter={onRecenter}
        onZoomIn={jest.fn()}
        onZoomOut={jest.fn()}
        onPause={onPause}
        onResume={jest.fn()}
        onFinish={onFinish}
      />,
    );
  });

  expect(renderer!.root.findByProps({ children: '18,0' })).toBeTruthy();
  expect(renderer!.root.findByProps({ testID: 'ride-average-speed' }).props.children)
    .toBe('Rata-rata 6,0 km/j');
  expect(renderer!.root.findByProps({ children: '412 m' })).toBeTruthy();
  expect(renderer!.root.findByProps({ children: '2,5 km' })).toBeTruthy();

  await ReactTestRenderer.act(() => {
    renderer!.root.findByProps({ accessibilityLabel: 'Pusatkan' }).props.onPress();
    renderer!.root.findByProps({ accessibilityLabel: 'Jeda' }).props.onPress();
    renderer!.root.findByProps({ accessibilityLabel: 'Selesai' }).props.onPress();
    renderer!.root.findAllByProps({ accessibilityLabel: 'Perluas panel perjalanan' })[0]!.props.onPress();
  });

  expect(onRecenter).toHaveBeenCalledTimes(1);
  expect(onPause).toHaveBeenCalledTimes(1);
  expect(onFinish).toHaveBeenCalledTimes(1);
  expect(renderer!.root.findByProps({ children: 'Akurasi GPS' })).toBeTruthy();
  expect(renderer!.root.findByProps({ testID: 'ride-average-speed' })).toBeTruthy();
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('distinguishes relative barometer readings and barometer errors from GPS altitude', async () => {
  const dashboardProps = {
    ride: {
      ...activeRide,
      elevationSource: 'gps' as const,
      relativeElevationMeters: 2.4,
      barometerStatus: 'active' as const,
    },
    busy: false,
    error: null,
    following: false,
    onRecenter: jest.fn(),
    onZoomIn: jest.fn(),
    onZoomOut: jest.fn(),
    onPause: jest.fn(),
    onResume: jest.fn(),
    onFinish: jest.fn(),
  };
  let renderer: ReactTestRenderer.ReactTestRenderer;

  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<RideDashboard {...dashboardProps} />);
  });
  expect(renderer!.root.findByProps({ children: 'GPS absolut · baro relatif' })).toBeTruthy();
  expect(renderer!.root.findByProps({ children: 'GPS' })).toBeTruthy();
  expect(renderer!.root.findByProps({ testID: 'ride-relative-elevation' }).props.children.join('')).toBe('Baro Δ +2,4 m');

  await ReactTestRenderer.act(() => {
    renderer!.update(
      <RideDashboard
        {...dashboardProps}
        ride={{ ...dashboardProps.ride, barometerStatus: 'simulated' }}
      />,
    );
  });
  expect(renderer!.root.findByProps({ children: 'Barometer simulasi' })).toBeTruthy();

  await ReactTestRenderer.act(() => {
    renderer!.update(
      <RideDashboard
        {...dashboardProps}
        ride={{ ...dashboardProps.ride, relativeElevationMeters: null }}
      />,
    );
  });
  expect(renderer!.root.findByProps({ children: 'GPS · barometer aktif' })).toBeTruthy();

  await ReactTestRenderer.act(() => {
    renderer!.update(
      <RideDashboard
        {...dashboardProps}
        ride={{ ...dashboardProps.ride, relativeElevationMeters: null, barometerStatus: 'error' }}
      />,
    );
  });
  expect(renderer!.root.findByProps({ children: 'GPS · barometer gagal' })).toBeTruthy();

  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('supports toggling 3D POV perspective mode', async () => {
  const onTogglePov = jest.fn();
  let renderer: ReactTestRenderer.ReactTestRenderer;

  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <RideDashboard
        ride={activeRide}
        busy={false}
        error={null}
        following={true}
        povMode="3d"
        onTogglePov={onTogglePov}
        onRecenter={jest.fn()}
        onZoomIn={jest.fn()}
        onZoomOut={jest.fn()}
        onPause={jest.fn()}
        onResume={jest.fn()}
        onFinish={jest.fn()}
      />,
    );
  });

  const povButton = renderer!.root.findByProps({
    accessibilityLabel: 'Ganti ke pandangan 2D utara',
  });
  expect(povButton).toBeTruthy();

  await ReactTestRenderer.act(() => {
    povButton.props.onPress();
  });

  expect(onTogglePov).toHaveBeenCalledTimes(1);
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('shows missing elevation instead of zero ascent and descent', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;

  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <RideDashboard
        ride={{ ...activeRide, elevationDataAvailable: false, ascentMeters: 0, descentMeters: 0 }}
        busy={false}
        error={null}
        following={false}
        onRecenter={jest.fn()}
        onZoomIn={jest.fn()}
        onZoomOut={jest.fn()}
        onPause={jest.fn()}
        onResume={jest.fn()}
        onFinish={jest.fn()}
      />,
    );
  });

  expect(renderer!.root.findByProps({ children: '— m' })).toBeTruthy();
  await ReactTestRenderer.act(() => {
    renderer!.root.findByProps({ accessibilityLabel: 'Perluas panel perjalanan' }).props.onPress();
  });
  expect(renderer!.root.findAllByProps({ children: '— m' }).length).toBeGreaterThanOrEqual(2);
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('shows no average speed until both distance and moving time are available', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <RideDashboard
        ride={{ ...activeRide, distanceMeters: 0, movingSeconds: 0 }}
        busy={false}
        error={null}
        following={true}
        onRecenter={jest.fn()}
        onZoomIn={jest.fn()}
        onZoomOut={jest.fn()}
        onPause={jest.fn()}
        onResume={jest.fn()}
        onFinish={jest.fn()}
      />,
    );
  });

  expect(renderer!.root.findByProps({ testID: 'ride-average-speed' }).props.children)
    .toBe('Rata-rata —');
  await ReactTestRenderer.act(() => {
    renderer!.root.findByProps({ accessibilityLabel: 'Perkecil panel perjalanan' }).props.onPress();
  });
  expect(renderer!.root.findByProps({ testID: 'ride-average-speed' }).props.children)
    .toBe('—');
  expect(renderer!.root.findByProps({ testID: 'ride-average-speed' }).props.accessibilityLabel)
    .toBe('Rata-rata —');
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('keeps speed on one line and only shows a fresh heart rate in the minimized panel', async () => {
  jest.useFakeTimers();
  let renderer: ReactTestRenderer.ReactTestRenderer;
  const ride = { ...activeRide, lastFixAt: new Date().toISOString(), watchHeartRateEnabled: true, heartRateBpm: 143, heartRateRecordedAt: new Date().toISOString() };
  const controls = { onRecenter: jest.fn(), onZoomIn: jest.fn(), onZoomOut: jest.fn(), onPause: jest.fn(), onResume: jest.fn(), onFinish: jest.fn() };
  await ReactTestRenderer.act(() => { renderer = ReactTestRenderer.create(<RideDashboard ride={ride} busy={false} error={null} following {...controls} />); });
  await ReactTestRenderer.act(() => { renderer!.root.findByProps({ accessibilityLabel: 'Perkecil panel perjalanan' }).props.onPress(); });
  expect(renderer!.root.findByProps({ testID: 'minimized-speed' }).props.numberOfLines).toBe(1);
  expect(renderer!.root.findByProps({ testID: 'minimized-speed' }).props.children[0]).toBe('18,0');
  expect(renderer!.root.findByProps({ testID: 'minimized-heart-rate' }).props.children[0]).toBe(143);
  expect(renderer!.root.findByProps({ accessibilityLabel: 'Jeda' })).toBeTruthy();
  await ReactTestRenderer.act(() => { jest.advanceTimersByTime(16000); });
  expect(renderer!.root.findByProps({ testID: 'minimized-heart-rate' }).props.children[0]).toBe('—');
  expect(renderer!.root.findByProps({ accessibilityLabel: 'Heart rate tidak tersedia' })).toBeTruthy();
  await ReactTestRenderer.act(() => {
    renderer!.update(<RideDashboard ride={{ ...ride, autoPaused: true, heartRateRecordedAt: new Date().toISOString() }} busy={false} error={null} following {...controls} />);
  });
  expect(renderer!.root.findByProps({ accessibilityLabel: 'Heart rate dijeda' })).toBeTruthy();
  expect(renderer!.root.findByProps({ testID: 'minimized-heart-rate' }).props.children[0]).toBe('—');
  await ReactTestRenderer.act(() => {
    renderer!.update(<RideDashboard ride={{ ...ride, status: 'paused' }} busy={false} error={null} following {...controls} />);
  });
  expect(renderer!.root.findByProps({ accessibilityLabel: 'Heart rate dijeda' })).toBeTruthy();
  await ReactTestRenderer.act(() => {
    renderer!.update(<RideDashboard ride={{ ...ride, watchHeartRateEnabled: false }} busy={false} error={null} following {...controls} />);
  });
  expect(renderer!.root.findByProps({ accessibilityLabel: 'Heart rate tidak aktif' })).toBeTruthy();
  await ReactTestRenderer.act(() => {
    renderer!.update(<RideDashboard ride={{ ...ride, watchHeartRateStatus: 'disconnected', heartRateBpm: null, heartRateRecordedAt: null }} busy={false} error={null} following {...controls} />);
  });
  expect(renderer!.root.findByProps({ children: 'HR TERPUTUS' })).toBeTruthy();
  await ReactTestRenderer.act(() => renderer!.unmount());
  jest.useRealTimers();
});

test('stops the dashboard clock while covered and restores the expanded panel on return', async () => {
  jest.useFakeTimers();
  let screen!: ReactTestRenderer.ReactTestRenderer;
  const controls = {
    onRecenter: jest.fn(), onZoomIn: jest.fn(), onZoomOut: jest.fn(),
    onPause: jest.fn(), onResume: jest.fn(), onFinish: jest.fn(),
  };
  const renderDashboard = (visible: boolean) => (
    <RideDashboard ride={activeRide} busy={false} error={null} following={true} visible={visible} {...controls} />
  );
  await ReactTestRenderer.act(() => { screen = ReactTestRenderer.create(renderDashboard(true)); });
  await ReactTestRenderer.act(() => {
    screen.root.findByProps({ accessibilityLabel: 'Perluas panel perjalanan' }).props.onPress();
  });
  const activeTimerCount = jest.getTimerCount();
  await ReactTestRenderer.act(() => { screen.update(renderDashboard(false)); });
  expect(screen.toJSON()).toBeNull();
  expect(jest.getTimerCount()).toBeLessThan(activeTimerCount);
  await ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(15000);
    screen.update(renderDashboard(true));
  });
  expect(screen.root.findByProps({ children: 'Akurasi GPS' })).toBeTruthy();
  await ReactTestRenderer.act(() => screen.unmount());
  jest.useRealTimers();
});

test('displays live gradient and climb status during navigation', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;

  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <RideDashboard
        ride={activeRide}
        busy={false}
        error={null}
        following={true}
        currentGrade={7.2}
        currentGradeSource="barometer"
        climbAlert={{
          type: 'active',
          climbIndex: 2,
          totalClimbs: 3,
          distanceRemainingMeters: 600,
          gainRemainingMeters: 45,
          progressPercent: 55,
          currentGradePercent: 7.2,
          currentElevationMeters: 380,
          climb: {
            id: 2,
            startDistanceMeters: 1000,
            endDistanceMeters: 2200,
            distanceMeters: 1200,
            elevationGainMeters: 80,
            averageGradePercent: 6.7,
            maxGradePercent: 11.0,
            startElevationMeters: 300,
            endElevationMeters: 380,
            startCoordinate: [115.2, -8.6],
            endCoordinate: [115.21, -8.61],
          },
        }}
        onRecenter={jest.fn()}
        onZoomIn={jest.fn()}
        onZoomOut={jest.fn()}
        onPause={jest.fn()}
        onResume={jest.fn()}
        onFinish={jest.fn()}
      />,
    );
  });

  expect(renderer!.root.findByProps({ testID: 'ride-live-grade' }).props.children).toBe('+7.2%');
  expect(renderer!.root.findByProps({ children: 'Tanjakan sedang · barometer' })).toBeTruthy();

  await ReactTestRenderer.act(() => {
    renderer!.root.findByProps({ accessibilityLabel: 'Perluas panel perjalanan' }).props.onPress();
  });

  expect(renderer!.root.findByProps({ children: 'T2/3 (Aktif)' })).toBeTruthy();
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('shows offline free-ride climb guidance and suppresses it while paused or route-guided', async () => {
  const rideWithUpcomingClimb: RideSnapshot = {
    ...activeRide,
    lastFixAt: new Date().toISOString(),
    terrainClimbStatus: 'upcoming',
    terrainClimbDistanceToStartMeters: 450,
    terrainClimbDistanceMeters: 820,
    terrainClimbElevationGainMeters: 74,
    terrainClimbAverageGradePercent: 6.4,
    terrainClimbMaxGradePercent: 11.2,
    terrainClimbProfileQuality: 'complete',
  };
  let renderer: ReactTestRenderer.ReactTestRenderer;

  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <RideDashboard
        ride={rideWithUpcomingClimb}
        busy={false}
        error={null}
        following={true}
        onRecenter={jest.fn()}
        onZoomIn={jest.fn()}
        onZoomOut={jest.fn()}
        onPause={jest.fn()}
        onResume={jest.fn()}
        onFinish={jest.fn()}
      />,
    );
  });

  expect(renderer!.root.findByProps({ testID: 'offline-terrain-climb-alert' })).toBeTruthy();
  expect(renderer!.root.findByProps({ children: 'Tanjakan di depan' })).toBeTruthy();
  expect(renderer!.root.findByProps({ children: '450 m lagi' })).toBeTruthy();
  expect(renderer!.root.findByProps({ children: 'Profil medan offline lengkap' })).toBeTruthy();
  for (const page of ['Data', 'Tanjakan', 'Peta']) {
    await ReactTestRenderer.act(() => {
      renderer!.root.findByProps({ accessibilityLabel: `Halaman ${page}` }).props.onPress();
    });
    expect(renderer!.root.findByProps({ testID: 'offline-terrain-climb-alert' })).toBeTruthy();
  }

  await ReactTestRenderer.act(() => {
    renderer!.root.findByProps({ accessibilityLabel: 'Perkecil panel perjalanan' }).props.onPress();
  });
  expect(renderer!.root.findByProps({ testID: 'minimized-terrain-climb-alert' }).props.children).toBe('Tanjakan 450 m lagi · +6.4%');
  await ReactTestRenderer.act(() => {
    renderer!.root.findAllByProps({ accessibilityLabel: 'Perluas panel perjalanan' })[0]!.props.onPress();
  });

  await ReactTestRenderer.act(() => {
    renderer!.update(
      <RideDashboard
        ride={{ ...rideWithUpcomingClimb, forwardPathQuality: 'inferred_to_boundary' }}
        busy={false}
        error={null}
        following={true}
        onRecenter={jest.fn()}
        onZoomIn={jest.fn()}
        onZoomOut={jest.fn()}
        onPause={jest.fn()}
        onResume={jest.fn()}
        onFinish={jest.fn()}
      />,
    );
  });
  expect(renderer!.root.findByProps({ children: 'Perkiraan jalur · profil lengkap' })).toBeTruthy();

  await ReactTestRenderer.act(() => {
    renderer!.update(
      <RideDashboard
        ride={{ ...rideWithUpcomingClimb, lastFixAt: new Date(Date.now() - 12000).toISOString() }}
        busy={false}
        error={null}
        following={true}
        onRecenter={jest.fn()}
        onZoomIn={jest.fn()}
        onZoomOut={jest.fn()}
        onPause={jest.fn()}
        onResume={jest.fn()}
        onFinish={jest.fn()}
      />,
    );
  });
  expect(renderer!.root.findAllByProps({ testID: 'offline-terrain-climb-alert' })).toHaveLength(0);

  await ReactTestRenderer.act(() => {
    renderer!.update(
      <RideDashboard
        ride={{ ...rideWithUpcomingClimb, autoPaused: true }}
        busy={false}
        error={null}
        following={true}
        onRecenter={jest.fn()}
        onZoomIn={jest.fn()}
        onZoomOut={jest.fn()}
        onPause={jest.fn()}
        onResume={jest.fn()}
        onFinish={jest.fn()}
      />,
    );
  });
  expect(renderer!.root.findAllByProps({ testID: 'offline-terrain-climb-alert' })).toHaveLength(0);

  await ReactTestRenderer.act(() => {
    renderer!.update(
      <RideDashboard
        ride={rideWithUpcomingClimb}
        busy={false}
        error={null}
        following={true}
        climbAlert={{
          type: 'upcoming',
          climbIndex: 1,
          totalClimbs: 2,
          distanceToStartMeters: 400,
          currentGradePercent: 1.2,
          currentElevationMeters: 100,
          climb: {
            id: 1,
            startDistanceMeters: 1000,
            endDistanceMeters: 1800,
            distanceMeters: 800,
            elevationGainMeters: 48,
            averageGradePercent: 6,
            maxGradePercent: 9,
            startElevationMeters: 100,
            endElevationMeters: 148,
            startCoordinate: [115.2, -8.6],
            endCoordinate: [115.21, -8.61],
          },
        }}
        onRecenter={jest.fn()}
        onZoomIn={jest.fn()}
        onZoomOut={jest.fn()}
        onPause={jest.fn()}
        onResume={jest.fn()}
        onFinish={jest.fn()}
      />,
    );
  });
  expect(renderer!.root.findAllByProps({ testID: 'offline-terrain-climb-alert' })).toHaveLength(0);
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('hides stale HR without waiting for another watch notification', async () => {
  jest.useFakeTimers();
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <RideDashboard
        ride={{ ...activeRide, watchHeartRateEnabled: true, watchHeartRateStatus: 'active', heartRateBpm: 92, heartRateRecordedAt: new Date().toISOString() }}
        busy={false} error={null} following={true}
        onRecenter={jest.fn()} onZoomIn={jest.fn()} onZoomOut={jest.fn()}
        onPause={jest.fn()} onResume={jest.fn()} onFinish={jest.fn()}
      />,
    );
  });
  expect(renderer!.root.findByProps({ testID: 'ride-heart-rate' }).props.children[0]).toBe(92);
  await ReactTestRenderer.act(() => { jest.advanceTimersByTime(16000); });
  expect(renderer!.root.findByProps({ testID: 'ride-heart-rate' }).props.children[0]).toBe('—');
  await ReactTestRenderer.act(() => renderer!.unmount());
  jest.useRealTimers();
});

test('does not present a cached HR as live while the ride is paused', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <RideDashboard
        ride={{ ...activeRide, status: 'paused', watchHeartRateEnabled: true, heartRateBpm: 92, heartRateRecordedAt: new Date().toISOString() }}
        busy={false} error={null} following={true}
        onRecenter={jest.fn()} onZoomIn={jest.fn()} onZoomOut={jest.fn()}
        onPause={jest.fn()} onResume={jest.fn()} onFinish={jest.fn()}
      />,
    );
  });
  expect(renderer!.root.findByProps({ testID: 'ride-heart-rate' }).props.children[0]).toBe('—');
  expect(renderer!.root.findByProps({ children: 'HR dijeda' })).toBeTruthy();
  expect(renderer!.root.findByProps({ children: '0,0' })).toBeTruthy();
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('holds speed across transient GPS gaps and drops to dash only after stale GPS timeout', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <RideDashboard
        ride={{ ...activeRide, status: 'active', speedMetersPerSecond: 0.555, lastFixAt: new Date().toISOString() }}
        busy={false} error={null} following={true}
        onRecenter={jest.fn()} onZoomIn={jest.fn()} onZoomOut={jest.fn()}
        onPause={jest.fn()} onResume={jest.fn()} onFinish={jest.fn()}
      />,
    );
  });
  // 0.555 m/s * 3.6 ≈ 2.0 km/h
  expect(renderer!.root.findByProps({ children: '2,0' })).toBeTruthy();

  // Next snapshot arrives with speedMetersPerSecond null but lastFixAt within 10s
  await ReactTestRenderer.act(() => {
    renderer!.update(
      <RideDashboard
        ride={{ ...activeRide, status: 'active', speedMetersPerSecond: null, lastFixAt: new Date(Date.now() - 3000).toISOString() }}
        busy={false} error={null} following={true}
        onRecenter={jest.fn()} onZoomIn={jest.fn()} onZoomOut={jest.fn()}
        onPause={jest.fn()} onResume={jest.fn()} onFinish={jest.fn()}
      />,
    );
  });
  // Should hold 2,0 rather than flickering to '—'
  expect(renderer!.root.findByProps({ children: '2,0' })).toBeTruthy();

  // If GPS is truly stale (> 10s), speed drops to '—'
  await ReactTestRenderer.act(() => {
    renderer!.update(
      <RideDashboard
        ride={{ ...activeRide, status: 'active', speedMetersPerSecond: null, lastFixAt: new Date(Date.now() - 12000).toISOString() }}
        busy={false} error={null} following={true}
        onRecenter={jest.fn()} onZoomIn={jest.fn()} onZoomOut={jest.fn()}
        onPause={jest.fn()} onResume={jest.fn()} onFinish={jest.fn()}
      />,
    );
  });
  expect(renderer!.root.findAllByProps({ children: '2,0' })).toHaveLength(0);
  expect(renderer!.root.findAllByProps({ children: '—' }).length).toBeGreaterThanOrEqual(1);
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('keeps speed and HR visible when a fresh snapshot arrives between clock ticks', async () => {
  jest.useFakeTimers();
  const initialTime = Date.now();
  const controls = { onRecenter: jest.fn(), onZoomIn: jest.fn(), onZoomOut: jest.fn(), onPause: jest.fn(), onResume: jest.fn(), onFinish: jest.fn() };
  let renderer: ReactTestRenderer.ReactTestRenderer;
  const initialRide = { ...activeRide, lastFixAt: new Date(initialTime).toISOString(), watchHeartRateEnabled: true, heartRateBpm: 140, heartRateRecordedAt: new Date(initialTime).toISOString() };
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<RideDashboard ride={initialRide} busy={false} error={null} following {...controls} />);
  });
  await ReactTestRenderer.act(() => { renderer!.root.findByProps({ accessibilityLabel: 'Perkecil panel perjalanan' }).props.onPress(); });
  jest.setSystemTime(initialTime + 500);
  const nextTimestamp = new Date(initialTime + 500).toISOString();
  await ReactTestRenderer.act(() => {
    renderer!.update(<RideDashboard ride={{ ...initialRide, speedMetersPerSecond: 6.5, lastFixAt: nextTimestamp, heartRateBpm: 143, heartRateRecordedAt: nextTimestamp }} busy={false} error={null} following {...controls} />);
  });
  expect(renderer!.root.findByProps({ testID: 'minimized-speed' }).props.children[0]).toBe('23,4');
  expect(renderer!.root.findByProps({ testID: 'minimized-heart-rate' }).props.children[0]).toBe(143);
  await ReactTestRenderer.act(() => { jest.advanceTimersByTime(11_000); });
  expect(renderer!.root.findByProps({ testID: 'minimized-speed' }).props.children[0]).toBe('—');
  await ReactTestRenderer.act(() => renderer!.unmount());
  jest.useRealTimers();
});



test('shows automatic pause as a pause while the recording session stays active', async () => {
  let screen!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    screen = ReactTestRenderer.create(
      <RideDashboard ride={{ ...activeRide, status: 'active', autoPaused: true }} busy={false} error={null} following onRecenter={jest.fn()} onZoomIn={jest.fn()} onZoomOut={jest.fn()} onPause={jest.fn()} onResume={jest.fn()} onFinish={jest.fn()} />,
    );
  });
  expect(screen.root.findByProps({ children: 'Jeda otomatis · menunggu gerak' })).toBeTruthy();
  await ReactTestRenderer.act(() => screen.unmount());
});


test('shows remaining ascent for an active climb and a dash when it is unavailable', async () => {
  const climbAlert: ClimbAlertState = {
    type: 'active', climbIndex: 1, totalClimbs: 1, distanceRemainingMeters: 400,
    gainRemainingMeters: 35, progressPercent: 50, currentGradePercent: 6,
    currentElevationMeters: 150,
    climb: { id: 1, startDistanceMeters: 0, endDistanceMeters: 800, distanceMeters: 800,
      elevationGainMeters: 70, averageGradePercent: 8, maxGradePercent: 12,
      startElevationMeters: 100, endElevationMeters: 170,
      startCoordinate: [115.2, -8.6], endCoordinate: [115.21, -8.61] },
  };
  let screen!: ReactTestRenderer.ReactTestRenderer;
  const renderDashboard = (alert: ClimbAlertState) => (
    <RideDashboard ride={activeRide} busy={false} error={null} following climbAlert={alert}
      onRecenter={jest.fn()} onZoomIn={jest.fn()} onZoomOut={jest.fn()}
      onPause={jest.fn()} onResume={jest.fn()} onFinish={jest.fn()} />
  );
  await ReactTestRenderer.act(() => { screen = ReactTestRenderer.create(renderDashboard(climbAlert)); });
  await ReactTestRenderer.act(() => screen.root.findByProps({ accessibilityLabel: 'Halaman Tanjakan' }).props.onPress());
  expect(screen.root.findByProps({ children: 'Profil elevasi belum tersedia.' })).toBeTruthy();
  expect(screen.root.findByProps({ children: 'Sisa naik' })).toBeTruthy();
  expect(screen.root.findByProps({ children: '+35 m' })).toBeTruthy();
  await ReactTestRenderer.act(() => screen.update(renderDashboard({ ...climbAlert, gainRemainingMeters: null })));
  expect(screen.root.findByProps({ children: '—' })).toBeTruthy();
  await ReactTestRenderer.act(() => screen.unmount());
});
