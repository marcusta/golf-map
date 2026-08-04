import XCTest
@testable import GolfMap

final class FeatureGatesTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "FeatureGatesTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    func testGeneratedDefaultsExposeEveryGateAsFalse() {
        let gates = FeatureGates.generatedDefaults

        XCTAssertEqual(FeatureGateKey.allCases.count, 6)
        XCTAssertFalse(gates.pinEntry)
        XCTAssertFalse(gates.laserCalibration)
        XCTAssertFalse(gates.planEditing)
        XCTAssertFalse(gates.planOptionsTree)
        XCTAssertFalse(gates.decideMode)
        XCTAssertFalse(gates.puttRead)
    }

    func testDebugUserDefaultsOverridesApplyByTypedKey() {
        defaults.set(true, forKey: "gates.pinEntry")
        defaults.set(true, forKey: "gates.puttRead")
        defaults.set("true", forKey: "gates.planEditing")

        let gates = FeatureGatesResolver.resolve(defaults: defaults, arguments: [])

        XCTAssertTrue(gates.pinEntry)
        XCTAssertTrue(gates.puttRead)
        XCTAssertFalse(gates.planEditing)
    }

    func testLaunchArgumentsOverrideUserDefaults() {
        defaults.set(false, forKey: "gates.pinEntry")
        defaults.set(false, forKey: "gates.planEditing")

        let gates = FeatureGatesResolver.resolve(
            defaults: defaults,
            arguments: [
                "GolfMap",
                "-gate.pinEntry=true",
                "-gate.planEditing", "true",
            ]
        )

        XCTAssertTrue(gates.pinEntry)
        XCTAssertTrue(gates.planEditing)
    }

    func testInvalidAndUnknownOverridesAreIgnored() {
        defaults.set("1", forKey: "gates.pinEntry")

        let gates = FeatureGatesResolver.resolve(
            defaults: defaults,
            arguments: [
                "GolfMap",
                "-gate.puttRead=1",
                "-gate.unknown=true",
            ]
        )

        XCTAssertFalse(gates.pinEntry)
        XCTAssertFalse(gates.puttRead)
        XCTAssertFalse(gates[.decideMode])
    }
}
