import Foundation

private final class ResumeDataCapture: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  let completion: (Data?) -> Void
  private var hasRequestedResumeData = false

  init(completion: @escaping (Data?) -> Void) { self.completion = completion }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    guard !hasRequestedResumeData, totalBytesWritten >= 4_096 else { return }
    hasRequestedResumeData = true
    downloadTask.cancel(byProducingResumeData: completion)
  }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    guard !hasRequestedResumeData else { return }
    hasRequestedResumeData = true
    completion(nil)
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
  ) {
    guard !hasRequestedResumeData else { return }
    hasRequestedResumeData = true
    completion(nil)
  }
}

@main
struct TerrainDownloadRecoveryCheck {
  static func main() async throws {
    let mode = CommandLine.arguments[1]
    let storageDirectory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    let sourceDirectory = URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: true)
    let publicKey = Data(base64Encoded: CommandLine.arguments[4])!
    let signingKeys = ["recovery-test-key": publicKey]
    if mode == "resume" {
      let baseURL = URL(string: CommandLine.arguments[5])!
      let databaseSha256 = CommandLine.arguments[6]
      let remoteDatabaseURL = baseURL.appendingPathComponent(
        "v1/terrain/releases/release-recovery-v1/recovery-chunk/\(databaseSha256).sqlite"
      )
      let resumeBytes: Data? = await withCheckedContinuation { continuation in
        let capture = ResumeDataCapture { continuation.resume(returning: $0) }
        let session = URLSession(configuration: .default, delegate: capture, delegateQueue: nil)
        session.downloadTask(with: remoteDatabaseURL).resume()
      }
      precondition(resumeBytes != nil, "URLSession did not produce resumable data")
      let operationID = UUID().uuidString
      let operationDirectory = storageDirectory.appendingPathComponent(".transfers/\(operationID)")
      try FileManager.default.createDirectory(
        at: operationDirectory, withIntermediateDirectories: true
      )
      let packageDirectory = operationDirectory.appendingPathComponent("package")
      try FileManager.default.copyItem(at: sourceDirectory, to: packageDirectory)
      try FileManager.default.removeItem(at: packageDirectory.appendingPathComponent("terrain.sqlite"))
      try resumeBytes!.write(to: operationDirectory.appendingPathComponent("resume.data"))
      let databaseBytes = try FileManager.default.attributesOfItem(
        atPath: sourceDirectory.appendingPathComponent("terrain.sqlite").path
      )[.size] as! NSNumber
      let downloadRecord: [String: Any] = [
        "operationID": operationID, "baseURL": baseURL.absoluteString,
        "releaseID": "release-recovery-v1", "chunkID": "recovery-chunk",
        "databaseSha256": databaseSha256, "stage": "database", "state": "downloading",
        "bytesWritten": 4_096, "totalBytes": databaseBytes,
      ]
      try JSONSerialization.data(withJSONObject: downloadRecord).write(
        to: operationDirectory.appendingPathComponent("download.json")
      )
    }
    let storage = try TerrainGridPackStorage(
      storageDirectory: storageDirectory, trustedSigningKeys: signingKeys
    )
    if mode == "promotion" {
      let summary = try storage.installPackage(from: sourceDirectory)
      let installedDirectory = try FileManager.default.contentsOfDirectory(
        at: storageDirectory, includingPropertiesForKeys: nil
      ).first { $0.lastPathComponent.hasPrefix("pack-") }!
      let backupDirectory = storageDirectory.appendingPathComponent(".replace-legacy-crash")
      let replacementDirectory = storageDirectory.appendingPathComponent(".install-legacy-crash")
      try FileManager.default.copyItem(at: sourceDirectory, to: replacementDirectory)
      try FileManager.default.moveItem(at: installedDirectory, to: backupDirectory)
      let restored = try TerrainGridPackStorage(
        storageDirectory: storageDirectory, trustedSigningKeys: signingKeys
      )
      let restoredInventory = try restored.inventory()
      precondition(restoredInventory.packs == [summary])
      precondition(!FileManager.default.fileExists(atPath: backupDirectory.path))
      precondition(!FileManager.default.fileExists(atPath: replacementDirectory.path))
      // An already promoted, valid replacement also survives a leftover backup.
      try FileManager.default.copyItem(at: sourceDirectory, to: backupDirectory)
      let promoted = try TerrainGridPackStorage(
        storageDirectory: storageDirectory, trustedSigningKeys: signingKeys
      )
      let promotedInventory = try promoted.inventory()
      precondition(promotedInventory.packs == [summary])
      // If a crash leaves an invalid destination, restore the verified backup over it.
      try FileManager.default.copyItem(at: sourceDirectory, to: backupDirectory)
      try Data("invalid replacement".utf8).write(
        to: installedDirectory.appendingPathComponent("manifest.json")
      )
      let restoredOverInvalid = try TerrainGridPackStorage(
        storageDirectory: storageDirectory, trustedSigningKeys: signingKeys
      )
      let restoredOverInvalidInventory = try restoredOverInvalid.inventory()
      precondition(restoredOverInvalidInventory.packs == [summary])
      print("promotion recovery passed")
      return
    }
    let baseURL = URL(string: CommandLine.arguments[5])!
    let databaseSha256 = CommandLine.arguments[6]
    if mode == "reject" {
      let deadline = Date().addingTimeInterval(10)
      while Date() < deadline && storage.downloadSnapshots().first?["state"] as? String != "failed" {
        try await Task.sleep(nanoseconds: 50_000_000)
      }
      let rejectedInventory = try storage.inventory()
      precondition(rejectedInventory.packs.isEmpty)
      precondition(storage.downloadSnapshots().first?["state"] as? String == "failed")
      print("mismatched recovery identity rejected")
      return
    }
    if mode == "start" || mode == "cancel" || mode == "retry" {
      let download = Task {
        try await storage.downloadAndInstallPackage(
          baseURL: baseURL, releaseID: "release-recovery-v1", chunkID: "recovery-chunk",
          databaseSha256: databaseSha256
        )
      }
      if mode == "cancel" {
        try await Task.sleep(nanoseconds: 150_000_000)
        await storage.cancelDownloadAndWait(chunkID: "recovery-chunk")
        do {
          _ = try await download.value
          preconditionFailure("Cancellation installed a package")
        } catch TerrainGridPackStoreError.downloadCancelled {}
        precondition(storage.downloadSnapshots().isEmpty)
        let cancelledInventory = try storage.inventory()
        precondition(cancelledInventory.packs.isEmpty)
        print("cancellation settled")
        return
      }
      do {
        _ = try await download.value
      } catch {
        guard mode == "retry" else { throw error }
        precondition(storage.downloadSnapshots().first?["state"] as? String == "failed")
        _ = try await storage.downloadAndInstallPackage(
          baseURL: baseURL, releaseID: "release-recovery-v1", chunkID: "recovery-chunk",
          databaseSha256: databaseSha256
        )
      }
    } else {
      let deadline = Date().addingTimeInterval(30)
      while Date() < deadline {
        if storage.downloadSnapshots().first?["state"] as? String == "completed" { break }
        if storage.downloadSnapshots().first?["state"] as? String == "failed" {
          fatalError("Recovery failed: \(storage.downloadSnapshots())")
        }
        try await Task.sleep(nanoseconds: 50_000_000)
      }
    }
    let inventory = try storage.inventory()
    precondition(inventory.packs.count == 1)
    precondition(inventory.packs.first?.databaseSha256 == databaseSha256)
    precondition(storage.downloadSnapshots().first?["state"] as? String == "completed")
    print("download verified and installed")
  }
}
