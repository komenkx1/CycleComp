import Foundation

struct RideSpeedSmoother {
  private var filteredSpeedMetersPerSecond: Double?
  private var lastUpdateAt: Date?

  mutating func update(speedMetersPerSecond: Double?, at timestamp: Date, stationary: Bool) -> Double? {
    if stationary {
      filteredSpeedMetersPerSecond = 0
      lastUpdateAt = timestamp
      return 0
    }

    guard let speedMetersPerSecond,
          speedMetersPerSecond.isFinite, speedMetersPerSecond >= 0,
          speedMetersPerSecond <= 40 else {
      guard let filteredSpeedMetersPerSecond, let lastUpdateAt,
            timestamp >= lastUpdateAt,
            timestamp.timeIntervalSince(lastUpdateAt) <= 4 else {
        reset()
        return nil
      }
      return filteredSpeedMetersPerSecond
    }

    guard let previousSpeed = filteredSpeedMetersPerSecond,
          let lastUpdateAt,
          timestamp > lastUpdateAt,
          timestamp.timeIntervalSince(lastUpdateAt) <= 5 else {
      filteredSpeedMetersPerSecond = speedMetersPerSecond
      lastUpdateAt = timestamp
      return speedMetersPerSecond
    }

    let elapsedSeconds = timestamp.timeIntervalSince(lastUpdateAt)
    let smoothingFactor = 1 - exp(-elapsedSeconds / 1.0)
    let smoothedSpeed = previousSpeed + smoothingFactor * (speedMetersPerSecond - previousSpeed)
    filteredSpeedMetersPerSecond = smoothedSpeed
    self.lastUpdateAt = timestamp
    return smoothedSpeed
  }

  mutating func reset() {
    filteredSpeedMetersPerSecond = nil
    lastUpdateAt = nil
  }
}

struct RidePositionSpeedEstimate {
  let speedMetersPerSecond: Double
  let windowMeters: Double
  let windowStartedAt: Date
}

struct RidePositionSpeedEstimator {
  private struct Sample {
    let latitude: Double
    let longitude: Double
    let horizontalAccuracyMeters: Double
    let timestamp: Date
  }

  private var samples: [Sample] = []

  mutating func update(
    latitude: Double,
    longitude: Double,
    horizontalAccuracyMeters: Double,
    at timestamp: Date
  ) -> RidePositionSpeedEstimate? {
    guard latitude.isFinite, (-90...90).contains(latitude),
          longitude.isFinite, (-180...180).contains(longitude),
          horizontalAccuracyMeters.isFinite, (0...20).contains(horizontalAccuracyMeters) else {
      reset()
      return nil
    }

    if let latestSample = samples.last {
      let interval = timestamp.timeIntervalSince(latestSample.timestamp)
      guard interval > 0 else { return nil }
      if interval > 3 {
        samples.removeAll(keepingCapacity: true)
      }
    }

    samples.append(Sample(
      latitude: latitude,
      longitude: longitude,
      horizontalAccuracyMeters: horizontalAccuracyMeters,
      timestamp: timestamp
    ))
    samples.removeAll { timestamp.timeIntervalSince($0.timestamp) > 8 }

    guard samples.count >= 3, let latestSample = samples.last else { return nil }

    for firstSample in samples.dropLast(2).reversed() {
      let windowSeconds = latestSample.timestamp.timeIntervalSince(firstSample.timestamp)
      guard windowSeconds >= 2, windowSeconds <= 8 else { continue }
      let displacementMeters = distanceMeters(from: firstSample, to: latestSample)
      let minimumDisplacementMeters = max(
        8,
        firstSample.horizontalAccuracyMeters + latestSample.horizontalAccuracyMeters
      )
      guard displacementMeters > minimumDisplacementMeters else { continue }

      let estimatedSpeedMetersPerSecond = displacementMeters / windowSeconds
      guard estimatedSpeedMetersPerSecond >= 0.25,
            estimatedSpeedMetersPerSecond <= 25 else { continue }

      return RidePositionSpeedEstimate(
        speedMetersPerSecond: estimatedSpeedMetersPerSecond,
        windowMeters: displacementMeters,
        windowStartedAt: firstSample.timestamp
      )
    }
    return nil
  }

  mutating func reset() {
    samples.removeAll(keepingCapacity: true)
  }

  private func distanceMeters(from firstSample: Sample, to lastSample: Sample) -> Double {
    let earthRadiusMeters = 6_371_000.0
    let firstLatitudeRadians = firstSample.latitude * .pi / 180
    let lastLatitudeRadians = lastSample.latitude * .pi / 180
    let latitudeDifferenceRadians = (lastSample.latitude - firstSample.latitude) * .pi / 180
    let longitudeDifferenceRadians = (lastSample.longitude - firstSample.longitude) * .pi / 180
    let haversine = pow(sin(latitudeDifferenceRadians / 2), 2) +
      cos(firstLatitudeRadians) * cos(lastLatitudeRadians) *
      pow(sin(longitudeDifferenceRadians / 2), 2)
    return 2 * earthRadiusMeters * asin(min(1, sqrt(haversine)))
  }
}

struct RideBarometerSample {
  let relativeAltitudeMeters: Double
  let pressureKilopascals: Double
  let timestamp: Date
}

struct RideSimulatedBarometer {
  private var referenceAltitudeMeters: Double?
  private let simulatedElevationProfile: [(distanceMeters: Double, elevationMeters: Double)] = [
    (0, 0),
    (120, 3),
    (320, 16),
    (520, 33),
    (740, 42),
    (980, 31),
    (1_240, 20),
    (1_520, 28),
    (1_850, 52),
  ]

  mutating func sample(altitudeMeters: Double, at timestamp: Date) -> RideBarometerSample? {
    guard altitudeMeters.isFinite, (-1_000...20_000).contains(altitudeMeters) else { return nil }
    if referenceAltitudeMeters == nil { referenceAltitudeMeters = altitudeMeters }

    let pressureKilopascals = 101.325 * pow(1 - altitudeMeters / 44_330, 5.255)
    guard pressureKilopascals.isFinite, pressureKilopascals > 0 else { return nil }
    return RideBarometerSample(
      relativeAltitudeMeters: altitudeMeters - (referenceAltitudeMeters ?? altitudeMeters),
      pressureKilopascals: pressureKilopascals,
      timestamp: timestamp
    )
  }

  mutating func sampleSimulatedRouteProfile(
    distanceMeters: Double,
    at timestamp: Date
  ) -> RideBarometerSample? {
    guard distanceMeters.isFinite, distanceMeters >= 0 else { return nil }
    return sample(
      altitudeMeters: 650 + interpolatedProfileElevation(at: distanceMeters),
      at: timestamp
    )
  }

  mutating func reset() {
    referenceAltitudeMeters = nil
  }

  private func interpolatedProfileElevation(at distanceMeters: Double) -> Double {
    guard let firstProfilePoint = simulatedElevationProfile.first,
          let lastProfilePoint = simulatedElevationProfile.last else { return 0 }
    if distanceMeters <= firstProfilePoint.distanceMeters {
      return firstProfilePoint.elevationMeters
    }
    if distanceMeters >= lastProfilePoint.distanceMeters {
      return lastProfilePoint.elevationMeters
    }

    for profileIndex in 1..<simulatedElevationProfile.count {
      let previousProfilePoint = simulatedElevationProfile[profileIndex - 1]
      let nextProfilePoint = simulatedElevationProfile[profileIndex]
      guard distanceMeters <= nextProfilePoint.distanceMeters else { continue }
      let profileProgress = (distanceMeters - previousProfilePoint.distanceMeters) /
        (nextProfilePoint.distanceMeters - previousProfilePoint.distanceMeters)
      return previousProfilePoint.elevationMeters +
        (nextProfilePoint.elevationMeters - previousProfilePoint.elevationMeters) * profileProgress
    }

    return lastProfilePoint.elevationMeters
  }
}

struct RideAltitudeReading {
  let elevationMeters: Double?
  let elevationSource: String?
  let relativeElevationMeters: Double?
  let relativeElevationSource: String?
  let pressureKilopascals: Double?
  let anchorQuality: String
}

struct RideAscentDelta {
  let ascentMeters: Double
  let descentMeters: Double
}

struct RideAscentAccumulator {
  private struct Reference {
    let elevationMeters: Double
    let distanceMeters: Double
    let source: String
  }

  private var reference: Reference?
  private(set) var ascentMeters = 0.0
  private(set) var descentMeters = 0.0

  mutating func reset() {
    reference = nil
    ascentMeters = 0
    descentMeters = 0
  }

  mutating func resetReference() {
    reference = nil
  }

  mutating func update(
    distanceMeters: Double,
    elevationMeters: Double?,
    source: String?,
    verticalAccuracyMeters: Double?
  ) -> RideAscentDelta? {
    guard distanceMeters.isFinite,
          let elevationMeters, elevationMeters.isFinite,
          let source, !source.isEmpty else { return nil }

    guard let previousReference = reference else {
      reference = Reference(elevationMeters: elevationMeters, distanceMeters: distanceMeters, source: source)
      return nil
    }

    guard previousReference.source == source else {
      reference = Reference(elevationMeters: elevationMeters, distanceMeters: distanceMeters, source: source)
      return nil
    }

    let isBarometerSource = source.hasPrefix("barometer")
    let minimumDistanceMeters = isBarometerSource ? 20.0 : 50.0
    guard distanceMeters - previousReference.distanceMeters >= minimumDistanceMeters else { return nil }

    let elevationDifferenceMeters = elevationMeters - previousReference.elevationMeters
    let elevationDeadbandMeters = isBarometerSource
      ? 2.5
      : max(5, (verticalAccuracyMeters ?? 0) * 0.25)
    guard abs(elevationDifferenceMeters) >= elevationDeadbandMeters else { return nil }

    reference = Reference(elevationMeters: elevationMeters, distanceMeters: distanceMeters, source: source)
    if elevationDifferenceMeters > 0 {
      let delta = RideAscentDelta(ascentMeters: elevationDifferenceMeters, descentMeters: 0)
      ascentMeters += delta.ascentMeters
      return delta
    }

    let delta = RideAscentDelta(ascentMeters: 0, descentMeters: -elevationDifferenceMeters)
    descentMeters += delta.descentMeters
    return delta
  }
}

func rideElevationQualitySummary(
  elevationSources: [String?],
  anchorQualities: [String?]
) -> String {
  guard !elevationSources.isEmpty, elevationSources.count == anchorQualities.count else {
    return "unavailable"
  }

  let pointQualities = zip(elevationSources, anchorQualities)
  if pointQualities.allSatisfy({ pointQuality in
    pointQuality.0 == "barometer_gps" && pointQuality.1 == "calibrated"
  }) {
    return "barometer_calibrated"
  }

  let measuredPointQualities = zip(elevationSources, anchorQualities).filter { pointQuality in
    pointQuality.1 != nil && pointQuality.1 != "unavailable"
  }
  guard !measuredPointQualities.isEmpty else { return "unavailable" }

  if measuredPointQualities.allSatisfy({ pointQuality in
    pointQuality.0 == "gps" && pointQuality.1 == "gps"
  }) {
    return "gps"
  }
  if measuredPointQualities.allSatisfy({ pointQuality in
    pointQuality.0 == nil && pointQuality.1 == "unanchored"
  }) {
    return "barometer_relative"
  }
  return "mixed"
}

struct RideAltitudeFusion {
  private(set) var epoch = 0
  private var relativeAltitudeAtEpochStart: Double?
  private var latestBarometerSample: RideBarometerSample?
  private var anchorMeters: Double?
  private var anchorIsCalibrated = false
  private var anchorCandidates: [(elevationMeters: Double, timestamp: Date)] = []
  private var lastAnchorGpsTimestamp: Date?
  private var lastAnchorCorrectionAt: Date?

  mutating func startNewEpoch(retaining elevationMeters: Double?, isCalibrated: Bool) {
    epoch += 1
    relativeAltitudeAtEpochStart = nil
    latestBarometerSample = nil
    anchorCandidates = []
    lastAnchorGpsTimestamp = nil
    lastAnchorCorrectionAt = nil
    anchorMeters = isCalibrated ? elevationMeters : nil
    anchorIsCalibrated = isCalibrated && elevationMeters != nil
  }

  mutating func recordBarometerSample(_ sample: RideBarometerSample) {
    guard sample.relativeAltitudeMeters.isFinite,
          sample.pressureKilopascals.isFinite, sample.pressureKilopascals > 0 else { return }
    if relativeAltitudeAtEpochStart == nil {
      relativeAltitudeAtEpochStart = sample.relativeAltitudeMeters
    }
    if latestBarometerSample == nil || sample.timestamp > (latestBarometerSample?.timestamp ?? .distantPast) {
      latestBarometerSample = sample
    }
  }

  mutating func reading(
    gpsElevationMeters: Double?,
    gpsVerticalAccuracyMeters: Double?,
    gpsTimestamp: Date
  ) -> RideAltitudeReading {
    let gpsElevationIsValid = gpsElevationMeters.map { $0.isFinite && $0 > -12_000 && $0 < 12_000 } ?? false
    let gpsAccuracyIsValid = gpsVerticalAccuracyMeters.map { $0.isFinite && $0 > 0 && $0 <= 60 } ?? false
    let strongGpsAnchorIsValid = gpsElevationIsValid && gpsVerticalAccuracyMeters.map { $0 > 0 && $0 <= 15 } == true
    let barometerIsPaired = latestBarometerSample.map {
      abs(gpsTimestamp.timeIntervalSince($0.timestamp)) <= 2
    } ?? false
    var relativeElevationMeters: Double?
    if barometerIsPaired,
       let latestBarometerSample,
       let relativeAltitudeAtEpochStart {
      relativeElevationMeters = latestBarometerSample.relativeAltitudeMeters - relativeAltitudeAtEpochStart
    }

    if strongGpsAnchorIsValid,
       let gpsElevationMeters,
       let relativeElevationMeters,
       lastAnchorGpsTimestamp != gpsTimestamp {
      let candidateAnchorMeters = gpsElevationMeters - relativeElevationMeters
      lastAnchorGpsTimestamp = gpsTimestamp
      anchorCandidates.removeAll { gpsTimestamp.timeIntervalSince($0.timestamp) > 30 }
      anchorCandidates.append((candidateAnchorMeters, gpsTimestamp))

      if !anchorIsCalibrated,
         anchorCandidates.count >= 5,
         let firstCandidate = anchorCandidates.first,
         gpsTimestamp.timeIntervalSince(firstCandidate.timestamp) >= 10 {
        anchorMeters = median(anchorCandidates.map(\.elevationMeters))
        anchorIsCalibrated = true
        lastAnchorCorrectionAt = gpsTimestamp
      } else if anchorIsCalibrated, let currentAnchor = anchorMeters {
        let candidateDifference = candidateAnchorMeters - currentAnchor
        if abs(candidateDifference) <= 30 {
          let correctionStart = lastAnchorCorrectionAt ?? gpsTimestamp
          let elapsedSeconds = max(0, gpsTimestamp.timeIntervalSince(correctionStart))
          let correctionFactor = 1 - exp(-elapsedSeconds / 180)
          anchorMeters = currentAnchor + candidateDifference * correctionFactor
          lastAnchorCorrectionAt = gpsTimestamp
        }
      }
    }

    if barometerIsPaired, anchorIsCalibrated,
       let anchorMeters, let relativeElevationMeters {
      return RideAltitudeReading(
        elevationMeters: anchorMeters + relativeElevationMeters,
        elevationSource: "barometer_gps",
        relativeElevationMeters: relativeElevationMeters,
        relativeElevationSource: "barometer",
        pressureKilopascals: latestBarometerSample?.pressureKilopascals,
        anchorQuality: "calibrated"
      )
    }

    let gpsFallbackElevation = gpsElevationIsValid && gpsAccuracyIsValid ? gpsElevationMeters : nil
    return RideAltitudeReading(
      elevationMeters: gpsFallbackElevation,
      elevationSource: gpsFallbackElevation == nil ? nil : "gps",
      relativeElevationMeters: relativeElevationMeters,
      relativeElevationSource: relativeElevationMeters == nil ? nil : "barometer",
      pressureKilopascals: barometerIsPaired ? latestBarometerSample?.pressureKilopascals : nil,
      anchorQuality: relativeElevationMeters != nil
        ? (anchorIsCalibrated ? "calibrated" : "unanchored")
        : gpsFallbackElevation == nil ? "unavailable" : "gps"
    )
  }

  private func median(_ elevationsMeters: [Double]) -> Double {
    let sortedElevations = elevationsMeters.sorted()
    let middleIndex = sortedElevations.count / 2
    if sortedElevations.count.isMultiple(of: 2) {
      return (sortedElevations[middleIndex - 1] + sortedElevations[middleIndex]) / 2
    }
    return sortedElevations[middleIndex]
  }
}

struct RideGradeEstimator {
  private struct Sample {
    let distanceMeters: Double
    let elevationMeters: Double
    let timestamp: Date
    let source: String
  }

  private var samples: [Sample] = []
  private var currentSource: String?

  var measurementWindowMeters: Double? {
    guard let firstSample = samples.first, let lastSample = samples.last else { return nil }
    return lastSample.distanceMeters - firstSample.distanceMeters
  }

  var measurementSampleCount: Int { samples.count }

  mutating func update(
    distanceMeters: Double,
    elevationMeters: Double?,
    timestamp: Date,
    source: String?,
    isMoving: Bool
  ) -> Double? {
    guard isMoving, let elevationMeters, elevationMeters.isFinite,
          let source, distanceMeters.isFinite else {
      reset()
      return nil
    }
    if currentSource != source {
      samples.removeAll(keepingCapacity: true)
      currentSource = source
    }
    if let lastSample = samples.last,
       (timestamp <= lastSample.timestamp || distanceMeters < lastSample.distanceMeters ||
        timestamp.timeIntervalSince(lastSample.timestamp) > 5) {
      samples.removeAll(keepingCapacity: true)
    }
    if let lastSample = samples.last, distanceMeters <= lastSample.distanceMeters {
      return nil
    }
    samples.append(Sample(
      distanceMeters: distanceMeters,
      elevationMeters: elevationMeters,
      timestamp: timestamp,
      source: source
    ))

    let isBarometerGrade = source.hasPrefix("barometer")
    let targetWindowMeters = isBarometerGrade ? 60.0 : 100.0
    samples.removeAll { distanceMeters - $0.distanceMeters > targetWindowMeters }
    return calculateGrade(minimumDistanceMeters: isBarometerGrade ? 20 : 60,
                          minimumSampleCount: isBarometerGrade ? 6 : 8,
                          minimumDurationSeconds: isBarometerGrade ? 6 : 12)
  }

  mutating func reset() {
    samples.removeAll(keepingCapacity: true)
    currentSource = nil
  }

  private func calculateGrade(
    minimumDistanceMeters: Double,
    minimumSampleCount: Int,
    minimumDurationSeconds: TimeInterval
  ) -> Double? {
    guard let firstSample = samples.first, let lastSample = samples.last,
          samples.count >= minimumSampleCount,
          lastSample.distanceMeters - firstSample.distanceMeters >= minimumDistanceMeters,
          lastSample.timestamp.timeIntervalSince(firstSample.timestamp) >= minimumDurationSeconds else { return nil }

    let meanDistance = samples.map(\.distanceMeters).reduce(0, +) / Double(samples.count)
    let meanElevation = samples.map(\.elevationMeters).reduce(0, +) / Double(samples.count)
    let covariance = samples.reduce(0) {
      $0 + ($1.distanceMeters - meanDistance) * ($1.elevationMeters - meanElevation)
    }
    let distanceVariance = samples.reduce(0) {
      $0 + pow($1.distanceMeters - meanDistance, 2)
    }
    guard distanceVariance > 0 else { return nil }
    return 100 * covariance / distanceVariance
  }
}
