import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Alert, Text } from 'react-native';

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

  it('shows the estimated power summary only when the ride contains estimated samples', () => {
    const rawGpxXml = `<gpx xmlns:cyclecomp="https://mangwahyu.tech/cyclecomp/gpx/1"><trk><trkseg>
      <trkpt><time>2026-01-01T00:00:00Z</time><extensions><power>100</power><cyclecomp:powerSource>estimated</cyclecomp:powerSource></extensions></trkpt>
      <trkpt><time>2026-01-01T00:00:02Z</time><extensions><power>200</power><cyclecomp:powerSource>estimated</cyclecomp:powerSource></extensions></trkpt>
      </trkseg></trk></gpx>`;
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => { renderer = ReactTestRenderer.create(<RideHistoryPanel {...defaultProps} selectedRide={{ ...mockSelectedRide, rawGpxXml }} />); });
    expect(renderer.root.findByProps({ testID: 'ride-history-power' }).props.children).toBe('150 W');
    act(() => { renderer.update(<RideHistoryPanel {...defaultProps} selectedRide={mockSelectedRide} />); });
    expect(renderer.root.findAllByProps({ testID: 'ride-history-power' })).toHaveLength(0);
    act(() => renderer.unmount());
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

  it('shows unavailable elevation metrics when the ride has no elevation samples', () => {
    const routeWithoutElevation: GpxRoute = {
      ...mockRoute,
      segments: [{ points: [
        { coordinate: [115.25, -8.68], elevationMeters: null },
        { coordinate: [115.26, -8.69], elevationMeters: null },
      ] }],
      elevationPointCount: 0,
      minimumElevationMeters: null,
      maximumElevationMeters: null,
    };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <RideHistoryPanel
          {...defaultProps}
          selectedRide={{ ...mockSelectedRide, route: routeWithoutElevation }}
        />,
      );
    });

    expect(renderer.root.findAllByType(Text).filter(text => text.props.children === '—')).toHaveLength(2);
    expect(renderer.root.findByProps({ children: 'Profil elevasi tidak tersedia.' })).toBeTruthy();
  });

  it('shows a loading error without presenting an empty history as fact', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <RideHistoryPanel {...defaultProps} rides={[]} error="Gagal memuat riwayat" />,
      );
    });
    expect(renderer.root.findByProps({ children: 'Gagal memuat riwayat' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ children: 'Belum Ada Riwayat' })).toHaveLength(0);
  });

  it('keeps route, share and sensor trace actions connected', () => {
    const onUseAsNavRoute = jest.fn();
    const onShareRide = jest.fn();
    const onShareSensorTrace = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <RideHistoryPanel {...defaultProps} selectedRide={mockSelectedRide}
          onUseAsNavRoute={onUseAsNavRoute} onShareRide={onShareRide}
          onShareSensorTrace={onShareSensorTrace} />,
      );
    });
    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Gunakan rute ini untuk navigasi' }).props.onPress();
      renderer.root.findByProps({ accessibilityLabel: 'Bagikan file GPX' }).props.onPress();
      renderer.root.findByProps({ accessibilityLabel: 'Bagikan trace diagnostik sensor' }).props.onPress();
    });
    expect(onUseAsNavRoute).toHaveBeenCalledWith(mockRoute);
    expect(onShareRide).toHaveBeenCalledWith(mockRides[0].fileUrl);
    expect(onShareSensorTrace).toHaveBeenCalledWith(mockRides[0].fileUrl);
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
