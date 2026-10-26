import Foundation

private struct ReplaySummary {
  var locationCount = 0
  var rejectedLocationCount = 0
  var policyCount = 0
  var speedCount = 0
  var transitionCount = 0
  var wasTruncated = false
}

private enum ReplayError: Error, CustomStringConvertible {
  case invalidTrace(String)

  var description: String {
    switch self {
    case .invalidTrace(let message): return message
    }
  }
}

@main struct RideSensorTraceReplay {
  static func main() {
    do {
      guard CommandLine.arguments.count == 2 else {
        throw ReplayError.invalidTrace("Usage: ride-sensor-replay <CycleComp-rideID-sensor.jsonl> | --self-test")
      }
      if CommandLine.arguments[1] == "--self-test" {
        try runSelfTest()
        print("Sensor trace recording and deterministic replay checks passed")
        return
      }
      let traceURL = URL(fileURLWithPath: CommandLine.arguments[1])
      let entries = try readEntries(from: traceURL)
      let summary = try replay(entries)
      print("Replay cocok: \(summary.locationCount) fix GPS, \(summary.rejectedLocationCount) ditolak, \(summary.policyCount) keputusan gerak, \(summary.speedCount) speed, \(summary.transitionCount) transisi\(summary.wasTruncated ? " (trace mencapai batas ukuran)" : "")")
    } catch {
      fputs("Replay gagal: \(error)\n", stderr)
      exit(1)
    }
  }

  private static func readEntries(from traceURL: URL) throws -> [RideSensorTraceEntry] {
    let traceContents = try String(contentsOf: traceURL, encoding: .utf8)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .secondsSince1970
    decoder.nonConformingFloatDecodingStrategy = .convertFromString(
      positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN"
    )
    return try traceContents.split(separator: "\n").enumerated().map { lineIndex, line in
      do {
        return try decoder.decode(RideSensorTraceEntry.self, from: Data(line.utf8))
      } catch {
        throw ReplayError.invalidTrace("Baris \(lineIndex + 1) tidak dapat dibaca: \(error)")
      }
    }
  }

  private static func replay(_ entries: [RideSensorTraceEntry]) throws -> ReplaySummary {
    guard entries.first?.kind == "header",
          entries.first?.schemaVersion == 1,
          entries.first?.algorithmVersion == 1 else {
      throw ReplayError.invalidTrace("Header, skema, atau versi algoritme trace tidak sesuai")
    }
    var policy = RideAutoPausePolicy()
    var smoother = RideSpeedSmoother()
    var summary = ReplaySummary()

    for (entryIndex, entry) in entries.enumerated() {
      switch entry.kind {
      case "header", "session", "locationBaseline":
        break
      case "location":
        guard entry.location != nil else { throw ReplayError.invalidTrace("Lokasi hilang pada baris \(entryIndex + 1)") }
        summary.locationCount += 1
      case "locationRejected":
        summary.rejectedLocationCount += 1
      case "policyReset":
        policy.reset()
      case "speedReset":
        smoother.reset()
      case "policy":
        guard let observation = entry.policy else {
          throw ReplayError.invalidTrace("Input gerak hilang pada baris \(entryIndex + 1)")
        }
        guard policy.state.rawValue == observation.stateBefore else {
          throw ReplayError.invalidTrace("State sebelum keputusan berbeda pada baris \(entryIndex + 1)")
        }
        let transition = policy.observe(
          speedMetersPerSecond: observation.speedMetersPerSecond,
          horizontalAccuracyMeters: observation.horizontalAccuracyMeters,
          speedAccuracyMetersPerSecond: observation.speedAccuracyMetersPerSecond,
          displacementSincePreviousMeters: observation.displacementSincePreviousMeters,
          timestamp: observation.timestamp,
          positionSpeedMetersPerSecond: observation.positionSpeedMetersPerSecond,
          positionSpeedWindowStartedAt: observation.positionSpeedWindowStartedAt,
          latitude: observation.latitude,
          longitude: observation.longitude,
          motionActivityIsStationary: observation.motionActivityIsStationary
        )
        let replayedTransition: (kind: String?, effectiveAt: Date?)
        switch transition {
        case .startedMoving(let effectiveAt): replayedTransition = ("startedMoving", effectiveAt)
        case .stoppedMoving(let effectiveAt): replayedTransition = ("stoppedMoving", effectiveAt)
        case .becameUnknown(let effectiveAt): replayedTransition = ("becameUnknown", effectiveAt)
        case .none: replayedTransition = (nil, nil)
        }
        guard policy.state.rawValue == observation.stateAfter,
              replayedTransition.kind == observation.transition,
              datesMatch(replayedTransition.effectiveAt, observation.transitionEffectiveAt) else {
          throw ReplayError.invalidTrace(
            "Keputusan gerak berbeda pada baris \(entryIndex + 1): rekaman \(observation.stateAfter)/\(observation.transition ?? "tanpa transisi"), replay \(policy.state.rawValue)/\(replayedTransition.kind ?? "tanpa transisi")"
          )
        }
        summary.policyCount += 1
        if transition != nil { summary.transitionCount += 1 }
      case "speed":
        guard let observation = entry.speed else {
          throw ReplayError.invalidTrace("Input speed hilang pada baris \(entryIndex + 1)")
        }
        let replayedSpeed = smoother.update(
          speedMetersPerSecond: observation.measuredSpeedMetersPerSecond,
          at: observation.timestamp,
          stationary: observation.stationary
        )
        guard speedsMatch(replayedSpeed, observation.filteredSpeedMetersPerSecond) else {
          throw ReplayError.invalidTrace(
            "Speed tersaring berbeda pada baris \(entryIndex + 1): rekaman \(String(describing: observation.filteredSpeedMetersPerSecond)), replay \(String(describing: replayedSpeed))"
          )
        }
        if observation.stationary, replayedSpeed != nil, observation.speedSource != "stationary" {
          throw ReplayError.invalidTrace("Sumber speed diam berbeda pada baris \(entryIndex + 1)")
        }
        if !observation.stationary, observation.measuredSpeedMetersPerSecond == nil,
           observation.speedSource != (replayedSpeed == nil ? nil : "held") {
          throw ReplayError.invalidTrace("Sumber speed tertahan berbeda pada baris \(entryIndex + 1)")
        }
        summary.speedCount += 1
      case "traceFull":
        summary.wasTruncated = true
      default:
        throw ReplayError.invalidTrace("Jenis event tidak dikenal pada baris \(entryIndex + 1): \(entry.kind)")
      }
    }
    return summary
  }

  private static func datesMatch(_ first: Date?, _ second: Date?) -> Bool {
    switch (first, second) {
    case (nil, nil): return true
    case let (first?, second?): return abs(first.timeIntervalSince(second)) < 0.001
    default: return false
    }
  }

  private static func speedsMatch(_ first: Double?, _ second: Double?) -> Bool {
    switch (first, second) {
    case (nil, nil): return true
    case let (first?, second?): return abs(first - second) < 0.000_001
    default: return false
    }
  }

  private static func runSelfTest() throws {
    let testDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: testDirectory) }
    let recorder = RideSensorTrace()
    recorder.open(rideID: "replay-check", in: testDirectory)
    guard recorder.status == "active" else { throw ReplayError.invalidTrace("Perekam trace gagal dibuka") }

    let rideStart = Date(timeIntervalSince1970: 1_000)
    var policy = RideAutoPausePolicy()
    var smoother = RideSpeedSmoother()
    for sampleIndex in 0...7 {
      let timestamp = rideStart.addingTimeInterval(Double(sampleIndex))
      let speed = sampleIndex < 4 ? 3.0 : 0.0
      let latitude = -8.65 + Double(min(sampleIndex, 3)) * 3 / 111_000
      let stateBefore = policy.state.rawValue
      let transition = policy.observe(
        speedMetersPerSecond: speed,
        horizontalAccuracyMeters: 3,
        speedAccuracyMetersPerSecond: 0.3,
        displacementSincePreviousMeters: sampleIndex < 4 ? 3 : 0,
        timestamp: timestamp,
        latitude: latitude,
        longitude: 115.24,
        motionActivityIsStationary: sampleIndex >= 4
      )
      let transitionKind: String?
      let transitionEffectiveAt: Date?
      switch transition {
      case .startedMoving(let effectiveAt):
        transitionKind = "startedMoving"
        transitionEffectiveAt = effectiveAt
      case .stoppedMoving(let effectiveAt):
        transitionKind = "stoppedMoving"
        transitionEffectiveAt = effectiveAt
      case .becameUnknown(let effectiveAt):
        transitionKind = "becameUnknown"
        transitionEffectiveAt = effectiveAt
      case .none:
        transitionKind = nil
        transitionEffectiveAt = nil
      }
      recorder.append(RideSensorTraceEntry(kind: "policy", policy: RideTracePolicyObservation(
        timestamp: timestamp,
        speedMetersPerSecond: speed,
        horizontalAccuracyMeters: 3,
        speedAccuracyMetersPerSecond: 0.3,
        displacementSincePreviousMeters: sampleIndex < 4 ? 3 : 0,
        positionSpeedMetersPerSecond: nil,
        positionSpeedWindowStartedAt: nil,
        latitude: latitude,
        longitude: 115.24,
        motionActivityIsStationary: sampleIndex >= 4,
        stateBefore: stateBefore,
        stateAfter: policy.state.rawValue,
        transition: transitionKind,
        transitionEffectiveAt: transitionEffectiveAt
      )))
      let filteredSpeed = smoother.update(speedMetersPerSecond: speed, at: timestamp, stationary: policy.state == .stationary)
      recorder.append(RideSensorTraceEntry(kind: "speed", speed: RideTraceSpeedObservation(
        timestamp: timestamp,
        measuredSpeedMetersPerSecond: speed,
        stationary: policy.state == .stationary,
        filteredSpeedMetersPerSecond: filteredSpeed,
        speedSource: policy.state == .stationary ? "stationary" : "gps"
      )))
    }
    recorder.close()
    guard let traceURL = recorder.fileURL else { throw ReplayError.invalidTrace("File trace tidak dibuat") }
    let entries = try readEntries(from: traceURL)
    let summary = try replay(entries)
    guard summary.policyCount == 8, summary.speedCount == 8, summary.transitionCount == 2 else {
      throw ReplayError.invalidTrace("Jumlah sampel atau transisi replay tidak sesuai")
    }
    var wrongEntries = entries
    let wrongSpeed = RideTraceSpeedObservation(
      timestamp: rideStart,
      measuredSpeedMetersPerSecond: 3,
      stationary: false,
      filteredSpeedMetersPerSecond: 99,
      speedSource: "gps"
    )
    wrongEntries.append(RideSensorTraceEntry(kind: "speed", speed: wrongSpeed))
    do {
      _ = try replay(wrongEntries)
      throw ReplayError.invalidTrace("Replay tidak mendeteksi output speed yang salah")
    } catch ReplayError.invalidTrace(let message) where message.contains("Speed tersaring berbeda") {
      // The negative check must fail for the recorded output, not for an unrelated parse error.
    }

    recorder.open(rideID: "bounded-check", in: testDirectory)
    recorder.append(RideSensorTraceEntry(kind: "session", reason: String(repeating: "x", count: 10_000_000)))
    guard recorder.status == "full", let boundedTraceURL = recorder.fileURL else {
      throw ReplayError.invalidTrace("Batas ukuran trace tidak ditegakkan")
    }
    let boundedTraceBytes = (try FileManager.default.attributesOfItem(atPath: boundedTraceURL.path)[.size] as? NSNumber)?.uint64Value
    guard boundedTraceBytes.map({ $0 <= RideSensorTrace.maximumBytes }) == true,
          try readEntries(from: boundedTraceURL).last?.kind == "traceFull" else {
      throw ReplayError.invalidTrace("Batas ukuran trace tidak ditegakkan")
    }
    recorder.clearCurrentRide()
    guard recorder.status == "off", recorder.fileURL == nil else {
      throw ReplayError.invalidTrace("Trace ride sebelumnya masih terpasang")
    }
  }
}
