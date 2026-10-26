import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { EnduranceScreenOverlay } from '../src/features/ride/EnduranceScreenOverlay';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

test('shows average speed calculated from moving time in endurance mode', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <EnduranceScreenOverlay
        visible
        speedKmh={18}
        distanceMeters={2_500}
        movingSeconds={1_500}
        onWakeUp={jest.fn()}
        onDisableEndurance={jest.fn()}
      />,
    );
  });

  expect(renderer!.root.findByProps({ testID: 'endurance-average-speed' }).props.children)
    .toBe('RATA-RATA 6,0 KM/JAM');
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('shows average speed as unavailable before moving time is recorded', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <EnduranceScreenOverlay
        visible
        distanceMeters={0}
        movingSeconds={0}
        onWakeUp={jest.fn()}
        onDisableEndurance={jest.fn()}
      />,
    );
  });

  expect(renderer!.root.findByProps({ testID: 'endurance-average-speed' }).props.children)
    .toBe('RATA-RATA —');
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('shows upcoming climb pill in free ride mode when terrain climb is detected', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <EnduranceScreenOverlay
        visible
        distanceMeters={1_000}
        movingSeconds={200}
        terrainClimbStatus="upcoming"
        terrainClimbDistanceToStartMeters={150}
        terrainClimbAverageGradePercent={7.5}
        onWakeUp={jest.fn()}
        onDisableEndurance={jest.fn()}
      />,
    );
  });

  expect(renderer!.root.findByProps({ children: 'Tanjakan 150m lagi' })).toBeTruthy();
  expect(renderer!.root.findByProps({ children: '+7.5%' })).toBeTruthy();
  await ReactTestRenderer.act(() => renderer!.unmount());
});

test('shows active climb pill in free ride mode', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <EnduranceScreenOverlay
        visible
        distanceMeters={1_200}
        movingSeconds={240}
        terrainClimbStatus="active"
        terrainClimbAverageGradePercent={8.2}
        onWakeUp={jest.fn()}
        onDisableEndurance={jest.fn()}
      />,
    );
  });

  expect(renderer!.root.findByProps({ children: 'Tanjakan di Depan' })).toBeTruthy();
  expect(renderer!.root.findByProps({ children: '+8.2%' })).toBeTruthy();
  await ReactTestRenderer.act(() => renderer!.unmount());
});

