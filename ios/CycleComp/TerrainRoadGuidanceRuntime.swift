import CoreLocation
import Foundation

final class TerrainRoadGuidanceRuntime {
  private let workQueue = DispatchQueue(label: "org.cyclecomp.terrain-road-guidance")
  private var matcher = TerrainRoadMatcherBridge()
  private var matchedPackID: String?
  private var sessionRevision = 0
  private var lastLocationTimestamp: Date?

  private var latestSnapshot: [String: Any] = TerrainRoadGuidanceRuntime.unavailableSnapshot(
    status: "noPack",
    reason: "road_graph_not_installed"
  )

  var snapshot: [String: Any] {
    Self.currentSnapshot(latestSnapshot, locationTimestamp: lastLocationTimestamp, at: Date())
  }

  static func currentSnapshot(
    _ latestSnapshot: [String: Any],
    locationTimestamp: Date?,
    at now: Date
  ) -> [String: Any] {
    guard let locationTimestamp else { return latestSnapshot }
    let locationAgeSeconds = now.timeIntervalSince(locationTimestamp)
    guard locationAgeSeconds >= 0 && locationAgeSeconds <= 3 else {
      return unavailableSnapshot(status: "staleLocation", reason: "location_expired")
    }
    return latestSnapshot
  }

  func reset() {
    sessionRevision += 1
    lastLocationTimestamp = nil
    latestSnapshot = Self.unavailableSnapshot(status: "acquiring", reason: "new_ride")
    workQueue.async {
      self.matcher.reset()
      self.matchedPackID = nil
    }
  }

  func pause() {
    sessionRevision += 1
    lastLocationTimestamp = nil
    latestSnapshot = Self.unavailableSnapshot(status: "staleLocation", reason: "ride_paused")
    workQueue.async {
      self.matcher.reset()
      self.matchedPackID = nil
    }
  }

  func update(
    location: CLLocation,
    speedMetersPerSecond: Double?,
    courseDegrees: Double?,
    motionState: String,
    completion: @escaping ([String: Any]) -> Void
  ) {
    let updateRevision = sessionRevision
    workQueue.async {
      let updatedSnapshot: [String: Any]
      do {
        let storage = try TerrainGridPackStorage.applicationStorage()
        guard let candidateBatch = try storage.roadCandidateBatch(
          longitude: location.coordinate.longitude,
          latitude: location.coordinate.latitude,
          horizontalAccuracyMeters: location.horizontalAccuracy
        ) else {
          self.matcher.reset()
          self.matchedPackID = nil
          updatedSnapshot = Self.unavailableSnapshot(
            status: "noPack",
            reason: "road_graph_not_installed"
          )
          DispatchQueue.main.async {
            guard self.sessionRevision == updateRevision else { return }
            self.lastLocationTimestamp = location.timestamp
            self.latestSnapshot = updatedSnapshot
            completion(self.snapshot)
          }
          return
        }

        if self.matchedPackID != candidateBatch.packID {
          self.matcher.reset()
          self.matchedPackID = candidateBatch.packID
        }

        let fixAgeSeconds = Date().timeIntervalSince(location.timestamp)
        let monotonicTimeMilliseconds = Int64(
          max(0, ProcessInfo.processInfo.systemUptime - fixAgeSeconds) * 1_000
        )
        let match = self.matcher.updateLongitude(
          location.coordinate.longitude,
          latitude: location.coordinate.latitude,
          horizontalAccuracyMeters: location.horizontalAccuracy,
          monotonicTimeMilliseconds: monotonicTimeMilliseconds,
          speedMetersPerSecond: speedMetersPerSecond.map(NSNumber.init(value:)),
          courseDegrees: courseDegrees.map(NSNumber.init(value:)),
          motionState: motionState,
          candidateRecords: candidateBatch.candidateRecords
        )
        var matchSnapshot: [String: Any] = [
          "terrainMatchStatus": match["status"] ?? "uncertain",
          "terrainMatchReason": match["reason"] ?? "matcher_unavailable",
          "terrainMatchPackID": candidateBatch.packID,
          "matchedEdgeID": match["matchedEdgeID"] ?? NSNull(),
          "matchedSegmentID": match["matchedSegmentID"] ?? NSNull(),
          "matchedCorridorID": match["corridorID"] ?? NSNull(),
          "positionMatchQuality": match["positionMatchQuality"] ?? "unavailable",
          "forwardPathQuality": match["forwardPathQuality"] ?? "unavailable",
          "profileQuality": match["profileQuality"] ?? "unavailable",
          "positionAlongEdgeMeters": match["positionAlongEdgeMeters"] ?? NSNull(),
          "positionAlongCorridorMeters": match["positionAlongCorridorMeters"] ?? NSNull(),
          "lateralDistanceMeters": match["lateralDistanceMeters"] ?? NSNull(),
          "profileDistanceToBoundaryMeters": match["profileDistanceToBoundaryMeters"] ?? NSNull(),
        ]
        var climbGuidance = Self.unavailableClimbGuidance(reason: "match_not_confident")
        let matchIsConfident = match["status"] as? String == "matched" &&
          ["high", "medium"].contains(match["positionMatchQuality"] as? String ?? "") &&
          ["known_to_boundary", "inferred_to_boundary"].contains(
            match["forwardPathQuality"] as? String ?? ""
          )
        if matchIsConfident,
           let corridorID = (match["corridorID"] as? NSNumber)?.int64Value,
           let positionAlongCorridorMeters =
            (match["positionAlongCorridorMeters"] as? NSNumber)?.doubleValue {
          climbGuidance = try storage.roadClimbGuidance(
            packID: candidateBatch.packID,
            corridorID: corridorID,
            positionAlongCorridorMeters: positionAlongCorridorMeters
          )
        }
        matchSnapshot.merge(climbGuidance) { _, guidanceValue in guidanceValue }
        updatedSnapshot = matchSnapshot
      } catch {
        self.matcher.reset()
        self.matchedPackID = nil
        updatedSnapshot = Self.unavailableSnapshot(
          status: "packCorrupt",
          reason: "road_lookup_failed"
        )
      }

      DispatchQueue.main.async {
        guard self.sessionRevision == updateRevision else { return }
        self.lastLocationTimestamp = location.timestamp
        self.latestSnapshot = updatedSnapshot
        completion(self.snapshot)
      }
    }
  }

  private static func unavailableSnapshot(status: String, reason: String) -> [String: Any] {
    [
      "terrainMatchStatus": status,
      "terrainMatchReason": reason,
      "terrainMatchPackID": NSNull(),
      "matchedEdgeID": NSNull(),
      "matchedSegmentID": NSNull(),
      "matchedCorridorID": NSNull(),
      "positionMatchQuality": "unavailable",
      "forwardPathQuality": "unavailable",
      "profileQuality": "unavailable",
      "positionAlongEdgeMeters": NSNull(),
      "positionAlongCorridorMeters": NSNull(),
      "lateralDistanceMeters": NSNull(),
      "profileDistanceToBoundaryMeters": NSNull(),
    ].merging(unavailableClimbGuidance(reason: "match_not_confident")) { _, guidanceValue in guidanceValue }
  }

  private static func unavailableClimbGuidance(reason: String) -> [String: Any] {
    [
      "terrainClimbStatus": "unavailable",
      "terrainClimbReason": reason,
      "terrainClimbIndex": NSNull(),
      "terrainClimbDistanceToStartMeters": NSNull(),
      "terrainClimbDistanceRemainingMeters": NSNull(),
      "terrainClimbDistanceMeters": NSNull(),
      "terrainClimbNetRiseMeters": NSNull(),
      "terrainClimbElevationGainMeters": NSNull(),
      "terrainClimbAverageGradePercent": NSNull(),
      "terrainClimbMaxGradePercent": NSNull(),
      "terrainClimbProgressPercent": NSNull(),
      "terrainClimbProfileQuality": "unavailable",
      "terrainClimbKnownForwardDistanceMeters": 0,
    ]
  }
}
