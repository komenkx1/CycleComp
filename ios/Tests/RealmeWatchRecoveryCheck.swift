import Foundation
import CoreBluetooth

func runRecovery(external: Bool, pauseBeforeDisconnect: Bool) {
  let reader = RealmeWatchHeartRate()
  var receivedHeartRates: [Int] = []
  reader.onSample = { bpm, _ in receivedHeartRates.append(bpm) }
  reader.setEnabled(true)
  let central = CBCentralManager.lastCreated!
  reader.centralManagerDidUpdateState(central)
  let watch = CBPeripheral()
  let command = CBCharacteristic("0AF6")
  let notifications = CBCharacteristic("0AF7", properties: .notify)
  let service = CBService([command, notifications])
  watch.services = [service]
  func connect() {
    reader.centralManager(central, didDiscover: watch, advertisementData: [:], rssi: 0)
    reader.centralManager(central, didConnect: watch)
    reader.peripheral(watch, didDiscoverCharacteristicsFor: service, error: nil)
    reader.peripheral(watch, didUpdateNotificationStateFor: notifications, error: nil)
  }
  func receive(_ packet: [UInt8]) {
    notifications.value = RealmeWatchProtocol.encode(packet)
    reader.peripheral(watch, didUpdateValueFor: notifications, error: nil)
  }
  connect()
  reader.startRide()
  receive([0x02, 0x01])
  receive([0x10, 0x01, external ? 1 : 0])
  var heartRate = [UInt8](repeating: 0, count: 19)
  heartRate[0] = 0x10; heartRate[1] = 0x02; heartRate[2] = 1; heartRate[10] = 145
  receive(heartRate)
  precondition(reader.currentHeartRate == 145)
  let writesBeforeResume = watch.writes.count
  reader.resumeRide()
  precondition(reader.status == "active" && watch.writes.count == writesBeforeResume)
  if pauseBeforeDisconnect {
    reader.pauseRide()
    if !external { receive([0x10, 0x04, 0]) }
  }
  watch.state = .disconnected
  reader.centralManager(central, didDisconnectPeripheral: watch, error: nil)
  precondition(reader.currentHeartRate == nil)
  if pauseBeforeDisconnect { reader.resumeRide() }
  let writeCount = watch.writes.count
  connect()
  if external {
    precondition(reader.status == "active")
    precondition(watch.writes.count == writeCount)
  } else {
    precondition(reader.status == "resuming")
    precondition(Array(watch.writes.last!).map { $0 ^ 0x57 }.prefix(2).elementsEqual([0x10, 0x05]))
    receive([0x10, 0x05, 0])
    precondition(reader.status == "active")
  }
  heartRate[10] = 151
  receive(heartRate)
  precondition(reader.currentHeartRate == 151)
  precondition(receivedHeartRates == [145, 151])
  reader.finishRide()
}
for external in [false, true] {
  for paused in [false, true] { runRecovery(external: external, pauseBeforeDisconnect: paused) }
}
print("Watch recovery checks passed: active and paused, internal and watch-started sessions")
