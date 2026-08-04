import Foundation

/// Resolves the generated, build-time gate defaults once for the app.
///
/// Release builds intentionally have no runtime override path. DEBUG builds
/// can override a gate through `gates.<name>` in UserDefaults or through a
/// launch argument in either `-gate.<name>=true` or `-gate.<name> true` form.
/// Launch arguments win over UserDefaults when both are present.
enum FeatureGatesResolver {
    private static let overridePrefix = "gates."
    private static let launchPrefix = "-gate."

    static func resolve(
        defaults: UserDefaults = .standard,
        arguments: [String] = CommandLine.arguments
    ) -> FeatureGates {
        #if DEBUG
        var overrides: [FeatureGateKey: Bool] = [:]
        for key in FeatureGateKey.allCases {
            if let value = defaults.object(forKey: "\(overridePrefix)\(key.rawValue)") as? Bool {
                overrides[key] = value
            }
        }
        for (key, value) in launchArgumentOverrides(arguments) {
            overrides[key] = value
        }
        return FeatureGates.generatedDefaults.applying(overrides)
        #else
        return .generatedDefaults
        #endif
    }

    #if DEBUG
    private static func launchArgumentOverrides(
        _ arguments: [String]
    ) -> [FeatureGateKey: Bool] {
        var result: [FeatureGateKey: Bool] = [:]
        var index = 0

        while index < arguments.count {
            let argument = arguments[index]
            guard argument.hasPrefix(launchPrefix) else {
                index += 1
                continue
            }

            let assignment = String(argument.dropFirst(launchPrefix.count))
            let keyName: String
            let valueText: String
            if let equals = assignment.firstIndex(of: "=") {
                keyName = String(assignment[..<equals])
                valueText = String(assignment[assignment.index(after: equals)...])
            } else if index + 1 < arguments.count {
                keyName = assignment
                valueText = arguments[index + 1]
                index += 1
            } else {
                index += 1
                continue
            }

            if let key = FeatureGateKey(rawValue: keyName),
               let value = parseBoolean(valueText) {
                result[key] = value
            }
            index += 1
        }

        return result
    }

    private static func parseBoolean(_ text: String) -> Bool? {
        switch text.lowercased() {
        case "true": return true
        case "false": return false
        default: return nil
        }
    }
    #endif
}

extension FeatureGates {
    /// The immutable gate set captured at app launch.
    static let current = FeatureGatesResolver.resolve()
}
