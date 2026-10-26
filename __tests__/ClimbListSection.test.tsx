import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import type { ClimbSegment } from '../src/domain/routes/elevation/routeElevationAnalysis';
import { ClimbListSection } from '../src/features/elevation/ClimbListSection';

describe('ClimbListSection', () => {
  const dummyClimbs: ClimbSegment[] = [
    {
      id: 1,
      startDistanceMeters: 4500,
      endDistanceMeters: 6200,
      distanceMeters: 1700,
      elevationGainMeters: 125,
      averageGradePercent: 7.3,
      maxGradePercent: 12.1,
      startElevationMeters: 150,
      endElevationMeters: 275,
      startCoordinate: [115.15, -8.35],
      endCoordinate: [115.16, -8.36],
    },
    {
      id: 2,
      startDistanceMeters: 12000,
      endDistanceMeters: 14500,
      distanceMeters: 2500,
      elevationGainMeters: 190,
      averageGradePercent: 7.6,
      maxGradePercent: 14.5,
      startElevationMeters: 300,
      endElevationMeters: 490,
      startCoordinate: [115.2, -8.4],
      endCoordinate: [115.22, -8.42],
    },
  ];

  test('renders climb list cards with summary header and climb stats', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <ClimbListSection
          climbs={dummyClimbs}
          maxGradePercent={14.5}
          totalAscentMeters={315}
        />,
      );
    });

    const root = renderer!.root;
    // Header summary
    expect(root.findByProps({ children: 'TANJAKAN RUTE (2)' })).toBeTruthy();
    expect(root.findByProps({ children: '+315m · Maks 14.5%' })).toBeTruthy();

    // Climb 1 card stats
    expect(root.findByProps({ children: 'Tanjakan 1/2' })).toBeTruthy();
    expect(root.findByProps({ children: 'km 4.5' })).toBeTruthy();
    expect(root.findAllByProps({ children: ' m' }).length).toBeGreaterThanOrEqual(2);
    expect(root.findByProps({ children: '+12.1%' })).toBeTruthy();

    // Climb 2 card stats
    expect(root.findByProps({ children: 'Tanjakan 2/2' })).toBeTruthy();
    expect(root.findByProps({ children: 'km 12.0' })).toBeTruthy();
  });

  test('calls onSelectClimb when a climb card is pressed', () => {
    const handleSelectClimb = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <ClimbListSection
          climbs={dummyClimbs}
          maxGradePercent={14.5}
          totalAscentMeters={315}
          onSelectClimb={handleSelectClimb}
        />,
      );
    });

    const climb1Card = renderer!.root.findByProps({
      accessibilityLabel:
        'Tanjakan 1 dari 2, panjang 1.7 kilometer, elevasi naik 125 meter',
    });

    ReactTestRenderer.act(() => {
      climb1Card.props.onPress();
    });

    expect(handleSelectClimb).toHaveBeenCalledWith(dummyClimbs[0]);
  });

  test('returns null when climbs array is empty', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <ClimbListSection
          climbs={[]}
          maxGradePercent={null}
          totalAscentMeters={0}
        />,
      );
    });

    expect(renderer!.toJSON()).toBeNull();
  });
});
