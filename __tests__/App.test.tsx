/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

jest.mock('react-native/Libraries/Settings/Settings', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn() },
}));

const mockPickAndImportGpxRoute = jest.fn();

jest.mock('@maplibre/maplibre-react-native', () => {
  const ReactModule = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  const MapContainer = ({ children }: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, children);

  return {
    Camera: () => null,
    GeoJSONSource: MapContainer,
    Layer: () => null,
    Map: MapContainer,
  };
});

jest.mock('../src/features/routes/importGpxRoute', () => ({
  GpxImportCanceledError: class GpxImportCanceledError extends Error {},
  pickAndImportGpxRoute: () => mockPickAndImportGpxRoute(),
}));

jest.mock('../src/features/maps/useOfflineMapPacks', () => ({
  useOfflineMapPacks: () => ({
    savedMapAreas: [],
    mapPackCheck: 'checking',
    mapPackError: null,
    downloadArea: jest.fn(),
    pauseArea: jest.fn(),
    resumeArea: jest.fn(),
    updateArea: jest.fn(),
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');

  return {
    SafeAreaProvider: View,
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

beforeEach(() => {
  mockPickAndImportGpxRoute.mockReset();
});

test('renders the empty GPX route state', async () => {
  let appRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await ReactTestRenderer.act(() => {
    appRenderer = ReactTestRenderer.create(<App />);
  });

  await ReactTestRenderer.act(() => {
    appRenderer!.root.findByProps({ accessibilityLabel: 'Rute' }).props.onPress();
  });

  const renderedScreen = appRenderer!.root;

  expect(renderedScreen.findByProps({ children: 'Belum ada rute' })).toBeTruthy();
  expect(renderedScreen.findByProps({ children: 'Pilih file GPX' })).toBeTruthy();
});

test('shows a useful error when GPX import fails', async () => {
  mockPickAndImportGpxRoute.mockRejectedValueOnce(
    new Error('GPX tidak memiliki track atau route point.'),
  );

  let appRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await ReactTestRenderer.act(() => {
    appRenderer = ReactTestRenderer.create(<App />);
  });

  await ReactTestRenderer.act(() => {
    appRenderer!.root.findByProps({ accessibilityLabel: 'Rute' }).props.onPress();
  });

  const importButton = appRenderer!.root.findByProps({
    accessibilityLabel: 'Pilih file GPX',
  });

  await ReactTestRenderer.act(async () => {
    await importButton.props.onPress();
  });

  expect(
    appRenderer!.root.findByProps({
      children: 'GPX tidak dapat digunakan',
    }),
  ).toBeTruthy();
  expect(
    appRenderer!.root.findByProps({
      children: 'GPX tidak memiliki track atau route point.',
    }),
  ).toBeTruthy();
});
