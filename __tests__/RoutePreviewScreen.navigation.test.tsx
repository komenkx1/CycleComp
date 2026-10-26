import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import type { GpxRoute } from '../src/domain/routes/gpx/GpxRoute';
import { Alert, AppState } from 'react-native';
import { RoutePreviewScreen } from '../src/features/routes/RoutePreviewScreen';

const mockRequestLocationPermission = jest.fn();
const mockPickAndImportGpxRoute = jest.fn();
const mockAddLocationListener = jest.fn();
const mockRemoveLocationListener = jest.fn();
const mockDownloadArea = jest.fn();
const mockUpdateArea = jest.fn();
const mockDeleteArea = jest.fn();
const mockStartRide = jest.fn();
const mockSetSensorDiagnosticsEnabled = jest.fn();
const mockMapUnproject = jest.fn(async ([x, y]: [number, number]) => [
  115 + x / 10_000,
  -8 - y / 10_000,
] as [number, number]);
const renderedScreens: ReactTestRenderer.ReactTestRenderer[] = [];
let mockRideState: {
  rideSnapshot: { status: 'idle' | 'active'; lastCoordinate?: [number, number]; pointCount?: number; sensorDiagnosticsEnabled?: boolean };
  trackSegments: [number, number][][];
} = { rideSnapshot: { status: 'idle' }, trackSegments: [] };
let mockMapPackState: { status: 'ready'; downloadedBytes: number } | { status: 'missing' } = {
  status: 'ready',
  downloadedBytes: 20 * 1024 * 1024,
};

jest.mock('@maplibre/maplibre-react-native', () => {
  const ReactModule = jest.requireActual('react');
  const { View: NativeView } = jest.requireActual('react-native');
  const MapContainer = ReactModule.forwardRef((
    { children, ...props }: { children?: React.ReactNode },
    ref: React.Ref<unknown>,
  ) => {
    ReactModule.useImperativeHandle(ref, () => ({
      unproject: (point: [number, number]) => mockMapUnproject(point),
    }));
    return ReactModule.createElement(NativeView, { testID: 'route-map', ...props }, children);
  });

  return {
    Camera: ReactModule.forwardRef((props: object, ref: React.Ref<unknown>) => {
      ReactModule.useImperativeHandle(ref, () => ({ setStop: () => Promise.resolve() }));
      return ReactModule.createElement(NativeView, { testID: 'route-camera', ...props });
    }),
    GeoJSONSource: MapContainer,
    Layer: (props: object) => ReactModule.createElement(NativeView, props),
    LocationManager: {
      requestPermissions: () => mockRequestLocationPermission(),
      addListener: (listener: (location: { coords: { longitude: number; latitude: number; accuracy: number } }) => void) =>
        mockAddLocationListener(listener),
      removeListener: (listener: (location: { coords: { longitude: number; latitude: number; accuracy: number } }) => void) =>
        mockRemoveLocationListener(listener),
    },
    Map: MapContainer,
    NativeUserLocation: (props: object) =>
      ReactModule.createElement(NativeView, { testID: 'user-location-dot', ...props }),
  };
});

jest.mock('../src/features/routes/importGpxRoute', () => ({
  GpxImportCanceledError: class GpxImportCanceledError extends Error {},
  pickAndImportGpxRoute: () => mockPickAndImportGpxRoute(),
}));

jest.mock('../src/features/elevation/TerrainPackManager', () => ({
  TerrainPackManager: () => null,
}));

jest.mock('../src/features/ride/useRideTracking', () => ({
  useRideTracking: () => ({
    ...mockRideState,
    lastFinishedRide: null,
    rideError: null,
    rideBusy: false,
    rideChecking: false,
    startRide: mockStartRide,
    setSensorDiagnosticsEnabled: mockSetSensorDiagnosticsEnabled,
    pauseRide: jest.fn(),
    resumeRide: jest.fn(),
    finishRide: jest.fn(),
    shareFinishedRide: jest.fn(),
    dismissFinishedRide: jest.fn(),
    setKeepScreenOn: jest.fn(),
  }),
}));

jest.mock('../src/features/maps/useOfflineMapPacks', () => ({
  useOfflineMapPacks: () => ({
    savedMapAreas: mockMapPackState.status === 'ready'
      ? [{
          id: 'saved-area',
          bounds: [115.1091, -8.69713, 115.24081, -8.339159],
          status: 'ready',
          percentage: 100,
          downloadedBytes: mockMapPackState.downloadedBytes,
        }]
      : [],
    mapPackCheck: 'done',
    mapPackError: null,
    downloadArea: mockDownloadArea,
    pauseArea: jest.fn(),
    resumeArea: jest.fn(),
    updateArea: mockUpdateArea,
    deleteArea: mockDeleteArea,
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View: NativeView } = jest.requireActual('react-native');

  return { SafeAreaView: NativeView, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

const importedRoute: GpxRoute = {
  name: 'Jatiluwih',
  sourceFileName: 'jatiluwih.gpx',
  segments: [
    {
      points: [
        { coordinate: [115.21535, -8.67567], elevationMeters: 10 },
        { coordinate: [115.20751, -8.63886], elevationMeters: 20 },
      ],
    },
  ],
  bounds: [115.20751, -8.67567, 115.21535, -8.63886],
  distanceMeters: 5000,
  pointCount: 2,
  elevationPointCount: 2,
  minimumElevationMeters: 10,
  maximumElevationMeters: 20,
};

beforeEach(() => {
  mockMapPackState = { status: 'ready', downloadedBytes: 20 * 1024 * 1024 };
  mockRequestLocationPermission.mockReset();
  mockPickAndImportGpxRoute.mockReset();
  mockAddLocationListener.mockReset();
  mockRemoveLocationListener.mockReset();
  mockDownloadArea.mockReset();
  mockUpdateArea.mockReset();
  mockMapUnproject.mockClear();
  mockStartRide.mockReset();
  mockSetSensorDiagnosticsEnabled.mockReset();
  mockRideState = { rideSnapshot: { status: 'idle' }, trackSegments: [] };
  mockPickAndImportGpxRoute.mockResolvedValue(importedRoute);
});

afterEach(async () => {
  await ReactTestRenderer.act(() => {
    for (const screen of renderedScreens) { screen.unmount(); }
  });
  renderedScreens.length = 0;
});

function createScreen() {
  const screen = ReactTestRenderer.create(<RoutePreviewScreen />);
  renderedScreens.push(screen);
  return screen;
}

function selectedBoundsFromLastMapProjection() {
  const projectedSelectorCorners = mockMapUnproject.mock.calls.slice(-4).map(([point]) => [
    115 + point[0] / 10_000,
    -8 - point[1] / 10_000,
  ]);
  const longitudes = projectedSelectorCorners.map(([longitude]) => longitude);
  const latitudes = projectedSelectorCorners.map(([, latitude]) => latitude);
  return [
    Math.min(...longitudes),
    Math.min(...latitudes),
    Math.max(...longitudes),
    Math.max(...latitudes),
  ];
}

test('starts offline recording without an imported GPX', async () => {
  mockRequestLocationPermission.mockResolvedValue(true);
  let screenRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await ReactTestRenderer.act(() => {
    screenRenderer = createScreen();
  });
  await ReactTestRenderer.act(async () => {
    pressButton(screenRenderer!, 'Mulai ride bebas');
  });

  expect(mockRequestLocationPermission).toHaveBeenCalledTimes(1);
  expect(mockStartRide).toHaveBeenCalledTimes(1);
});

test('allows sensor diagnostics to be enabled before a ride', async () => {
  let screenRenderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    screenRenderer = createScreen();
  });
  await ReactTestRenderer.act(() => {
    selectMainTab(screenRenderer!, 'Setelan');
  });

  const diagnosticsSwitch = screenRenderer!.root.findByProps({ accessibilityLabel: 'Rekam diagnostik sensor selama ride' });
  expect(diagnosticsSwitch.props.disabled).toBe(false);
  await ReactTestRenderer.act(() => diagnosticsSwitch.props.onValueChange(true));
  expect(mockSetSensorDiagnosticsEnabled).toHaveBeenCalledWith(true);
});

test('shows the recorded orange track and follows the live position in 3D first-person POV', async () => {
  mockRideState = {
    rideSnapshot: { status: 'active', lastCoordinate: [115.2, -8.6], pointCount: 2 },
    trackSegments: [[[115.19, -8.61], [115.2, -8.6]]],
  };
  let screenRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await ReactTestRenderer.act(() => {
    screenRenderer = createScreen();
  });

  const camera = screenRenderer!.root.findByProps({ testID: 'route-camera' });
  expect(camera.props.center).toEqual([115.2, -8.6]);
  expect(mockAddLocationListener).toHaveBeenCalledTimes(1);
  expect(camera.props.pitch).toBe(55);
  expect(camera.props.padding).toEqual({ top: 30, bottom: 356, left: 20, right: 20 });
  expect(screenRenderer!.root.findByProps({ id: 'recorded-ride-line' }).props.paint['line-color']).toBe('#E86A28');
  expect(screenRenderer!.root.findByProps({ testID: 'user-location-dot' }).props.mode).toBe('heading');

  // Toggle to 2D overview mode
  await ReactTestRenderer.act(() => {
    pressButton(screenRenderer!, 'Ganti ke pandangan 2D utara');
  });

  const camera2d = screenRenderer!.root.findByProps({ testID: 'route-camera' });
  expect(camera2d.props.pitch).toBe(0);
  expect(camera2d.props.padding).toEqual({ top: 30, bottom: 356, left: 20, right: 20 });
});

test('dynamically raises camera padding when bottom sheet expands', async () => {
  mockRideState = {
    rideSnapshot: { status: 'active', lastCoordinate: [115.2, -8.6], pointCount: 2 },
    trackSegments: [[[115.19, -8.61], [115.2, -8.6]]],
  };
  let screenRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await ReactTestRenderer.act(() => {
    screenRenderer = createScreen();
  });

  const camera = screenRenderer!.root.findByProps({ testID: 'route-camera' });
  expect(camera.props.padding).toEqual({ top: 30, bottom: 356, left: 20, right: 20 });

  // Tap to expand bottom sheet
  await ReactTestRenderer.act(() => {
    const expandHandle = screenRenderer!.root.findByProps({
      accessibilityLabel: 'Perluas panel perjalanan',
    });
    expandHandle.props.onPress();
  });

  const cameraExpanded = screenRenderer!.root.findByProps({ testID: 'route-camera' });
  expect(cameraExpanded.props.padding).toEqual({ top: 30, bottom: 606, left: 20, right: 20 });
});

test('opens area selection on first launch and downloads the selected box', async () => {
  mockMapPackState = { status: 'missing' };
  let screenRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await ReactTestRenderer.act(() => {
    screenRenderer = createScreen();
  });

  expect(screenRenderer!.root.findByProps({ children: 'Pilih area offline' })).toBeTruthy();
  const routeMap = screenRenderer!.root.findByProps({ testID: 'route-map' });
  await ReactTestRenderer.act(async () => {
    routeMap.props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 393, height: 852 } },
    });
    await Promise.resolve();
    await Promise.resolve();
  });
  await ReactTestRenderer.act(() => {
    routeMap.props.onRegionDidChange({
      nativeEvent: {
        zoom: 12,
        bounds: [115.12, -8.68, 115.23, -8.38],
      },
    });
  });
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await ReactTestRenderer.act(() => {
    pressButton(screenRenderer!, 'Unduh area ini');
  });

  const selectedBounds = mockDownloadArea.mock.calls[0][0];
  expect(selectedBounds).toEqual(selectedBoundsFromLastMapProjection());
  expect(mockMapUnproject).toHaveBeenCalledTimes(8);
  const frameLayout = screenRenderer!.root.findByProps({
    testID: 'area-selection-frame',
  }).props.style[1];
  const cameraBottomPadding = screenRenderer!.root.findByProps({
    testID: 'route-camera',
  }).props.padding.bottom;
  expect(frameLayout.top + frameLayout.height).toBeLessThanOrEqual(
    852 - cameraBottomPadding,
  );
});

test('applies the selected map area only after tapping Perbarui', async () => {
  let screenRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await ReactTestRenderer.act(() => {
    screenRenderer = createScreen();
  });
  await ReactTestRenderer.act(() => {
    selectMainTab(screenRenderer!, 'Peta');
  });
  const routeMap = screenRenderer!.root.findByProps({ testID: 'route-map' });
  await ReactTestRenderer.act(async () => {
    routeMap.props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 393, height: 852 } },
    });
    await Promise.resolve();
    await Promise.resolve();
  });
  await ReactTestRenderer.act(() => {
    routeMap.props.onRegionDidChange({
      nativeEvent: {
        zoom: 12,
        bounds: [115.12, -8.68, 115.23, -8.38],
      },
    });
  });
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockUpdateArea).not.toHaveBeenCalled();
  expect(screenRenderer!.root.findAllByProps({
    id: 'saved-offline-map-areas',
  })).toHaveLength(0);
  expect(screenRenderer!.root.findAllByProps({
    children: 'Kotak biru: area pilihan · Garis hijau: area tersimpan',
  })).toHaveLength(0);

  await ReactTestRenderer.act(async () => {
    pressButton(screenRenderer!, 'Terapkan cakupan pilihan ke Area 1');
    await Promise.resolve();
  });

  expect(mockUpdateArea).toHaveBeenCalledTimes(1);
  const [, selectedBounds] = mockUpdateArea.mock.calls[0];
  expect(selectedBounds).toEqual(selectedBoundsFromLastMapProjection());
});

test('warns when the offline map pack is missing for an imported route', async () => {
  mockMapPackState = { status: 'missing' };
  const screenRenderer = await renderImportedRoute();

  expect(screenRenderer.root.findByProps({ children: 'Belum ada peta offline.' })).toBeTruthy();
  expect(screenRenderer.root.findAllByProps({ accessibilityLabel: 'Mulai navigasi' })).toHaveLength(0);
});

async function renderImportedRoute() {
  let screenRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await ReactTestRenderer.act(() => {
    screenRenderer = createScreen();
  });

  if (mockMapPackState.status === 'missing') {
    await ReactTestRenderer.act(() => {
      pressButton(screenRenderer!, 'Tutup');
    });
  }

  await ReactTestRenderer.act(() => {
    selectMainTab(screenRenderer!, 'Rute');
  });

  await ReactTestRenderer.act(async () => {
    screenRenderer!.root
      .findByProps({ accessibilityLabel: 'Pilih file GPX' })
      .props.onPress();
  });

  return screenRenderer!;
}

function pressButton(
  screenRenderer: ReactTestRenderer.ReactTestRenderer,
  label: string,
) {
  screenRenderer.root.findByProps({ accessibilityLabel: label }).props.onPress();
}

function selectMainTab(
  screenRenderer: ReactTestRenderer.ReactTestRenderer,
  label: 'Ride' | 'Rute' | 'Peta' | 'Setelan',
) {
  screenRenderer.root.findByProps({ accessibilityLabel: label }).props.onPress();
}

test('starts navigation for an imported route when offline map is ready and follows location', async () => {
  mockRequestLocationPermission.mockResolvedValue(true);
  const screenRenderer = await renderImportedRoute();

  const startButton = screenRenderer.root.findByProps({ accessibilityLabel: 'Mulai navigasi mengikuti arah rute GPX' });
  expect(startButton).toBeTruthy();

  await ReactTestRenderer.act(async () => {
    pressButton(screenRenderer, 'Mulai navigasi mengikuti arah rute GPX');
  });

  expect(mockRequestLocationPermission).toHaveBeenCalledTimes(1);
  expect(mockStartRide).toHaveBeenCalledTimes(1);
});

test('alerts when location permission is denied on starting navigation', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert');
  mockRequestLocationPermission.mockResolvedValue(false);
  const screenRenderer = await renderImportedRoute();

  await ReactTestRenderer.act(async () => {
    pressButton(screenRenderer, 'Mulai navigasi mengikuti arah rute GPX');
  });

  expect(mockRequestLocationPermission).toHaveBeenCalledTimes(1);
  expect(mockStartRide).not.toHaveBeenCalled();
  expect(alertSpy).toHaveBeenCalledWith(
    'Lokasi belum diizinkan',
    'Aktifkan lokasi tepat untuk CycleComp di Pengaturan iPhone.',
  );
  alertSpy.mockRestore();
});

test('quick action centers camera on user position, retains blue dot on map drag, and allows recentering', async () => {
  mockRequestLocationPermission.mockResolvedValue(true);
  let screenRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await ReactTestRenderer.act(() => {
    screenRenderer = createScreen();
  });

  expect(screenRenderer!.root.findAllByProps({ testID: 'user-location-dot' })).toHaveLength(0);

  await ReactTestRenderer.act(async () => {
    pressButton(screenRenderer!, 'Pusatkan ke lokasi saya');
  });

  expect(mockRequestLocationPermission).toHaveBeenCalledTimes(1);
  expect(screenRenderer!.root.findByProps({ testID: 'user-location-dot' })).toBeTruthy();

  await ReactTestRenderer.act(() => {
    mockAddLocationListener.mock.calls[0][0]({
      coords: { longitude: 115.19, latitude: -8.65, accuracy: 6 },
    });
  });

  expect(screenRenderer!.root.findByProps({ testID: 'user-location-dot' })).toBeTruthy();
  expect(screenRenderer!.root.findByProps({ testID: 'route-camera' }).props.center).toEqual([
    115.19,
    -8.65,
  ]);

  // Simulate user dragging the map
  const routeMap = screenRenderer!.root.findByProps({ testID: 'route-map' });
  await ReactTestRenderer.act(() => {
    routeMap.props.onRegionWillChange({
      nativeEvent: { userInteraction: true },
    });
  });

  // Camera unlocks, but blue dot stays visible
  expect(screenRenderer!.root.findByProps({ testID: 'route-camera' }).props.center).toBeUndefined();
  expect(screenRenderer!.root.findByProps({ testID: 'user-location-dot' })).toBeTruthy();

  // Live GPS updates continue to be received as user moves
  await ReactTestRenderer.act(() => {
    mockAddLocationListener.mock.calls[0][0]({
      coords: { longitude: 115.20, latitude: -8.64, accuracy: 5 },
    });
  });

  expect(screenRenderer!.root.findByProps({ testID: 'user-location-dot' })).toBeTruthy();
  expect(screenRenderer!.root.findByProps({ testID: 'route-camera' }).props.center).toBeUndefined();

  // Tapping shortcut again re-centers camera to latest coordinates
  await ReactTestRenderer.act(async () => {
    pressButton(screenRenderer!, 'Pusatkan ke lokasi saya');
  });

  expect(screenRenderer!.root.findByProps({ testID: 'route-camera' }).props.center).toEqual([
    115.20,
    -8.64,
  ]);
  expect(screenRenderer!.root.findByProps({ testID: 'user-location-dot' })).toBeTruthy();
});

test('renders route with gradient coloring and legend in preview mode', async () => {
  const screenRenderer = await renderImportedRoute();

  // Gradient route layer is rendered
  const gradientLayer = screenRenderer.root.findByProps({ id: 'imported-route-gradient-line' });
  expect(gradientLayer).toBeTruthy();
  expect(gradientLayer.props.paint['line-color']).toEqual(['get', 'color']);

  // Gradient legend chips are present
  expect(screenRenderer.root.findByProps({ children: 'Turun' })).toBeTruthy();
  expect(screenRenderer.root.findByProps({ children: '0–3%' })).toBeTruthy();
  expect(screenRenderer.root.findByProps({ children: '3–6%' })).toBeTruthy();
});

test('allows removing/clearing imported GPX route to return to empty state', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert');
  const screenRenderer = await renderImportedRoute();

  expect(screenRenderer.root.findByProps({ children: 'Jatiluwih' })).toBeTruthy();

  // Tap "Hapus" button in header
  await ReactTestRenderer.act(async () => {
    pressButton(screenRenderer, 'Hapus rute GPX dari peta');
  });

  expect(alertSpy).toHaveBeenCalledWith(
    'Hapus rute GPX?',
    'Rute akan dilepas dari peta dan kembali ke mode navigasi bebas tanpa GPX.',
    expect.any(Array),
  );

  const confirmButtons = alertSpy.mock.calls[0][2] as any[];
  const deleteAction = confirmButtons.find((b: any) => b.text === 'Hapus rute');
  await ReactTestRenderer.act(async () => {
    deleteAction.onPress();
  });

  expect(screenRenderer.root.findByProps({ children: 'Belum ada rute' })).toBeTruthy();
  expect(screenRenderer.root.findAllByProps({ id: 'imported-route-gradient-line' })).toHaveLength(0);

  alertSpy.mockRestore();
});

test('allows deleting a saved offline map area with confirmation', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert');
  let screenRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await ReactTestRenderer.act(() => {
    screenRenderer = createScreen();
  });

  // Open the map manager tab
  await ReactTestRenderer.act(async () => {
    selectMainTab(screenRenderer!, 'Peta');
  });

  expect(screenRenderer!.root.findByProps({ children: 'Kelola area offline' })).toBeTruthy();
  expect(screenRenderer!.root.findByProps({ children: 'Area 1' })).toBeTruthy();

  // Tap "Hapus" on Area 1
  await ReactTestRenderer.act(async () => {
    pressButton(screenRenderer!, 'Hapus Area 1');
  });

  expect(alertSpy).toHaveBeenCalledWith(
    'Hapus Area 1?',
    expect.stringContaining('akan dihapus dari penyimpanan iPhone'),
    expect.any(Array),
  );

  const confirmButtons = alertSpy.mock.calls[0][2] as any[];
  const deleteAction = confirmButtons.find((b: any) => b.text === 'Hapus');
  await ReactTestRenderer.act(async () => {
    deleteAction.onPress();
  });

  expect(mockDeleteArea).toHaveBeenCalledWith('saved-area');
  alertSpy.mockRestore();
});

test('shows the route summary and Route Back action after importing a GPX', async () => {
  const screenRenderer = await renderImportedRoute();

  expect(screenRenderer.root.findByProps({ children: 'RUTE GPX' })).toBeTruthy();
  expect(screenRenderer.root.findByProps({ children: 'Jatiluwih' })).toBeTruthy();
  expect(screenRenderer.root.findByProps({ accessibilityLabel: 'Mulai Route Back menuju titik awal melalui jalur GPX yang sama' })).toBeTruthy();
});

test('unmounts the covered map in Endurance and restores its viewport when waking', async () => {
  mockRideState.rideSnapshot = { status: 'active' };
  let screen!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => { screen = createScreen(); });
  const viewport = { center: [115.2, -8.6], zoom: 13, pitch: 0, bearing: 45 };
  await ReactTestRenderer.act(() => {
    screen.root.findByProps({ testID: 'route-map' }).props.onRegionDidChange({ nativeEvent: viewport });
    pressButton(screen, 'Mode Hemat Baterai Layar AMOLED');
  });
  expect(screen.root.findAllByProps({ testID: 'route-camera' })).toHaveLength(0);
  await ReactTestRenderer.act(() => {
    pressButton(screen, 'Layar hemat daya AMOLED aktif. Ketuk untuk membangunkan peta.');
  });
  expect(screen.root.findByProps({ testID: 'route-camera' }).props.initialViewState).toEqual(viewport);
});

test('releases preview location updates in background and restores them on return', async () => {
  const appStateSpy = jest.spyOn(AppState, 'addEventListener');
  appStateSpy.mockClear();
  mockRequestLocationPermission.mockResolvedValue(true);
  let screen!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => { screen = createScreen(); });
  await ReactTestRenderer.act(async () => { pressButton(screen, 'Pusatkan ke lokasi saya'); });
  const appStateChanged = appStateSpy.mock.calls[0][1];
  await ReactTestRenderer.act(() => { appStateChanged('inactive'); });
  expect(screen.root.findByProps({ testID: 'route-camera' })).toBeTruthy();
  expect(mockRemoveLocationListener).not.toHaveBeenCalled();
  await ReactTestRenderer.act(() => { appStateChanged('background'); });
  expect(screen.root.findAllByProps({ testID: 'route-camera' })).toHaveLength(0);
  expect(mockRemoveLocationListener).toHaveBeenCalledTimes(1);
  await ReactTestRenderer.act(() => { appStateChanged('active'); });
  expect(screen.root.findByProps({ testID: 'route-camera' })).toBeTruthy();
  expect(mockAddLocationListener).toHaveBeenCalledTimes(2);
  appStateSpy.mockRestore();
});
