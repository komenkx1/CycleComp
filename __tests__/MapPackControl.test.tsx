import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { MapPackControl } from '../src/features/routes/RoutePreviewScreen';

jest.mock('@maplibre/maplibre-react-native', () => ({}));
jest.mock('../src/features/routes/importGpxRoute', () => ({
  GpxImportCanceledError: class GpxImportCanceledError extends Error {},
  pickAndImportGpxRoute: jest.fn(),
}));

describe('MapPackControl', () => {
  test('offers map management when the imported route is outside saved areas', async () => {
    const openMapManager = jest.fn();
    let controlRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

    await ReactTestRenderer.act(() => {
      controlRenderer = ReactTestRenderer.create(
        <MapPackControl
          mapPackCheck="done"
          readyAreaCount={1}
          routeHasOfflineMap={false}
          onManage={openMapManager}
        />,
      );
    });

    expect(controlRenderer!.root.findByProps({
      children: 'GPX ini di luar area offline yang tersimpan.',
    })).toBeTruthy();

    await ReactTestRenderer.act(() => {
      controlRenderer!.root.findByProps({ accessibilityLabel: 'Kelola peta' }).props.onPress();
    });

    expect(openMapManager).toHaveBeenCalledTimes(1);
  });

  test('displays combined readiness when both map and terrain are ready', async () => {
    let controlRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

    await ReactTestRenderer.act(() => {
      controlRenderer = ReactTestRenderer.create(
        <MapPackControl
          mapPackCheck="done"
          readyAreaCount={1}
          routeHasOfflineMap={true}
          terrainStatus="ready"
          onManage={jest.fn()}
        />,
      );
    });

    expect(controlRenderer!.root.findByProps({
      children: 'Lengkap untuk offline · Peta dan medan siap.',
    })).toBeTruthy();
  });

  test('displays partial readiness with action when terrain pack is missing', async () => {
    const openTerrainManager = jest.fn();
    let controlRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

    await ReactTestRenderer.act(() => {
      controlRenderer = ReactTestRenderer.create(
        <MapPackControl
          mapPackCheck="done"
          readyAreaCount={1}
          routeHasOfflineMap={true}
          terrainStatus="missing"
          onManage={jest.fn()}
          onManageTerrain={openTerrainManager}
        />,
      );
    });

    expect(controlRenderer!.root.findByProps({
      children: 'Peta siap · Medan belum diunduh.',
    })).toBeTruthy();

    const completeButton = controlRenderer!.root.findByProps({
      accessibilityLabel: 'Lengkapi data medan',
    });
    expect(completeButton).toBeTruthy();

    await ReactTestRenderer.act(() => {
      completeButton.props.onPress();
    });

    expect(openTerrainManager).toHaveBeenCalledTimes(1);
  });

  test('displays partial status when terrain coverage is incomplete', async () => {
    const openTerrainManager = jest.fn();
    let controlRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

    await ReactTestRenderer.act(() => {
      controlRenderer = ReactTestRenderer.create(
        <MapPackControl
          mapPackCheck="done"
          readyAreaCount={1}
          routeHasOfflineMap={true}
          terrainStatus="partial"
          onManage={jest.fn()}
          onManageTerrain={openTerrainManager}
        />,
      );
    });

    expect(controlRenderer!.root.findByProps({
      children: 'Peta siap · Data medan belum lengkap.',
    })).toBeTruthy();

    await ReactTestRenderer.act(() => {
      controlRenderer!.root.findByProps({
        accessibilityLabel: 'Lengkapi data medan',
      }).props.onPress();
    });

    expect(openTerrainManager).toHaveBeenCalledTimes(1);
  });
});
