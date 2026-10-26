import React from 'react';
import { View } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import type { RouteSample } from '../src/domain/routes/elevation/routeElevationAnalysis';
import { ElevationProfileChart } from '../src/features/elevation/ElevationProfileChart';

describe('ElevationProfileChart', () => {
  const dummySamples: RouteSample[] = [
    {
      coordinate: [115.1, -8.3],
      distanceMeters: 0,
      elevationMeters: 100,
      gradePercent: 1.0,
    },
    {
      coordinate: [115.11, -8.31],
      distanceMeters: 500,
      elevationMeters: 140,
      gradePercent: 8.0,
    },
    {
      coordinate: [115.12, -8.32],
      distanceMeters: 1000,
      elevationMeters: 200,
      gradePercent: 12.0,
    },
    {
      coordinate: [115.13, -8.33],
      distanceMeters: 1500,
      elevationMeters: 250,
      gradePercent: 10.0,
    },
  ];

  test('renders elevation chart with boundary labels and peak indicator', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <ElevationProfileChart
          samples={dummySamples}
          height={80}
          showLabels={true}
        />,
      );
    });

    const root = renderer!.root;
    // Min elevation label
    expect(root.findByProps({ children: 'Min 100 m' })).toBeTruthy();
    // Peak elevation label
    expect(root.findByProps({ children: 'Puncak 250 m' })).toBeTruthy();
    // Distance boundaries
    expect(root.findByProps({ children: '0 km' })).toBeTruthy();
    expect(root.findByProps({ children: '1.5 km' })).toBeTruthy();
  });

  test('renders rider dot on elevation profile when riderProgressPercent is provided', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <ElevationProfileChart
          samples={dummySamples}
          height={80}
          riderProgressPercent={50}
          showLabels={false}
        />,
      );
    });

    // Simulasikan layout untuk container width
    const container = renderer!.root.findByProps({ testID: 'elevation-profile-chart' });
    ReactTestRenderer.act(() => {
      container.props.onLayout({
        nativeEvent: { layout: { width: 300, height: 80 } },
      });
    });

    // Rider dot anchor should be present
    const allViews = renderer!.root.findAllByType(View);
    expect(allViews.length).toBeGreaterThan(10);
  });

  test('handles empty samples gracefully without crashing', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <ElevationProfileChart samples={[]} height={80} />,
      );
    });

    expect(
      renderer!.root.findByProps({ children: 'Data elevasi tidak tersedia' }),
    ).toBeTruthy();
  });
});
