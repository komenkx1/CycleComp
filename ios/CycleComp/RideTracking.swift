import AudioToolbox
import AVFoundation
import CoreLocation
import CoreMotion
import React
import SafariServices
import UIKit

private struct RideRecord: Codable {
  let id: String
  let startedAt: Date
  var status: String
  var elapsedTime: RideElapsedTime?
  var autoPaused: Bool?
  var sensorDiagnosticsEnabled: Bool?
  var finishedAt: Date?
  var events: [RideSessionEvent]?
}

private struct RidePoint: Codable {
  let timestamp: Date
  let latitude: Double
  let longitude: Double
  let horizontalAccuracyMeters: Double
  let verticalAccuracyMeters: Double?
  let elevationMeters: Double?
  let elevationSource: String?
  let speedMetersPerSecond: Double?
  let filteredSpeedMetersPerSecond: Double?
  let speedSource: String?
  let speedAccuracyMetersPerSecond: Double?
  let speedLowerBoundMetersPerSecond: Double?
  let speedUpperBoundMetersPerSecond: Double?
  let courseDegrees: Double?
  let segmentStart: Bool?
  let motionState: String?
  let relativeElevationMeters: Double?
  let barometerEpoch: Int?
  let barometricPressureKilopascals: Double?
  let altitudeAnchorQuality: String?
  let liveGradePercent: Double?
  let liveGradeSource: String?
  let liveGradeQuality: String?
  let liveGradeWindowMeters: Double?
  let liveGradeSampleCount: Int?
  let heartRateBpm: Int?
  let heartRateRecordedAt: Date?
  let cumulativeDistanceMeters: Double?
}

private struct RideHeartRateSample: Codable {
  let timestamp: Date
  let beatsPerMinute: Int
}

private final class RideMotionSensor {
  private struct MotionSample {
    let observedAt: Date
    let accelerationSquared: Double
    let rotationSquared: Double
  }

  private let deviceMotionManager = CMMotionManager()
  private let motionActivityManager = CMMotionActivityManager()
  private var motionSamples: [MotionSample] = []
  private var latestActivity: (isStationary: Bool, confidence: CMMotionActivityConfidence, observedAt: Date)?
  private var updatesActive = false
  private var activityUpdatesActive = false
  private var reducedRate = false
  private(set) var status = "unavailable"
  private(set) var activityStatus = "unavailable"

  func start(reducedRate: Bool = false) {
    if !activityUpdatesActive, CMMotionActivityManager.isActivityAvailable(),
       CMMotionActivityManager.authorizationStatus() != .denied {
      activityUpdatesActive = true
      activityStatus = "starting"
      motionActivityManager.startActivityUpdates(to: .main) { [weak self] activity in
        guard let self, self.activityUpdatesActive, let activity else { return }
        self.latestActivity = (activity.stationary, activity.confidence, Date())
        self.activityStatus = "active"
      }
    } else if !activityUpdatesActive {
      activityStatus = CMMotionActivityManager.authorizationStatus() == .denied
        ? "denied" : "unavailable"
    }

    guard deviceMotionManager.isDeviceMotionAvailable else {
      status = activityUpdatesActive ? "activity_only" : "unavailable"
      return
    }
    if updatesActive, self.reducedRate == reducedRate { return }
    if updatesActive { deviceMotionManager.stopDeviceMotionUpdates() }
    self.reducedRate = reducedRate
    deviceMotionManager.deviceMotionUpdateInterval = reducedRate ? 0.1 : 0.04
    updatesActive = true
    status = "starting"
    deviceMotionManager.startDeviceMotionUpdates(to: .main) { [weak self] deviceMotion, error in
      guard let self, self.updatesActive else { return }
      guard error == nil, let deviceMotion else {
        self.deviceMotionManager.stopDeviceMotionUpdates()
        self.updatesActive = false
        self.status = "error"
        return
      }
      let acceleration = deviceMotion.userAcceleration
      let rotation = deviceMotion.rotationRate
      let observedAt = Date()
      self.motionSamples.append(MotionSample(
        observedAt: observedAt,
        accelerationSquared: acceleration.x * acceleration.x +
          acceleration.y * acceleration.y + acceleration.z * acceleration.z,
        rotationSquared: rotation.x * rotation.x + rotation.y * rotation.y + rotation.z * rotation.z
      ))
      self.motionSamples.removeAll { observedAt.timeIntervalSince($0.observedAt) > 2 }
      self.status = "active"
    }
  }

  func stop() {
    updatesActive = false
    activityUpdatesActive = false
    deviceMotionManager.stopDeviceMotionUpdates()
    motionActivityManager.stopActivityUpdates()
    motionSamples.removeAll(keepingCapacity: true)
    latestActivity = nil
    status = "paused"
    activityStatus = "paused"
  }

  func isConfidentlyStationary(at timestamp: Date) -> Bool {
    if CMMotionActivityManager.authorizationStatus() == .denied {
      motionActivityManager.stopActivityUpdates()
      activityUpdatesActive = false
      activityStatus = "denied"
      latestActivity = nil
      return false
    }
    // A delivered GPS fix can predate the most recent activity callback slightly.
    guard let latestActivity,
          latestActivity.isStationary,
          latestActivity.confidence == .high,
          timestamp.timeIntervalSince(latestActivity.observedAt) >= -1,
          timestamp.timeIntervalSince(latestActivity.observedAt) <= 5 else { return false }
    return true
  }

  var activityConfidence: String? {
    guard let latestActivity else { return nil }
    switch latestActivity.confidence {
    case .low: return "low"
    case .medium: return "medium"
    case .high: return "high"
    @unknown default: return "unknown"
    }
  }

  var activityObservedAt: Date? { latestActivity?.observedAt }

  var recentMotionSummary: (accelerationRmsG: Double, rotationRmsRadiansPerSecond: Double, sampleCount: Int)? {
    let freshSamples = motionSamples.filter { Date().timeIntervalSince($0.observedAt) <= 2 }
    guard freshSamples.count >= 10 else { return nil }
    let sampleCount = Double(freshSamples.count)
    return (
      sqrt(freshSamples.reduce(0) { $0 + $1.accelerationSquared } / sampleCount),
      sqrt(freshSamples.reduce(0) { $0 + $1.rotationSquared } / sampleCount),
      freshSamples.count
    )
  }
}

@objc(RideTracking)
final class RideTracking: RCTEventEmitter, CLLocationManagerDelegate {
  private let locationManager = CLLocationManager()
  private let altimeter = CMAltimeter()
  private let motionSensor = RideMotionSensor()
  private let sensorTrace = RideSensorTrace()
#if DEBUG && targetEnvironment(simulator)
  private let simulatesDistanceProfile = ProcessInfo.processInfo.arguments.contains("-CycleCompSimulateDistanceProfile")
  private let simulatesBarometer = ProcessInfo.processInfo.arguments.contains("-CycleCompSimulateBarometer") ||
    ProcessInfo.processInfo.arguments.contains("-CycleCompSimulateDistanceProfile")
  private var simulatedBarometer = RideSimulatedBarometer()
#endif
  private var backgroundSession: CLBackgroundActivitySession?
  private var rideRecord: RideRecord?
  private var sampleFile: FileHandle?
  private var heartRateFile: FileHandle?
  private let watchHeartRate = RealmeWatchHeartRate()
  private var ridePoints: [RidePoint] = []
  private var distanceMeters = 0.0
  private var ascentAccumulator = RideAscentAccumulator()
  private var lastReceivedLocation: CLLocation?
  private var lastDistanceLocation: CLLocation?
  private var pendingAutoPauseLocations: [CLLocation] = []
  private var autoPauseResumeEffectiveAt: Date?
  private var altitudeFusion = RideAltitudeFusion()
  private var speedSmoother = RideSpeedSmoother()
  private var positionSpeedEstimator = RidePositionSpeedEstimator()
  private var positionSpeedEstimatesByTimestamp: [TimeInterval: RidePositionSpeedEstimate] = [:]
  private var gradeEstimator = RideGradeEstimator()
  private var terrainRoadGuidance = TerrainRoadGuidanceRuntime()
  private var lastTerrainGuidancePublishedAt = Date.distantPast
  private var lastPublishedTerrainGuidance: [String: Any] = [:]
  private var relativeAltitudeUpdatesActive = false
  private var barometerStatus = "unavailable"
  private var lastPublishedAt = Date.distantPast
  private var lastCheckpointAt = Date.distantPast
  private let snapshotDateFormatter = ISO8601DateFormatter()
  private var hasListeners = false
  private var nextPointStartsSegment = true
  private var playingCueCount = 0
  private var autoPauseEnabled = UserDefaults.standard.bool(forKey: "CycleCompAutoPauseEnabled")
  private var sensorDiagnosticsEnabled = UserDefaults.standard.bool(forKey: "CycleCompSensorDiagnosticsEnabled")
  private var autoPausePolicy = RideAutoPausePolicy()

  override init() {
    super.init()
    watchHeartRate.rideDurationSeconds = { [weak self] in Int(self?.activeRideSeconds() ?? 0) }
    watchHeartRate.rideDistanceMeters = { [weak self] in Int(self?.distanceMeters ?? 0) }
    watchHeartRate.onChange = { [weak self] in self?.publishHeartRateSnapshot() }
    watchHeartRate.onSample = { [weak self] bpm, timestamp in self?.recordHeartRate(bpm, at: timestamp) }
    locationManager.delegate = self
    locationManager.activityType = .fitness
    locationManager.desiredAccuracy = kCLLocationAccuracyBest
    locationManager.distanceFilter = 3
    restoreRide()
    if UserDefaults.standard.bool(forKey: "CycleCompWatchHeartRateEnabled") { watchHeartRate.setEnabled(true) }
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleAppDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleAppDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    sensorTrace.close()
    motionSensor.stop()
    updateIdleTimer(disabled: false)
  }

  @objc private func handleAppDidBecomeActive() {
    if rideRecord?.status == "active" || rideRecord?.status == "paused" {
      updateIdleTimer(disabled: true)
    }
    if rideRecord?.status == "active" || rideRecord?.autoPaused == true {
      motionSensor.start(reducedRate: rideRecord?.autoPaused == true)
    }
  }

  @objc private func handleAppDidEnterBackground() {
    sampleFile?.synchronizeFile()
    sensorTrace.synchronize()
    if let record = rideRecord { try? saveRecord(record) }
    lastCheckpointAt = Date()
  }

  private func updateIdleTimer(disabled: Bool) {
    DispatchQueue.main.async {
      UIApplication.shared.isIdleTimerDisabled = disabled
    }
  }

  override static func requiresMainQueueSetup() -> Bool { true }

  @objc override var methodQueue: DispatchQueue { .main }

  @objc(setWatchHeartRateEnabled:resolver:rejecter:)
  func setWatchHeartRateEnabled(_ enabled: Bool, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard rideRecord == nil, watchHeartRate.status != "stopping" else {
      reject("ride_exists", "Ubah koneksi jam sebelum memulai perjalanan.", nil)
      return
    }
    UserDefaults.standard.set(enabled, forKey: "CycleCompWatchHeartRateEnabled")
    watchHeartRate.setEnabled(enabled)
    resolve(currentSnapshot())
  }

  private func publishHeartRateSnapshot() {
    if hasListeners { sendEvent(withName: "RideTrackingSnapshot", body: currentSnapshot()) }
  }

  private func recordHeartRate(_ bpm: Int, at timestamp: Date) {
    guard rideRecord?.status == "active", let heartRateFile else { return }
    do {
      let sample = RideHeartRateSample(timestamp: timestamp, beatsPerMinute: bpm)
      try heartRateFile.write(contentsOf: JSONEncoder().encode(sample) + Data([10]))
      try heartRateFile.synchronize()
    } catch {
      if hasListeners { sendEvent(withName: "RideTrackingError", body: ["message": "Sampel HR tidak dapat disimpan. Rekaman GPS tetap berjalan."]) }
    }
  }

  private func openHeartRateFile(for record: RideRecord) throws {
    guard watchHeartRate.enabled else { return }
    heartRateFile?.closeFile()
    let url = recordingDirectory.appendingPathComponent("\(record.id)-hr.jsonl")
    if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
    heartRateFile = try FileHandle(forWritingTo: url)
    heartRateFile?.seekToEndOfFile()
  }

  override func supportedEvents() -> [String]! {
    ["RideTrackingSnapshot", "RideTrackingError"]
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  @objc(getRideState:rejecter:)
  func getRideState(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    var state = currentSnapshot()
    state["trackSegments"] = trackSegments()
    resolve(state)
  }

  @objc(getRideElevationTrack:rejecter:)
  func getRideElevationTrack(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    resolve(trackElevationSegments())
  }

  @objc(startRide:rejecter:)
  func startRide(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard rideRecord == nil else {
      reject("ride_exists", "Selesaikan atau pulihkan perjalanan yang sudah ada.", nil)
      return
    }
    if let locationError = locationError() {
      reject("location_unavailable", locationError, nil)
      return
    }

    do {
      let now = Date()
      let record = RideRecord(
        id: UUID().uuidString,
        startedAt: now,
        status: "active",
        elapsedTime: RideElapsedTime(runningSince: now),
        autoPaused: false,
        sensorDiagnosticsEnabled: sensorDiagnosticsEnabled,
        finishedAt: nil,
        events: []
      )
      sensorTrace.clearCurrentRide()
      rideRecord = record
      ridePoints = []
      distanceMeters = 0
      ascentAccumulator.reset()
      lastReceivedLocation = nil
      lastDistanceLocation = nil
      pendingAutoPauseLocations = []
      autoPauseResumeEffectiveAt = nil
      speedSmoother.reset()
      positionSpeedEstimator.reset()
      positionSpeedEstimatesByTimestamp = [:]
      gradeEstimator.reset()
      terrainRoadGuidance.reset()
      lastTerrainGuidancePublishedAt = Date.distantPast
      lastPublishedTerrainGuidance = [:]
      nextPointStartsSegment = true
      autoPausePolicy.reset()
      try saveRecord(record)
      FileManager.default.createFile(atPath: sampleURL(for: record).path, contents: nil)
      try openSampleFile(for: record)
      try openHeartRateFile(for: record)
      if sensorDiagnosticsEnabled { sensorTrace.open(rideID: record.id, in: ridesDirectory) }
      startSensors()
      watchHeartRate.startRide()
      resolve(currentSnapshot())
    } catch {
      sensorTrace.close()
      sampleFile?.closeFile()
      sampleFile = nil
      heartRateFile?.closeFile()
      heartRateFile = nil
      rideRecord = nil
      try? FileManager.default.removeItem(at: recordURL)
      reject("ride_start_failed", "Perjalanan tidak dapat disimpan: \(error.localizedDescription)", error)
    }
  }

  @objc(pauseRide:rejecter:)
  func pauseRide(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard var record = rideRecord, record.status == "active" else {
      reject("ride_not_active", "Tidak ada perjalanan aktif untuk dijeda.", nil)
      return
    }
    do {
      try pauseRecording(record: &record, automatic: false)
      resolve(currentSnapshot())
    } catch {
      reject("ride_pause_failed", "Status jeda tidak dapat disimpan.", error)
    }
  }

  private func pauseRecording(record: inout RideRecord, automatic: Bool, effectiveAt: Date = Date()) throws {
    var clock = record.elapsedTime ?? legacyElapsedTime(for: record)
    clock.pause(at: effectiveAt)
    record.elapsedTime = clock
    record.status = "paused"
    record.autoPaused = automatic
    if !automatic { endMotionEvidence(record: &record, at: effectiveAt) }
    appendSessionEvent(automatic ? "auto_paused" : "manual_paused", effectiveAt: effectiveAt, record: &record)
    sensorTrace.append(RideSensorTraceEntry(
      kind: "session", reason: automatic ? "auto_paused" : "manual_paused"
    ))
    try saveRecord(record)
    rideRecord = record
    if !automatic {
      autoPausePolicy.reset()
      sensorTrace.append(RideSensorTraceEntry(kind: "policyReset", reason: "manual_pause"))
      positionSpeedEstimator.reset()
      positionSpeedEstimatesByTimestamp = [:]
    }
    gradeEstimator.reset()
    speedSmoother.reset()
    sensorTrace.append(RideSensorTraceEntry(kind: "speedReset", reason: "pause"))
    terrainRoadGuidance.pause()
    stopSensors(keepLocationForAutoPause: automatic)
    watchHeartRate.pauseRide()
    nextPointStartsSegment = true
    lastDistanceLocation = nil
    publishHeartRateSnapshot()
  }

  @objc(resumeRide:rejecter:)
  func resumeRide(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard var record = rideRecord, record.status != "active" else {
      reject("ride_not_paused", "Tidak ada perjalanan yang perlu dilanjutkan.", nil)
      return
    }
    if let locationError = locationError() {
      reject("location_unavailable", locationError, nil)
      return
    }

    do {
      try resumeRecording(record: &record)
      resolve(currentSnapshot())
    } catch {
      reject("ride_resume_failed", "Perjalanan tidak dapat dilanjutkan: \(error.localizedDescription)", error)
    }
  }

  private func resumeRecording(record: inout RideRecord, effectiveAt: Date = Date(), resetMotionPolicy: Bool = true) throws {
    try openSampleFile(for: record)
    try openHeartRateFile(for: record)
    if record.sensorDiagnosticsEnabled == true,
       sensorTrace.status != "active", sensorTrace.status != "full" {
      sensorTrace.open(rideID: record.id, in: ridesDirectory)
    }
    var clock = record.elapsedTime ?? legacyElapsedTime(for: record)
    clock.resume(at: effectiveAt)
    record.elapsedTime = clock
    record.status = "active"
    record.autoPaused = false
    if let previousFinishTime = record.finishedAt {
      record.finishedAt = nil
      record.events?.removeAll { $0.kind == "finished" }
      appendSessionEvent("manual_paused", effectiveAt: previousFinishTime, record: &record)
    }
    appendSessionEvent("resumed", effectiveAt: effectiveAt, record: &record)
    sensorTrace.append(RideSensorTraceEntry(kind: "session", reason: "resumed"))
    try saveRecord(record)
    rideRecord = record
    if resetMotionPolicy {
      autoPausePolicy.reset()
      sensorTrace.append(RideSensorTraceEntry(kind: "policyReset", reason: "resume"))
      positionSpeedEstimator.reset()
      positionSpeedEstimatesByTimestamp = [:]
    }
    ascentAccumulator.resetReference()
    lastDistanceLocation = nil
    lastReceivedLocation = nil
    gradeEstimator.reset()
    nextPointStartsSegment = true
    startSensors()
    watchHeartRate.resumeRide()
    publishHeartRateSnapshot()
  }

  @objc(setAutoPauseEnabled:resolver:rejecter:)
  func setAutoPauseEnabled(_ enabled: Bool, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    let previousSetting = autoPauseEnabled
    autoPauseEnabled = enabled
    do {
      if !enabled, var record = rideRecord, record.status == "paused", record.autoPaused == true {
        if let message = locationError() { throw NSError(domain: "RideTracking", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        try resumeRecording(record: &record)
        pendingAutoPauseLocations = []
      }
      UserDefaults.standard.set(enabled, forKey: "CycleCompAutoPauseEnabled")
      locationManager.distanceFilter = 0
      locationManager.pausesLocationUpdatesAutomatically = false
      resolve(currentSnapshot())
    } catch {
      autoPauseEnabled = previousSetting
      reject("auto_pause_failed", error.localizedDescription, error)
    }
  }

  @objc(setSensorDiagnosticsEnabled:resolver:rejecter:)
  func setSensorDiagnosticsEnabled(_ enabled: Bool, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard rideRecord == nil else {
      reject("ride_exists", "Ubah diagnostik sensor sebelum memulai perjalanan.", nil)
      return
    }
    sensorDiagnosticsEnabled = enabled
    UserDefaults.standard.set(enabled, forKey: "CycleCompSensorDiagnosticsEnabled")
    resolve(currentSnapshot())
  }

  @objc(finishRide:rejecter:)
  func finishRide(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard var record = rideRecord else {
      reject("ride_missing", "Tidak ada perjalanan untuk diselesaikan.", nil)
      return
    }
    let finishTime = record.finishedAt ?? Date()
    var finishedClock = record.elapsedTime ?? legacyElapsedTime(for: record)
    finishedClock.pause(at: finishTime)
    record.elapsedTime = finishedClock
    record.finishedAt = finishTime
    if record.events?.contains(where: { $0.kind == "finished" }) != true {
      endMotionEvidence(record: &record, at: finishTime)
      appendSessionEvent("finished", effectiveAt: finishTime, record: &record)
    }
    rideRecord = record
    autoPausePolicy.reset()
    sensorTrace.append(RideSensorTraceEntry(kind: "session", reason: "finished"))
    positionSpeedEstimator.reset()
    positionSpeedEstimatesByTimestamp = [:]
    terrainRoadGuidance.pause()
    stopSensors()
    watchHeartRate.finishRide()
    heartRateFile?.closeFile()
    heartRateFile = nil
    sensorTrace.close()
    updateIdleTimer(disabled: false)
    sampleFile?.closeFile()
    sampleFile = nil

    do {
      let exportedURL = ridePoints.isEmpty ? nil : try exportGpx(for: record)
      var finishedState = currentSnapshot()
      finishedState["status"] = "finished"
      finishedState["fileUrl"] = exportedURL?.absoluteString ?? NSNull()
      let traceURL = ridesDirectory.appendingPathComponent("CycleComp-\(record.id)-sensor.jsonl")
      if record.sensorDiagnosticsEnabled == true,
         let traceBytes = (try? FileManager.default.attributesOfItem(atPath: traceURL.path)[.size]) as? NSNumber,
         traceBytes.intValue > 0 {
        finishedState["sensorTraceFileUrl"] = traceURL.absoluteString
        if sensorTrace.status == "off" { finishedState["sensorTraceStatus"] = "complete" }
      }
      let recordedHeartRateURL = recordingDirectory.appendingPathComponent("\(record.id)-hr.jsonl")
      if FileManager.default.fileExists(atPath: recordedHeartRateURL.path) {
        try FileManager.default.createDirectory(at: ridesDirectory, withIntermediateDirectories: true)
        let savedHeartRateURL = ridesDirectory.appendingPathComponent("CycleComp-\(record.id)-hr.jsonl")
        try Data(contentsOf: recordedHeartRateURL).write(to: savedHeartRateURL, options: .atomic)
        finishedState["heartRateFileUrl"] = savedHeartRateURL.absoluteString
      }
      try FileManager.default.removeItem(at: recordURL)
      rideRecord = nil
      ridePoints = []
      pendingAutoPauseLocations = []
      resolve(finishedState)
    } catch {
      var recoverableRecord = record
      recoverableRecord.status = "paused"
      recoverableRecord.autoPaused = false
      try? saveRecord(recoverableRecord)
      rideRecord = recoverableRecord
      if hasListeners { sendEvent(withName: "RideTrackingSnapshot", body: currentSnapshot()) }
      reject("gpx_export_failed", "GPX belum tersimpan. Coba Selesai lagi: \(error.localizedDescription)", error)
    }
  }

  @objc(shareGpx:resolver:rejecter:)
  func shareGpx(_ fileUrl: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard let url = URL(string: fileUrl), url.isFileURL,
          url.pathExtension.lowercased() == "gpx",
          FileManager.default.fileExists(atPath: url.path),
          url.deletingLastPathComponent() == ridesDirectory else {
      reject("gpx_missing", "File GPX tidak ditemukan di penyimpanan CycleComp.", nil)
      return
    }

    let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    guard let presenter = RCTPresentedViewController() else {
      reject("share_unavailable", "Lembar berbagi tidak dapat dibuka.", nil)
      return
    }
    presenter.present(activity, animated: true)
    resolve(nil)
  }

  @objc(shareSensorTrace:resolver:rejecter:)
  func shareSensorTrace(_ fileUrl: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard let url = URL(string: fileUrl), url.isFileURL,
          url.lastPathComponent.hasSuffix("-sensor.jsonl"),
          url.deletingLastPathComponent() == ridesDirectory,
          FileManager.default.fileExists(atPath: url.path) else {
      reject("sensor_trace_missing", "File diagnostik sensor tidak ditemukan.", nil)
      return
    }
    guard let presenter = RCTPresentedViewController() else {
      reject("share_unavailable", "Lembar berbagi tidak dapat dibuka.", nil)
      return
    }
    presenter.present(UIActivityViewController(activityItems: [url], applicationActivities: nil), animated: true)
    resolve(nil)
  }

  @objc(listSavedRides:rejecter:)
  func listSavedRides(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    let fileManager = FileManager.default
    let directory = ridesDirectory

    guard fileManager.fileExists(atPath: directory.path) else {
      resolve([])
      return
    }

    do {
      let fileURLs = try fileManager.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: [.contentModificationDateKey, .creationDateKey, .fileSizeKey],
        options: [.skipsHiddenFiles]
      )

      let isoFormatter = ISO8601DateFormatter()
      var results: [[String: Any]] = []

      for fileURL in fileURLs where fileURL.pathExtension.lowercased() == "gpx" {
        let attributes = (try? fileManager.attributesOfItem(atPath: fileURL.path)) ?? [:]
        let creationDate = (attributes[.creationDate] as? Date) ?? (attributes[.modificationDate] as? Date) ?? Date()
        let fileSize = (attributes[.size] as? NSNumber)?.intValue ?? 0
        let baseName = fileURL.deletingPathExtension().lastPathComponent

        // Check if sensor trace exists
        let traceUrl = directory.appendingPathComponent("\(baseName)-sensor.jsonl")
        let hasSensorTrace = fileManager.fileExists(atPath: traceUrl.path)

        results.append([
          "id": baseName,
          "fileName": fileURL.lastPathComponent,
          "fileUrl": fileURL.absoluteString,
          "filePath": fileURL.path,
          "fileSizeBytes": fileSize,
          "createdAt": isoFormatter.string(from: creationDate),
          "hasSensorTrace": hasSensorTrace,
        ])
      }

      // Sort newest first
      results.sort { ($0["createdAt"] as? String ?? "") > ($1["createdAt"] as? String ?? "") }
      resolve(results)
    } catch {
      reject("list_rides_failed", "Gagal membaca daftar riwayat perjalanan: \(error.localizedDescription)", error)
    }
  }

  @objc(readSavedRideGpx:resolver:rejecter:)
  func readSavedRideGpx(_ fileUrl: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard let url = URL(string: fileUrl), url.isFileURL,
          url.pathExtension.lowercased() == "gpx",
          url.standardizedFileURL.path.hasPrefix(ridesDirectory.standardizedFileURL.path),
          FileManager.default.fileExists(atPath: url.path) else {
      reject("gpx_missing", "File GPX tidak ditemukan di penyimpanan CycleComp.", nil)
      return
    }

    do {
      let content = try String(contentsOf: url, encoding: .utf8)
      resolve(content)
    } catch {
      reject("read_gpx_failed", "Gagal membaca isi file GPX: \(error.localizedDescription)", error)
    }
  }

  @objc(deleteSavedRide:resolver:rejecter:)
  func deleteSavedRide(_ fileUrl: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard let url = URL(string: fileUrl), url.isFileURL,
          url.pathExtension.lowercased() == "gpx",
          url.standardizedFileURL.path.hasPrefix(ridesDirectory.standardizedFileURL.path),
          FileManager.default.fileExists(atPath: url.path) else {
      reject("gpx_missing", "File GPX tidak ditemukan di penyimpanan CycleComp.", nil)
      return
    }

    do {
      try FileManager.default.removeItem(at: url)
      let traceUrl = ridesDirectory.appendingPathComponent(url.deletingPathExtension().lastPathComponent + "-sensor.jsonl")
      if FileManager.default.fileExists(atPath: traceUrl.path) {
        try? FileManager.default.removeItem(at: traceUrl)
      }
      resolve(true)
    } catch {
      reject("delete_failed", "Gagal menghapus file riwayat: \(error.localizedDescription)", error)
    }
  }

  @objc(openStravaUpload:rejecter:)
  func openStravaUpload(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard let presenter = RCTPresentedViewController(),
          let uploadURL = URL(string: "https://www.strava.com/upload/select") else {
      reject("strava_unavailable", "Halaman unggah Strava tidak dapat dibuka.", nil)
      return
    }

    // Keep the file uploader on the website instead of following a link into the Strava app.
    let browser = SFSafariViewController(url: uploadURL)
    presenter.present(browser, animated: true)
    resolve(nil)
  }

  @objc(getStravaStorage:rejecter:)
  func getStravaStorage(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    let dict = UserDefaults.standard.dictionary(forKey: "CycleComp_StravaStorage") ?? [:]
    resolve(dict)
  }

  @objc(setStravaStorage:resolver:rejecter:)
  func setStravaStorage(_ data: [String: Any], resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    UserDefaults.standard.set(data, forKey: "CycleComp_StravaStorage")
    resolve(true)
  }

  @objc(uploadGpxToStrava:accessToken:activityName:resolver:rejecter:)
  func uploadGpxToStrava(_ fileUrl: String, accessToken: String, activityName: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let url = URL(string: fileUrl), url.isFileURL,
          url.standardizedFileURL.path.hasPrefix(ridesDirectory.standardizedFileURL.path),
          FileManager.default.fileExists(atPath: url.path) else {
      reject("file_missing", "File GPX tidak ditemukan di folder penyimpanan.", nil)
      return
    }

    guard let gpxData = try? Data(contentsOf: url) else {
      reject("file_read_failed", "Gagal membaca isi data file GPX.", nil)
      return
    }

    guard let uploadApiUrl = URL(string: "https://www.strava.com/api/v3/uploads") else {
      reject("invalid_url", "URL endpoint Strava tidak valid.", nil)
      return
    }

    let boundary = "Boundary-\(UUID().uuidString)"
    var request = URLRequest(url: uploadApiUrl)
    request.httpMethod = "POST"
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

    var body = Data()
    func appendFormField(name: String, value: String) {
      if let boundaryData = "--\(boundary)\r\n".data(using: .utf8),
         let dispositionData = "Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8),
         let valueData = "\(value)\r\n".data(using: .utf8) {
        body.append(boundaryData)
        body.append(dispositionData)
        body.append(valueData)
      }
    }

    appendFormField(name: "data_type", value: "gpx")
    appendFormField(name: "name", value: activityName.isEmpty ? "CycleComp ride" : activityName)
    appendFormField(name: "description", value: "Direkam dengan CycleComp · Barometer elevation & Live metrics")

    let filename = url.lastPathComponent
    if let boundaryData = "--\(boundary)\r\n".data(using: .utf8),
       let dispositionData = "Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8),
       let contentTypeData = "Content-Type: application/gpx+xml\r\n\r\n".data(using: .utf8),
       let newlineData = "\r\n".data(using: .utf8),
       let closingBoundaryData = "--\(boundary)--\r\n".data(using: .utf8) {
      body.append(boundaryData)
      body.append(dispositionData)
      body.append(contentTypeData)
      body.append(gpxData)
      body.append(newlineData)
      body.append(closingBoundaryData)
    }

    request.httpBody = body

    let task = URLSession.shared.dataTask(with: request) { data, response, error in
      if let error = error {
        reject("upload_network_error", "Koneksi ke Strava gagal: \(error.localizedDescription)", error)
        return
      }

      guard let httpResponse = response as? HTTPURLResponse, let data = data else {
        reject("upload_invalid_response", "Respon dari Strava tidak valid.", nil)
        return
      }

      guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        reject("upload_parse_error", "Gagal memproses respon JSON Strava.", nil)
        return
      }

      if httpResponse.statusCode < 200 || httpResponse.statusCode >= 300 {
        let message = (json["message"] as? String) ?? (json["error"] as? String) ?? "Status HTTP \(httpResponse.statusCode)"
        reject("strava_api_error", "Strava menolak unggahan: \(message)", nil)
        return
      }

      resolve(json)
    }
    task.resume()
  }

  @objc(checkStravaUploadStatus:accessToken:resolver:rejecter:)
  func checkStravaUploadStatus(_ uploadId: String, accessToken: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let url = URL(string: "https://www.strava.com/api/v3/uploads/\(uploadId)") else {
      reject("invalid_url", "URL status Strava tidak valid.", nil)
      return
    }

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")

    let task = URLSession.shared.dataTask(with: request) { data, response, error in
      if let error = error {
        reject("status_network_error", "Gagal memeriksa status Strava: \(error.localizedDescription)", error)
        return
      }

      guard let httpResponse = response as? HTTPURLResponse, let data = data else {
        reject("status_invalid_response", "Respon dari Strava tidak valid.", nil)
        return
      }

      guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        reject("status_parse_error", "Gagal memproses respon status Strava.", nil)
        return
      }

      if httpResponse.statusCode < 200 || httpResponse.statusCode >= 300 {
        let message = (json["message"] as? String) ?? (json["error"] as? String) ?? "Status HTTP \(httpResponse.statusCode)"
        reject("strava_status_error", message, nil)
        return
      }

      resolve(json)
    }
    task.resume()
  }

  @objc(setKeepScreenOn:resolver:rejecter:)
  func setKeepScreenOn(_ keepOn: Bool, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    updateIdleTimer(disabled: keepOn)
    resolve(keepOn)
  }

  @objc(playAudioCue:resolver:rejecter:)
  func playAudioCue(_ cueType: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      switch cueType {
      case "turn_approach":
        self.playSystemCue(1057)
        let haptic = UIImpactFeedbackGenerator(style: .medium)
        haptic.prepare()
        haptic.impactOccurred()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) {
          self.playSystemCue(1057)
          haptic.impactOccurred()
        }
      case "turn_imminent":
        self.playSystemCue(1054)
        let haptic = UIImpactFeedbackGenerator(style: .heavy)
        haptic.prepare()
        haptic.impactOccurred()
      case "off_route":
        self.playSystemCue(1073)
        let haptic = UINotificationFeedbackGenerator()
        haptic.prepare()
        haptic.notificationOccurred(.warning)
      case "on_route":
        self.playSystemCue(1052)
        let haptic = UINotificationFeedbackGenerator()
        haptic.prepare()
        haptic.notificationOccurred(.success)
      case "climb_approach":
        self.playSystemCue(1057)
        let haptic = UIImpactFeedbackGenerator(style: .light)
        haptic.prepare()
        haptic.impactOccurred()
      case "climb_start":
        self.playSystemCue(1022)
        let haptic = UINotificationFeedbackGenerator()
        haptic.prepare()
        haptic.notificationOccurred(.success)
      default:
        self.playSystemCue(1103)
        let haptic = UIImpactFeedbackGenerator(style: .light)
        haptic.prepare()
        haptic.impactOccurred()
      }
      resolve(true)
    }
  }

  private func playSystemCue(_ soundID: SystemSoundID) {
    if playingCueCount == 0 {
      try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers, .duckOthers])
      try? AVAudioSession.sharedInstance().setActive(true)
    }
    playingCueCount += 1
    AudioServicesPlaySystemSoundWithCompletion(soundID) { [weak self] in
      DispatchQueue.main.async {
        guard let self else { return }
        self.playingCueCount -= 1
        if self.playingCueCount == 0 {
          try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
      }
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let record = rideRecord else { return }
    guard record.status == "active" || (record.status == "paused" && record.autoPaused == true) else { return }
    let receivedAt = Date()
    for location in locations.sorted(by: { $0.timestamp < $1.timestamp }) {
      if sensorTrace.status == "active" {
        let motionSummary = motionSensor.recentMotionSummary
        sensorTrace.append(RideSensorTraceEntry(
          kind: "location",
          recordedAt: receivedAt,
          location: RideTraceLocation(
            timestamp: location.timestamp,
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            horizontalAccuracyMeters: location.horizontalAccuracy,
            verticalAccuracyMeters: location.verticalAccuracy,
            gpsElevationMeters: location.altitude,
            speedMetersPerSecond: location.speed,
            speedAccuracyMetersPerSecond: location.speedAccuracy,
            motionActivityIsStationary: motionSensor.isConfidentlyStationary(at: location.timestamp),
            motionActivityStatus: motionSensor.activityStatus,
            motionActivityConfidence: motionSensor.activityConfidence,
            motionActivityObservedAt: motionSensor.activityObservedAt,
            barometerStatus: barometerStatus,
            accelerationRmsG: motionSummary?.accelerationRmsG,
            rotationRmsRadiansPerSecond: motionSummary?.rotationRmsRadiansPerSecond
          )
        ))
      }
      let recordingStartedAt = (rideRecord?.events ?? []).last(where: { $0.kind == "resumed" })?.effectiveAt
        ?? record.startedAt
      guard location.timestamp >= recordingStartedAt, location.timestamp <= receivedAt else {
        sensorTrace.append(RideSensorTraceEntry(kind: "locationRejected", reason: "outside_ride_window"))
        continue
      }
      let wasAutoPaused = rideRecord?.status == "paused" && rideRecord?.autoPaused == true
      if wasAutoPaused { bufferAutoPauseLocation(location) }
      let resumedFromAutoPause = handleMotion(location)
      let isAutoPaused = rideRecord?.status == "paused" && rideRecord?.autoPaused == true
      if resumedFromAutoPause {
        flushAutoPauseLocations()
      } else if isAutoPaused {
        if !wasAutoPaused { bufferAutoPauseLocation(location) }
      } else if rideRecord?.status == "active", !wasAutoPaused {
        recordLocation(location)
      }
    }
  }

  private func handleMotion(_ location: CLLocation) -> Bool {
    guard var record = rideRecord,
          record.status == "active" || (record.status == "paused" && record.autoPaused == true) else { return false }
    guard location.horizontalAccuracy.isFinite, location.horizontalAccuracy >= 0 else {
      sensorTrace.append(RideSensorTraceEntry(kind: "locationRejected", reason: "invalid_horizontal_accuracy"))
      return false
    }

    let fixAgeSeconds = Date().timeIntervalSince(location.timestamp)
    guard fixAgeSeconds >= 0 else {
      sensorTrace.append(RideSensorTraceEntry(kind: "locationRejected", reason: "future_fix"))
      return false
    }
    if fixAgeSeconds > 3 {
      sensorTrace.append(RideSensorTraceEntry(kind: "locationRejected", reason: "stale_fix"))
      if let previousLocation = lastReceivedLocation,
         location.timestamp > previousLocation.timestamp,
         autoPausePolicy.state != .unknown {
        appendSessionEvent(
          "motion_unknown",
          effectiveAt: previousLocation.timestamp.addingTimeInterval(3),
          record: &record
        )
        rideRecord = record
        try? saveRecord(record)
        lastDistanceLocation = nil
        ascentAccumulator.resetReference()
        nextPointStartsSegment = true
      }
      autoPausePolicy.reset()
      sensorTrace.append(RideSensorTraceEntry(kind: "policyReset", reason: "stale_fix"))
      positionSpeedEstimator.reset()
      positionSpeedEstimatesByTimestamp = [:]
      lastReceivedLocation = location
      return false
    }
    guard let previousLocation = lastReceivedLocation else {
      _ = updatePositionSpeedEstimate(for: location)
      lastReceivedLocation = location
      sensorTrace.append(RideSensorTraceEntry(kind: "locationBaseline"))
      return false
    }
    guard location.timestamp > previousLocation.timestamp else {
      sensorTrace.append(RideSensorTraceEntry(kind: "locationRejected", reason: "out_of_order_fix"))
      return false
    }

    let sampleInterval = location.timestamp.timeIntervalSince(previousLocation.timestamp)
    let displacementMeters = sampleInterval <= 3
      ? location.distance(from: previousLocation)
      : 0
    lastReceivedLocation = location
    let positionSpeedEstimate = updatePositionSpeedEstimate(for: location)
    let rawSpeedIsValid = location.speed.isFinite && location.speed >= 0 && location.speed <= 40
    let speedAccuracyIsValid = location.speedAccuracy.isFinite && location.speedAccuracy >= 0 && location.speedAccuracy <= 1.5
    let policyStateBefore = autoPausePolicy.state.rawValue
    let motionActivityIsStationary = motionSensor.isConfidentlyStationary(at: location.timestamp)
    let transition = autoPausePolicy.observe(
      speedMetersPerSecond: rawSpeedIsValid && speedAccuracyIsValid ? location.speed : nil,
      horizontalAccuracyMeters: location.horizontalAccuracy,
      speedAccuracyMetersPerSecond: location.speedAccuracy,
      displacementSincePreviousMeters: displacementMeters,
      timestamp: location.timestamp,
      positionSpeedMetersPerSecond: positionSpeedEstimate?.speedMetersPerSecond,
      positionSpeedWindowStartedAt: positionSpeedEstimate?.windowStartedAt,
      latitude: location.coordinate.latitude,
      longitude: location.coordinate.longitude,
      motionActivityIsStationary: motionActivityIsStationary
    )
    let transitionDescription: (kind: String?, effectiveAt: Date?)
    switch transition {
    case .startedMoving(let effectiveAt): transitionDescription = ("startedMoving", effectiveAt)
    case .stoppedMoving(let effectiveAt): transitionDescription = ("stoppedMoving", effectiveAt)
    case .becameUnknown(let effectiveAt): transitionDescription = ("becameUnknown", effectiveAt)
    case .none: transitionDescription = (nil, nil)
    }
    sensorTrace.append(RideSensorTraceEntry(
      kind: "policy",
      policy: RideTracePolicyObservation(
        timestamp: location.timestamp,
        speedMetersPerSecond: rawSpeedIsValid && speedAccuracyIsValid ? location.speed : nil,
        horizontalAccuracyMeters: location.horizontalAccuracy,
        speedAccuracyMetersPerSecond: location.speedAccuracy,
        displacementSincePreviousMeters: displacementMeters,
        positionSpeedMetersPerSecond: positionSpeedEstimate?.speedMetersPerSecond,
        positionSpeedWindowStartedAt: positionSpeedEstimate?.windowStartedAt,
        latitude: location.coordinate.latitude,
        longitude: location.coordinate.longitude,
        motionActivityIsStationary: motionActivityIsStationary,
        stateBefore: policyStateBefore,
        stateAfter: autoPausePolicy.state.rawValue,
        transition: transitionDescription.kind,
        transitionEffectiveAt: transitionDescription.effectiveAt
      )
    ))

    do {
      switch transition {
      case .startedMoving(let effectiveAt):
        appendSessionEvent("motion_started", effectiveAt: effectiveAt, record: &record)
        if autoPauseEnabled, record.status == "paused", record.autoPaused == true {
          autoPauseResumeEffectiveAt = effectiveAt
          try resumeRecording(record: &record, effectiveAt: Date(), resetMotionPolicy: false)
          return true
        }
        backfillConfirmedDistance(from: effectiveAt)
        rideRecord = record
        try saveRecord(record)
      case .stoppedMoving(let effectiveAt):
        appendSessionEvent("motion_stopped", effectiveAt: effectiveAt, record: &record)
        gradeEstimator.reset()
        if autoPauseEnabled, record.status == "active" {
          try pauseRecording(record: &record, automatic: true, effectiveAt: Date())
        } else {
          rideRecord = record
          try saveRecord(record)
        }
      case .becameUnknown(let effectiveAt):
        appendSessionEvent("motion_unknown", effectiveAt: effectiveAt, record: &record)
        gradeEstimator.reset()
        positionSpeedEstimator.reset()
        positionSpeedEstimatesByTimestamp = [:]
        lastDistanceLocation = nil
        ascentAccumulator.resetReference()
        nextPointStartsSegment = true
        rideRecord = record
        try saveRecord(record)
      case .none:
        break
      }
    } catch {
      if hasListeners { sendEvent(withName: "RideTrackingError", body: ["message": "Auto-pause gagal menyimpan status: \(error.localizedDescription)"]) }
    }
    return false
  }

  private func updatePositionSpeedEstimate(for location: CLLocation) -> RidePositionSpeedEstimate? {
    let estimate = positionSpeedEstimator.update(
      latitude: location.coordinate.latitude,
      longitude: location.coordinate.longitude,
      horizontalAccuracyMeters: location.horizontalAccuracy,
      at: location.timestamp
    )
    guard let estimate else { return nil }

    positionSpeedEstimatesByTimestamp[location.timestamp.timeIntervalSince1970] = estimate
    if positionSpeedEstimatesByTimestamp.count > 20 {
      for timestamp in positionSpeedEstimatesByTimestamp.keys.sorted().prefix(5) {
        positionSpeedEstimatesByTimestamp.removeValue(forKey: timestamp)
      }
    }
    return estimate
  }

  private func backfillConfirmedDistance(from movementStartedAt: Date) {
    guard ridePoints.count > 1 else { return }
    for pointIndex in 1..<ridePoints.count {
      let previousPoint = ridePoints[pointIndex - 1]
      let point = ridePoints[pointIndex]
      let intervalSeconds = point.timestamp.timeIntervalSince(previousPoint.timestamp)
      guard previousPoint.timestamp >= movementStartedAt,
            point.timestamp >= movementStartedAt,
            point.segmentStart != true,
            intervalSeconds > 0, intervalSeconds <= 3,
            previousPoint.horizontalAccuracyMeters <= 20,
            point.horizontalAccuracyMeters <= 20 else { continue }

      let previousLocation = CLLocation(latitude: previousPoint.latitude, longitude: previousPoint.longitude)
      let location = CLLocation(latitude: point.latitude, longitude: point.longitude)
      let displacementMeters = location.distance(from: previousLocation)
      let positionSpeedMetersPerSecond = displacementMeters / intervalSeconds
      guard positionSpeedMetersPerSecond >= 0.25,
            positionSpeedMetersPerSecond <= 40 else { continue }
      distanceMeters += displacementMeters
    }
  }

  private func bufferAutoPauseLocation(_ location: CLLocation) {
    guard abs(location.timestamp.timeIntervalSinceNow) <= 5 else { return }
    pendingAutoPauseLocations.append(location)
    pendingAutoPauseLocations.removeAll {
      Date().timeIntervalSince($0.timestamp) > 5
    }
  }

  private func flushAutoPauseLocations() {
    let bufferedLocations = pendingAutoPauseLocations.sorted { $0.timestamp < $1.timestamp }
    pendingAutoPauseLocations = []
    let movingStartedAt = autoPauseResumeEffectiveAt
    var movingSegmentStarted = false
    for location in bufferedLocations {
      let locationWasRecordedAsMoving = movingStartedAt.map { location.timestamp >= $0 } ?? true
      if locationWasRecordedAsMoving, !movingSegmentStarted {
        nextPointStartsSegment = true
        movingSegmentStarted = true
      }
      recordLocation(location, motionStateOverride: locationWasRecordedAsMoving ? .moving : .stationary)
    }
    autoPauseResumeEffectiveAt = nil
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    if (error as? CLError)?.code == .locationUnknown { return }
    if hasListeners {
      sendEvent(withName: "RideTrackingError", body: ["message": error.localizedDescription])
    }
  }

  private func locationError() -> String? {
    guard CLLocationManager.locationServicesEnabled(),
          locationManager.authorizationStatus == .authorizedWhenInUse ||
            locationManager.authorizationStatus == .authorizedAlways else {
      return "Izinkan lokasi untuk CycleComp di Pengaturan iPhone."
    }
    guard locationManager.accuracyAuthorization == .fullAccuracy else {
      return "Aktifkan Lokasi Tepat untuk merekam jalur."
    }
    return nil
  }

#if DEBUG && targetEnvironment(simulator)
  private func simulatedBarometerSample(for location: CLLocation) -> RideBarometerSample? {
    if simulatesDistanceProfile {
      return simulatedBarometer.sampleSimulatedRouteProfile(
        distanceMeters: distanceMeters,
        at: location.timestamp
      )
    }
    return simulatedBarometer.sample(altitudeMeters: location.altitude, at: location.timestamp)
  }
#endif

  private func startSensors() {
    updateIdleTimer(disabled: true)
    motionSensor.start()
    if !relativeAltitudeUpdatesActive {
      let previousPoint = ridePoints.last
      altitudeFusion.startNewEpoch(
        retaining: previousPoint?.elevationMeters,
        isCalibrated: previousPoint?.elevationSource == "barometer_gps"
      )
    }
    startBarometerUpdates()
    if backgroundSession == nil { backgroundSession = CLBackgroundActivitySession() }
    locationManager.distanceFilter = 0
    locationManager.pausesLocationUpdatesAutomatically = false
    locationManager.allowsBackgroundLocationUpdates = true
    locationManager.startUpdatingLocation()
  }

  private func startBarometerUpdates() {
#if DEBUG && targetEnvironment(simulator)
    if simulatesBarometer {
      barometerStatus = "simulated"
      relativeAltitudeUpdatesActive = true
      return
    }
#endif
    guard CMAltimeter.isRelativeAltitudeAvailable() else {
      barometerStatus = "unavailable"
      return
    }
    guard !relativeAltitudeUpdatesActive else { return }

    barometerStatus = "starting"
    relativeAltitudeUpdatesActive = true
    altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] altitude, error in
      guard let self, self.relativeAltitudeUpdatesActive else { return }
      if error != nil {
        self.altimeter.stopRelativeAltitudeUpdates()
        self.relativeAltitudeUpdatesActive = false
        self.barometerStatus = "error"
        return
      }
      guard let altitude else { return }
      let sampleDate = Date().addingTimeInterval(altitude.timestamp - ProcessInfo.processInfo.systemUptime)
      self.altitudeFusion.recordBarometerSample(RideBarometerSample(
        relativeAltitudeMeters: altitude.relativeAltitude.doubleValue,
        pressureKilopascals: altitude.pressure.doubleValue,
        timestamp: sampleDate
      ))
      self.barometerStatus = "active"
    }
  }

  private func stopSensors(keepLocationForAutoPause: Bool = false) {
    if keepLocationForAutoPause {
      motionSensor.start(reducedRate: true)
    } else {
      motionSensor.stop()
      locationManager.stopUpdatingLocation()
      locationManager.allowsBackgroundLocationUpdates = false
      backgroundSession?.invalidate()
      backgroundSession = nil
      stopBarometerUpdates()
    }
    sampleFile?.synchronizeFile()
  }

  private func stopBarometerUpdates() {
#if DEBUG && targetEnvironment(simulator)
    if simulatesBarometer {
      simulatedBarometer.reset()
      relativeAltitudeUpdatesActive = false
      barometerStatus = "paused"
      return
    }
#endif
    guard relativeAltitudeUpdatesActive else { return }
    altimeter.stopRelativeAltitudeUpdates()
    relativeAltitudeUpdatesActive = false
    barometerStatus = "paused"
  }

  private func recordLocation(_ location: CLLocation, motionStateOverride: RideAutoPausePolicy.MotionState? = nil) {
    let now = Date()
    let positionSpeedEstimate = positionSpeedEstimatesByTimestamp.removeValue(
      forKey: location.timestamp.timeIntervalSince1970
    )
    let locationAgeSeconds = now.timeIntervalSince(location.timestamp)
    guard location.horizontalAccuracy.isFinite, location.horizontalAccuracy >= 0, location.horizontalAccuracy <= 50,
          locationAgeSeconds >= 0, locationAgeSeconds <= 15,
          CLLocationCoordinate2DIsValid(location.coordinate) else {
      sensorTrace.append(RideSensorTraceEntry(kind: "locationRejected", reason: "recording_quality"))
      return
    }
    if let lastRecordedAt = ridePoints.last?.timestamp,
       location.timestamp <= lastRecordedAt {
      sensorTrace.append(RideSensorTraceEntry(kind: "locationRejected", reason: "recording_out_of_order"))
      return
    }

    let recordedMotionState = motionStateOverride ?? autoPausePolicy.state
    var startsNewSegment = nextPointStartsSegment
    if let previousDistanceLocation = lastDistanceLocation {
      let interval = location.timestamp.timeIntervalSince(previousDistanceLocation.timestamp)
      let displacementMeters = location.distance(from: previousDistanceLocation)
      if interval <= 0, !startsNewSegment { return }
      let isFirstConfirmedAutoResumePoint = startsNewSegment &&
        recordedMotionState == .moving &&
        autoPauseResumeEffectiveAt.map {
          previousDistanceLocation.timestamp < $0 && location.timestamp >= $0
        } == true
      let measuredSpeedForDistance = validRawSpeed(for: location) ?? positionSpeedEstimate?.speedMetersPerSecond
      if isFirstConfirmedAutoResumePoint,
         interval > 0, interval <= 3,
         displacementMeters / interval <= 40,
         let speedMetersPerSecond = measuredSpeedForDistance,
         speedMetersPerSecond >= 0.25 {
        distanceMeters += displacementMeters
      } else if interval > 0 && !startsNewSegment && (interval > 30 || displacementMeters / interval > 40) {
        startsNewSegment = true
      } else if interval > 0, !startsNewSegment,
                recordedMotionState == .moving,
                let speedMetersPerSecond = measuredSpeedForDistance,
                speedMetersPerSecond >= 0.25 {
        distanceMeters += displacementMeters
      }
    }
    if startsNewSegment {
      ascentAccumulator.resetReference()
      gradeEstimator.reset()
    }
    lastDistanceLocation = location

    let gpsElevationIsValid = location.verticalAccuracy.isFinite && location.verticalAccuracy > 0 &&
      location.verticalAccuracy <= 60 && location.altitude.isFinite
    let gpsElevation = gpsElevationIsValid ? location.altitude : nil
#if DEBUG && targetEnvironment(simulator)
    if simulatesBarometer,
       let simulatedSample = simulatedBarometerSample(for: location) {
      altitudeFusion.recordBarometerSample(simulatedSample)
    }
#endif
    let altitudeReading = altitudeFusion.reading(
      gpsElevationMeters: gpsElevation,
      gpsVerticalAccuracyMeters: gpsElevationIsValid ? location.verticalAccuracy : nil,
      gpsTimestamp: location.timestamp
    )
    let rawSpeedIsValid = location.speed.isFinite && location.speed >= 0 && location.speed <= 40
    let speedAccuracyIsValid = location.speedAccuracy.isFinite && location.speedAccuracy >= 0 && location.speedAccuracy <= 4.0
    let rawSpeed = rawSpeedIsValid ? location.speed : nil
    let measuredSpeed = rawSpeedIsValid && speedAccuracyIsValid
      ? rawSpeed
      : positionSpeedEstimate?.speedMetersPerSecond
    let speedSource = rawSpeedIsValid && speedAccuracyIsValid
      ? "gps"
      : positionSpeedEstimate == nil ? nil : "position"
    let filteredSpeed = speedSmoother.update(
      speedMetersPerSecond: measuredSpeed,
      at: location.timestamp,
      stationary: recordedMotionState == .stationary
    )
    let recordedSpeedSource = recordedMotionState == .stationary && filteredSpeed != nil
      ? "stationary"
      : measuredSpeed == nil && filteredSpeed != nil ? "held" : speedSource
    sensorTrace.append(RideSensorTraceEntry(
      kind: "speed",
      speed: RideTraceSpeedObservation(
        timestamp: location.timestamp,
        measuredSpeedMetersPerSecond: measuredSpeed,
        stationary: recordedMotionState == .stationary,
        filteredSpeedMetersPerSecond: filteredSpeed,
        speedSource: recordedSpeedSource
      )
    ))
    let gradeElevation = altitudeReading.relativeElevationMeters ??
      (location.verticalAccuracy > 0 && location.verticalAccuracy <= 15 ? gpsElevation : nil)
    let gradeSource = altitudeReading.relativeElevationMeters != nil
      ? "barometer:\(altitudeFusion.epoch)"
      : gradeElevation == nil ? nil : "gps"
    let liveGrade = gradeEstimator.update(
      distanceMeters: distanceMeters,
      elevationMeters: gradeElevation,
      timestamp: location.timestamp,
      source: gradeSource,
      isMoving: recordedMotionState == .moving
    )
    let liveGradeQuality = liveGrade == nil
      ? nil
      : gradeSource == "gps" ? "gps_vertical" : "barometer_relative"
    let heartRateIsFresh = watchHeartRate.lastSampleAt.map {
      let sampleAgeSeconds = location.timestamp.timeIntervalSince($0)
      return sampleAgeSeconds >= 0 && sampleAgeSeconds <= 15
    } ?? false

    let point = RidePoint(
      timestamp: location.timestamp,
      latitude: location.coordinate.latitude,
      longitude: location.coordinate.longitude,
      horizontalAccuracyMeters: location.horizontalAccuracy,
      verticalAccuracyMeters: gpsElevationIsValid ? location.verticalAccuracy : nil,
      elevationMeters: altitudeReading.elevationMeters,
      elevationSource: altitudeReading.elevationSource,
      speedMetersPerSecond: rawSpeed,
      filteredSpeedMetersPerSecond: filteredSpeed,
      speedSource: recordedSpeedSource,
      speedAccuracyMetersPerSecond: speedAccuracyIsValid ? location.speedAccuracy : nil,
      speedLowerBoundMetersPerSecond: speedAccuracyIsValid && rawSpeed != nil
        ? max(0, location.speed - location.speedAccuracy) : nil,
      speedUpperBoundMetersPerSecond: speedAccuracyIsValid && rawSpeed != nil
        ? location.speed + location.speedAccuracy : nil,
      courseDegrees: location.course.isFinite && location.course >= 0 ? location.course : nil,
      segmentStart: startsNewSegment,
      motionState: recordedMotionState.rawValue,
      relativeElevationMeters: altitudeReading.relativeElevationMeters,
      barometerEpoch: barometerStatus == "active" || barometerStatus == "simulated"
        ? altitudeFusion.epoch : nil,
      barometricPressureKilopascals: altitudeReading.pressureKilopascals,
      altitudeAnchorQuality: altitudeReading.anchorQuality,
      liveGradePercent: recordedMotionState == .moving ? liveGrade : nil,
      liveGradeSource: liveGrade == nil ? nil : (gradeSource == "gps" ? "gps" : "barometer"),
      liveGradeQuality: liveGrade == nil ? nil : liveGradeQuality,
      liveGradeWindowMeters: liveGrade == nil ? nil : gradeEstimator.measurementWindowMeters,
      liveGradeSampleCount: liveGrade == nil ? nil : gradeEstimator.measurementSampleCount,
      heartRateBpm: heartRateIsFresh ? watchHeartRate.currentHeartRate : nil,
      heartRateRecordedAt: heartRateIsFresh ? watchHeartRate.lastSampleAt : nil,
      cumulativeDistanceMeters: distanceMeters
    )

    do {
      let encodedPoint = try JSONEncoder().encode(point)
      guard let sampleFile else { throw NSError(domain: "RideTracking", code: 1) }
      try sampleFile.write(contentsOf: encodedPoint + Data([10]))
      // Append every fix; force a disk checkpoint at segment boundaries and every five seconds.
      if startsNewSegment || now.timeIntervalSince(lastCheckpointAt) >= 5 {
        try sampleFile.synchronize()
        lastCheckpointAt = now
        if let record = rideRecord { try saveRecord(record) }
      }
      ridePoints.append(point)
      nextPointStartsSegment = false
      lastReceivedLocation = location
      updateAscent(with: point)
      terrainRoadGuidance.update(
        location: location,
        speedMetersPerSecond: point.filteredSpeedMetersPerSecond,
        courseDegrees: point.courseDegrees,
        motionState: recordedMotionState.rawValue
      ) { [weak self] updatedTerrainGuidance in
        guard let self,
              self.rideRecord?.status == "active",
              self.hasListeners,
              self.shouldPublishTerrainGuidance(updatedTerrainGuidance) else { return }
        self.lastTerrainGuidancePublishedAt = Date()
        self.lastPublishedTerrainGuidance = updatedTerrainGuidance
        self.sendEvent(withName: "RideTrackingSnapshot", body: self.currentSnapshot())
      }
      if point.segmentStart == true || now.timeIntervalSince(lastPublishedAt) >= 1 {
        lastPublishedAt = now
        var snapshot = currentSnapshot()
        snapshot["newCoordinate"] = [point.longitude, point.latitude]
        snapshot["newSegment"] = point.segmentStart ?? false
        snapshot["courseDegrees"] = point.courseDegrees ?? NSNull()
        if hasListeners { sendEvent(withName: "RideTrackingSnapshot", body: snapshot) }
      }
    } catch {
      stopSensors()
      watchHeartRate.pauseRide()
      if var record = rideRecord {
        var clock = record.elapsedTime ?? legacyElapsedTime(for: record)
        clock.pause(at: Date())
        record.elapsedTime = clock
        record.status = "paused"
        record.autoPaused = false
        endMotionEvidence(record: &record, at: Date())
        appendSessionEvent("recording_error_paused", effectiveAt: Date(), record: &record)
        rideRecord = record
        try? saveRecord(record)
      }
      if hasListeners {
        sendEvent(withName: "RideTrackingSnapshot", body: currentSnapshot())
        sendEvent(withName: "RideTrackingError", body: ["message": "Perekaman berhenti karena titik GPS tidak dapat disimpan."])
      }
    }
  }

  private func validRawSpeed(for location: CLLocation) -> Double? {
    guard location.speed.isFinite, location.speed >= 0, location.speed <= 40,
          location.speedAccuracy.isFinite, location.speedAccuracy >= 0,
          location.speedAccuracy <= 4.0 else { return nil }
    return location.speed
  }

  private func updateAscent(with point: RidePoint) {
    guard point.motionState == RideAutoPausePolicy.MotionState.moving.rawValue else { return }
    let ascentElevation = point.relativeElevationMeters ?? point.elevationMeters
    let ascentSource: String?
    if point.relativeElevationMeters != nil {
      ascentSource = "barometer-relative:\(point.barometerEpoch ?? 0)"
    } else if point.barometerEpoch != nil {
      return
    } else if point.elevationSource == "barometer_gps" {
      ascentSource = "barometer-absolute"
    } else {
      ascentSource = point.elevationSource.map { "absolute:\($0)" }
    }
    _ = ascentAccumulator.update(
      distanceMeters: distanceMeters,
      elevationMeters: ascentElevation,
      source: ascentSource,
      verticalAccuracyMeters: point.verticalAccuracyMeters
    )
  }

  private func appendSessionEvent(_ kind: String, effectiveAt: Date, record: inout RideRecord) {
    var events = record.events ?? []
    events.append(RideSessionEvent(kind: kind, effectiveAt: effectiveAt, detectedAt: Date()))
    record.events = events.sorted {
      if $0.effectiveAt != $1.effectiveAt { return $0.effectiveAt < $1.effectiveAt }
      return $0.detectedAt < $1.detectedAt
    }
  }

  private func legacyElapsedTime(for record: RideRecord) -> RideElapsedTime {
    if record.status == "active" { return RideElapsedTime(runningSince: record.startedAt) }
    let lastRecordedAt = ridePoints.last?.timestamp ?? record.startedAt
    return RideElapsedTime(accumulatedSeconds: max(0, lastRecordedAt.timeIntervalSince(record.startedAt)))
  }

  private func activeRideSeconds() -> TimeInterval {
    guard let record = rideRecord else { return 0 }
    return (record.elapsedTime ?? legacyElapsedTime(for: record)).seconds(at: Date())
  }

  private func elapsedSeconds(for record: RideRecord, at now: Date) -> TimeInterval {
    max(0, (record.finishedAt ?? now).timeIntervalSince(record.startedAt))
  }

  private func movingSeconds(for record: RideRecord, at now: Date) -> TimeInterval {
    let events = orderedSessionEvents(for: record)
    guard !events.isEmpty else { return legacyMovingSeconds() }

    var movingStartedAt: Date?
    var totalMovingSeconds = 0.0
    for event in events {
      switch event.kind {
      case "motion_started":
        movingStartedAt = event.effectiveAt
      case "motion_stopped", "motion_unknown":
        if let intervalStart = movingStartedAt {
          totalMovingSeconds += max(0, event.effectiveAt.timeIntervalSince(intervalStart))
          movingStartedAt = nil
        }
      default:
        break
      }
    }

    if let movingStartedAt {
      let latestReliableMotionAt = ridePoints.last?.timestamp.addingTimeInterval(3) ?? movingStartedAt
      let motionIntervalEnd = min(record.finishedAt ?? now, latestReliableMotionAt)
      totalMovingSeconds += max(0, motionIntervalEnd.timeIntervalSince(movingStartedAt))
    }
    return min(totalMovingSeconds, elapsedSeconds(for: record, at: now))
  }

  private func pausedSeconds(for record: RideRecord, at endTime: Date) -> (manual: TimeInterval, automatic: TimeInterval) {
    var totalManualPauseSeconds = 0.0
    var totalAutomaticPauseSeconds = 0.0
    var activePause: (kind: String, startedAt: Date)?

    for event in orderedSessionEvents(for: record) where event.effectiveAt <= endTime {
      if event.kind == "manual_paused" || event.kind == "auto_paused" {
        if let activePause {
          let pauseDuration = max(0, event.effectiveAt.timeIntervalSince(activePause.startedAt))
          if activePause.kind == "manual_paused" { totalManualPauseSeconds += pauseDuration }
          else { totalAutomaticPauseSeconds += pauseDuration }
        }
        activePause = (event.kind, event.effectiveAt)
      } else if event.kind == "resumed", let pausedInterval = activePause {
        let pauseDuration = max(0, event.effectiveAt.timeIntervalSince(pausedInterval.startedAt))
        if pausedInterval.kind == "manual_paused" { totalManualPauseSeconds += pauseDuration }
        else { totalAutomaticPauseSeconds += pauseDuration }
        activePause = nil
      }
    }

    if let activePause {
      let pauseDuration = max(0, endTime.timeIntervalSince(activePause.startedAt))
      if activePause.kind == "manual_paused" { totalManualPauseSeconds += pauseDuration }
      else { totalAutomaticPauseSeconds += pauseDuration }
    }
    return (totalManualPauseSeconds, totalAutomaticPauseSeconds)
  }

  private func unknownMotionSeconds(for record: RideRecord, at endTime: Date) -> TimeInterval {
    let totalUnknownSeconds = RideMotionTiming.unknownSeconds(
      events: record.events ?? [],
      startedAt: record.startedAt,
      lastLocationAt: ridePoints.last?.timestamp,
      at: endTime
    )
    let activeTimerSeconds = (record.elapsedTime ?? legacyElapsedTime(for: record)).seconds(at: endTime)
    return min(totalUnknownSeconds, activeTimerSeconds)
  }

  private func endMotionEvidence(record: inout RideRecord, at endTime: Date) {
    var motionState = RideAutoPausePolicy.MotionState.unknown
    for event in orderedSessionEvents(for: record) where event.effectiveAt <= endTime {
      switch event.kind {
      case "motion_started": motionState = .moving
      case "motion_stopped": motionState = .stationary
      case "motion_unknown", "manual_paused", "auto_paused", "recording_error_paused": motionState = .unknown
      default: break
      }
    }
    if let endingEvent = RideMotionTiming.endingEvent(
      motionState: motionState,
      lastLocationAt: lastReceivedLocation?.timestamp ?? ridePoints.last?.timestamp,
      at: endTime
    ) {
      appendSessionEvent(endingEvent.kind, effectiveAt: endingEvent.effectiveAt, record: &record)
    }
  }

  private func orderedSessionEvents(for record: RideRecord) -> [RideSessionEvent] {
    (record.events ?? []).sorted {
      if $0.effectiveAt != $1.effectiveAt { return $0.effectiveAt < $1.effectiveAt }
      return $0.detectedAt < $1.detectedAt
    }
  }

  private func legacyMovingSeconds() -> TimeInterval {
    ridePoints.enumerated().reduce(0) { totalMovingSeconds, indexedPoint in
      let (index, point) = indexedPoint
      guard index + 1 < ridePoints.count else { return totalMovingSeconds }
      let recordedAsMoving = point.motionState == RideAutoPausePolicy.MotionState.moving.rawValue
      let legacySpeedIndicatesMoving = point.motionState == nil && (point.speedMetersPerSecond ?? 0) >= 1
      guard recordedAsMoving || legacySpeedIndicatesMoving else { return totalMovingSeconds }
      let nextPoint = ridePoints[index + 1]
      let interval = nextPoint.timestamp.timeIntervalSince(point.timestamp)
      guard interval > 0 && interval <= 3 else { return totalMovingSeconds }
      return totalMovingSeconds + interval
    }
  }

  private func currentSnapshot() -> [String: Any] {
    let motionSummary = motionSensor.recentMotionSummary
    let sharedSensorState: [String: Any] = [
      "autoPauseEnabled": autoPauseEnabled,
      "autoPaused": rideRecord?.autoPaused ?? false,
      "sensorDiagnosticsEnabled": sensorDiagnosticsEnabled,
      "sensorTraceStatus": sensorTrace.status,
      "barometerStatus": barometerStatus,
      "motionSensorStatus": motionSensor.status,
      "motionActivityStatus": motionSensor.activityStatus,
      "motionActivityStationary": motionSensor.isConfidentlyStationary(at: Date()),
      "motionAccelerationRmsG": motionSummary?.accelerationRmsG ?? NSNull(),
      "motionRotationRmsRadiansPerSecond": motionSummary?.rotationRmsRadiansPerSecond ?? NSNull(),
      "watchHeartRateEnabled": watchHeartRate.enabled,
      "watchHeartRateStatus": watchHeartRate.status,
      "watchHeartRateMessage": watchHeartRate.message ?? NSNull(),
      "heartRateBpm": watchHeartRate.currentHeartRate ?? NSNull(),
      "heartRateRecordedAt": watchHeartRate.lastSampleAt.map { snapshotDateFormatter.string(from: $0) } ?? NSNull()
    ]
    guard let record = rideRecord else {
      return sharedSensorState
        .merging(["status": "idle", "trackSegments": []]) { _, rideValue in rideValue }
        .merging(terrainRoadGuidance.snapshot) { _, terrainValue in terrainValue }
    }
    let latestPoint = ridePoints.last
    let now = Date()
    let timerSeconds = activeRideSeconds()
    let elapsedTimeSeconds = elapsedSeconds(for: record, at: now)
    let pauseDurations = pausedSeconds(for: record, at: now)
    let rideState: [String: Any] = [
      "status": record.status,
      "rideId": record.id,
      "startedAt": snapshotDateFormatter.string(from: record.startedAt),
      "finishedAt": record.finishedAt.map { snapshotDateFormatter.string(from: $0) } ?? NSNull(),
      "elapsedSeconds": elapsedTimeSeconds,
      "timerSeconds": timerSeconds,
      "durationSeconds": timerSeconds,
      "durationUpdatedAt": snapshotDateFormatter.string(from: now),
      "movingSeconds": movingSeconds(for: record, at: now),
      "unknownMotionSeconds": unknownMotionSeconds(for: record, at: now),
      "manualPausedSeconds": pauseDurations.manual,
      "autoPausedSeconds": pauseDurations.automatic,
      "distanceMeters": distanceMeters,
      "ascentMeters": ascentAccumulator.ascentMeters,
      "descentMeters": ascentAccumulator.descentMeters,
      "elevationDataAvailable": ridePoints.contains { $0.elevationMeters != nil },
      "speedMetersPerSecond": latestPoint?.filteredSpeedMetersPerSecond ?? NSNull(),
      "speedSource": latestPoint?.speedSource ?? NSNull(),
      "rawSpeedMetersPerSecond": latestPoint?.speedMetersPerSecond ?? NSNull(),
      "speedAccuracyMetersPerSecond": latestPoint?.speedAccuracyMetersPerSecond ?? NSNull(),
      "speedLowerBoundMetersPerSecond": latestPoint?.speedLowerBoundMetersPerSecond ?? NSNull(),
      "speedUpperBoundMetersPerSecond": latestPoint?.speedUpperBoundMetersPerSecond ?? NSNull(),
      "courseDegrees": latestPoint?.courseDegrees ?? NSNull(),
      "elevationMeters": latestPoint?.elevationMeters ?? NSNull(),
      "elevationSource": latestPoint?.elevationSource ?? NSNull(),
      "elevationAnchorQuality": latestPoint?.altitudeAnchorQuality ?? NSNull(),
      "relativeElevationMeters": latestPoint?.relativeElevationMeters ?? NSNull(),
      "liveGradePercent": autoPausePolicy.state == .moving ? latestPoint?.liveGradePercent ?? NSNull() : NSNull(),
      "liveGradeSource": autoPausePolicy.state == .moving ? latestPoint?.liveGradeSource ?? NSNull() : NSNull(),
      "liveGradeQuality": autoPausePolicy.state == .moving ? latestPoint?.liveGradeQuality ?? NSNull() : NSNull(),
      "liveGradeWindowMeters": autoPausePolicy.state == .moving ? latestPoint?.liveGradeWindowMeters ?? NSNull() : NSNull(),
      "liveGradeSampleCount": autoPausePolicy.state == .moving ? latestPoint?.liveGradeSampleCount ?? NSNull() : NSNull(),
      "liveGradeUpdatedAt": autoPausePolicy.state == .moving && latestPoint?.liveGradePercent != nil
        ? latestPoint.map { snapshotDateFormatter.string(from: $0.timestamp) } ?? NSNull()
        : NSNull(),
      "horizontalAccuracyMeters": latestPoint?.horizontalAccuracyMeters ?? NSNull(),
      "lastFixAt": latestPoint.map { snapshotDateFormatter.string(from: $0.timestamp) } ?? NSNull(),
      "lastCoordinate": latestPoint.map { [$0.longitude, $0.latitude] } ?? NSNull(),
      "pointCount": ridePoints.count
    ]
    return rideState
      .merging(sharedSensorState) { _, sensorValue in sensorValue }
      .merging(terrainRoadGuidance.snapshot) { _, terrainValue in terrainValue }
  }

  private func shouldPublishTerrainGuidance(_ updatedSnapshot: [String: Any]) -> Bool {
    let stateKeys = [
      "terrainMatchStatus",
      "terrainMatchReason",
      "matchedEdgeID",
      "matchedCorridorID",
      "forwardPathQuality",
      "profileQuality",
      "terrainClimbStatus",
      "terrainClimbIndex",
    ]
    if stateKeys.contains(where: { !Self.equalSnapshotValues(lastPublishedTerrainGuidance[$0], updatedSnapshot[$0]) }) {
      return true
    }
    return Date().timeIntervalSince(lastTerrainGuidancePublishedAt) >= 1
  }

  private static func equalSnapshotValues(_ firstValue: Any?, _ secondValue: Any?) -> Bool {
    switch (firstValue, secondValue) {
    case (nil, nil): return true
    case let (first as NSNumber, second as NSNumber): return first == second
    case let (first as String, second as String): return first == second
    case (_ as NSNull, _ as NSNull): return true
    default: return false
    }
  }

  private var ridesDirectory: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Rides", isDirectory: true)
  }

  private var recordingDirectory: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("RideTracking", isDirectory: true)
  }

  private var recordURL: URL { recordingDirectory.appendingPathComponent("active.json") }

  private func sampleURL(for record: RideRecord) -> URL {
    recordingDirectory.appendingPathComponent("\(record.id).jsonl")
  }

  private func saveRecord(_ record: RideRecord) throws {
    try FileManager.default.createDirectory(at: recordingDirectory, withIntermediateDirectories: true)
    var checkpoint = record
    checkpoint.elapsedTime = (record.elapsedTime ?? legacyElapsedTime(for: record)).checkpoint(at: Date())
    try JSONEncoder().encode(checkpoint).write(to: recordURL, options: .atomic)
  }

  private func openSampleFile(for record: RideRecord) throws {
    sampleFile?.closeFile()
    sampleFile = try FileHandle(forWritingTo: sampleURL(for: record))
    sampleFile?.seekToEndOfFile()
    if !ridePoints.isEmpty { try sampleFile?.write(contentsOf: Data([10])) }
  }

  private func restoreRide() {
    guard let recordData = try? Data(contentsOf: recordURL),
          var record = try? JSONDecoder().decode(RideRecord.self, from: recordData) else { return }
    if var clock = record.elapsedTime { clock.runningSince = nil; record.elapsedTime = clock }
    record.status = "recoveryNeeded"
    record.autoPaused = false
    rideRecord = record
    guard let sampleData = try? String(contentsOf: sampleURL(for: record), encoding: .utf8) else { return }
    ridePoints = sampleData.split(separator: "\n").compactMap { line in
      try? JSONDecoder().decode(RidePoint.self, from: Data(line.utf8))
    }
    nextPointStartsSegment = true
    if let firstPoint = ridePoints.first { updateAscent(with: firstPoint) }
    for (index, point) in ridePoints.enumerated() {
      guard index > 0 else { continue }
      if point.segmentStart == true { ascentAccumulator.resetReference() }
      let previous = ridePoints[index - 1]
      let from = CLLocation(latitude: previous.latitude, longitude: previous.longitude)
      let stepDistance = CLLocation(latitude: point.latitude, longitude: point.longitude).distance(from: from)
      let elapsed = point.timestamp.timeIntervalSince(previous.timestamp)
      let pointWasRecordedWhileMoving = point.motionState == RideAutoPausePolicy.MotionState.moving.rawValue ||
        (point.motionState == nil && (point.speedMetersPerSecond ?? 0) >= 1)
      if point.segmentStart != true && elapsed > 0 && elapsed <= 30 &&
          stepDistance / elapsed <= 40 && pointWasRecordedWhileMoving &&
          (point.speedMetersPerSecond ?? 0) >= 0.25 {
        distanceMeters += stepDistance
      }
      updateAscent(with: point)
    }

    // Preserve position-speed fallback, motion backfill, and auto-resume distance credits.
    if let recordedDistanceMeters = ridePoints.last?.cumulativeDistanceMeters,
       recordedDistanceMeters.isFinite, recordedDistanceMeters >= 0 {
      distanceMeters = recordedDistanceMeters
    }

    if motionIsStillOpen(in: record) {
      let lastReliableMotionAt = (ridePoints.last?.timestamp ?? record.startedAt).addingTimeInterval(3)
      appendSessionEvent("motion_unknown", effectiveAt: lastReliableMotionAt, record: &record)
    }
    rideRecord = record
    try? saveRecord(record)
  }

  private func motionIsStillOpen(in record: RideRecord) -> Bool {
    var motionIsOpen = false
    for event in (record.events ?? []).sorted(by: { $0.effectiveAt < $1.effectiveAt }) {
      if event.kind == "motion_started" { motionIsOpen = true }
      else if event.kind == "motion_stopped" || event.kind == "motion_unknown" { motionIsOpen = false }
    }
    return motionIsOpen
  }

  private func trackSegments() -> [[[Double]]] {
    var segments: [[[Double]]] = []
    for point in ridePoints {
      if point.segmentStart == true || segments.isEmpty { segments.append([]) }
      segments[segments.count - 1].append([point.longitude, point.latitude])
    }
    return segments
  }

  private func trackElevationSegments() -> [[[String: Any]]] {
    var segments: [[[String: Any]]] = []
    for point in ridePoints {
      if point.segmentStart == true || segments.isEmpty { segments.append([]) }
      segments[segments.count - 1].append([
        "coordinate": [point.longitude, point.latitude],
        "elevationMeters": point.elevationMeters ?? NSNull()
      ])
    }
    return segments
  }

  private func exportGpx(for record: RideRecord) throws -> URL {
    try FileManager.default.createDirectory(at: ridesDirectory, withIntermediateDirectories: true)
    let fileURL = ridesDirectory.appendingPathComponent("CycleComp-\(record.id).gpx")
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let finishedAt = record.finishedAt ?? Date()
    let elapsedDuration = elapsedSeconds(for: record, at: finishedAt)
    let timerDuration = (record.elapsedTime ?? legacyElapsedTime(for: record)).seconds(at: finishedAt)
    let movingDuration = movingSeconds(for: record, at: finishedAt)
    let unknownMotionDuration = unknownMotionSeconds(for: record, at: finishedAt)
    let pauseDurations = pausedSeconds(for: record, at: finishedAt)
    let trackTimeSpan = ridePoints.first.flatMap { firstPoint in
      ridePoints.last.map { max(0, $0.timestamp.timeIntervalSince(firstPoint.timestamp)) }
    } ?? 0
    let hasContinuousCalibratedBarometer = !ridePoints.isEmpty && ridePoints.allSatisfy {
      $0.elevationSource == "barometer_gps" && $0.altitudeAnchorQuality == "calibrated"
    }
    let elevationQuality = rideElevationQualitySummary(
      elevationSources: ridePoints.map(\.elevationSource),
      anchorQualities: ridePoints.map(\.altitudeAnchorQuality)
    )
    let elevationGainAttributes = ridePoints.contains { $0.elevationMeters != nil }
      ? " ascentMeters=\"\(ascentAccumulator.ascentMeters)\" descentMeters=\"\(ascentAccumulator.descentMeters)\""
      : ""
    let creator = hasContinuousCalibratedBarometer ? "CycleComp with barometer" : "CycleComp"
    var lines = [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<gpx version=\"1.1\" creator=\"\(creator)\" xmlns=\"http://www.topografix.com/GPX/1/1\" xmlns:cyclecomp=\"https://mangwahyu.tech/cyclecomp/gpx/1\" xmlns:gpxtpx=\"http://www.garmin.com/xmlschemas/TrackPointExtension/v1\">",
      "<metadata><time>\(formatter.string(from: record.startedAt))</time><extensions>",
      "<cyclecomp:activitySummary algorithmVersion=\"\(RideMotionTiming.algorithmVersion)\" distanceMeters=\"\(distanceMeters)\" elapsedSeconds=\"\(elapsedDuration)\" timerSeconds=\"\(timerDuration)\" movingSeconds=\"\(movingDuration)\" manualPausedSeconds=\"\(pauseDurations.manual)\" autoPausedSeconds=\"\(pauseDurations.automatic)\" unknownMotionSeconds=\"\(unknownMotionDuration)\" trackTimeSpanSeconds=\"\(trackTimeSpan)\"\(elevationGainAttributes) elevationQuality=\"\(elevationQuality)\" />",
      "<cyclecomp:finishedAt>\(formatter.string(from: finishedAt))</cyclecomp:finishedAt>"
    ]
    for event in orderedSessionEvents(for: record) {
      lines.append("<cyclecomp:sessionEvent kind=\"\(event.kind)\" effectiveAt=\"\(formatter.string(from: event.effectiveAt))\" detectedAt=\"\(formatter.string(from: event.detectedAt))\" />")
    }
    lines.append("</extensions></metadata><trk><name>CycleComp ride</name><type>cycling</type><trkseg>")
    for (index, point) in ridePoints.enumerated() {
      if index > 0 && point.segmentStart == true { lines.append("</trkseg><trkseg>") }
      lines.append("<trkpt lat=\"\(point.latitude)\" lon=\"\(point.longitude)\">")
      if let elevation = point.elevationMeters { lines.append("<ele>\(elevation)</ele>") }
      lines.append("<time>\(formatter.string(from: point.timestamp))</time>")
      lines.append("<extensions>")
      lines.append("<cyclecomp:horizontalAccuracyMeters>\(point.horizontalAccuracyMeters)</cyclecomp:horizontalAccuracyMeters>")
      if let accuracy = point.verticalAccuracyMeters { lines.append("<cyclecomp:verticalAccuracyMeters>\(accuracy)</cyclecomp:verticalAccuracyMeters>") }
      if let speed = point.speedMetersPerSecond { lines.append("<cyclecomp:speedMetersPerSecond>\(speed)</cyclecomp:speedMetersPerSecond>") }
      if let speed = point.filteredSpeedMetersPerSecond { lines.append("<cyclecomp:filteredSpeedMetersPerSecond>\(speed)</cyclecomp:filteredSpeedMetersPerSecond>") }
      if let source = point.speedSource { lines.append("<cyclecomp:speedSource>\(source)</cyclecomp:speedSource>") }
      if let accuracy = point.speedAccuracyMetersPerSecond { lines.append("<cyclecomp:speedAccuracyMetersPerSecond>\(accuracy)</cyclecomp:speedAccuracyMetersPerSecond>") }
      if let speedLowerBound = point.speedLowerBoundMetersPerSecond { lines.append("<cyclecomp:speedLowerBoundMetersPerSecond>\(speedLowerBound)</cyclecomp:speedLowerBoundMetersPerSecond>") }
      if let speedUpperBound = point.speedUpperBoundMetersPerSecond { lines.append("<cyclecomp:speedUpperBoundMetersPerSecond>\(speedUpperBound)</cyclecomp:speedUpperBoundMetersPerSecond>") }
      if let course = point.courseDegrees { lines.append("<cyclecomp:courseDegrees>\(course)</cyclecomp:courseDegrees>") }
      if let source = point.elevationSource { lines.append("<cyclecomp:elevationSource>\(source)</cyclecomp:elevationSource>") }
      if let quality = point.altitudeAnchorQuality { lines.append("<cyclecomp:elevationQuality>\(quality)</cyclecomp:elevationQuality>") }
      if let relativeElevation = point.relativeElevationMeters { lines.append("<cyclecomp:relativeBarometerElevationMeters>\(relativeElevation)</cyclecomp:relativeBarometerElevationMeters>") }
      if let epoch = point.barometerEpoch { lines.append("<cyclecomp:barometerEpoch>\(epoch)</cyclecomp:barometerEpoch>") }
      if let pressure = point.barometricPressureKilopascals { lines.append("<cyclecomp:barometricPressureKilopascals>\(pressure)</cyclecomp:barometricPressureKilopascals>") }
      if let grade = point.liveGradePercent { lines.append("<cyclecomp:liveGradePercent>\(grade)</cyclecomp:liveGradePercent>") }
      if let gradeSource = point.liveGradeSource { lines.append("<cyclecomp:liveGradeSource>\(gradeSource)</cyclecomp:liveGradeSource>") }
      if let quality = point.liveGradeQuality { lines.append("<cyclecomp:liveGradeQuality>\(quality)</cyclecomp:liveGradeQuality>") }
      if let windowMeters = point.liveGradeWindowMeters { lines.append("<cyclecomp:liveGradeWindowMeters>\(windowMeters)</cyclecomp:liveGradeWindowMeters>") }
      if let sampleCount = point.liveGradeSampleCount { lines.append("<cyclecomp:liveGradeSampleCount>\(sampleCount)</cyclecomp:liveGradeSampleCount>") }
      if let motionState = point.motionState { lines.append("<cyclecomp:motionState>\(motionState)</cyclecomp:motionState>") }
      if let bpm = point.heartRateBpm {
        lines.append("<gpxtpx:TrackPointExtension><gpxtpx:hr>\(bpm)</gpxtpx:hr></gpxtpx:TrackPointExtension>")
      }
      lines.append("</extensions></trkpt>")
    }
    lines.append("</trkseg></trk></gpx>")
    try lines.joined(separator: "\n").write(to: fileURL, atomically: true, encoding: .utf8)
    return fileURL
  }
}
