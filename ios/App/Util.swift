import Foundation
import UIKit
import Darwin

/// A value shared between queues (the camera's, the network's and the screen's).
final class Locked<T> {
    private var value: T
    private let lock = NSLock()
    init(_ value: T) { self.value = value }
    var get: T { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ newValue: T) { lock.lock(); value = newValue; lock.unlock() }
    @discardableResult func mutate<R>(_ change: (inout T) -> R) -> R {
        lock.lock(); defer { lock.unlock() }
        return change(&value)
    }
}

/// How the iPhone and the PC talk: one TCP port, and every message is a frame:
/// 4 bytes of length (big-endian, counting the type byte), 1 type byte, then the payload.
enum Wire {
    static let port: UInt16 = 47100
    static let serviceType = "_camstudio._tcp"
    static let json: UInt8 = 1      // a JSON object (UTF-8)
    static let jpeg: UInt8 = 2      // one preview picture
    static let chunk: UInt8 = 3     // a piece of a video file being copied to the PC

    static func frame(_ type: UInt8, _ payload: Data) -> Data {
        var d = Data(capacity: payload.count + 5)
        let n = UInt32(payload.count + 1)
        d.append(UInt8((n >> 24) & 0xff))
        d.append(UInt8((n >> 16) & 0xff))
        d.append(UInt8((n >> 8) & 0xff))
        d.append(UInt8(n & 0xff))
        d.append(type)
        d.append(payload)
        return d
    }

    /// nil if the object can't be written as JSON (e.g. a NaN slipped in), so a bad number never crashes the app.
    static func jsonFrame(_ object: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return frame(json, data)
    }
}

func finite(_ x: Double) -> Double { x.isFinite ? x : 0 }
func finite(_ x: Float) -> Double { finite(Double(x)) }
func finite(_ x: CGFloat) -> Double { finite(Double(x)) }

enum DeviceInfo {
    static var identifier: String {
        var sys = utsname()
        uname(&sys)
        return withUnsafeBytes(of: &sys.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
    }

    static var modelName: String {
        let names = [
            "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
            "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max",
            "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,5": "iPhone 16e",
            "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17",
            "iPhone18,4": "iPhone Air",
        ]
        return names[identifier] ?? "iPhone"
    }

    /// Every IPv4 address the phone has, with the name of its network interface (en0 is Wi-Fi).
    static func addresses() -> [(name: String, ip: String)] {
        var result: [(name: String, ip: String)] = []
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return [] }
        defer { freeifaddrs(list) }
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard let sa = ptr.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
                  (flags & (IFF_UP | IFF_RUNNING)) == (IFF_UP | IFF_RUNNING),
                  (flags & IFF_LOOPBACK) == 0 else { continue }
            let name = String(cString: ptr.pointee.ifa_name)
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = host.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
                result.append((name, ip))
            }
        }
        return result
    }

    static func wifiAddress() -> String? {
        let all = addresses()
        return all.first(where: { $0.name == "en0" })?.ip
            ?? all.first(where: { $0.name.hasPrefix("en") })?.ip
            ?? all.first(where: { $0.name.hasPrefix("bridge") })?.ip
    }

    static func freeBytes() -> Int64 {
        let url = URL(fileURLWithPath: NSHomeDirectory())
        let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage ?? 0
    }

    static var thermal: String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "ok"
        case .fair: return "warm"
        case .serious: return "hot"
        case .critical: return "critical"
        @unknown default: return "ok"
        }
    }
}
