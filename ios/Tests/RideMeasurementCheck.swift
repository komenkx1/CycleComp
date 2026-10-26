import Foundation

@main struct RideMeasurementCheck {
  static func main() {
    let rideStart = Date(timeIntervalSince1970: 1_000)
    checkStopAndResumeTiming(from: rideStart)
    checkSpeedSmoothing(from: rideStart)
    checkMotionSupportedStopAndShake(from: rideStart)
    checkLowSpeedStopWithoutStationaryMotion(from: rideStart)
    checkPositionSpeedFallback(from: rideStart)
    checkSignedBarometerFusion(from: rideStart)
    checkSimulatedBarometer(from: rideStart)
    checkRelativeBarometerAscent()
    checkSignedLiveGrade(from: rideStart)
    checkSlowRollAndUnanchoredAltitude(from: rideStart)
    checkElevationQualitySummary()
    print("Ride motion, speed, altitude, and signed grade checks passed")
  }

  private static func checkPositionSpeedFallback(from rideStart: Date) {
    var estimator = RidePositionSpeedEstimator()
    var estimate: RidePositionSpeedEstimate?
    for sampleIndex in 0...3 {
      let distanceMeters = Double(sampleIndex) * 5
      estimate = estimator.update(
        latitude: -8.65 + distanceMeters / 111_000,
        longitude: 115.2167,
        horizontalAccuracyMeters: 5,
        at: rideStart.addingTimeInterval(Double(sampleIndex))
      ) ?? estimate
    }
    precondition(abs((estimate?.speedMetersPerSecond ?? 0) - 5) < 0.1)
    precondition(estimate?.windowStartedAt == rideStart.addingTimeInterval(1))

    var jitterEstimator = RidePositionSpeedEstimator()
    for (sampleIndex, jitterMeters) in [0.0, 1.0, -1.0, 0.5].enumerated() {
      let jitterEstimate = jitterEstimator.update(
        latitude: -8.65 + jitterMeters / 111_000,
        longitude: 115.2167,
        horizontalAccuracyMeters: 5,
        at: rideStart.addingTimeInterval(Double(sampleIndex))
      )
      precondition(jitterEstimate == nil)
    }

    var policy = RideAutoPausePolicy()
    var movingEstimator = RidePositionSpeedEstimator()
    var movementTransition: RideAutoPausePolicy.Transition?
    for sampleIndex in 0...4 {
      let distanceMeters = Double(sampleIndex) * 5
      let sampleTime = rideStart.addingTimeInterval(Double(sampleIndex))
      let positionSpeed = movingEstimator.update(
        latitude: -8.65 + distanceMeters / 111_000,
        longitude: 115.2167,
        horizontalAccuracyMeters: 5,
        at: sampleTime
      )
      movementTransition = policy.observe(
        speedMetersPerSecond: nil,
        horizontalAccuracyMeters: 5,
        speedAccuracyMetersPerSecond: -1,
        displacementSincePreviousMeters: 5,
        timestamp: sampleTime,
        positionSpeedMetersPerSecond: positionSpeed?.speedMetersPerSecond,
        positionSpeedWindowStartedAt: positionSpeed?.windowStartedAt
      ) ?? movementTransition
    }
    guard case let .startedMoving(at: movementStart)? = movementTransition else {
      preconditionFailure("Clean position windows should confirm movement when GPS speed accuracy is unavailable")
    }
    precondition(movementStart == rideStart)
  }

  private static func checkElevationQualitySummary() {
    precondition(rideElevationQualitySummary(elevationSources: [], anchorQualities: []) == "unavailable")
    precondition(rideElevationQualitySummary(
      elevationSources: [nil, nil],
      anchorQualities: ["unavailable", "unavailable"]
    ) == "unavailable")
    precondition(rideElevationQualitySummary(
      elevationSources: ["gps", "gps"],
      anchorQualities: ["gps", "gps"]
    ) == "gps")
    precondition(rideElevationQualitySummary(
      elevationSources: [nil, nil],
      anchorQualities: ["unanchored", "unanchored"]
    ) == "barometer_relative")
    precondition(rideElevationQualitySummary(
      elevationSources: ["barometer_gps", "barometer_gps"],
      anchorQualities: ["calibrated", "calibrated"]
    ) == "barometer_calibrated")
    precondition(rideElevationQualitySummary(
      elevationSources: ["gps", nil],
      anchorQualities: ["gps", "unanchored"]
    ) == "mixed")
  }

  private static func checkStopAndResumeTiming(from rideStart: Date) {
    var policy = RideAutoPausePolicy()
    let stationaryTimes = [0.0, 1.0, 2.0].compactMap { offset in
      policy.observe(
        speedMetersPerSecond: 0.05,
        horizontalAccuracyMeters: 4,
        speedAccuracyMetersPerSecond: 0.2,
        displacementSincePreviousMeters: 0.1,
        timestamp: rideStart.addingTimeInterval(offset)
      )
    }
    guard case let .stoppedMoving(at: stoppedAt)? = stationaryTimes.last else {
      preconditionFailure("A stable stop should be confirmed after three clean fixes")
    }
    precondition(stoppedAt == rideStart)

    let resumedAt = rideStart.addingTimeInterval(3)
    precondition(policy.observe(
      speedMetersPerSecond: 2,
      horizontalAccuracyMeters: 4,
      speedAccuracyMetersPerSecond: 0.3,
      displacementSincePreviousMeters: 2,
      timestamp: resumedAt
    ) == nil)
    guard case let .startedMoving(at: movementStart)? = policy.observe(
      speedMetersPerSecond: 2,
      horizontalAccuracyMeters: 4,
      speedAccuracyMetersPerSecond: 0.3,
      displacementSincePreviousMeters: 2,
      timestamp: resumedAt.addingTimeInterval(1)
    ) else { preconditionFailure("Two clean moving fixes should resume the ride") }
    precondition(movementStart == resumedAt)

    policy.reset()
    for second in 20...22 {
      _ = policy.observe(
        speedMetersPerSecond: 0.05,
        horizontalAccuracyMeters: 50,
        speedAccuracyMetersPerSecond: 0.2,
        displacementSincePreviousMeters: 0,
        timestamp: rideStart.addingTimeInterval(Double(second))
      )
    }
    precondition(policy.state == .unknown)
  }

  private static func checkSpeedSmoothing(from rideStart: Date) {
    var smoother = RideSpeedSmoother()
    precondition(smoother.update(speedMetersPerSecond: 10, at: rideStart, stationary: false) == 10)
    let filteredSpeed = smoother.update(
      speedMetersPerSecond: 8,
      at: rideStart.addingTimeInterval(1),
      stationary: false
    )
    precondition((filteredSpeed ?? 0) < 10 && (filteredSpeed ?? 0) > 8)
    precondition(smoother.update(speedMetersPerSecond: 0.04, at: rideStart.addingTimeInterval(2), stationary: true) == 0)

    smoother.reset()
    precondition(smoother.update(speedMetersPerSecond: 5, at: rideStart, stationary: false) == 5)
    precondition(smoother.update(speedMetersPerSecond: nil, at: rideStart.addingTimeInterval(1), stationary: false) == 5)
    precondition(smoother.update(speedMetersPerSecond: nil, at: rideStart.addingTimeInterval(2), stationary: false) == 5)
    precondition(smoother.update(speedMetersPerSecond: nil, at: rideStart.addingTimeInterval(3), stationary: false) == 5)
    precondition(smoother.update(speedMetersPerSecond: nil, at: rideStart.addingTimeInterval(4), stationary: false) == 5)
    precondition(smoother.update(speedMetersPerSecond: nil, at: rideStart.addingTimeInterval(5), stationary: false) == nil)
    precondition(smoother.update(speedMetersPerSecond: 4, at: rideStart.addingTimeInterval(6), stationary: false) == 4)
  }

  private static func checkLowSpeedStopWithoutStationaryMotion(from rideStart: Date) {
    var policy = RideAutoPausePolicy()
    _ = policy.observe(
      speedMetersPerSecond: 5.0,
      horizontalAccuracyMeters: 5,
      speedAccuracyMetersPerSecond: 1.0,
      displacementSincePreviousMeters: 5.0,
      timestamp: rideStart,
      latitude: -8.65,
      longitude: 115.2167,
      motionActivityIsStationary: false
    )
    _ = policy.observe(
      speedMetersPerSecond: 5.0,
      horizontalAccuracyMeters: 5,
      speedAccuracyMetersPerSecond: 1.0,
      displacementSincePreviousMeters: 5.0,
      timestamp: rideStart.addingTimeInterval(1),
      latitude: -8.65005,
      longitude: 115.2167,
      motionActivityIsStationary: false
    )
    precondition(policy.state == .moving)

    var stoppedAt: Date?
    for second in 2...5 {
      let sampleTime = rideStart.addingTimeInterval(Double(second))
      let transition = policy.observe(
        speedMetersPerSecond: 0.15,
        horizontalAccuracyMeters: 6,
        speedAccuracyMetersPerSecond: 3.8,
        displacementSincePreviousMeters: 0.2,
        timestamp: sampleTime,
        latitude: -8.65005,
        longitude: 115.2167,
        motionActivityIsStationary: false
      )
      if case let .stoppedMoving(at: confirmedAt)? = transition {
        stoppedAt = confirmedAt
      }
    }
    precondition(stoppedAt == rideStart.addingTimeInterval(2), "Low speed stop should confirm stop even when speedAccuracy is noisy and motion is not stationary")
    precondition(policy.state == .stationary)
  }

  private static func checkMotionSupportedStopAndShake(from rideStart: Date) {
    let latitude = -8.65
    let longitude = 115.2167
    var policy = RideAutoPausePolicy()
    var stoppedAt: Date?
    for (second, offsetMeters) in [0.0, 0.4, -0.3, 0.2].enumerated() {
      let sampleTime = rideStart.addingTimeInterval(Double(second))
      let transition = policy.observe(
        speedMetersPerSecond: 0.32,
        horizontalAccuracyMeters: 4,
        speedAccuracyMetersPerSecond: 0.6,
        displacementSincePreviousMeters: 0.7,
        timestamp: sampleTime,
        latitude: latitude + offsetMeters / 111_000,
        longitude: longitude,
        motionActivityIsStationary: true
      )
      if case let .stoppedMoving(at: confirmedAt)? = transition { stoppedAt = confirmedAt }
    }
    precondition(stoppedAt == rideStart)

    var rollingPolicy = RideAutoPausePolicy()
    for second in 0...5 {
      let transition = rollingPolicy.observe(
        speedMetersPerSecond: 0.32,
        horizontalAccuracyMeters: 4,
        speedAccuracyMetersPerSecond: 0.6,
        displacementSincePreviousMeters: 1.2,
        timestamp: rideStart.addingTimeInterval(Double(second)),
        latitude: latitude + Double(second) * 1.2 / 111_000,
        longitude: longitude,
        motionActivityIsStationary: true
      )
      precondition(transition == nil)
    }
    precondition(rollingPolicy.state == .unknown)

    for (index, offsetMeters) in [-1.0, 1.0, -1.0, 1.0].enumerated() {
      let transition = policy.observe(
        speedMetersPerSecond: 1,
        horizontalAccuracyMeters: 4,
        speedAccuracyMetersPerSecond: 0.4,
        displacementSincePreviousMeters: 2,
        timestamp: rideStart.addingTimeInterval(Double(index + 4)),
        latitude: latitude + offsetMeters / 111_000,
        longitude: longitude,
        motionActivityIsStationary: true
      )
      precondition(transition == nil)
    }
    precondition(policy.state == .stationary)

    var resumed = false
    for (index, offsetMeters) in [3.0, 6.0, 9.0].enumerated() {
      let transition = policy.observe(
        speedMetersPerSecond: 3,
        horizontalAccuracyMeters: 4,
        speedAccuracyMetersPerSecond: 0.3,
        displacementSincePreviousMeters: 3,
        timestamp: rideStart.addingTimeInterval(Double(index + 8)),
        latitude: latitude + offsetMeters / 111_000,
        longitude: longitude
      )
      if case .startedMoving? = transition { resumed = true }
    }
    precondition(resumed)
  }

  private static func checkSignedBarometerFusion(from rideStart: Date) {
    var fusion = RideAltitudeFusion()
    fusion.startNewEpoch(retaining: nil, isCalibrated: false)
    var finalReading: RideAltitudeReading?
    for sampleIndex in 0...5 {
      let sampleTime = rideStart.addingTimeInterval(Double(sampleIndex) * 2)
      fusion.recordBarometerSample(RideBarometerSample(
        relativeAltitudeMeters: Double(sampleIndex),
        pressureKilopascals: 100.2,
        timestamp: sampleTime
      ))
      finalReading = fusion.reading(
        gpsElevationMeters: -10 + Double(sampleIndex),
        gpsVerticalAccuracyMeters: 5,
        gpsTimestamp: sampleTime
      )
    }
    precondition(finalReading?.anchorQuality == "calibrated")
    precondition(abs((finalReading?.elevationMeters ?? 0) - -5) < 0.01)
    precondition(finalReading?.relativeElevationMeters == 5)

    let invalidGpsReading = fusion.reading(
      gpsElevationMeters: -5,
      gpsVerticalAccuracyMeters: 0,
      gpsTimestamp: rideStart.addingTimeInterval(12)
    )
    precondition(invalidGpsReading.elevationSource == "barometer_gps")
  }

  private static func checkSimulatedBarometer(from rideStart: Date) {
    var simulatedBarometer = RideSimulatedBarometer()
    let baseSample = simulatedBarometer.sample(altitudeMeters: 450, at: rideStart)
    let uphillSample = simulatedBarometer.sample(
      altitudeMeters: 470,
      at: rideStart.addingTimeInterval(1)
    )
    precondition(baseSample?.relativeAltitudeMeters == 0)
    precondition(uphillSample?.relativeAltitudeMeters == 20)
    precondition((uphillSample?.pressureKilopascals ?? .infinity) < (baseSample?.pressureKilopascals ?? 0))
    precondition(simulatedBarometer.sample(altitudeMeters: .nan, at: rideStart) == nil)

    simulatedBarometer.reset()
    precondition(simulatedBarometer.sample(altitudeMeters: -20, at: rideStart)?.relativeAltitudeMeters == 0)

    var simulatedRouteBarometer = RideSimulatedBarometer()
    let simulatedRouteStart = simulatedRouteBarometer.sampleSimulatedRouteProfile(
      distanceMeters: 0,
      at: rideStart
    )
    let simulatedRouteClimb = simulatedRouteBarometer.sampleSimulatedRouteProfile(
      distanceMeters: 740,
      at: rideStart.addingTimeInterval(30)
    )
    let simulatedRouteDescent = simulatedRouteBarometer.sampleSimulatedRouteProfile(
      distanceMeters: 1_240,
      at: rideStart.addingTimeInterval(60)
    )
    precondition(simulatedRouteStart?.relativeAltitudeMeters == 0)
    precondition(simulatedRouteClimb?.relativeAltitudeMeters == 42)
    precondition(simulatedRouteDescent?.relativeAltitudeMeters == 20)
    precondition((simulatedRouteDescent?.pressureKilopascals ?? 0) > (simulatedRouteClimb?.pressureKilopascals ?? .infinity))
    precondition(simulatedRouteBarometer.sampleSimulatedRouteProfile(distanceMeters: .nan, at: rideStart) == nil)
  }

  private static func checkSignedLiveGrade(from rideStart: Date) {
    var uphill = RideGradeEstimator()
    var uphillGrade: Double?
    for sampleIndex in 0...6 {
      let distanceMeters = Double(sampleIndex) * 4
      uphillGrade = uphill.update(
        distanceMeters: distanceMeters,
        elevationMeters: 30 + distanceMeters * 0.05,
        timestamp: rideStart.addingTimeInterval(Double(sampleIndex)),
        source: "barometer:1",
        isMoving: true
      )
    }
    precondition(abs((uphillGrade ?? 0) - 5) < 0.0001)
    precondition(uphill.measurementWindowMeters == 24)
    precondition(uphill.measurementSampleCount == 7)

    var downhill = RideGradeEstimator()
    var downhillGrade: Double?
    for sampleIndex in 0...6 {
      let distanceMeters = Double(sampleIndex) * 4
      downhillGrade = downhill.update(
        distanceMeters: distanceMeters,
        elevationMeters: -20 - distanceMeters * 0.05,
        timestamp: rideStart.addingTimeInterval(Double(sampleIndex)),
        source: "barometer:1",
        isMoving: true
      )
    }
    precondition(abs((downhillGrade ?? 0) + 5) < 0.0001)
  }

  private static func checkRelativeBarometerAscent() {
    var barometerAccumulator = RideAscentAccumulator()
    _ = barometerAccumulator.update(
      distanceMeters: 0,
      elevationMeters: 0,
      source: "barometer-relative:1",
      verticalAccuracyMeters: nil
    )
    _ = barometerAccumulator.update(
      distanceMeters: 20,
      elevationMeters: 5,
      source: "barometer-relative:1",
      verticalAccuracyMeters: nil
    )
    _ = barometerAccumulator.update(
      distanceMeters: 40,
      elevationMeters: 1,
      source: "barometer-relative:1",
      verticalAccuracyMeters: nil
    )
    precondition(barometerAccumulator.ascentMeters == 5)
    precondition(barometerAccumulator.descentMeters == 4)

    var sourceSwitchAccumulator = RideAscentAccumulator()
    _ = sourceSwitchAccumulator.update(
      distanceMeters: 0,
      elevationMeters: 500,
      source: "absolute:gps",
      verticalAccuracyMeters: 8
    )
    _ = sourceSwitchAccumulator.update(
      distanceMeters: 50,
      elevationMeters: 0,
      source: "barometer-relative:2",
      verticalAccuracyMeters: nil
    )
    _ = sourceSwitchAccumulator.update(
      distanceMeters: 70,
      elevationMeters: 3,
      source: "barometer-relative:2",
      verticalAccuracyMeters: nil
    )
    precondition(sourceSwitchAccumulator.ascentMeters == 3)
    precondition(sourceSwitchAccumulator.descentMeters == 0)
  }

  private static func checkSlowRollAndUnanchoredAltitude(from rideStart: Date) {
    var slowRollPolicy = RideAutoPausePolicy()
    for second in 0...2 {
      _ = slowRollPolicy.observe(
        speedMetersPerSecond: 0.05,
        horizontalAccuracyMeters: 4,
        speedAccuracyMetersPerSecond: 0.2,
        displacementSincePreviousMeters: 0.1,
        timestamp: rideStart.addingTimeInterval(Double(second))
      )
    }
    _ = slowRollPolicy.observe(
      speedMetersPerSecond: 0.28,
      horizontalAccuracyMeters: 4,
      speedAccuracyMetersPerSecond: 0.3,
      displacementSincePreviousMeters: 0.28,
      timestamp: rideStart.addingTimeInterval(3)
    )
    _ = slowRollPolicy.observe(
      speedMetersPerSecond: 0.28,
      horizontalAccuracyMeters: 4,
      speedAccuracyMetersPerSecond: 0.3,
      displacementSincePreviousMeters: 0.28,
      timestamp: rideStart.addingTimeInterval(4)
    )
    guard case .startedMoving? = slowRollPolicy.observe(
      speedMetersPerSecond: 0.28,
      horizontalAccuracyMeters: 4,
      speedAccuracyMetersPerSecond: 0.3,
      displacementSincePreviousMeters: 0.28,
      timestamp: rideStart.addingTimeInterval(5)
    ) else { preconditionFailure("Consistent slow rolling should resume after distance evidence") }

    var unanchoredFusion = RideAltitudeFusion()
    unanchoredFusion.startNewEpoch(retaining: nil, isCalibrated: false)
    let barometerTime = rideStart.addingTimeInterval(1)
    unanchoredFusion.recordBarometerSample(RideBarometerSample(
      relativeAltitudeMeters: 0,
      pressureKilopascals: 100.1,
      timestamp: barometerTime
    ))
    let unanchoredReading = unanchoredFusion.reading(
      gpsElevationMeters: -20,
      gpsVerticalAccuracyMeters: 0,
      gpsTimestamp: barometerTime
    )
    precondition(unanchoredReading.elevationMeters == nil)
    precondition(unanchoredReading.relativeElevationMeters == 0)
    precondition(unanchoredReading.anchorQuality == "unanchored")
  }
}
