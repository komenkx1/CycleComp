import Foundation

@main struct RideTimingCheck {
  static func main() throws {
    let start = Date(timeIntervalSince1970: 1_000)
    var clock = RideElapsedTime(runningSince: start)
    clock.pause(at: start.addingTimeInterval(10))
    precondition(clock.seconds(at: start.addingTimeInterval(100)) == 10)
    clock.resume(at: start.addingTimeInterval(100))
    clock.resume(at: start.addingTimeInterval(105))
    precondition(clock.seconds(at: start.addingTimeInterval(110)) == 20)
    let checkpoint = clock.checkpoint(at: start.addingTimeInterval(110))
    var recovered = try JSONDecoder().decode(RideElapsedTime.self, from: JSONEncoder().encode(checkpoint))
    recovered.runningSince = nil
    precondition(recovered.seconds(at: start.addingTimeInterval(10_000)) == 20)
    recovered.resume(at: start.addingTimeInterval(10_000))
    precondition(recovered.seconds(at: start.addingTimeInterval(10_005)) == 25)

    var policy = RideAutoPausePolicy()
    var confirmedStop: RideAutoPausePolicy.Transition?
    for second in 0...2 {
      confirmedStop = policy.observe(
        speedMetersPerSecond: 0.05,
        horizontalAccuracyMeters: 5,
        speedAccuracyMetersPerSecond: 0.3,
        displacementSincePreviousMeters: 0.1,
        timestamp: start.addingTimeInterval(Double(second))
      ) ?? confirmedStop
    }
    guard case let .stoppedMoving(at: stoppedAt)? = confirmedStop else {
      preconditionFailure("Three clean near-zero fixes should confirm a stop")
    }
    precondition(stoppedAt == start)

    let resumeStartedAt = start.addingTimeInterval(3)
    _ = policy.observe(
      speedMetersPerSecond: 2,
      horizontalAccuracyMeters: 5,
      speedAccuracyMetersPerSecond: 0.3,
      displacementSincePreviousMeters: 2,
      timestamp: resumeStartedAt
    )
    guard case let .startedMoving(at: movementStartedAt)? = policy.observe(
      speedMetersPerSecond: 2,
      horizontalAccuracyMeters: 5,
      speedAccuracyMetersPerSecond: 0.3,
      displacementSincePreviousMeters: 2,
      timestamp: resumeStartedAt.addingTimeInterval(1)
    ) else { preconditionFailure("Two moving fixes should resume the ride") }
    precondition(movementStartedAt == resumeStartedAt)

    _ = policy.observe(
      speedMetersPerSecond: 0.05,
      horizontalAccuracyMeters: 5,
      speedAccuracyMetersPerSecond: 0.3,
      displacementSincePreviousMeters: 0,
      timestamp: start.addingTimeInterval(5)
    )
    guard case let .becameUnknown(at: unknownAt)? = policy.observe(
      speedMetersPerSecond: 2,
      horizontalAccuracyMeters: 5,
      speedAccuracyMetersPerSecond: 0.3,
      displacementSincePreviousMeters: 5,
      timestamp: start.addingTimeInterval(10)
    ) else { preconditionFailure("A long fix gap should make motion unknown") }
    precondition(unknownAt == start.addingTimeInterval(8))

    var missingSpeedPolicy = RideAutoPausePolicy()
    _ = missingSpeedPolicy.observe(
      speedMetersPerSecond: 2,
      horizontalAccuracyMeters: 5,
      speedAccuracyMetersPerSecond: 0.3,
      displacementSincePreviousMeters: 2,
      timestamp: start.addingTimeInterval(20)
    )
    _ = missingSpeedPolicy.observe(
      speedMetersPerSecond: 2,
      horizontalAccuracyMeters: 5,
      speedAccuracyMetersPerSecond: 0.3,
      displacementSincePreviousMeters: 2,
      timestamp: start.addingTimeInterval(21)
    )
    var missingSpeedTransition: RideAutoPausePolicy.Transition?
    for second in 22...25 {
      missingSpeedTransition = missingSpeedPolicy.observe(
        speedMetersPerSecond: nil,
        horizontalAccuracyMeters: 5,
        speedAccuracyMetersPerSecond: -1,
        displacementSincePreviousMeters: 0,
        timestamp: start.addingTimeInterval(Double(second))
      ) ?? missingSpeedTransition
    }
    guard case let .becameUnknown(at: missingSpeedAt)? = missingSpeedTransition else {
      preconditionFailure("Sustained invalid speed evidence should become unknown")
    }
    precondition(missingSpeedAt == start.addingTimeInterval(22))

    checkMotionEvidenceExpiration()
    checkUnknownMotionIntervals()
    print("Timer checkpoint, stop/resume hysteresis, invalid/stale locations, and unknown-motion checks passed")
  }

  private static func checkMotionEvidenceExpiration() {
    let locationTime = Date(timeIntervalSince1970: 1_000)
    let freshEnd = locationTime.addingTimeInterval(3)
    let staleEnd = locationTime.addingTimeInterval(90)
    let freshClosure = RideMotionTiming.endingEvent(
      motionState: .moving, lastLocationAt: locationTime, at: freshEnd
    )
    precondition(freshClosure?.kind == "motion_stopped" && freshClosure?.effectiveAt == freshEnd)
    for motionState in [RideAutoPausePolicy.MotionState.moving, .stationary] {
      let expiredClosure = RideMotionTiming.endingEvent(
        motionState: motionState, lastLocationAt: locationTime, at: staleEnd
      )
      precondition(expiredClosure?.kind == "motion_unknown" && expiredClosure?.effectiveAt == freshEnd)
    }
    precondition(RideMotionTiming.endingEvent(
      motionState: .stationary, lastLocationAt: locationTime, at: freshEnd
    ) == nil)
    precondition(RideMotionTiming.endingEvent(
      motionState: .unknown, lastLocationAt: locationTime, at: staleEnd
    ) == nil)
    let missingFixClosure = RideMotionTiming.endingEvent(
      motionState: .moving, lastLocationAt: nil, at: staleEnd
    )
    precondition(missingFixClosure?.kind == "motion_unknown")
    let futureFixClosure = RideMotionTiming.endingEvent(
      motionState: .moving, lastLocationAt: staleEnd.addingTimeInterval(1), at: staleEnd
    )
    precondition(futureFixClosure?.kind == "motion_unknown")
  }

  private static func checkUnknownMotionIntervals() {
    let startedAt = Date(timeIntervalSince1970: 1_000)
    func event(_ kind: String, _ second: Double) -> RideSessionEvent {
      let occurredAt = startedAt.addingTimeInterval(second)
      return RideSessionEvent(kind: kind, effectiveAt: occurredAt, detectedAt: occurredAt)
    }
    func unknown(_ events: [RideSessionEvent], lastFixSecond: Double?, endSecond: Double) -> Double {
      RideMotionTiming.unknownSeconds(
        events: events, startedAt: startedAt,
        lastLocationAt: lastFixSecond.map { startedAt.addingTimeInterval($0) },
        at: startedAt.addingTimeInterval(endSecond)
      )
    }
    precondition(unknown([event("motion_started", 0)], lastFixSecond: 20, endSecond: 20) == 0)
    precondition(unknown([event("motion_started", 0)], lastFixSecond: 10, endSecond: 100) == 87)
    precondition(unknown([event("motion_stopped", 0)], lastFixSecond: 10, endSecond: 100) == 87)
    precondition(unknown([
      event("motion_started", 0), event("motion_unknown", 13), event("finished", 100),
    ], lastFixSecond: 10, endSecond: 100) == 87)
    precondition(unknown([
      event("motion_started", 0), event("manual_paused", 20),
      event("resumed", 40), event("motion_started", 43),
    ], lastFixSecond: 50, endSecond: 60) == 10)
    precondition(unknown([
      event("motion_started", 0), event("auto_paused", 20), event("motion_unknown", 25),
      event("motion_started", 40), event("resumed", 40),
    ], lastFixSecond: 50, endSecond: 60) == 7)
    precondition(unknown([
      event("motion_started", 0), event("recording_error_paused", 20),
      event("resumed", 40), event("motion_started", 42),
    ], lastFixSecond: 50, endSecond: 60) == 9)
    precondition(unknown([], lastFixSecond: nil, endSecond: 60) == 60)
    precondition(unknown([event("motion_started", 0)], lastFixSecond: 61, endSecond: 60) == 60)
    precondition(unknown([
      event("manual_paused", 20), event("resumed", 40),
    ], lastFixSecond: nil, endSecond: 60) == 40)
  }
}
