import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { GmapsLinkModal } from '../src/features/search/GmapsLinkModal';
import * as gmapsPipeline from '../src/domain/routes/search/gmapsLinkToGpxRoute';
import type { GpxRoute } from '../src/domain/routes/gpx/GpxRoute';

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  };
});

describe('GmapsLinkModal', () => {
  const mockRoute: GpxRoute = {
    name: 'Sanur → Ubud',
    sourceFileName: 'gmaps-12345.gpx',
    segments: [],
    bounds: [115.2, -8.6, 115.26, -8.5],
    distanceMeters: 25000,
    pointCount: 150,
    elevationPointCount: 150,
    minimumElevationMeters: 5,
    maximumElevationMeters: 220,
  };

  it('renders input and tips when visible', async () => {
    let screen: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(() => {
      screen = ReactTestRenderer.create(
        <GmapsLinkModal
          visible={true}
          onClose={jest.fn()}
          onRouteCreated={jest.fn()}
        />,
      );
    });

    expect(screen!.root.findByProps({ children: 'Buat Rute dari Google Maps' })).toBeTruthy();
    expect(screen!.root.findByProps({ accessibilityLabel: 'Input link Google Maps' })).toBeTruthy();
  });

  it('invokes gmapsLinkToGpxRoute when submitted', async () => {
    const mockOnRouteCreated = jest.fn();
    const mockOnClose = jest.fn();
    jest.spyOn(gmapsPipeline, 'gmapsLinkToGpxRoute').mockResolvedValue(mockRoute);

    let screen: ReactTestRenderer.ReactTestRenderer | undefined;

    await ReactTestRenderer.act(() => {
      screen = ReactTestRenderer.create(
        <GmapsLinkModal
          visible={true}
          onClose={mockOnClose}
          onRouteCreated={mockOnRouteCreated}
        />,
      );
    });

    const textInput = screen!.root.findByProps({ accessibilityLabel: 'Input link Google Maps' });

    await ReactTestRenderer.act(() => {
      textInput.props.onChangeText('https://maps.app.goo.gl/abc123xyz');
    });

    const submitBtn = screen!.root.findByProps({
      accessibilityLabel: 'Konversi link menjadi rute GPX',
    });

    await ReactTestRenderer.act(async () => {
      submitBtn.props.onPress();
    });

    expect(gmapsPipeline.gmapsLinkToGpxRoute).toHaveBeenCalledWith(
      'https://maps.app.goo.gl/abc123xyz',
      expect.any(Function),
      undefined,
    );
    expect(mockOnRouteCreated).toHaveBeenCalledWith(mockRoute);
    expect(mockOnClose).toHaveBeenCalled();
  });
});
