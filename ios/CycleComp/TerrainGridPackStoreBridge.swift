import Foundation
import React

@objc(TerrainGridPackStore)
final class TerrainGridPackStoreBridge: RCTEventEmitter {
  private static let workQueue = DispatchQueue(label: "org.cyclecomp.terrain-pack-store")
  private var hasListeners = false

  @objc
  override static func requiresMainQueueSetup() -> Bool {
    false
  }

  @objc
  override static func moduleName() -> String! {
    "TerrainGridPackStore"
  }

  @objc
  override var methodQueue: DispatchQueue {
    Self.workQueue
  }

  override func supportedEvents() -> [String]! {
    ["onTerrainDownloadProgress", "onTerrainDownloadStateChanged"]
  }

  override func startObserving() {
    hasListeners = true
    do {
      try storage().setDownloadChangeHandler { [weak self] downloads in
        Self.workQueue.async { [weak self] in
          guard let self, self.hasListeners else { return }
          self.sendEvent(withName: "onTerrainDownloadStateChanged", body: ["downloads": downloads])
        }
      }
    } catch {
      Self.workQueue.async { [weak self] in
        guard let self, self.hasListeners else { return }
        self.sendEvent(withName: "onTerrainDownloadStateChanged", body: [
          "downloads": [],
          "error": error.localizedDescription,
        ])
      }
    }
  }

  override func stopObserving() {
    hasListeners = false
    try? storage().setDownloadChangeHandler(nil)
  }

  private func sendProgress(
    chunkID: String,
    progress: Double,
    bytesWritten: Int64,
    totalBytes: Int64
  ) {
    Self.workQueue.async { [weak self] in
      guard let self, self.hasListeners else { return }
      self.sendEvent(withName: "onTerrainDownloadProgress", body: [
        "chunkID": chunkID,
        "progress": progress,
        "bytesWritten": bytesWritten,
        "totalBytes": totalBytes,
      ])
    }
  }

  @objc(getDownloadStates:rejecter:)
  func getDownloadStates(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      resolve(try storage().downloadSnapshots())
    } catch {
      Self.reject(error, using: reject)
    }
  }

  @objc(getInventory:rejecter:)
  func getInventory(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      let terrainPackStorage = try storage()
      let inventory = try terrainPackStorage.inventory()
      resolve([
        "packs": inventory.packs.map(Self.dictionary(from:)),
        "unavailablePackageCount": inventory.unavailablePackageCount,
        "trustedSigningKeyCount": terrainPackStorage.trustedSigningKeyCount,
        "allowUnsignedPilot": terrainPackStorage.allowsUnsignedPilotInstallation,
      ])
    } catch {
      Self.reject(error, using: reject)
    }
  }

  @objc(installPack:resolver:rejecter:)
  func installPack(
    _ directoryURI: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      guard let directoryURL = URL(string: directoryURI), directoryURL.isFileURL else {
        throw TerrainGridPackStoreError.invalidPackageDirectory
      }

      let hasScopedAccess = directoryURL.startAccessingSecurityScopedResource()
      defer {
        if hasScopedAccess {
          directoryURL.stopAccessingSecurityScopedResource()
        }
      }

      var coordinationError: NSError?
      var installationResult: Result<TerrainGridPackSummary, Error>?
      NSFileCoordinator().coordinate(
        readingItemAt: directoryURL,
        options: [],
        error: &coordinationError
      ) { coordinatedDirectoryURL in
        installationResult = Result {
          try self.storage().installPackage(from: coordinatedDirectoryURL)
        }
      }

      if let coordinationError {
        throw coordinationError
      }
      guard let installationResult else {
        throw TerrainGridPackStoreError.storageFailure("folder tidak dapat dibaca")
      }
      resolve(Self.dictionary(from: try installationResult.get()))
    } catch {
      Self.reject(error, using: reject)
    }
  }

  @objc(downloadAndInstallPack:releaseID:chunkID:databaseSha256:resolver:rejecter:)
  func downloadAndInstallPack(
    _ baseURLString: String,
    releaseID: String,
    chunkID: String,
    databaseSha256: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      do {
        guard let baseURL = URL(string: baseURLString),
              let scheme = baseURL.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
          throw TerrainGridPackStoreError.invalidDownloadURL
        }
        let storageInstance = try self.storage()
        let summary = try await storageInstance.downloadAndInstallPackage(
          baseURL: baseURL,
          releaseID: releaseID,
          chunkID: chunkID,
          databaseSha256: databaseSha256
        ) { [weak self] progress, bytesWritten, totalBytes in
          self?.sendProgress(
            chunkID: chunkID,
            progress: progress,
            bytesWritten: bytesWritten,
            totalBytes: totalBytes
          )
        }
        resolve(Self.dictionary(from: summary))
      } catch {
        Self.reject(error, using: reject)
      }
    }
  }

  @objc(cancelDownload:resolver:rejecter:)
  func cancelDownload(
    _ chunkID: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      do {
        try await storage().cancelDownloadAndWait(chunkID: chunkID)
        resolve(nil)
      } catch {
        Self.reject(error, using: reject)
      }
    }
  }

  @objc(removePack:resolver:rejecter:)
  func removePack(
    _ packID: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      try storage().removePackage(packID: packID)
      resolve(nil)
    } catch {
      Self.reject(error, using: reject)
    }
  }

  @objc(sampleElevations:resolver:rejecter:)
  func sampleElevations(
    _ flatCoordinates: NSArray,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    guard flatCoordinates.count.isMultiple(of: 2),
          flatCoordinates.count <= 4_000,
          let coordinateNumbers = flatCoordinates as? [NSNumber] else {
      reject(
        "invalid_coordinates",
        "Koordinat medan harus berupa pasangan angka dengan maksimal 2.000 titik.",
        nil
      )
      return
    }

    let coordinateValues = coordinateNumbers.map(\.doubleValue)
    guard coordinateValues.allSatisfy(\.isFinite) else {
      reject("invalid_coordinates", "Koordinat medan harus bernilai finite.", nil)
      return
    }

    let coordinates = stride(from: 0, to: coordinateValues.count, by: 2).map { index in
      (longitude: coordinateValues[index], latitude: coordinateValues[index + 1])
    }

    do {
      let samples = try storage().sampleBatch(coordinates)
      resolve(samples.map { sample in
        [
          "elevationMeters": sample.elevationMeters ?? NSNull() as Any,
          "packID": sample.packID ?? NSNull() as Any,
          "verticalDatum": sample.verticalDatum ?? NSNull() as Any,
        ]
      })
    } catch {
      Self.reject(error, using: reject)
    }
  }

  private func storage() throws -> TerrainGridPackStorage {
    try TerrainGridPackStorage.applicationStorage()
  }

  private static func dictionary(from summary: TerrainGridPackSummary) -> [String: Any] {
    [
      "packID": summary.packID,
      "schemaVersion": summary.schemaVersion,
      "requestedBoundsWgs84": summary.requestedBoundsWgs84,
      "verticalDatum": summary.verticalDatum,
      "signatureStatus": summary.signatureStatus,
      "signatureKeyID": summary.signatureKeyID ?? NSNull() as Any,
      "databaseSha256": summary.databaseSha256 ?? NSNull() as Any,
    ]
  }

  private static func reject(
    _ error: Error,
    using reject: RCTPromiseRejectBlock
  ) {
    let errorCode: String
    if let storeError = error as? TerrainGridPackStoreError,
       case .downloadCancelled = storeError {
      errorCode = "download_cancelled"
    } else {
      errorCode = "terrain_pack_error"
    }
    reject(errorCode, error.localizedDescription, error as NSError)
  }
}
