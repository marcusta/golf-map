import Foundation

/// Small facts about the running device/app for scan payload envelopes
/// (`device`, `appVersion` per the green-scan-payload contract).
enum DeviceInfo {
    /// Hardware model identifier, e.g. `iPhone17,2`. Read from `uname`.
    static var modelIdentifier: String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let mirror = Mirror(reflecting: systemInfo.machine)
        let bytes = mirror.children.compactMap { $0.value as? Int8 }
        let scalars = bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        return String(decoding: scalars, as: UTF8.self)
    }

    /// Marketing version (`CFBundleShortVersionString`), e.g. `0.1.0`.
    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    /// ISO-8601 timestamp (UTC, seconds) for `capturedAt`.
    static func iso8601(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}
