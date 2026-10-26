import Foundation

struct RideSessionEvent: Codable {
  let kind: String
  let effectiveAt: Date
  let detectedAt: Date
}

enum RideMotionTiming {
  static let algorithmVersion = 3
  static func endingEvent(
    motionState: RideAutoPausePolicy.MotionState,
    lastLocationAt: Date?,
    at endTime: Date
  ) -> (kind: String, effectiveAt: Date)? {
    guard motionState != .unknown else { return nil }
    guard let lastLocationAt, lastLocationAt <= endTime else {
      return ("motion_unknown", endTime)
    }
    let knownThrough = lastLocationAt.addingTimeInterval(3)
    if endTime > knownThrough { return ("motion_unknown", knownThrough) }
    return motionState == .moving ? ("motion_stopped", endTime) : nil
  }

  static func unknownSeconds(
    events: [RideSessionEvent],
    startedAt: Date,
    lastLocationAt: Date?,
    at endTime: Date
  ) -> TimeInterval {
    var motionIsUnknown = true
    var timerIsRunning = true
    var intervalStart = startedAt
    var totalUnknownSeconds = 0.0
    let knownThrough = lastLocationAt.flatMap { $0 <= endTime ? $0.addingTimeInterval(3) : nil }

    func countUnknown(until intervalEnd: Date) -> TimeInterval {
      guard timerIsRunning else { return 0 }
      let unknownStartedAt = motionIsUnknown ? intervalStart : max(intervalStart, knownThrough ?? intervalStart)
      return max(0, intervalEnd.timeIntervalSince(unknownStartedAt))
    }

    let orderedEvents = events.sorted {
      if $0.effectiveAt != $1.effectiveAt { return $0.effectiveAt < $1.effectiveAt }
      return $0.detectedAt < $1.detectedAt
    }
    for event in orderedEvents where event.effectiveAt <= endTime {
      totalUnknownSeconds += countUnknown(until: event.effectiveAt)
      intervalStart = max(startedAt, event.effectiveAt)
      switch event.kind {
      case "motion_started", "motion_stopped":
        motionIsUnknown = false
      case "motion_unknown":
        motionIsUnknown = true
      case "manual_paused", "auto_paused", "recording_error_paused":
        timerIsRunning = false
        motionIsUnknown = true
      case "resumed":
        timerIsRunning = true
      case "finished":
        timerIsRunning = false
      default:
        break
      }
    }
    totalUnknownSeconds += countUnknown(until: endTime)
    return totalUnknownSeconds
  }
}

struct RideElapsedTime: Codable {
  var accumulatedSeconds: TimeInterval = 0
  var runningSince: Date?

  func seconds(at now: Date) -> TimeInterval {
    accumulatedSeconds + (runningSince.map { max(0, now.timeIntervalSince($0)) } ?? 0)
  }

  mutating func pause(at now: Date) {
    accumulatedSeconds = seconds(at: now)
    runningSince = nil
  }

  mutating func resume(at now: Date) {
    if runningSince == nil { runningSince = now }
  }

  func checkpoint(at now: Date) -> RideElapsedTime {
    RideElapsedTime(accumulatedSeconds: seconds(at: now), runningSince: runningSince == nil ? nil : now)
  }
}
