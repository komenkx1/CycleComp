import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';

import { RideHistoryPanel } from '../src/features/history/RideHistoryPanel';
import type { SavedRideFile } from '../src/features/ride/useRideTracking';
import type { SelectedRideDetail } from '../src/features/history/useRideHistory';
import type { GpxRoute } from '../src/domain/routes/gpx/GpxRoute';

describe('RideHistoryPanel', () => {
  const mockRides: SavedRideFile[] = [
    {
      id: 'CycleComp-RIDE1',
      fileName: 'CycleComp-RIDE1.gpx',
      fileUrl: 'file:///Rides/CycleComp-RIDE1.gpx',
      filePath: '/Rides/CycleComp-RIDE1.gpx',
      fileSizeBytes: 2048,
      createdAt: '2026-10-20T06:30:00Z',
      hasSensorTrace: true,
    },
  ];

  const mockRoute: GpxRoute = {
    name: 'Gowes Pagi Sanur',
    sourceFileName: 'CycleComp-RIDE1.gpx',
    segments: [
      {
        points: [
          { coordinate: [115.25, -8.68], elevationMeters: 5 },
          { coordinate: [115.26, -8.69], elevationMeters: 8 },
        ],
      },
    ],
    bounds: [115.25, -8.69, 115.26, -8.68],
    distanceMeters: 1850,
    pointCount: 2,
    elevationPointCount: 2,
    minimumElevationMeters: 5,
    maximumElevationMeters: 8,
  };

  const mockSelectedRide: SelectedRideDetail = {
    file: mockRides[0],
    route: mockRoute,
    rawGpxXml: '<gpx></gpx>',
  };

  const defaultProps = {
    rides: mockRides,
    loading: false,
    selectedRide: null,
    loadingSelected: false,
    onSelectRide: jest.fn(),
    onClearSelectedRide: jest.fn(),
    onDeleteRide: jest.fn(),
    onShareRide: jest.fn(),
    onShareSensorTrace: jest.fn(),
    onUseAsNavRoute: jest.fn(),
    onUploadToStrava: jest.fn(),
    stravaConnected: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders list of rides when no ride is selected', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<RideHistoryPanel {...defaultProps} />);
    });
    const root = renderer.root;

    expect(root.findByProps({ children: 'Riwayat Gowes' })).toBeTruthy();
    expect(root.findByProps({ children: 'CycleComp-RIDE1.gpx' })).toBeTruthy();
  });

  it('calls onSelectRide when clicking a ride card', () => {
    const onSelectRide = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <RideHistoryPanel {...defaultProps} onSelectRide={onSelectRide} />,
      );
    });
    const root = renderer.root;

    const rideCard = root.findByProps({
      accessibilityLabel: 'Pilih riwayat gowes CycleComp-RIDE1.gpx',
    });
    act(() => {
      rideCard.props.onPress();
    });

    expect(onSelectRide).toHaveBeenCalledWith(mockRides[0]);
  });

  it('renders ride details and Strava upload button when selectedRide is provided', () => {
    const onUploadToStrava = jest.fn();
    const onClearSelectedRide = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <RideHistoryPanel
          {...defaultProps}
          selectedRide={mockSelectedRide}
          onUploadToStrava={onUploadToStrava}
          onClearSelectedRide={onClearSelectedRide}
        />,
      );
    });
    const root = renderer.root;

    expect(root.findByProps({ children: 'DETAIL RIWAYAT GOWES' })).toBeTruthy();
    expect(root.findByProps({ children: 'Gowes Pagi Sanur' })).toBeTruthy();

    // Strava button
    const stravaBtn = root.findByProps({
      accessibilityLabel: 'Upload rekaman gowes ini ke Strava',
    });
    act(() => {
      stravaBtn.props.onPress();
    });
    expect(onUploadToStrava).toHaveBeenCalledWith(mockSelectedRide);

    // Back button
    const backBtn = root.findByProps({
      accessibilityLabel: 'Kembali ke daftar riwayat',
    });
    act(() => {
      backBtn.props.onPress();
    });
    expect(onClearSelectedRide).toHaveBeenCalled();
  });

  it('prompts confirmation when clicking delete', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const onDeleteRide = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <RideHistoryPanel
          {...defaultProps}
          selectedRide={mockSelectedRide}
          onDeleteRide={onDeleteRide}
        />,
      );
    });
    const root = renderer.root;

    const deleteBtn = root.findByProps({
      accessibilityLabel: 'Hapus rekaman ini',
    });
    act(() => {
      deleteBtn.props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Hapus Riwayat Perjalanan',
      expect.stringContaining('CycleComp-RIDE1.gpx'),
      expect.any(Array),
    );
  });

  it('calls onFocusRoute when clicking Fokus Peta button', () => {
    const onFocusRoute = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <RideHistoryPanel
          {...defaultProps}
          selectedRide={mockSelectedRide}
          onFocusRoute={onFocusRoute}
        />,
      );
    });
    const root = renderer.root;

    const focusBtn = root.findByProps({
      accessibilityLabel: 'Pusatkan peta ke rute ini',
    });
    act(() => {
      focusBtn.props.onPress();
    });

    expect(onFocusRoute).toHaveBeenCalledWith(mockRoute);
  });
});
