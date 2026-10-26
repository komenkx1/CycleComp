import {
  NavigationAudioCueManager,
  isSoundEnabled,
  setSoundEnabled,
  toggleSoundEnabled,
  playAudioCue,
} from '../src/features/audio/audioCueService';
import { Vibration } from 'react-native';

describe('audioCueService and NavigationAudioCueManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setSoundEnabled(true);
  });

  it('toggles sound on and off correctly', () => {
    expect(isSoundEnabled()).toBe(true);
    expect(toggleSoundEnabled()).toBe(false);
    expect(isSoundEnabled()).toBe(false);
    expect(toggleSoundEnabled()).toBe(true);
    expect(isSoundEnabled()).toBe(true);
  });

  it('does not trigger audio cue when sound is disabled', async () => {
    setSoundEnabled(false);
    const played = await playAudioCue('turn_approach');
    expect(played).toBe(false);
  });

  it('triggers haptic and native audio when sound is enabled', async () => {
    const vibrateSpy = jest.spyOn(Vibration, 'vibrate');
    const played = await playAudioCue('turn_approach');
    expect(played).toBe(true);
    expect(vibrateSpy).toHaveBeenCalledWith([0, 80, 60, 80]);
  });

  it('evaluates off-route and on-route cues without repeating on every frame', () => {
    const manager = new NavigationAudioCueManager();
    const vibrateSpy = jest.spyOn(Vibration, 'vibrate');

    // First time off-route
    manager.evaluateGuidance({ isOffRoute: true });
    expect(vibrateSpy).toHaveBeenCalledWith([0, 140, 90, 140, 90, 140]);

    vibrateSpy.mockClear();
    // Subsequent frames still off-route should NOT spam
    manager.evaluateGuidance({ isOffRoute: true });
    expect(vibrateSpy).not.toHaveBeenCalled();

    // Returning on-route
    manager.evaluateGuidance({ isOffRoute: false });
    expect(vibrateSpy).toHaveBeenCalledWith([0, 70, 70, 70]);
  });

  it('triggers turn approach at <=160m and imminent at <=35m', () => {
    const manager = new NavigationAudioCueManager();
    const vibrateSpy = jest.spyOn(Vibration, 'vibrate');
    const turnCoord: [number, number] = [115.2, -8.6];

    // Approaching turn at 300m -> no cue
    manager.evaluateGuidance({
      distanceToTurnMeters: 300,
      turnCoordinate: turnCoord,
      turnType: 'right',
    });
    expect(vibrateSpy).not.toHaveBeenCalled();

    // Approaching turn at 140m -> turn_approach cue
    manager.evaluateGuidance({
      distanceToTurnMeters: 140,
      turnCoordinate: turnCoord,
      turnType: 'right',
    });
    expect(vibrateSpy).toHaveBeenCalledWith([0, 80, 60, 80]);

    vibrateSpy.mockClear();
    // At 100m -> same turn, should NOT trigger approach again
    manager.evaluateGuidance({
      distanceToTurnMeters: 100,
      turnCoordinate: turnCoord,
      turnType: 'right',
    });
    expect(vibrateSpy).not.toHaveBeenCalled();

    // At 25m -> turn_imminent cue
    manager.evaluateGuidance({
      distanceToTurnMeters: 25,
      turnCoordinate: turnCoord,
      turnType: 'right',
    });
    expect(vibrateSpy).toHaveBeenCalledWith(220);
  });

  it('triggers climb approach and climb start cues', () => {
    const manager = new NavigationAudioCueManager();
    const vibrateSpy = jest.spyOn(Vibration, 'vibrate');

    // Upcoming climb at 200m
    manager.evaluateGuidance({
      climbType: 'upcoming',
      distanceToClimbMeters: 180,
      climbId: 1,
      currentTimeMs: 10_000,
    });
    expect(vibrateSpy).toHaveBeenCalledWith([0, 100, 70, 100]);

    vibrateSpy.mockClear();
    // Active climb start 10s later (outside MINIMUM_CUE_SEPARATION_MS)
    manager.evaluateGuidance({
      climbType: 'active',
      climbId: 1,
      currentTimeMs: 20_000,
    });
    expect(vibrateSpy).toHaveBeenCalledWith(280);
  });

  it('arbitrates audio cues by prioritizing imminent turn cues over climb cues', () => {
    const manager = new NavigationAudioCueManager();
    const vibrateSpy = jest.spyOn(Vibration, 'vibrate');
    const turnCoord: [number, number] = [115.2, -8.6];

    // Case 1: Both turn imminent (<=35m) and upcoming climb (180m) happen together
    manager.evaluateGuidance({
      distanceToTurnMeters: 25,
      turnCoordinate: turnCoord,
      turnType: 'right',
      climbType: 'upcoming',
      distanceToClimbMeters: 180,
      climbId: 1,
      currentTimeMs: 10_000,
    });

    // Only turn_imminent (220) should fire; climb_approach should be held
    expect(vibrateSpy).toHaveBeenCalledTimes(1);
    expect(vibrateSpy).toHaveBeenCalledWith(220);

    vibrateSpy.mockClear();

    // Case 2: Turn is past (now 500m), but within 2.5s window -> still hold climb cue
    manager.evaluateGuidance({
      distanceToTurnMeters: 500,
      turnCoordinate: [115.3, -8.7],
      turnType: 'left',
      climbType: 'upcoming',
      distanceToClimbMeters: 180,
      climbId: 1,
      currentTimeMs: 11_500, // only 1.5s later
    });
    expect(vibrateSpy).not.toHaveBeenCalled();

    // Case 3: After separation window expires (>= 2.5s later) -> climb cue can now play
    manager.evaluateGuidance({
      distanceToTurnMeters: 500,
      turnCoordinate: [115.3, -8.7],
      turnType: 'left',
      climbType: 'upcoming',
      distanceToClimbMeters: 180,
      climbId: 1,
      currentTimeMs: 13_000, // 3.0s later
    });
    expect(vibrateSpy).toHaveBeenCalledWith([0, 100, 70, 100]);
  });

  it('suppresses climb alerts when off-route', () => {
    const manager = new NavigationAudioCueManager();
    const vibrateSpy = jest.spyOn(Vibration, 'vibrate');

    manager.evaluateGuidance({
      isOffRoute: true,
      climbType: 'upcoming',
      distanceToClimbMeters: 180,
      climbId: 1,
    });

    // Only off-route alert should fire
    expect(vibrateSpy).toHaveBeenCalledWith([0, 140, 90, 140, 90, 140]);
  });
});
