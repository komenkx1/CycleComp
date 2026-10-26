import Foundation

struct RideAutoPausePolicy {
  enum MotionState: String, Codable {
    case unknown
    case moving
    case stationary
  }

  enum Transition {
    case startedMoving(at: Date)
    case stoppedMoving(at: Date)
    case becameUnknown(at: Date)
  }

  private var motionState = MotionState.unknown
  private var stationaryCandidateAt: Date?
  private var stationaryCandidateCount = 0
  private var movementCandidateAt: Date?
  private var movementCandidateCount = 0
  private var movementCandidateDistance = 0.0
  private var lastSampleAt: Date?
  private var invalidEvidenceStartedAt: Date?
  private var stationaryCandidateCoordinate: (latitude: Double, longitude: Double)?
  private var previousCoordinate: (latitude: Double, longitude: Double)?
  private var movementCandidateOrigin: (latitude: Double, longitude: Double)?

  mutating func reset() {
    motionState = .unknown
    stationaryCandidateAt = nil
    stationaryCandidateCount = 0
    movementCandidateAt = nil
    movementCandidateCount = 0
    movementCandidateDistance = 0
    lastSampleAt = nil
    invalidEvidenceStartedAt = nil
    stationaryCandidateCoordinate = nil
    previousCoordinate = nil
    movementCandidateOrigin = nil
  }

  mutating func observe(
    speedMetersPerSecond: Double?,
    horizontalAccuracyMeters: Double,
    speedAccuracyMetersPerSecond: Double,
    displacementSincePreviousMeters: Double,
    timestamp: Date,
    positionSpeedMetersPerSecond: Double? = nil,
    positionSpeedWindowStartedAt: Date? = nil,
    latitude: Double? = nil,
    longitude: Double? = nil,
    motionActivityIsStationary: Bool = false
  ) -> Transition? {
    if let lastSampleAt {
      guard timestamp > lastSampleAt else { return nil }
      let sampleGap = timestamp.timeIntervalSince(lastSampleAt)
      if sampleGap > 3 {
        motionState = .unknown
        resetCandidates()
        invalidEvidenceStartedAt = nil
        previousCoordinate = nil
        self.lastSampleAt = timestamp
        return .becameUnknown(at: lastSampleAt.addingTimeInterval(3))
      }
    }
    lastSampleAt = timestamp
    let currentCoordinate: (latitude: Double, longitude: Double)? = {
      guard let latitude, let longitude, latitude.isFinite, longitude.isFinite,
            (-90...90).contains(latitude), (-180...180).contains(longitude) else { return nil }
      return (latitude, longitude)
    }()
    let previousCoordinate = self.previousCoordinate
    self.previousCoordinate = currentCoordinate

    let horizontalEvidenceIsValid = horizontalAccuracyMeters.isFinite && horizontalAccuracyMeters >= 0 &&
      horizontalAccuracyMeters <= 20 && displacementSincePreviousMeters.isFinite &&
      displacementSincePreviousMeters >= 0
    let gpsSpeedEvidenceIsValid = speedAccuracyMetersPerSecond.isFinite &&
      speedAccuracyMetersPerSecond >= 0 && speedAccuracyMetersPerSecond <= 4.5 &&
      speedMetersPerSecond.map { $0.isFinite && $0 >= 0 && $0 <= 40 } == true
    let positionSpeedEvidenceIsValid = positionSpeedMetersPerSecond.map {
      $0.isFinite && $0 >= 0.25 && $0 <= 40
    } == true
    guard horizontalEvidenceIsValid else { return observeInvalidEvidence(at: timestamp) }
    guard gpsSpeedEvidenceIsValid, let speedMetersPerSecond else {
      guard positionSpeedEvidenceIsValid, let positionSpeedMetersPerSecond else {
        return observeInvalidEvidence(at: timestamp)
      }
      invalidEvidenceStartedAt = nil
      return observePositionSpeed(
        positionSpeedMetersPerSecond,
        windowStartedAt: positionSpeedWindowStartedAt ?? timestamp,
        displacementMeters: displacementSincePreviousMeters,
        timestamp: timestamp
      )
    }
    invalidEvidenceStartedAt = nil

    let lowSpeedStop = speedMetersPerSecond <= 0.35 &&
      displacementSincePreviousMeters <= 2.0 &&
      horizontalAccuracyMeters <= 20 &&
      currentCoordinate != nil
    let preciseStop = speedMetersPerSecond <= 0.15 && speedAccuracyMetersPerSecond <= 1.0
    let activitySupportedStop = motionActivityIsStationary &&
      speedMetersPerSecond <= 0.5 && speedAccuracyMetersPerSecond <= 2.0 &&
      horizontalAccuracyMeters <= 12 && currentCoordinate != nil
    if preciseStop || activitySupportedStop || lowSpeedStop {
      resetMovementCandidate()
      if let currentCoordinate {
        if let candidateCoordinate = stationaryCandidateCoordinate,
           coordinateDistanceMeters(from: candidateCoordinate, to: currentCoordinate) > max(3, horizontalAccuracyMeters * 0.6) {
          stationaryCandidateAt = nil
          stationaryCandidateCount = 0
          stationaryCandidateCoordinate = nil
        }
        stationaryCandidateCoordinate = stationaryCandidateCoordinate ?? currentCoordinate
      }
      stationaryCandidateAt = stationaryCandidateAt ?? timestamp
      stationaryCandidateCount += 1
      if stationaryCandidateCount >= 3,
         timestamp.timeIntervalSince(stationaryCandidateAt ?? timestamp) >= (preciseStop ? 1.5 : 2.5),
         motionState != .stationary {
        let stoppedAt = stationaryCandidateAt ?? timestamp
        motionState = .stationary
        stationaryCandidateAt = nil
        stationaryCandidateCount = 0
        stationaryCandidateCoordinate = nil
        return .stoppedMoving(at: stoppedAt)
      }
      return nil
    }

    stationaryCandidateAt = nil
    stationaryCandidateCount = 0
    stationaryCandidateCoordinate = nil

    let isFastEnoughToConfirm = speedMetersPerSecond >= 0.7
    let isSlowRollWithLocationEvidence = speedMetersPerSecond >= 0.25 &&
      displacementSincePreviousMeters >= 0.2
    guard isFastEnoughToConfirm || isSlowRollWithLocationEvidence else {
      resetMovementCandidate()
      return nil
    }

    guard motionState != .moving else {
      resetMovementCandidate()
      return nil
    }

    if movementCandidateAt == nil {
      movementCandidateAt = timestamp
      movementCandidateOrigin = previousCoordinate
    }
    movementCandidateCount += 1
    movementCandidateDistance += displacementSincePreviousMeters

    let candidateDuration = timestamp.timeIntervalSince(movementCandidateAt ?? timestamp)
    let movementIsSupportedByPosition: Bool
    if motionState == .stationary,
       let movementCandidateOrigin, let currentCoordinate {
      let netDisplacementMeters = coordinateDistanceMeters(from: movementCandidateOrigin, to: currentCoordinate)
      let minimumDisplacementMeters = motionActivityIsStationary
        ? max(5, horizontalAccuracyMeters)
        : max(2, horizontalAccuracyMeters * 0.5)
      movementIsSupportedByPosition = netDisplacementMeters >= minimumDisplacementMeters
    } else {
      movementIsSupportedByPosition = true
    }
    let fastMovementConfirmed = isFastEnoughToConfirm && movementCandidateCount >= 2 &&
      candidateDuration >= 1 && movementIsSupportedByPosition
    let slowMovementConfirmed = isSlowRollWithLocationEvidence && movementCandidateCount >= 3 &&
      candidateDuration >= 2 && movementCandidateDistance >= 0.75 && movementIsSupportedByPosition

    guard motionState != .moving, fastMovementConfirmed || slowMovementConfirmed else { return nil }
    let startedAt = movementCandidateAt ?? timestamp
    motionState = .moving
    resetCandidates()
    return .startedMoving(at: startedAt)
  }

  private mutating func observeInvalidEvidence(at timestamp: Date) -> Transition? {
    resetCandidates()
    if motionState == .moving {
      invalidEvidenceStartedAt = invalidEvidenceStartedAt ?? timestamp
      if timestamp.timeIntervalSince(invalidEvidenceStartedAt ?? timestamp) >= 3 {
        let unknownAt = invalidEvidenceStartedAt ?? timestamp
        motionState = .unknown
        invalidEvidenceStartedAt = nil
        return .becameUnknown(at: unknownAt)
      }
    } else {
      invalidEvidenceStartedAt = nil
    }
    return nil
  }

  private mutating func observePositionSpeed(
    _ speedMetersPerSecond: Double,
    windowStartedAt: Date,
    displacementMeters: Double,
    timestamp: Date
  ) -> Transition? {
    stationaryCandidateAt = nil
    stationaryCandidateCount = 0
    guard motionState != .moving else { return nil }

    if movementCandidateAt == nil { movementCandidateAt = windowStartedAt }
    movementCandidateCount += 1
    movementCandidateDistance += displacementMeters

    let candidateDuration = timestamp.timeIntervalSince(movementCandidateAt ?? timestamp)
    let fastMovementConfirmed = speedMetersPerSecond >= 0.7 &&
      movementCandidateCount >= 2 && candidateDuration >= 1
    let slowMovementConfirmed = movementCandidateCount >= 3 && candidateDuration >= 2 &&
      movementCandidateDistance >= 0.75
    guard fastMovementConfirmed || slowMovementConfirmed else { return nil }

    let startedAt = movementCandidateAt ?? windowStartedAt
    motionState = .moving
    resetCandidates()
    return .startedMoving(at: startedAt)
  }

  var state: MotionState { motionState }

  private mutating func resetCandidates() {
    stationaryCandidateAt = nil
    stationaryCandidateCount = 0
    stationaryCandidateCoordinate = nil
    resetMovementCandidate()
  }

  private mutating func resetMovementCandidate() {
    movementCandidateAt = nil
    movementCandidateCount = 0
    movementCandidateDistance = 0
    movementCandidateOrigin = nil
  }

  private func coordinateDistanceMeters(
    from start: (latitude: Double, longitude: Double),
    to end: (latitude: Double, longitude: Double)
  ) -> Double {
    let latitudeDifference = (end.latitude - start.latitude) * .pi / 180
    let longitudeDifference = (end.longitude - start.longitude) * .pi / 180
    let startLatitude = start.latitude * .pi / 180
    let endLatitude = end.latitude * .pi / 180
    let haversine = pow(sin(latitudeDifference / 2), 2) +
      cos(startLatitude) * cos(endLatitude) * pow(sin(longitudeDifference / 2), 2)
    return 2 * 6_371_000 * asin(min(1, sqrt(haversine)))
  }
}
