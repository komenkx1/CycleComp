import Foundation

enum RealmeWatchProtocol {
  static let cyclingType: UInt8 = 50

  static func encode(_ decodedBytes: [UInt8]) -> Data {
    Data(decodedBytes.map { $0 ^ 0x57 })
  }

  static func sessionClock(at date: Date) -> [UInt8] {
    let clock = Calendar.current.dateComponents([.day, .hour, .minute, .second], from: date)
    return [clock.day ?? 1, clock.hour ?? 0, clock.minute ?? 0, clock.second ?? 0].map { UInt8($0) }
  }

  static func start(time: [UInt8]) -> [UInt8] {
    [0x10, 0x01] + time + [cyclingType, 0, 0, 0, 0, 0, 0]
  }

  static func update(time: [UInt8], duration: Int, distanceMeters: Int = 0) -> [UInt8] {
    [0x10, 0x02] + time + [0] + metricsFields(duration: duration, distanceMeters: distanceMeters)
  }

  static func end(time: [UInt8], duration: Int, distanceMeters: Int = 0) -> [UInt8] {
    [0x10, 0x03] + time + metricsFields(duration: duration, distanceMeters: distanceMeters) + [cyclingType, 0]
  }

  static func heartRate(in decodedPacket: [UInt8]) -> Int? {
    guard decodedPacket.count >= 19, decodedPacket.starts(with: [0x10, 0x02]),
          decodedPacket[2] == 1, decodedPacket[10] > 0 else { return nil }
    return Int(decodedPacket[10])
  }

  private static func metricsFields(duration: Int, distanceMeters: Int) -> [UInt8] {
    let seconds = min(0xFFFFF, max(0, duration))
    let meters = max(0, distanceMeters)
    return [
      UInt8(seconds & 255),
      UInt8((seconds >> 8) & 255),
      UInt8((seconds >> 16) & 15),
      UInt8(meters & 255),
      UInt8((meters >> 8) & 255),
      UInt8((meters >> 16) & 255),
      UInt8((meters >> 24) & 255)
    ]
  }
}
