import Foundation

struct RideTraceLocation: Codable {
  let timestamp: Date
  let latitude: Double
  let longitude: Double
  let horizontalAccuracyMeters: Double
  let verticalAccuracyMeters: Double
  let gpsElevationMeters: Double
  let speedMetersPerSecond: Double
  let speedAccuracyMetersPerSecond: Double
  let motionActivityIsStationary: Bool
  let motionActivityStatus: String
  let motionActivityConfidence: String?
  let motionActivityObservedAt: Date?
  let barometerStatus: String
  let accelerationRmsG: Double?
  let rotationRmsRadiansPerSecond: Double?
}

struct RideTracePolicyObservation: Codable {
  let timestamp: Date
  let speedMetersPerSecond: Double?
  let horizontalAccuracyMeters: Double
  let speedAccuracyMetersPerSecond: Double
  let displacementSincePreviousMeters: Double
  let positionSpeedMetersPerSecond: Double?
  let positionSpeedWindowStartedAt: Date?
  let latitude: Double
  let longitude: Double
  let motionActivityIsStationary: Bool
  let stateBefore: String
  let stateAfter: String
  let transition: String?
  let transitionEffectiveAt: Date?
}

struct RideTraceSpeedObservation: Codable {
  let timestamp: Date
  let measuredSpeedMetersPerSecond: Double?
  let stationary: Bool
  let filteredSpeedMetersPerSecond: Double?
  let speedSource: String?
}

struct RideSensorTraceEntry: Codable {
  let kind: String
  let recordedAt: Date
  let schemaVersion: Int?
  let algorithmVersion: Int?
  let location: RideTraceLocation?
  let policy: RideTracePolicyObservation?
  let speed: RideTraceSpeedObservation?
  let reason: String?

  init(
    kind: String,
    recordedAt: Date = Date(),
    schemaVersion: Int? = nil,
    algorithmVersion: Int? = nil,
    location: RideTraceLocation? = nil,
    policy: RideTracePolicyObservation? = nil,
    speed: RideTraceSpeedObservation? = nil,
    reason: String? = nil
  ) {
    self.kind = kind
    self.recordedAt = recordedAt
    self.schemaVersion = schemaVersion
    self.algorithmVersion = algorithmVersion
    self.location = location
    self.policy = policy
    self.speed = speed
    self.reason = reason
  }
}

final class RideSensorTrace {
  static let maximumBytes: UInt64 = 10_000_000

  private var fileHandle: FileHandle?
  private var bytesWritten: UInt64 = 0
  private var lastSynchronizedAt = Date.distantPast
  private(set) var fileURL: URL?
  private(set) var status = "off"

  func open(rideID: String, in ridesDirectory: URL) {
    close()
    do {
      try FileManager.default.createDirectory(at: ridesDirectory, withIntermediateDirectories: true)
      let traceURL = ridesDirectory.appendingPathComponent("CycleComp-\(rideID)-sensor.jsonl")
      if !FileManager.default.fileExists(atPath: traceURL.path) {
        FileManager.default.createFile(atPath: traceURL.path, contents: nil)
      }
      let existingBytes = try FileManager.default.attributesOfItem(atPath: traceURL.path)[.size] as? NSNumber
      bytesWritten = existingBytes?.uint64Value ?? 0
      fileURL = traceURL
      guard bytesWritten < Self.maximumBytes else {
        status = "full"
        return
      }
      fileHandle = try FileHandle(forWritingTo: traceURL)
      fileHandle?.seekToEndOfFile()
      status = "active"
      if bytesWritten == 0 {
        append(RideSensorTraceEntry(kind: "header", schemaVersion: 1, algorithmVersion: 1))
      } else {
        append(RideSensorTraceEntry(kind: "policyReset", reason: "recorder_reopened"))
        append(RideSensorTraceEntry(kind: "speedReset", reason: "recorder_reopened"))
      }
    } catch {
      fileHandle?.closeFile()
      fileHandle = nil
      status = "error"
    }
  }

  func append(_ entry: RideSensorTraceEntry) {
    guard status == "active", let fileHandle else { return }
    do {
      let encoder = JSONEncoder()
      encoder.dateEncodingStrategy = .secondsSince1970
      encoder.nonConformingFloatEncodingStrategy = .convertToString(
        positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN"
      )
      let line = try encoder.encode(entry) + Data([10])
      guard bytesWritten + UInt64(line.count) <= Self.maximumBytes else {
        let limitEntry = RideSensorTraceEntry(kind: "traceFull")
        let limitLine = try encoder.encode(limitEntry) + Data([10])
        if bytesWritten + UInt64(limitLine.count) <= Self.maximumBytes {
          try fileHandle.write(contentsOf: limitLine)
          bytesWritten += UInt64(limitLine.count)
        }
        try fileHandle.synchronize()
        fileHandle.closeFile()
        self.fileHandle = nil
        status = "full"
        return
      }
      try fileHandle.write(contentsOf: line)
      bytesWritten += UInt64(line.count)
      if entry.kind == "header" || entry.kind == "policyReset" || entry.kind == "speedReset" {
        synchronize()
      } else if entry.recordedAt.timeIntervalSince(lastSynchronizedAt) >= 5 {
        synchronize()
      }
    } catch {
      fileHandle.closeFile()
      self.fileHandle = nil
      status = "error"
    }
  }

  func synchronize() {
    guard let fileHandle else { return }
    do {
      try fileHandle.synchronize()
      lastSynchronizedAt = Date()
    } catch {
      fileHandle.closeFile()
      self.fileHandle = nil
      status = "error"
    }
  }

  func close() {
    if fileHandle != nil { synchronize() }
    fileHandle?.closeFile()
    fileHandle = nil
    if status == "active" { status = "complete" }
  }

  func clearCurrentRide() {
    close()
    fileURL = nil
    bytesWritten = 0
    status = "off"
  }
}
