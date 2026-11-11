import Foundation
public protocol CBCentralManagerDelegate: AnyObject {}
public protocol CBPeripheralDelegate: AnyObject {}
public enum CBManagerState { case poweredOn, poweredOff }
public enum CBPeripheralState { case disconnected, connecting, connected }
public struct CBCharacteristicProperties: OptionSet {
  public let rawValue: Int
  public init(rawValue: Int) { self.rawValue = rawValue }
  public static let notify = CBCharacteristicProperties(rawValue: 1)
}
public final class CBUUID {
  public let uuidString: String
  public init(string: String) { uuidString = string }
}
public final class CBCharacteristic {
  public let uuid: CBUUID
  public var properties: CBCharacteristicProperties
  public var isNotifying = false
  public var value: Data?
  public init(_ uuid: String, properties: CBCharacteristicProperties = []) { self.uuid = CBUUID(string: uuid); self.properties = properties }
}
public final class CBService {
  public var characteristics: [CBCharacteristic]?
  public init(_ characteristics: [CBCharacteristic]) { self.characteristics = characteristics }
}
public enum CBCharacteristicWriteType { case withResponse }
public final class CBPeripheral {
  public var name: String? = "Watch 5"
  public var state: CBPeripheralState = .disconnected
  public weak var delegate: CBPeripheralDelegate?
  public var services: [CBService]?
  public var writes: [Data] = []
  public init() {}
  public func discoverServices(_ services: [CBUUID]?) {}
  public func discoverCharacteristics(_ characteristics: [CBUUID]?, for service: CBService) {}
  public func setNotifyValue(_ enabled: Bool, for characteristic: CBCharacteristic) { characteristic.isNotifying = enabled }
  public func writeValue(_ data: Data, for characteristic: CBCharacteristic, type: CBCharacteristicWriteType) { writes.append(data) }
}
public final class CBCentralManager {
  public static var lastCreated: CBCentralManager?
  public var state: CBManagerState = .poweredOn
  public init(delegate: CBCentralManagerDelegate?, queue: DispatchQueue?) { Self.lastCreated = self }
  public func stopScan() {}
  public func scanForPeripherals(withServices: [CBUUID]?) {}
  public func retrieveConnectedPeripherals(withServices: [CBUUID]) -> [CBPeripheral] { [] }
  public func connect(_ peripheral: CBPeripheral) { peripheral.state = .connected }
  public func cancelPeripheralConnection(_ peripheral: CBPeripheral) { peripheral.state = .disconnected }
}
