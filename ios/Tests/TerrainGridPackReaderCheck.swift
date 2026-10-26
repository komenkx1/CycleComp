import CryptoKit
import Foundation

@main
struct TerrainGridPackReaderCheck {
  static func main() throws {
    checkExpiredGuidanceIsUnavailable()
    guard CommandLine.arguments.count == 3 || CommandLine.arguments.count == 4 else {
      fatalError(
        "Usage: TerrainGridPackReaderCheck <pack-directory> " +
          "<samples|seam|signed|external-signed|external-signed-graph|corrupt|store> " +
          "[trusted-public-key-base64]"
      )
    }

    let packDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    let checkName = CommandLine.arguments[2]
    if checkName == "signed" {
      try checkSignedManifest(at: packDirectory)
      return
    }
    if checkName == "external-signed" ||
      checkName == "external-signed-graph" ||
      checkName == "external-signed-inferred" ||
      checkName == "external-signed-zero-corridor" {
      guard CommandLine.arguments.count == 4 else {
        fatalError("The external signature check requires a trusted public key")
      }
      try checkExternallySignedManifest(
        at: packDirectory,
        publicKeyBase64: CommandLine.arguments[3],
        checkName: checkName
      )
      return
    }
    if checkName == "corrupt" {
      checkCorruptPackIsRejected(at: packDirectory)
      return
    }
    if checkName == "symlink" {
      checkSymlinkPackIsRejected(at: packDirectory)
      return
    }
    if checkName == "store" {
      try checkPackStore(at: packDirectory)
      return
    }

    checkUnsignedPackRequiresExplicitDebugOptIn(at: packDirectory)
    let reader = try TerrainGridPackReader(packDirectory: packDirectory, allowUnsignedPilot: true)
    try reader.validateAllBlocks()

    switch checkName {
    case "samples":
      try checkSignedZeroNodataAndBilinearSamples(reader)
    case "seam":
      try checkBlockHaloSampling(reader)
    default:
      fatalError("Unknown terrain grid reader check: \(checkName)")
    }
  }

  private static func checkExpiredGuidanceIsUnavailable() {
    let locationTime = Date(timeIntervalSince1970: 1_000)
    let activeGuidance: [String: Any] = [
      "terrainMatchStatus": "matched", "terrainClimbStatus": "active",
      "forwardPathQuality": "inferred_to_boundary",
    ]
    let freshGuidance = TerrainRoadGuidanceRuntime.currentSnapshot(
      activeGuidance, locationTimestamp: locationTime, at: locationTime.addingTimeInterval(3)
    )
    precondition(freshGuidance["terrainClimbStatus"] as? String == "active")
    for staleAge in [-1.0, 3.01, 60] {
      let staleGuidance = TerrainRoadGuidanceRuntime.currentSnapshot(
        activeGuidance, locationTimestamp: locationTime,
        at: locationTime.addingTimeInterval(staleAge)
      )
      precondition(staleGuidance["terrainMatchStatus"] as? String == "staleLocation")
      precondition(staleGuidance["terrainClimbStatus"] as? String == "unavailable")
      precondition(staleGuidance["forwardPathQuality"] as? String == "unavailable")
    }
  }

  private static func checkSignedManifest(at directory: URL) throws {
    let manifestURL = directory.appendingPathComponent("manifest.json")
    var manifestRecord = try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as! [String: Any]
    manifestRecord["signatureStatus"] = "signed"
    manifestRecord["signatureKeyId"] = "test-key-1"
    let manifestBytes = try JSONSerialization.data(withJSONObject: manifestRecord, options: [.sortedKeys])
    try manifestBytes.write(to: manifestURL, options: .atomic)

    let signingKey = Curve25519.Signing.PrivateKey()
    let signature = try signingKey.signature(for: manifestBytes)
    let signatureURL = directory.appendingPathComponent("manifest.ed25519")
    try signature.write(to: signatureURL, options: .atomic)

    let trustedSigningKeys = ["test-key-1": signingKey.publicKey.rawRepresentation]
    let reader = try TerrainGridPackReader(
      packDirectory: directory,
      trustedSigningKeys: trustedSigningKeys
    )
    try reader.validateAllBlocks()
    let signedSample = try reader.sample(longitude: 0.5, latitude: 2.5)
    precondition(signedSample == -5)

    do {
      _ = try TerrainGridPackReader(packDirectory: directory)
      preconditionFailure("A signed pack must be rejected when its key is not trusted")
    } catch let error as TerrainGridPackReaderError {
      guard case let .unknownSigningKey(keyID) = error, keyID == "test-key-1" else {
        preconditionFailure("Unexpected untrusted key rejection: \(error)")
      }
    }

    var invalidSignature = signature
    invalidSignature[0] ^= 0x01
    try invalidSignature.write(to: signatureURL, options: .atomic)
    do {
      _ = try TerrainGridPackReader(
        packDirectory: directory,
        trustedSigningKeys: trustedSigningKeys
      )
      preconditionFailure("A modified detached signature must be rejected")
    } catch let error as TerrainGridPackReaderError {
      guard case .invalidSignature = error else {
        preconditionFailure("Unexpected invalid signature rejection: \(error)")
      }
    }
  }

  private static func checkExternallySignedManifest(
    at directory: URL,
    publicKeyBase64: String,
    checkName: String
  ) throws {
    guard let publicKeyBytes = Data(base64Encoded: publicKeyBase64) else {
      preconditionFailure("The trusted Ed25519 public key must be base64 encoded")
    }
    let reader = try TerrainGridPackReader(
      packDirectory: directory,
      trustedSigningKeys: ["terrain-test-2026": publicKeyBytes]
    )
    try reader.validateAllBlocks()
    precondition(reader.summary.signatureStatus == "signed")
    precondition(reader.summary.signatureKeyID == "terrain-test-2026")
    if checkName == "external-signed" {
      let signedSample = try reader.sample(longitude: 0.5, latitude: 2.5)
      precondition(signedSample == -5)
    } else if checkName == "external-signed-zero-corridor" {
      try checkZeroIndexedCorridorGuidance(reader)
    } else {
      try checkRoadGraphMatch(
        reader,
        expectedForwardQuality: checkName == "external-signed-inferred"
          ? "inferred_to_boundary" : "known_to_boundary"
      )
    }
  }

  private static func checkZeroIndexedCorridorGuidance(_ reader: TerrainGridPackReader) throws {
    let candidates = try reader.roadCandidateRecords(
      longitude: 1.15,
      latitude: 1.15,
      horizontalAccuracyMeters: 5
    )
    precondition(!candidates.isEmpty)

    let matcher = TerrainRoadMatcherBridge()
    _ = matcher.updateLongitude(
      1.15,
      latitude: 1.15,
      horizontalAccuracyMeters: 5,
      monotonicTimeMilliseconds: 1_000,
      speedMetersPerSecond: NSNumber(value: 2.8),
      courseDegrees: NSNumber(value: 45),
      motionState: "moving",
      candidateRecords: candidates
    )
    let match = matcher.updateLongitude(
      1.15005,
      latitude: 1.15005,
      horizontalAccuracyMeters: 5,
      monotonicTimeMilliseconds: 4_000,
      speedMetersPerSecond: NSNumber(value: 2.8),
      courseDegrees: NSNumber(value: 45),
      motionState: "moving",
      candidateRecords: candidates
    )
    precondition(match["status"] as? String == "matched")
    precondition((match["corridorID"] as? NSNumber)?.int64Value == 0)
    guard let positionAlongCorridorMeters =
      (match["positionAlongCorridorMeters"] as? NSNumber)?.doubleValue else {
      preconditionFailure("The match must include a position on zero-indexed corridor")
    }
    let climbGuidance = try reader.roadClimbGuidance(
      corridorID: 0,
      positionAlongCorridorMeters: positionAlongCorridorMeters
    )
    precondition(["upcoming", "active"].contains(
      climbGuidance["terrainClimbStatus"] as? String ?? ""
    ))
  }

  private static func checkRoadGraphMatch(
    _ reader: TerrainGridPackReader,
    expectedForwardQuality: String
  ) throws {
    precondition(reader.supportsRoadGraph)
    precondition(reader.supportsRoadProfiles)
    let roadCandidates = try reader.roadCandidateRecords(
      longitude: 1.15,
      latitude: 1.15,
      horizontalAccuracyMeters: 5
    )
    precondition(!roadCandidates.isEmpty)
    let predictableRoadCandidates = roadCandidates.filter {
      ($0["predictable"] as? Bool) == true
    }
    precondition(!predictableRoadCandidates.isEmpty)

    let matcher = TerrainRoadMatcherBridge()
    let firstMatch = matcher.updateLongitude(
      1.15,
      latitude: 1.15,
      horizontalAccuracyMeters: 5,
      monotonicTimeMilliseconds: 1_000,
      speedMetersPerSecond: NSNumber(value: 2.8),
      courseDegrees: NSNumber(value: 45),
      motionState: "moving",
      candidateRecords: predictableRoadCandidates
    )
    precondition(firstMatch["status"] as? String == "acquiring")

    let nextMatch = matcher.updateLongitude(
      1.15005,
      latitude: 1.15005,
      horizontalAccuracyMeters: 5,
      monotonicTimeMilliseconds: 4_000,
      speedMetersPerSecond: NSNumber(value: 2.8),
      courseDegrees: NSNumber(value: 45),
      motionState: "moving",
      candidateRecords: predictableRoadCandidates
    )
    precondition(nextMatch["status"] as? String == "matched")
    precondition(nextMatch["positionMatchQuality"] as? String == "high")
    precondition(nextMatch["forwardPathQuality"] as? String == expectedForwardQuality)
    guard let corridorID = (nextMatch["corridorID"] as? NSNumber)?.int64Value,
          let positionAlongCorridorMeters =
            (nextMatch["positionAlongCorridorMeters"] as? NSNumber)?.doubleValue else {
      preconditionFailure("A stable road match must include its corridor position")
    }
    let climbGuidance = try reader.roadClimbGuidance(
      corridorID: corridorID,
      positionAlongCorridorMeters: positionAlongCorridorMeters
    )
    precondition(["upcoming", "active"].contains(climbGuidance["terrainClimbStatus"] as? String ?? ""))
    precondition(["complete", "partial"].contains(
      climbGuidance["terrainClimbProfileQuality"] as? String ?? ""
    ))
    precondition((climbGuidance["terrainClimbAverageGradePercent"] as? Double ?? 0) >= 3)
    precondition(
      (climbGuidance["terrainClimbKnownForwardDistanceMeters"] as? Double ?? -1) >= 0
    )
  }

  private static func checkUnsignedPackRequiresExplicitDebugOptIn(at directory: URL) {
    do {
      _ = try TerrainGridPackReader(packDirectory: directory)
      preconditionFailure("Unsigned packs must be rejected without a Debug opt-in")
    } catch let error as TerrainGridPackReaderError {
      guard case .unsignedPilot = error else {
        preconditionFailure("Unexpected unsigned pack rejection: \(error)")
      }
    } catch {
      preconditionFailure("Unexpected unsigned pack rejection: \(error)")
    }
  }

  private static func checkCorruptPackIsRejected(at directory: URL) {
    do {
      _ = try TerrainGridPackReader(packDirectory: directory, allowUnsignedPilot: true)
      preconditionFailure("A pack with a mismatched file hash must be rejected")
    } catch let error as TerrainGridPackReaderError {
      guard case let .invalidPackage(reason) = error,
            reason.contains("SHA-256") else {
        preconditionFailure("Unexpected corrupt pack rejection: \(error)")
      }
    } catch {
      preconditionFailure("Unexpected corrupt pack rejection: \(error)")
    }
  }

  private static func checkSymlinkPackIsRejected(at directory: URL) {
    do {
      _ = try TerrainGridPackReader(packDirectory: directory, allowUnsignedPilot: true)
      preconditionFailure("A terrain database symlink must be rejected")
    } catch let error as TerrainGridPackReaderError {
      guard case let .invalidPackage(reason) = error,
            reason.contains("regular file") else {
        preconditionFailure("Unexpected symlink rejection: \(error)")
      }
    } catch {
      preconditionFailure("Unexpected symlink rejection: \(error)")
    }
  }

  private static func checkPackStore(at sourceDirectory: URL) throws {
    let manifestURL = sourceDirectory.appendingPathComponent("manifest.json")
    var manifestRecord = try JSONSerialization.jsonObject(
      with: Data(contentsOf: manifestURL)
    ) as! [String: Any]
    manifestRecord["signatureStatus"] = "signed"
    manifestRecord["signatureKeyId"] = "store-check-key"
    let manifestBytes = try JSONSerialization.data(
      withJSONObject: manifestRecord,
      options: [.sortedKeys]
    )
    try manifestBytes.write(to: manifestURL, options: .atomic)

    let signingKey = Curve25519.Signing.PrivateKey()
    let signature = try signingKey.signature(for: manifestBytes)
    let signatureURL = sourceDirectory.appendingPathComponent("manifest.ed25519")
    try signature.write(to: signatureURL, options: .atomic)

    let temporaryStoreDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent("terrain-pack-store-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: temporaryStoreDirectory) }

    let store = try TerrainGridPackStorage(
      storageDirectory: temporaryStoreDirectory,
      trustedSigningKeys: ["store-check-key": signingKey.publicKey.rawRepresentation]
    )
    let installedSummary = try store.installPackage(from: sourceDirectory)
    precondition(installedSummary.packID == manifestRecord["packId"] as? String)
    precondition(installedSummary.signatureStatus == "signed")

    let installedInventory = try store.inventory()
    precondition(installedInventory.packs == [installedSummary])
    precondition(installedInventory.unavailablePackageCount == 0)

    let installedSamples = try store.sampleBatch([
      (longitude: 0.5, latitude: 2.5),
      (longitude: 1.5, latitude: 2.5),
      (longitude: 0.5, latitude: 0.5),
      (longitude: 2.6, latitude: 2.0),
    ])
    precondition(installedSamples[0].elevationMeters == -5)
    precondition(installedSamples[0].packID == installedSummary.packID)
    precondition(installedSamples[1].elevationMeters == 0)
    precondition(installedSamples[2].elevationMeters == nil)
    precondition(installedSamples[3].elevationMeters == nil)

    var modifiedSignature = signature
    modifiedSignature[0] ^= 0x01
    try modifiedSignature.write(to: signatureURL, options: .atomic)
    do {
      _ = try store.installPackage(from: sourceDirectory)
      preconditionFailure("An invalid replacement must not replace an installed pack")
    } catch let error as TerrainGridPackReaderError {
      guard case .invalidSignature = error else {
        preconditionFailure("Unexpected replacement rejection: \(error)")
      }
    }

    let samplesAfterRejectedReplacement = try store.sampleBatch([
      (longitude: 0.5, latitude: 2.5),
    ])
    precondition(samplesAfterRejectedReplacement[0].elevationMeters == -5)

    try store.removePackage(packID: installedSummary.packID)
    let emptyInventory = try store.inventory()
    precondition(emptyInventory.packs.isEmpty)
  }

  private static func checkSignedZeroNodataAndBilinearSamples(_ reader: TerrainGridPackReader) throws {
    let samples = try reader.sampleBatch([
      (longitude: 0.5, latitude: 2.5),
      (longitude: 1.5, latitude: 2.5),
      (longitude: 1.0, latitude: 2.0),
      (longitude: 0.5, latitude: 0.5),
      (longitude: 2.6, latitude: 2.0),
    ])
    precondition(samples[0] == -5)
    precondition(samples[1] == 0)
    precondition(abs((samples[2] ?? 0) - 5) < 1e-6)
    precondition(samples[3] == nil)
    precondition(samples[4] == nil)
  }

  private static func checkBlockHaloSampling(_ reader: TerrainGridPackReader) throws {
    guard let elevationMeters = try reader.sample(longitude: 62, latitude: 62.5) else {
      preconditionFailure("A bilinear sample across the block boundary should be available")
    }
    precondition(abs(elevationMeters - 61.5) < 1e-5)
  }
}
