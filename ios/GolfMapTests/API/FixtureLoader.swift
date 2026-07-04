import Foundation
import XCTest

/// Loads JSON/GeoJSON fixtures captured from the running server.
///
/// XcodeGen includes non-Swift files that live inside a `sources` folder as
/// target resources, so the fixtures under `GolfMapTests/API/Fixtures/` should
/// be present in the test bundle. As a pragmatic fallback (which also avoids any
/// need to touch project.yml), if a fixture is not found in the bundle we load
/// it from disk relative to this source file's location via `#filePath`.
enum FixtureLoader {
    /// Loads a fixture's bytes by base name (e.g. `"course-get.json"`).
    static func data(_ name: String, file: StaticString = #filePath, line: UInt = #line) throws -> Data {
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension

        // 1. Bundle resource (preferred — how it ships in the built test bundle).
        let bundle = Bundle(for: BundleToken.self)
        if let url = bundle.url(forResource: base, withExtension: ext) {
            return try Data(contentsOf: url)
        }
        if let url = bundle.url(forResource: base, withExtension: ext, subdirectory: "Fixtures") {
            return try Data(contentsOf: url)
        }

        // 2. #filePath-relative fallback: <thisDir>/Fixtures/<name>.
        let thisDir = URL(fileURLWithPath: "\(file)").deletingLastPathComponent()
        let onDisk = thisDir.appendingPathComponent("Fixtures").appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: onDisk.path) {
            return try Data(contentsOf: onDisk)
        }

        XCTFail("Fixture \(name) not found in bundle or on disk at \(onDisk.path)", file: file, line: line)
        throw CocoaError(.fileNoSuchFile)
    }

    private final class BundleToken {}
}
