import CryptoKit
import Darwin
import Foundation

enum TerrainGridPackStoreError: Error, LocalizedError {
  case invalidPackageDirectory
  case unsupportedPackageContents
  case storageLimitReached
  case insufficientStorage
  case tooManyCoordinates
  case packageNotInstalled
  case invalidDownloadURL
  case invalidIdentifier(String)
  case downloadFailed(String)
  case downloadCancelled
  case storageFailure(String)

  var errorDescription: String? {
    switch self {
    case .invalidPackageDirectory:
      return "Pilih folder paket medan yang valid."
    case .unsupportedPackageContents:
      return "Isi folder paket medan tidak sesuai format."
    case .storageLimitReached:
      return "Terlalu banyak paket medan tersimpan."
    case .insufficientStorage:
      return "Ruang penyimpanan tidak cukup untuk memasang paket medan."
    case .tooManyCoordinates:
      return "Lookup medan melebihi batas 2.000 titik per batch."
    case .packageNotInstalled:
      return "Paket medan ini tidak ditemukan."
    case .invalidDownloadURL:
      return "URL server paket medan tidak valid."
    case let .invalidIdentifier(name):
      return "Format pengidentifikasi \(name) tidak valid."
    case let .downloadFailed(reason):
      return "Unduhan paket medan gagal: \(reason)"
    case .downloadCancelled:
      return "Unduhan paket medan dibatalkan."
    case let .storageFailure(reason):
      return "Penyimpanan paket medan gagal: \(reason)"
    }
  }
}

struct TerrainGridPackInventory {
  let packs: [TerrainGridPackSummary]
  let unavailablePackageCount: Int
}

struct TerrainRoadCandidateBatch {
  let packID: String
  let candidateRecords: [[String: Any]]
}

final class TerrainGridPackStorage: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  private struct InstalledPack {
    let directory: URL
    let reader: TerrainGridPackReader
  }

  private static let maximumInstalledPacks = 64
  private static let maximumSampleCount = 2_000
  private static let maximumDatabaseBytes: Int64 = 256 * 1_024 * 1_024
  private static let maximumManifestBytes: Int64 = 1_048_576
  private static let requiredFreeSpaceReserve: Int64 = 64 * 1_024 * 1_024
  private static let applicationStorageResult: Result<TerrainGridPackStorage, Error> = Result {
    let encodedSigningKeys = Bundle.main.infoDictionary?["TerrainPackTrustedSigningKeys"]
      as? [String: String] ?? [:]
    var decodedSigningKeys: [String: Data] = [:]
    for (keyID, encodedKey) in encodedSigningKeys {
      guard let publicKey = Data(base64Encoded: encodedKey), publicKey.count == 32 else {
        throw TerrainGridPackStoreError.storageFailure(
          "public key \(keyID) tidak valid di konfigurasi aplikasi"
        )
      }
      decodedSigningKeys[keyID] = publicKey
    }

    let applicationSupportDirectory = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let storageDirectory = applicationSupportDirectory
      .appendingPathComponent("CycleComp/TerrainPacks", isDirectory: true)

    #if DEBUG
    let unsignedPilotSetting = Bundle.main.infoDictionary?["TerrainAllowUnsignedPilot"]
    let allowUnsignedPilot = (unsignedPilotSetting as? Bool) ??
      ((unsignedPilotSetting as? String)?.uppercased() == "YES")
    #else
    let allowUnsignedPilot = false
    #endif

    return try TerrainGridPackStorage(
      storageDirectory: storageDirectory,
      trustedSigningKeys: decodedSigningKeys,
      allowUnsignedPilot: allowUnsignedPilot,
      backgroundSessionIdentifier: (Bundle.main.bundleIdentifier ?? "org.cyclecomp") +
        ".terrain-download.v1"
    )
  }

  private struct DownloadRecord: Codable {
    let operationID: String
    let baseURL: URL
    let releaseID: String
    let chunkID: String
    let databaseSha256: String
    var stage = "manifest"
    var state = "preparing"
    var bytesWritten: Int64 = 0
    var totalBytes: Int64 = 0
    var failureReason: String?
    var taskIdentifier: Int?
  }

  private final class ActiveDownload: @unchecked Sendable {
    var record: DownloadRecord
    var task: URLSessionDownloadTask?
    var completions: [(Result<TerrainGridPackSummary, Error>) -> Void] = []
    var progressHandlers: [(Double, Int64, Int64) -> Void] = []
    var cancellationWaiters: [CheckedContinuation<Void, Never>] = []
    var lastPersistedBytes: Int64 = 0
    var lastProgressPublication = Date.distantPast
    var pendingFailure: Error?
    var isResuming = false
    var hasRestartedAfterForceQuit = false

    init(record: DownloadRecord) { self.record = record }
  }

  private let lock = NSRecursiveLock()
  private let fileManager: FileManager
  private let storageDirectory: URL
  private let trustedSigningKeys: [String: Data]
  private let allowUnsignedPilot: Bool
  private let backgroundSessionIdentifier: String
  private var installedPacksByID: [String: InstalledPack] = [:]
  private var hasLoadedInstalledPacks = false
  private var unavailablePackageCount = 0
  private var activeDownloadsByChunkID: [String: ActiveDownload] = [:]
  private var downloadChangeHandler: (([[String: Any]]) -> Void)?
  private var backgroundEventsCompletion: (() -> Void)?
  private var backgroundEventsFinished = false
  private let transferQueue = DispatchQueue(label: "org.cyclecomp.terrain-transfer")
  private var hasReconnectedDownloads = false
  private var downloadSession: URLSession!

  private var transferDirectory: URL {
    storageDirectory.appendingPathComponent(".transfers", isDirectory: true)
  }

  static func applicationStorage() throws -> TerrainGridPackStorage {
    try applicationStorageResult.get()
  }

  var trustedSigningKeyCount: Int { trustedSigningKeys.count }
  var allowsUnsignedPilotInstallation: Bool { allowUnsignedPilot }

  init(
    storageDirectory: URL,
    trustedSigningKeys: [String: Data],
    allowUnsignedPilot: Bool = false,
    fileManager: FileManager = .default,
    backgroundSessionIdentifier: String? = nil
  ) throws {
    self.storageDirectory = storageDirectory
    self.trustedSigningKeys = trustedSigningKeys
    self.allowUnsignedPilot = allowUnsignedPilot
    self.backgroundSessionIdentifier = backgroundSessionIdentifier ??
      "org.cyclecomp.terrain-download." + SHA256.hash(data: Data(storageDirectory.path.utf8))
        .prefix(12).map { String(format: "%02x", $0) }.joined()
    self.fileManager = fileManager
    super.init()

    do {
      try fileManager.createDirectory(
        at: storageDirectory,
        withIntermediateDirectories: true
      )
    } catch {
      throw TerrainGridPackStoreError.storageFailure(error.localizedDescription)
    }

    try restoreInterruptedPromotions()
    try fileManager.createDirectory(at: transferDirectory, withIntermediateDirectories: true)
    try loadPersistedDownloads()
    #if os(iOS)
    #if targetEnvironment(simulator)
    // The simulator runtime does not provide nsurlsessiond for background download sessions.
    let configuration = URLSessionConfiguration.default
    #else
    let configuration = URLSessionConfiguration.background(withIdentifier: self.backgroundSessionIdentifier)
    configuration.sessionSendsLaunchEvents = true
    configuration.isDiscretionary = false
    configuration.waitsForConnectivity = true
    #endif
    #else
    let configuration = URLSessionConfiguration.default
    #endif
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 24 * 60 * 60
    configuration.httpMaximumConnectionsPerHost = 2
    let delegateQueue = OperationQueue()
    delegateQueue.maxConcurrentOperationCount = 1
    delegateQueue.underlyingQueue = transferQueue
    downloadSession = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    reconnectDownloads()
  }

  private func restoreInterruptedPromotions() throws {
    let directories = try fileManager.contentsOfDirectory(
      at: storageDirectory, includingPropertiesForKeys: nil
    ).sorted { $0.lastPathComponent < $1.lastPathComponent }
    for backupDirectory in directories where backupDirectory.lastPathComponent.hasPrefix(".replace-") {
      // A legacy backup has no journal. Its verified manifest identifies the original destination.
      guard let backupReader = try? TerrainGridPackReader(
        packDirectory: backupDirectory,
        trustedSigningKeys: trustedSigningKeys,
        allowUnsignedPilot: allowUnsignedPilot
      ), (try? backupReader.validateAllBlocks()) != nil else { continue }
      let installedDirectory = storageDirectory.appendingPathComponent(
        Self.directoryName(for: backupReader.summary.packID), isDirectory: true
      )
      if let installedReader = try? TerrainGridPackReader(
        packDirectory: installedDirectory,
        trustedSigningKeys: trustedSigningKeys,
        allowUnsignedPilot: allowUnsignedPilot
      ), installedReader.summary.packID == backupReader.summary.packID,
         (try? installedReader.validateAllBlocks()) != nil {
        try fileManager.removeItem(at: backupDirectory)
      } else {
        if fileManager.fileExists(atPath: installedDirectory.path) {
          try fileManager.moveItem(at: installedDirectory, to: storageDirectory.appendingPathComponent(
            ".invalid-\(UUID().uuidString)", isDirectory: true
          ))
        }
        try fileManager.moveItem(at: backupDirectory, to: installedDirectory)
      }
    }
    for directory in directories where directory.lastPathComponent.hasPrefix(".install-") ||
      directory.lastPathComponent.hasPrefix(".download-") {
      try? fileManager.removeItem(at: directory)
    }
  }

  func inventory() throws -> TerrainGridPackInventory {
    lock.lock()
    defer { lock.unlock() }
    try loadInstalledPacksIfNeeded()

    let summaries = installedPacksByID.values
      .map(\.reader.summary)
      .sorted { $0.packID.localizedStandardCompare($1.packID) == .orderedAscending }
    return TerrainGridPackInventory(
      packs: summaries,
      unavailablePackageCount: unavailablePackageCount
    )
  }

  func installPackage(from sourceDirectory: URL) throws -> TerrainGridPackSummary {
    lock.lock()
    defer { lock.unlock() }
    try loadInstalledPacksIfNeeded()

    let stagingDirectory = storageDirectory
      .appendingPathComponent(".install-\(UUID().uuidString)", isDirectory: true)
    do {
      try copyPackageFiles(from: sourceDirectory, to: stagingDirectory)
      let stagedReader = try TerrainGridPackReader(
        packDirectory: stagingDirectory,
        trustedSigningKeys: trustedSigningKeys,
        allowUnsignedPilot: allowUnsignedPilot
      )
      try stagedReader.validateAllBlocks()

      let packID = stagedReader.summary.packID
      if installedPacksByID[packID] == nil,
         installedPacksByID.count >= Self.maximumInstalledPacks {
        throw TerrainGridPackStoreError.storageLimitReached
      }

      let installedDirectory = storageDirectory.appendingPathComponent(
        Self.directoryName(for: packID),
        isDirectory: true
      )
      let backupDirectory = storageDirectory
        .appendingPathComponent(".replace-\(UUID().uuidString)", isDirectory: true)
      let hadPreviousPackage = fileManager.fileExists(atPath: installedDirectory.path)
      if hadPreviousPackage {
        try fileManager.moveItem(at: installedDirectory, to: backupDirectory)
      }

      do {
        try fileManager.moveItem(at: stagingDirectory, to: installedDirectory)
      } catch let promotionError {
        if hadPreviousPackage {
          do {
            try fileManager.moveItem(at: backupDirectory, to: installedDirectory)
          } catch let restoreError {
            throw TerrainGridPackStoreError.storageFailure(
              "Pemasangan gagal dan paket sebelumnya tersimpan di \(backupDirectory.lastPathComponent): " +
                restoreError.localizedDescription
            )
          }
        }
        throw promotionError
      }

      installedPacksByID[packID] = InstalledPack(
        directory: installedDirectory,
        reader: stagedReader
      )
      if hadPreviousPackage {
        try? fileManager.removeItem(at: backupDirectory)
      }
      return stagedReader.summary
    } catch let error as TerrainGridPackStoreError {
      try? fileManager.removeItem(at: stagingDirectory)
      throw error
    } catch {
      try? fileManager.removeItem(at: stagingDirectory)
      throw error
    }
  }

  func downloadSnapshots() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return activeDownloadsByChunkID.values.map { download in
      let record = download.record
      return [
        "operationID": record.operationID,
        "chunkID": record.chunkID,
        "releaseID": record.releaseID,
        "databaseSha256": record.databaseSha256,
        "state": record.state,
        "progress": record.totalBytes > 0
          ? min(1, Double(record.bytesWritten) / Double(record.totalBytes)) : 0,
        "bytesWritten": record.bytesWritten,
        "totalBytes": record.totalBytes,
        "error": record.failureReason ?? NSNull() as Any,
      ]
    }.sorted { ($0["chunkID"] as? String ?? "") < ($1["chunkID"] as? String ?? "") }
  }

  func setDownloadChangeHandler(_ handler: (([[String: Any]]) -> Void)?) {
    lock.lock()
    downloadChangeHandler = handler
    publishDownloadChanges()
    lock.unlock()
  }

  func handleBackgroundSessionEvents(
    identifier: String,
    completionHandler: @escaping () -> Void
  ) -> Bool {
    guard identifier == backgroundSessionIdentifier else { return false }
    lock.lock()
    if backgroundEventsFinished {
      backgroundEventsFinished = false
      lock.unlock()
      DispatchQueue.main.async(execute: completionHandler)
      return true
    }
    backgroundEventsCompletion = completionHandler
    lock.unlock()
    return true
  }

  func cancelDownload(chunkID: String) {
    lock.lock()
    defer { lock.unlock() }
    guard let download = activeDownloadsByChunkID[chunkID],
          download.record.state != "completed" else { return }
    download.record.state = "cancelling"
    try? persist(download)
    publishDownloadChanges()
    if let task = download.task {
      task.cancel()
    } else if hasReconnectedDownloads {
      finishCancellation(download)
    }
  }

  func cancelDownloadAndWait(chunkID: String) async {
    await withCheckedContinuation { continuation in
      lock.lock()
      guard let download = activeDownloadsByChunkID[chunkID],
            download.record.state != "completed" else {
        lock.unlock()
        continuation.resume()
        return
      }
      download.cancellationWaiters.append(continuation)
      cancelDownload(chunkID: chunkID)
      lock.unlock()
    }
  }

  func downloadAndInstallPackage(
    baseURL: URL,
    releaseID: String,
    chunkID: String,
    databaseSha256: String,
    progressHandler: ((_ progress: Double, _ bytesWritten: Int64, _ totalBytes: Int64) -> Void)? = nil
  ) async throws -> TerrainGridPackSummary {
    try Self.validateDownloadIdentity(
      baseURL: baseURL, releaseID: releaseID, chunkID: chunkID, databaseSha256: databaseSha256
    )
    return try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      defer { lock.unlock() }
      do {
        let download: ActiveDownload
        if let previousDownload = activeDownloadsByChunkID[chunkID] {
          guard previousDownload.record.state != "cancelling" else {
            throw TerrainGridPackStoreError.downloadCancelled
          }
          let sameIdentity = previousDownload.record.baseURL == baseURL &&
            previousDownload.record.releaseID == releaseID &&
            previousDownload.record.databaseSha256 == databaseSha256
          if previousDownload.record.state == "completed" || previousDownload.record.state == "failed" {
            if sameIdentity && previousDownload.record.state == "failed" {
              download = previousDownload
              download.record.state = "preparing"
              download.record.failureReason = nil
              download.record.taskIdentifier = nil
              if download.record.stage == "install" {
                download.record.stage = "database"
                try? fileManager.removeItem(
                  at: packageDirectory(download).appendingPathComponent("terrain.sqlite")
                )
              }
            } else {
              try? fileManager.removeItem(at: operationDirectory(previousDownload))
              download = try createDownload(
                baseURL: baseURL, releaseID: releaseID, chunkID: chunkID,
                databaseSha256: databaseSha256
              )
            }
          } else {
            guard sameIdentity else {
              throw TerrainGridPackStoreError.downloadFailed(
                "Operasi unduhan untuk \(chunkID) sedang berlangsung."
              )
            }
            download = previousDownload
          }
        } else {
          download = try createDownload(
            baseURL: baseURL, releaseID: releaseID, chunkID: chunkID,
            databaseSha256: databaseSha256
          )
        }
        try persist(download)
        download.completions.append { continuation.resume(with: $0) }
        if let progressHandler { download.progressHandlers.append(progressHandler) }
        publishDownloadChanges()
        if hasReconnectedDownloads && download.task == nil {
          transferQueue.async { self.continueDownload(download) }
        }
      } catch {
        continuation.resume(throwing: error)
      }
    }
  }

  private func createDownload(
    baseURL: URL, releaseID: String, chunkID: String, databaseSha256: String
  ) throws -> ActiveDownload {
    let download = ActiveDownload(record: DownloadRecord(
      operationID: UUID().uuidString, baseURL: baseURL,
      releaseID: releaseID, chunkID: chunkID, databaseSha256: databaseSha256
    ))
    try fileManager.createDirectory(
      at: packageDirectory(download), withIntermediateDirectories: true
    )
    activeDownloadsByChunkID[chunkID] = download
    return download
  }

  private static func validateDownloadIdentity(
    baseURL: URL, releaseID: String, chunkID: String, databaseSha256: String
  ) throws {
    guard let scheme = baseURL.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          baseURL.host != nil, baseURL.user == nil, baseURL.password == nil,
          baseURL.query == nil, baseURL.fragment == nil else {
      throw TerrainGridPackStoreError.invalidDownloadURL
    }
    for (name, identifier) in [("release ID", releaseID), ("chunk ID", chunkID)] {
      guard identifier.range(
        of: "^[a-z0-9][a-z0-9._-]{0,95}$", options: .regularExpression
      ) != nil else { throw TerrainGridPackStoreError.invalidIdentifier(name) }
    }
    guard databaseSha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
      throw TerrainGridPackStoreError.invalidIdentifier("database SHA-256")
    }
  }

  private func operationDirectory(_ download: ActiveDownload) -> URL {
    transferDirectory.appendingPathComponent(download.record.operationID, isDirectory: true)
  }

  private func packageDirectory(_ download: ActiveDownload) -> URL {
    operationDirectory(download).appendingPathComponent("package", isDirectory: true)
  }

  private func persist(_ download: ActiveDownload) throws {
    let encodedRecord = try JSONEncoder().encode(download.record)
    try encodedRecord.write(
      to: operationDirectory(download).appendingPathComponent("download.json"), options: .atomic
    )
  }

  private func loadPersistedDownloads() throws {
    let directories = try fileManager.contentsOfDirectory(
      at: transferDirectory, includingPropertiesForKeys: nil
    )
    for directory in directories {
      guard Self.isDirectory(directory),
            let encodedRecord = try? Data(
              contentsOf: directory.appendingPathComponent("download.json")
            ), encodedRecord.count <= 16_384,
            var record = try? JSONDecoder().decode(DownloadRecord.self, from: encodedRecord),
            UUID(uuidString: record.operationID) != nil,
            record.operationID == directory.lastPathComponent,
            ["manifest", "signature", "database", "install"].contains(record.stage),
            ["preparing", "downloading", "installing", "cancelling", "failed", "completed"]
              .contains(record.state),
            (try? Self.validateDownloadIdentity(
              baseURL: record.baseURL, releaseID: record.releaseID,
              chunkID: record.chunkID, databaseSha256: record.databaseSha256
            )) != nil else { continue }
      guard activeDownloadsByChunkID[record.chunkID] == nil else { continue }
      // A force quit may cancel the daemon task. Reconnect first, then resume or restart its immutable URL.
      if record.state == "installing" { record.stage = "install" }
      activeDownloadsByChunkID[record.chunkID] = ActiveDownload(record: record)
    }
  }

  private func reconnectDownloads() {
    downloadSession.getAllTasks { tasks in
      self.transferQueue.async {
        self.lock.lock()
        defer { self.lock.unlock() }
        for task in tasks {
          guard let downloadTask = task as? URLSessionDownloadTask,
                let download = self.download(for: task, reconnecting: true),
                download.record.state != "completed",
                download.record.state != "failed",
                task.originalRequest?.url == self.remoteURL(download),
                download.task == nil else {
            task.cancel()
            continue
          }
          download.task = downloadTask
          download.record.taskIdentifier = task.taskIdentifier
          try? self.persist(download)
          if download.record.stage == "database" {
            download.record.bytesWritten = max(0, task.countOfBytesReceived)
          }
          if download.record.state == "cancelling" { task.cancel() }
          else { task.resume() }
        }
        self.hasReconnectedDownloads = true
        for download in Array(self.activeDownloadsByChunkID.values) {
          if download.record.state == "cancelling" && download.task == nil {
            self.finishCancellation(download)
          } else if download.task == nil &&
            !["failed", "completed"].contains(download.record.state) {
            self.continueDownload(download)
          }
        }
        self.publishDownloadChanges()
      }
    }
  }

  private func remoteURL(_ download: ActiveDownload) -> URL {
    let remoteDirectory = download.record.baseURL
      .appendingPathComponent("v1/terrain/releases", isDirectory: true)
      .appendingPathComponent(download.record.releaseID, isDirectory: true)
      .appendingPathComponent(download.record.chunkID, isDirectory: true)
    let filename: String
    switch download.record.stage {
    case "manifest": filename = "manifest.json"
    case "signature": filename = "manifest.ed25519"
    default: filename = "\(download.record.databaseSha256).sqlite"
    }
    return remoteDirectory.appendingPathComponent(filename)
  }

  private func download(for task: URLSessionTask, reconnecting: Bool = false) -> ActiveDownload? {
    guard let description = task.taskDescription else { return nil }
    return activeDownloadsByChunkID.values.first {
      description == "\($0.record.operationID):\($0.record.stage)" &&
        (reconnecting || $0.record.taskIdentifier == task.taskIdentifier) &&
        !["failed", "completed"].contains($0.record.state)
    }
  }

  private func continueDownload(_ download: ActiveDownload) {
    lock.lock()
    defer { lock.unlock() }
    guard activeDownloadsByChunkID[download.record.chunkID] === download,
          download.task == nil,
          !["completed", "failed", "cancelling"].contains(download.record.state) else { return }
    do {
      try fileManager.createDirectory(
        at: packageDirectory(download), withIntermediateDirectories: true
      )
      if download.record.stage == "install" {
        try validateDownloadedManifest(download)
        download.record.state = "installing"
        try persist(download)
        publishDownloadChanges()
        let summary = try installPackage(from: packageDirectory(download))
        guard summary.databaseSha256 == download.record.databaseSha256 else {
          throw TerrainGridPackStoreError.unsupportedPackageContents
        }
        finish(download, with: .success(summary))
        return
      }
      if download.record.stage == "database" {
        try validateDownloadedManifest(download)
        let completedDatabase = packageDirectory(download).appendingPathComponent("terrain.sqlite")
        if fileManager.fileExists(atPath: completedDatabase.path) {
          download.record.stage = "install"
          try persist(download)
          continueDownload(download)
          return
        }
      }
      let resumeURL = operationDirectory(download).appendingPathComponent("resume.data")
      let task: URLSessionDownloadTask
      download.isResuming = false
      if download.record.stage == "database",
         let resumeBytes = try? Data(contentsOf: resumeURL), !resumeBytes.isEmpty {
        let resumableTask = downloadSession.downloadTask(withResumeData: resumeBytes)
        if resumableTask.originalRequest?.url == remoteURL(download) {
          task = resumableTask
          download.isResuming = true
        } else {
          resumableTask.cancel()
          try? fileManager.removeItem(at: resumeURL)
          task = downloadSession.downloadTask(with: remoteURL(download))
        }
      } else {
        task = downloadSession.downloadTask(with: remoteURL(download))
      }
      task.taskDescription = "\(download.record.operationID):\(download.record.stage)"
      download.record.state = download.record.stage == "database" ? "downloading" : "preparing"
      download.record.taskIdentifier = task.taskIdentifier
      download.task = task
      try persist(download)
      publishDownloadChanges()
      task.resume()
    } catch {
      finish(download, with: .failure(error))
    }
  }

  private func manifestObject(_ download: ActiveDownload) throws -> (Data, [String: Any]) {
    let manifestURL = packageDirectory(download).appendingPathComponent("manifest.json")
    try Self.requireRegularFile(manifestURL)
    let attributes = try fileManager.attributesOfItem(atPath: manifestURL.path)
    guard let bytes = attributes[.size] as? NSNumber,
          bytes.int64Value > 0, bytes.int64Value <= Self.maximumManifestBytes else {
      throw TerrainGridPackStoreError.unsupportedPackageContents
    }
    let manifestBytes = try Data(contentsOf: manifestURL)
    guard let manifest = try JSONSerialization.jsonObject(with: manifestBytes) as? [String: Any] else {
      throw TerrainGridPackStoreError.unsupportedPackageContents
    }
    return (manifestBytes, manifest)
  }

  private func validateDownloadedManifest(_ download: ActiveDownload) throws {
    let (manifestBytes, manifest) = try manifestObject(download)
    if manifest["signatureStatus"] as? String == "signed" {
      let signatureURL = packageDirectory(download).appendingPathComponent("manifest.ed25519")
      try Self.requireRegularFile(signatureURL)
      let signatureBytes = try Data(contentsOf: signatureURL)
      guard signatureBytes.count == 64,
            let keyID = manifest["signatureKeyId"] as? String,
            let keyBytes = trustedSigningKeys[keyID],
            let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyBytes),
            key.isValidSignature(signatureBytes, for: manifestBytes) else {
        throw TerrainGridPackStoreError.unsupportedPackageContents
      }
    } else {
      guard manifest["signatureStatus"] as? String == "unsigned_pilot",
            allowUnsignedPilot else { throw TerrainGridPackStoreError.unsupportedPackageContents }
    }
    guard let files = manifest["files"] as? [[String: Any]], files.count == 1,
          let database = files.first, database["path"] as? String == "terrain.sqlite",
          let size = database["sizeBytes"] as? NSNumber,
          CFGetTypeID(size) != CFBooleanGetTypeID(),
          size.doubleValue.isFinite, size.doubleValue.rounded() == size.doubleValue,
          size.int64Value > 0, size.int64Value <= Self.maximumDatabaseBytes,
          database["sha256"] as? String == download.record.databaseSha256 else {
      throw TerrainGridPackStoreError.unsupportedPackageContents
    }
    download.record.totalBytes = size.int64Value
    try Self.requireAvailableSpace(
      at: storageDirectory,
      requiredBytes: size.int64Value * 2 + Self.requiredFreeSpaceReserve,
      fileManager: fileManager
    )
  }

  private func finishCancellation(_ download: ActiveDownload) {
    let completions = download.completions
    let waiters = download.cancellationWaiters
    download.completions = []
    download.cancellationWaiters = []
    activeDownloadsByChunkID.removeValue(forKey: download.record.chunkID)
    try? fileManager.removeItem(at: operationDirectory(download))
    publishDownloadChanges()
    completions.forEach { $0(.failure(TerrainGridPackStoreError.downloadCancelled)) }
    waiters.forEach { $0.resume() }
  }

  private func finish(
    _ download: ActiveDownload, with installation: Result<TerrainGridPackSummary, Error>
  ) {
    download.task = nil
    if download.record.state == "cancelling" {
      finishCancellation(download)
      return
    }
    switch installation {
    case .success:
      download.record.state = "completed"
      download.record.bytesWritten = download.record.totalBytes
    case let .failure(error):
      download.record.state = "failed"
      download.record.failureReason = error.localizedDescription
    }
    do {
      try persist(download)
      if download.record.state == "completed" {
        try? fileManager.removeItem(at: packageDirectory(download))
        try? fileManager.removeItem(at: operationDirectory(download).appendingPathComponent("resume.data"))
      }
    } catch {
      download.record.state = "failed"
      download.record.failureReason = error.localizedDescription
    }
    let completions = download.completions
    download.completions = []
    download.progressHandlers = []
    let waiters = download.cancellationWaiters
    download.cancellationWaiters = []
    publishDownloadChanges()
    completions.forEach { $0(installation) }
    waiters.forEach { $0.resume() }
  }

  private func publishDownloadChanges() {
    guard let handler = downloadChangeHandler else { return }
    let snapshots = downloadSnapshots()
    DispatchQueue.main.async { handler(snapshots) }
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    lock.lock()
    defer { lock.unlock() }
    guard let download = download(for: downloadTask),
          download.record.state != "cancelling" else { return }
    let maximumBytes = download.record.stage == "database" ? download.record.totalBytes :
      (download.record.stage == "signature" ? 64 : Self.maximumManifestBytes)
    if totalBytesWritten > maximumBytes ||
       (totalBytesExpectedToWrite > 0 && totalBytesExpectedToWrite > maximumBytes) {
      download.pendingFailure = TerrainGridPackStoreError.unsupportedPackageContents
      downloadTask.cancel()
      return
    }
    guard download.record.stage == "database" else { return }
    download.record.bytesWritten = totalBytesWritten
    let progress = min(1, Double(totalBytesWritten) / Double(max(1, download.record.totalBytes)))
    if totalBytesWritten - download.lastPersistedBytes >= 1_048_576 {
      try? persist(download)
      download.lastPersistedBytes = totalBytesWritten
    }
    if Date().timeIntervalSince(download.lastProgressPublication) >= 0.25 || progress == 1 {
      download.progressHandlers.forEach { $0(progress, totalBytesWritten, download.record.totalBytes) }
      publishDownloadChanges()
      download.lastProgressPublication = Date()
    }
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    lock.lock()
    defer { lock.unlock() }
    guard let download = download(for: downloadTask) else { return }
    download.task = nil
    if download.record.state == "cancelling" {
      finishCancellation(download)
      return
    }
    do {
      guard let response = downloadTask.response as? HTTPURLResponse,
            response.statusCode == 200 ||
              (download.record.stage == "database" && response.statusCode == 206) else {
        throw TerrainGridPackStoreError.downloadFailed(
          "HTTP \((downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0)"
        )
      }
      let filename = download.record.stage == "database" ? "terrain.sqlite" :
        (download.record.stage == "signature" ? "manifest.ed25519" : "manifest.json")
      let destination = packageDirectory(download).appendingPathComponent(filename)
      let attributes = try fileManager.attributesOfItem(atPath: location.path)
      let writtenBytes = (attributes[.size] as? NSNumber)?.int64Value ?? 0
      let maximumBytes = download.record.stage == "database" ? download.record.totalBytes :
        (download.record.stage == "signature" ? 64 : Self.maximumManifestBytes)
      guard writtenBytes > 0, writtenBytes <= maximumBytes else {
        throw TerrainGridPackStoreError.unsupportedPackageContents
      }
      if fileManager.fileExists(atPath: destination.path) { try fileManager.removeItem(at: destination) }
      try fileManager.moveItem(at: location, to: destination)
      if download.record.stage == "manifest" {
        let (_, manifest) = try manifestObject(download)
        download.record.stage = manifest["signatureStatus"] as? String == "signed"
          ? "signature" : "database"
      } else if download.record.stage == "signature" {
        download.record.stage = "database"
      } else {
        guard writtenBytes == download.record.totalBytes else {
          throw TerrainGridPackStoreError.unsupportedPackageContents
        }
        download.record.stage = "install"
      }
      download.record.taskIdentifier = nil
      try? fileManager.removeItem(at: operationDirectory(download).appendingPathComponent("resume.data"))
      try persist(download)
      continueDownload(download)
    } catch {
      finish(download, with: .failure(error))
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    lock.lock()
    defer { lock.unlock() }
    guard let download = download(for: task), let error else { return }
    download.task = nil
    if download.record.state == "cancelling" {
      finishCancellation(download)
      return
    }
    if let pendingFailure = download.pendingFailure {
      download.pendingFailure = nil
      finish(download, with: .failure(pendingFailure))
      return
    }
    let nativeError = error as NSError
    let forceQuitReason = nativeError.userInfo[NSURLErrorBackgroundTaskCancelledReasonKey] as? NSNumber
    let cancelledByForceQuit = nativeError.domain == NSURLErrorDomain &&
      nativeError.code == NSURLErrorCancelled && forceQuitReason?.intValue == 0
    if download.isResuming || (cancelledByForceQuit && !download.hasRestartedAfterForceQuit) {
      // Resume files may have been purged or moved during an app update. Retry the same immutable URL.
      download.isResuming = false
      download.hasRestartedAfterForceQuit = download.hasRestartedAfterForceQuit || cancelledByForceQuit
      try? fileManager.removeItem(at: operationDirectory(download).appendingPathComponent("resume.data"))
      download.record.state = "preparing"
      download.record.taskIdentifier = nil
      download.record.bytesWritten = 0
      try? persist(download)
      continueDownload(download)
      return
    }
    if download.record.stage == "database",
       let resumeBytes = nativeError.userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
      try? resumeBytes.write(
        to: operationDirectory(download).appendingPathComponent("resume.data"), options: .atomic
      )
    }
    finish(download, with: .failure(TerrainGridPackStoreError.downloadFailed(error.localizedDescription)))
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    lock.lock()
    let completion = backgroundEventsCompletion
    backgroundEventsCompletion = nil
    backgroundEventsFinished = completion == nil
    lock.unlock()
    if let completion { DispatchQueue.main.async(execute: completion) }
  }

  func removePackage(packID: String) throws {
    lock.lock()
    defer { lock.unlock() }
    try loadInstalledPacksIfNeeded()

    guard let installedPack = installedPacksByID.removeValue(forKey: packID) else {
      throw TerrainGridPackStoreError.packageNotInstalled
    }

    do {
      try fileManager.removeItem(at: installedPack.directory)
    } catch {
      installedPacksByID[packID] = installedPack
      throw TerrainGridPackStoreError.storageFailure(error.localizedDescription)
    }
  }

  func sampleBatch(
    _ coordinates: [(longitude: Double, latitude: Double)]
  ) throws -> [TerrainGridPackSample] {
    guard coordinates.count <= Self.maximumSampleCount else {
      throw TerrainGridPackStoreError.tooManyCoordinates
    }

    lock.lock()
    defer { lock.unlock() }
    try loadInstalledPacksIfNeeded()

    let mostSpecificPacks = installedPacksByID.values.sorted { left, right in
      let leftArea = left.reader.summary.requestedAreaSquareDegrees
      let rightArea = right.reader.summary.requestedAreaSquareDegrees
      if leftArea != rightArea { return leftArea < rightArea }
      return left.reader.summary.packID.localizedStandardCompare(right.reader.summary.packID) == .orderedAscending
    }

    return try coordinates.map { coordinate in
      for installedPack in mostSpecificPacks {
        if let elevationMeters = try installedPack.reader.sample(
          longitude: coordinate.longitude,
          latitude: coordinate.latitude
        ) {
          return TerrainGridPackSample(
            elevationMeters: elevationMeters,
            packID: installedPack.reader.summary.packID,
            verticalDatum: installedPack.reader.summary.verticalDatum
          )
        }
      }
      return TerrainGridPackSample(elevationMeters: nil, packID: nil, verticalDatum: nil)
    }
  }

  func roadCandidateBatch(
    longitude: Double,
    latitude: Double,
    horizontalAccuracyMeters: Double
  ) throws -> TerrainRoadCandidateBatch? {
    lock.lock()
    defer { lock.unlock() }
    try loadInstalledPacksIfNeeded()

    let roadGraphPacks = installedPacksByID.values
      .filter { $0.reader.supportsRoadGraph }
      .sorted { left, right in
        let leftArea = left.reader.summary.requestedAreaSquareDegrees
        let rightArea = right.reader.summary.requestedAreaSquareDegrees
        if leftArea != rightArea { return leftArea < rightArea }
        return left.reader.summary.packID.localizedStandardCompare(right.reader.summary.packID) == .orderedAscending
      }

    guard let mostSpecificRoadGraphPack = roadGraphPacks.first else { return nil }
    guard let selectedPack = roadGraphPacks.first(where: {
      $0.reader.roadGraphCovers(longitude: longitude, latitude: latitude)
    }) else {
      return TerrainRoadCandidateBatch(
        packID: mostSpecificRoadGraphPack.reader.summary.packID,
        candidateRecords: []
      )
    }
    let candidateRecords = try selectedPack.reader.roadCandidateRecords(
      longitude: longitude,
      latitude: latitude,
      horizontalAccuracyMeters: horizontalAccuracyMeters
    )
    return TerrainRoadCandidateBatch(
      packID: selectedPack.reader.summary.packID,
      candidateRecords: candidateRecords
    )
  }

  func roadClimbGuidance(
    packID: String,
    corridorID: Int64,
    positionAlongCorridorMeters: Double
  ) throws -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    try loadInstalledPacksIfNeeded()

    guard let installedPack = installedPacksByID[packID],
          installedPack.reader.supportsRoadGraph else {
      return Self.unavailableClimbGuidance(reason: "road_pack_unavailable")
    }
    return try installedPack.reader.roadClimbGuidance(
      corridorID: corridorID,
      positionAlongCorridorMeters: positionAlongCorridorMeters
    )
  }

  private func loadInstalledPacksIfNeeded() throws {
    guard !hasLoadedInstalledPacks else { return }
    let packageDirectories: [URL]
    do {
      packageDirectories = try fileManager.contentsOfDirectory(
        at: storageDirectory,
        includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
      )
    } catch {
      throw TerrainGridPackStoreError.storageFailure(error.localizedDescription)
    }

    for packageDirectory in packageDirectories.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
      guard Self.isDirectory(packageDirectory) else { continue }
      do {
        let reader = try TerrainGridPackReader(
          packDirectory: packageDirectory,
          trustedSigningKeys: trustedSigningKeys,
          allowUnsignedPilot: allowUnsignedPilot
        )
        installedPacksByID[reader.summary.packID] = InstalledPack(
          directory: packageDirectory,
          reader: reader
        )
      } catch {
        unavailablePackageCount += 1
      }
    }
    hasLoadedInstalledPacks = true
  }

  private func copyPackageFiles(from sourceDirectory: URL, to stagingDirectory: URL) throws {
    guard Self.isDirectory(sourceDirectory) else {
      throw TerrainGridPackStoreError.invalidPackageDirectory
    }
    let sourceEntries: [String]
    do {
      sourceEntries = try fileManager.contentsOfDirectory(atPath: sourceDirectory.path)
    } catch {
      throw TerrainGridPackStoreError.invalidPackageDirectory
    }

    let expectedEntries: Set<String> = ["manifest.json", "terrain.sqlite"]
    let signedEntries = expectedEntries.union(["manifest.ed25519"])
    guard Set(sourceEntries) == expectedEntries || Set(sourceEntries) == signedEntries else {
      throw TerrainGridPackStoreError.unsupportedPackageContents
    }

    let manifestURL = sourceDirectory.appendingPathComponent("manifest.json")
    try Self.requireRegularFile(manifestURL)
    let manifestAttributes = try fileManager.attributesOfItem(atPath: manifestURL.path)
    guard let manifestBytes = manifestAttributes[.size] as? NSNumber,
          manifestBytes.int64Value <= Self.maximumManifestBytes else {
      throw TerrainGridPackStoreError.unsupportedPackageContents
    }

    let databaseURL = sourceDirectory.appendingPathComponent("terrain.sqlite")
    try Self.requireRegularFile(databaseURL)
    let databaseAttributes = try fileManager.attributesOfItem(atPath: databaseURL.path)
    guard let databaseBytes = databaseAttributes[.size] as? NSNumber,
          databaseBytes.int64Value > 0,
          databaseBytes.int64Value <= Self.maximumDatabaseBytes else {
      throw TerrainGridPackStoreError.unsupportedPackageContents
    }

    let manifestObject = try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL))
    guard let manifest = manifestObject as? [String: Any],
          let signatureStatus = manifest["signatureStatus"] as? String else {
      throw TerrainGridPackStoreError.unsupportedPackageContents
    }
    let signatureURL = sourceDirectory.appendingPathComponent("manifest.ed25519")
    if signatureStatus == "signed" {
      try Self.requireRegularFile(signatureURL)
      let signatureAttributes = try fileManager.attributesOfItem(atPath: signatureURL.path)
      guard let signatureBytes = signatureAttributes[.size] as? NSNumber,
            signatureBytes.intValue == 64 else {
        throw TerrainGridPackStoreError.unsupportedPackageContents
      }
    } else if fileManager.fileExists(atPath: signatureURL.path) {
      throw TerrainGridPackStoreError.unsupportedPackageContents
    }

    let sourcePackageBytes = databaseBytes.int64Value + manifestBytes.int64Value +
      (fileManager.fileExists(atPath: signatureURL.path) ? 64 : 0)
    try Self.requireAvailableSpace(
      at: storageDirectory,
      requiredBytes: sourcePackageBytes + Self.requiredFreeSpaceReserve,
      fileManager: fileManager
    )

    do {
      try fileManager.createDirectory(at: stagingDirectory, withIntermediateDirectories: false)
      for fileName in sourceEntries.sorted() {
        let sourceFile = sourceDirectory.appendingPathComponent(fileName)
        try Self.requireRegularFile(sourceFile)
        try fileManager.copyItem(
          at: sourceFile,
          to: stagingDirectory.appendingPathComponent(fileName)
        )
      }
    } catch {
      throw TerrainGridPackStoreError.storageFailure(error.localizedDescription)
    }
  }

  private static func directoryName(for packID: String) -> String {
    let identifierDigest = SHA256.hash(data: Data(packID.utf8))
      .map { String(format: "%02x", $0) }
      .joined()
    return "pack-\(identifierDigest)"
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

  private static func requireAvailableSpace(
    at directory: URL,
    requiredBytes: Int64,
    fileManager: FileManager
  ) throws {
    do {
      let fileSystemAttributes = try fileManager.attributesOfFileSystem(forPath: directory.path)
      guard let availableBytes = fileSystemAttributes[.systemFreeSize] as? NSNumber,
            availableBytes.int64Value >= requiredBytes else {
        throw TerrainGridPackStoreError.insufficientStorage
      }
    } catch let error as TerrainGridPackStoreError {
      throw error
    } catch {
      throw TerrainGridPackStoreError.storageFailure(error.localizedDescription)
    }
  }

  private static func isDirectory(_ url: URL) -> Bool {
    var fileStatus = stat()
    return lstat(url.path, &fileStatus) == 0 &&
      fileStatus.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR)
  }

  private static func requireRegularFile(_ url: URL) throws {
    var fileStatus = stat()
    guard lstat(url.path, &fileStatus) == 0,
          fileStatus.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else {
      throw TerrainGridPackStoreError.unsupportedPackageContents
    }
  }
}
