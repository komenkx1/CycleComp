import { NativeModules, Vibration } from 'react-native';

export type AudioCueType =
  | 'turn_approach'
  | 'turn_imminent'
  | 'off_route'
  | 'on_route'
  | 'climb_approach'
  | 'climb_start'
  | 'click';

let soundEnabled = true;

export function isSoundEnabled(): boolean {
  return soundEnabled;
}

export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled;
}

export function toggleSoundEnabled(): boolean {
  soundEnabled = !soundEnabled;
  return soundEnabled;
}

/**
 * Memainkan suara khas Garmin + haptic vibration feedback.
 */
export async function playAudioCue(cue: AudioCueType): Promise<boolean> {
  if (!soundEnabled) {
    return false;
  }

  // 1. Trigger haptic vibration di semua platform
  triggerHaptic(cue);

  // 2. Mainkan native system sound iOS via RideTracking module
  try {
    const RideTrackingModule = NativeModules.RideTracking;
    if (RideTrackingModule && typeof RideTrackingModule.playAudioCue === 'function') {
      await RideTrackingModule.playAudioCue(cue);
      return true;
    }
  } catch {
    // Graceful fallback jika modul native belum siap
  }

  return true;
}

function triggerHaptic(cue: AudioCueType): void {
  try {
    switch (cue) {
      case 'turn_approach':
        Vibration.vibrate([0, 80, 60, 80]);
        break;
      case 'turn_imminent':
        Vibration.vibrate(220);
        break;
      case 'off_route':
        Vibration.vibrate([0, 140, 90, 140, 90, 140]);
        break;
      case 'on_route':
        Vibration.vibrate([0, 70, 70, 70]);
        break;
      case 'climb_approach':
        Vibration.vibrate([0, 100, 70, 100]);
        break;
      case 'climb_start':
        Vibration.vibrate(280);
        break;
      case 'click':
      default:
        Vibration.vibrate(40);
        break;
    }
  } catch {
    // Ignore haptic errors on unsupported environments
  }
}

/**
 * State evaluator untuk mencegah spam audio cue yang berulang untuk belokan yang sama.
 */
export class NavigationAudioCueManager {
  public static readonly MINIMUM_CUE_SEPARATION_MS = 2500;

  private lastTurnKey: string | null = null;
  private playedApproachForTurn = false;
  private playedImminentForTurn = false;
  private isCurrentlyOffRoute = false;
  private lastClimbKey: string | null = null;
  private playedApproachForClimb = false;
  private playedStartForClimb = false;
  private lastCueTimestampMs = 0;

  public reset(): void {
    this.lastTurnKey = null;
    this.playedApproachForTurn = false;
    this.playedImminentForTurn = false;
    this.isCurrentlyOffRoute = false;
    this.lastClimbKey = null;
    this.playedApproachForClimb = false;
    this.playedStartForClimb = false;
    this.lastCueTimestampMs = 0;
  }

  /**
   * Mengevaluasi kondisi navigasi & tanjakan secara berkala dan memicu suara yang tepat
   * dengan wasit prioritas (Audio Arbiter) untuk mencegah tabrakan audio turn vs climb.
   */
  public evaluateGuidance({
    distanceToTurnMeters,
    turnCoordinate,
    turnType,
    isOffRoute,
    climbType,
    distanceToClimbMeters,
    climbId,
    currentTimeMs = Date.now(),
  }: {
    distanceToTurnMeters?: number | null;
    turnCoordinate?: [number, number] | null;
    turnType?: string | null;
    isOffRoute?: boolean;
    climbType?: 'none' | 'upcoming' | 'active';
    distanceToClimbMeters?: number | null;
    climbId?: string | number | null;
    currentTimeMs?: number;
  }): void {
    // 1. Off-Route & On-Route Alerts (Prioritas tertinggi keselamatan)
    if (isOffRoute && !this.isCurrentlyOffRoute) {
      this.isCurrentlyOffRoute = true;
      this.lastCueTimestampMs = currentTimeMs;
      playAudioCue('off_route');
      return;
    } else if (!isOffRoute && this.isCurrentlyOffRoute) {
      this.isCurrentlyOffRoute = false;
      this.lastCueTimestampMs = currentTimeMs;
      playAudioCue('on_route');
    }

    if (isOffRoute) {
      // Saat off-route, jangan membunyikan alert tanjakan atau belokan rute
      return;
    }

    let turnAlertFired = false;

    // 2. Turn Approaching & Turn Imminent Alerts (Prioritas manuver navigasi)
    if (turnCoordinate && turnType && turnType !== 'straight' && turnType !== 'finish') {
      const turnKey = `${turnCoordinate[0].toFixed(5)},${turnCoordinate[1].toFixed(5)}`;

      if (this.lastTurnKey !== turnKey) {
        this.lastTurnKey = turnKey;
        this.playedApproachForTurn = false;
        this.playedImminentForTurn = false;
      }

      if (typeof distanceToTurnMeters === 'number') {
        // Warning 150m (Turn Approach)
        if (distanceToTurnMeters <= 160 && distanceToTurnMeters > 35 && !this.playedApproachForTurn) {
          this.playedApproachForTurn = true;
          this.lastCueTimestampMs = currentTimeMs;
          turnAlertFired = true;
          playAudioCue('turn_approach');
        }

        // Warning <= 35m (Sekarang Berbelok)
        if (distanceToTurnMeters <= 35 && !this.playedImminentForTurn) {
          this.playedImminentForTurn = true;
          this.lastCueTimestampMs = currentTimeMs;
          turnAlertFired = true;
          playAudioCue('turn_imminent');
        }
      }
    }

    // 3. Audio Arbiter Guard:
    // Jika manuver belokan baru saja dibunyikan, atau belokan <= 40m (sedang berbelok),
    // atau baru saja ada suara dalam waktu MINIMUM_CUE_SEPARATION_MS, tunda alert tanjakan.
    const isTurnImminent = typeof distanceToTurnMeters === 'number' && distanceToTurnMeters <= 40;
    const isWithinSeparationWindow =
      currentTimeMs - this.lastCueTimestampMs < NavigationAudioCueManager.MINIMUM_CUE_SEPARATION_MS;

    if (turnAlertFired || isTurnImminent || isWithinSeparationWindow) {
      return;
    }

    // 4. Climb Alerts (ClimbPro Style)
    if (climbType === 'upcoming' && climbId !== undefined && climbId !== null) {
      const climbKey = String(climbId);
      if (this.lastClimbKey !== climbKey) {
        this.lastClimbKey = climbKey;
        this.playedApproachForClimb = false;
        this.playedStartForClimb = false;
      }

      if (
        typeof distanceToClimbMeters === 'number' &&
        distanceToClimbMeters <= 220 &&
        !this.playedApproachForClimb
      ) {
        this.playedApproachForClimb = true;
        this.lastCueTimestampMs = currentTimeMs;
        playAudioCue('climb_approach');
      }
    } else if (climbType === 'active' && climbId !== undefined && climbId !== null) {
      const climbKey = String(climbId);
      if (this.lastClimbKey === climbKey && !this.playedStartForClimb) {
        this.playedStartForClimb = true;
        this.lastCueTimestampMs = currentTimeMs;
        playAudioCue('climb_start');
      }
    }
  }
}
