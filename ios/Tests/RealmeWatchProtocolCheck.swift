import Foundation

@main struct RealmeWatchProtocolCheck {
  static func main() {
    let response = [UInt8](Data(hex: "475556575757575757570f57573bcd576f5957"))
    let decoded = response.map { $0 ^ 0x57 }
    precondition(RealmeWatchProtocol.heartRate(in: decoded) == 88)
    precondition(RealmeWatchProtocol.encode(decoded) == Data(response))
    var rejectedResponse = decoded
    rejectedResponse[2] = 2
    precondition(RealmeWatchProtocol.heartRate(in: rejectedResponse) == nil)
    rejectedResponse = decoded
    rejectedResponse[10] = 0
    precondition(RealmeWatchProtocol.heartRate(in: rejectedResponse) == nil)
    precondition(RealmeWatchProtocol.heartRate(in: Array(decoded.prefix(10))) == nil)
    precondition(RealmeWatchProtocol.heartRate(in: [0x02, 0x01] + Array(decoded.dropFirst(2))) == nil)
    let time: [UInt8] = [13, 14, 46, 22]
    let start = RealmeWatchProtocol.start(time: time)
    precondition(start.count == 13 && start[6] == 50 && start[12] == 0)
    let update = RealmeWatchProtocol.update(time: time, duration: 0x12345, distanceMeters: 0x04030201)
    precondition(update.count == 14 && Array(update[7...9]) == [0x45, 0x23, 1])
    precondition(Array(update[10...13]) == [0x01, 0x02, 0x03, 0x04])
    let end = RealmeWatchProtocol.end(time: time, duration: 90, distanceMeters: 500)
    precondition(end.count == 15 && end[13] == 50 && end[14] == 0)
    print("Watch 5 recorded packet, parser rejection, cycling start and session encoding checks passed")
  }
}

private extension Data {
  init(hex: String) {
    self.init(stride(from: 0, to: hex.count, by: 2).map { offset in
      let start = hex.index(hex.startIndex, offsetBy: offset)
      return UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16)!
    })
  }
}
