import CoreBluetooth
import Foundation

final class RealmeWatchHeartRate: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  var onChange: (() -> Void)?
  var rideDurationSeconds: (() -> Int)?
  var rideDistanceMeters: (() -> Int)?
  var onSample: ((Int, Date) -> Void)?
  private(set) var enabled = false
  private(set) var status = "off"
  private(set) var message: String?
  private(set) var beatsPerMinute: Int?
  private(set) var lastSampleAt: Date?

  private var bluetooth: CBCentralManager?
  private var watch: CBPeripheral?
  private var commandChannel: CBCharacteristic?
  private var notificationsReady = false
  private var isExternalSession = false
  private var desiredRideState = "idle"
  private var sessionTime: [UInt8]?
  private var sessionStartedAt: Date?
  private var pollTimer: Timer?
  private var responseTimeout: Timer?
  private var scanTimeout: Timer?

  var currentHeartRate: Int? {
    guard status == "active", let lastSampleAt,
          Date().timeIntervalSince(lastSampleAt) <= 15 else { return nil }
    return beatsPerMinute
  }

  func setEnabled(_ useWatch: Bool) {
    enabled = useWatch
    if useWatch {
      if bluetooth == nil { bluetooth = CBCentralManager(delegate: self, queue: .main) }
      else if bluetooth?.state == .poweredOn { findWatch() }
    } else {
      bluetooth?.stopScan()
      scanTimeout?.invalidate()
      if let watch { bluetooth?.cancelPeripheralConnection(watch) }
      watch = nil
      commandChannel = nil
      notificationsReady = false
      isExternalSession = false
      changeStatus("off")
    }
  }

  func startRide() {
    guard enabled else { return }
    desiredRideState = "active"
    beatsPerMinute = nil
    lastSampleAt = nil
    if sessionTime != nil && !isExternalSession {
      changeStatus("error", "Akhiri sesi sebelumnya di jam sebelum memulai HR lagi.")
      return
    }
    if notificationsReady { requestSessionStart() }
    else if bluetooth?.state == .poweredOn { findWatch() }
  }

  func pauseRide() {
    guard enabled else { return }
    desiredRideState = "paused"
    pollTimer?.invalidate()
    if isExternalSession {
      changeStatus("paused", "HR dijeda (sesi jam tetap berjalan)")
    } else if let sessionTime, status == "active" {
      changeStatus("pausing")
      send([0x10, 0x04] + sessionTime)
      awaitResponse(for: "pausing")
    } else if sessionTime == nil {
      responseTimeout?.invalidate()
      changeStatus("paused")
    }
  }

  func resumeRide() {
    guard enabled else { return }
    desiredRideState = "active"
    if status == "pausing" { return }
    if isExternalSession {
      changeStatus("active", "HR aktif (sesi jam)")
      beginPolling()
    } else if let sessionTime, status == "paused" {
      beatsPerMinute = nil
      lastSampleAt = nil
      changeStatus("resuming")
      send([0x10, 0x05] + sessionTime)
      awaitResponse(for: "resuming")
    } else if sessionTime == nil {
      startRide()
    } else {
      changeStatus("error", "Cek sesi jam; HR belum bisa dilanjutkan otomatis.")
    }
  }

  func finishRide() {
    desiredRideState = "idle"
    pollTimer?.invalidate()
    responseTimeout?.invalidate()
    if isExternalSession {
      sessionTime = nil
      sessionStartedAt = nil
      beatsPerMinute = nil
      lastSampleAt = nil
      isExternalSession = false
      if enabled { changeStatus(notificationsReady ? "ready" : "disconnected", "Sesi CycleComp selesai. Sesi jam dapat diakhiri di jam.") }
      return
    }
    guard let sessionTime else {
      if enabled { changeStatus(notificationsReady ? "ready" : "disconnected") }
      return
    }
    changeStatus("stopping")
    send(RealmeWatchProtocol.end(time: sessionTime, duration: sessionDuration(), distanceMeters: currentDistance()))
    awaitResponse(for: "stopping")
  }

  private func changeStatus(_ state: String, _ explanation: String? = nil) {
    status = state
    message = explanation
    onChange?()
  }

  private func findWatch() {
    guard enabled, let bluetooth, bluetooth.state == .poweredOn else { return }
    if watch?.state == .connected {
      if notificationsReady, desiredRideState == "active" { requestSessionStart() }
      return
    }
    changeStatus("connecting")
    let connected = bluetooth.retrieveConnectedPeripherals(withServices: [CBUUID(string: "0AF0")])
    if let selected = connected.first(where: { ($0.name ?? "").lowercased().contains("watch 5") }) {
      connect(selected)
    } else {
      bluetooth.scanForPeripherals(withServices: [CBUUID(string: "0AF0")])
    }
    scanTimeout?.invalidate()
    scanTimeout = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in
      guard let self, !self.notificationsReady else { return }
      self.bluetooth?.stopScan()
      if let watch = self.watch, watch.state == .connecting { self.bluetooth?.cancelPeripheralConnection(watch) }
      self.changeStatus("disconnected", "Watch 5 belum terhubung. Dekatkan jam dan sambungkan lewat Realme Link.")
    }
  }

  private func connect(_ peripheral: CBPeripheral) {
    guard watch == nil || watch?.state == .disconnected else { return }
    bluetooth?.stopScan()
    watch = peripheral
    peripheral.delegate = self
    bluetooth?.connect(peripheral)
  }

  private func requestSessionStart() {
    guard sessionTime == nil, status != "readingInfo", status != "starting", desiredRideState == "active" else { return }
    changeStatus("readingInfo")
    send([0x02, 0x01])
    awaitResponse(for: "readingInfo")
  }

  private func beginSession() {
    guard desiredRideState == "active" else { return }
    let now = Date()
    sessionStartedAt = now
    sessionTime = RealmeWatchProtocol.sessionClock(at: now)
    changeStatus("starting")
    send(RealmeWatchProtocol.start(time: sessionTime!))
    awaitResponse(for: "starting")
  }

  private func awaitResponse(for expectedStatus: String) {
    responseTimeout?.invalidate()
    responseTimeout = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { [weak self] _ in
      guard let self, self.status == expectedStatus else { return }
      self.changeStatus("error", "Jam belum mengonfirmasi perintah. Cek sesi olahraga di jam.")
    }
  }

  private func beginPolling() {
    pollTimer?.invalidate()
    changeStatus("active")
    pollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      guard let self, self.desiredRideState == "active", let time = self.sessionTime else { return }
      self.send(RealmeWatchProtocol.update(time: time, duration: self.sessionDuration(), distanceMeters: self.currentDistance()))
      if let lastSampleAt = self.lastSampleAt, Date().timeIntervalSince(lastSampleAt) > 15 { self.onChange?() }
    }
  }

  private func currentDistance() -> Int {
    rideDistanceMeters?() ?? 0
  }

  private func sessionDuration() -> Int {
    rideDurationSeconds?() ?? max(0, Int(Date().timeIntervalSince(sessionStartedAt ?? Date())))
  }

  private func send(_ decodedBytes: [UInt8]) {
    guard let watch, let commandChannel, watch.state == .connected else {
      changeStatus("disconnected", "Watch 5 terputus. Cek dan akhiri sesi di jam bila masih aktif.")
      return
    }
    watch.writeValue(RealmeWatchProtocol.encode(decodedBytes), for: commandChannel, type: .withResponse)
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    guard enabled else { return }
    if central.state == .poweredOn { findWatch() }
    else { changeStatus("disconnected", "Aktifkan Bluetooth dan izinkan akses untuk CycleComp.") }
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    if (peripheral.name ?? "").lowercased().contains("watch 5") { connect(peripheral) }
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    peripheral.discoverServices([CBUUID(string: "0AF0")])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    changeStatus("disconnected", "Sambungan Watch 5 gagal. Coba hubungkan kembali sebelum ride.")
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    pollTimer?.invalidate()
    responseTimeout?.invalidate()
    notificationsReady = false
    commandChannel = nil
    isExternalSession = false
    if enabled { changeStatus("disconnected", "Watch 5 terputus. Cek sesi jam; rekaman GPS tetap berjalan.") }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    if error != nil { changeStatus("error", "Layanan Watch 5 belum bisa dibaca."); return }
    for service in peripheral.services ?? [] { peripheral.discoverCharacteristics(nil, for: service) }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    if error != nil { changeStatus("error", "Kanal Watch 5 belum siap."); return }
    for characteristic in service.characteristics ?? [] {
      if characteristic.uuid.uuidString == "0AF6" { commandChannel = characteristic }
      if ["0AF7", "0AF2"].contains(characteristic.uuid.uuidString), characteristic.properties.contains(.notify) {
        peripheral.setNotifyValue(true, for: characteristic)
      }
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    guard characteristic.uuid.uuidString == "0AF7" else { return }
    notificationsReady = characteristic.isNotifying && error == nil && commandChannel != nil
    if notificationsReady {
      scanTimeout?.invalidate()
      changeStatus("ready")
      if desiredRideState == "active" { requestSessionStart() }
    } else { changeStatus("error", "Notifikasi Watch 5 belum dapat diaktifkan.") }
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    if error != nil { changeStatus("error", "Perintah ke Watch 5 gagal. Cek sesi di jam.") }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard error == nil, let bytes = characteristic.value else { return }
    let packet = bytes.map { $0 ^ 0x57 }
    if packet.starts(with: [0x02, 0x01]), status == "readingInfo" {
      responseTimeout?.invalidate()
      beginSession()
      return
    }
    guard packet.count >= 3, packet[0] == 0x10 else { return }
    switch packet[1] {
    case 0x01 where sessionTime != nil && (status == "starting" || status == "error"):
      responseTimeout?.invalidate()
      if packet[2] == 0 {
        isExternalSession = false
        changeStatus("active", "HR aktif")
        beginPolling()
        if desiredRideState == "paused" { pauseRide() }
        else if desiredRideState == "idle" { finishRide() }
      } else if packet[2] == 1 {
        isExternalSession = true
        changeStatus("active", "HR aktif (sesi jam)")
        beginPolling()
        if desiredRideState == "paused" { pauseRide() }
        else if desiredRideState == "idle" { finishRide() }
      } else {
        sessionTime = nil
        sessionStartedAt = nil
        changeStatus("error", "Watch 5 menolak start olahraga.")
      }
    case 0x02 where status == "active" && desiredRideState == "active":
      if let bpm = RealmeWatchProtocol.heartRate(in: packet) {
        let now = Date()
        beatsPerMinute = bpm
        lastSampleAt = now
        onSample?(bpm, now)
        onChange?()
      }
    case 0x03 where status == "stopping" || status == "error":
      responseTimeout?.invalidate()
      if packet[2] == 0 {
        sessionTime = nil
        sessionStartedAt = nil
        beatsPerMinute = nil
        lastSampleAt = nil
        changeStatus(enabled ? "ready" : "off")
      } else { changeStatus("error", "Stop belum diterima. Akhiri sesi di jam.") }
    case 0x04 where status == "pausing":
      responseTimeout?.invalidate()
      if packet[2] == 0 {
        changeStatus("paused")
        if desiredRideState == "active" { resumeRide() }
      }
      else { changeStatus("error", "Jeda jam belum dikonfirmasi.") }
    case 0x05 where status == "resuming":
      responseTimeout?.invalidate()
      if packet[2] == 0 {
        beginPolling()
        if desiredRideState == "paused" { pauseRide() }
        else if desiredRideState == "idle" { finishRide() }
      }
      else { changeStatus("error", "Jam menolak melanjutkan sesi HR.") }
    default: break
    }
  }
}
