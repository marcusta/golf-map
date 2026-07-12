import XCTest
@testable import GolfMap

/// The three Settings-screen preferences added alongside competition mode:
/// distance unit, default putt stimp (seed), and server origin
/// (validation/normalization + persistence). Competition mode itself is
/// covered by `CompetitionModeTests`.
@MainActor
final class AppSettingsTests: XCTestCase {

    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "AppSettingsTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Distance unit

    func testDistanceUnitDefaultsToMeters() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertEqual(settings.distanceUnit, .meters)
    }

    func testDistanceUnitPersists() {
        let settings = AppSettings(defaults: defaults)
        settings.distanceUnit = .yards
        let reloaded = AppSettings(defaults: defaults)
        XCTAssertEqual(reloaded.distanceUnit, .yards)
    }

    func testDistanceUnitBackToMetersPersists() {
        let settings = AppSettings(defaults: defaults)
        settings.distanceUnit = .yards
        settings.distanceUnit = .meters
        let reloaded = AppSettings(defaults: defaults)
        XCTAssertEqual(reloaded.distanceUnit, .meters)
    }

    // MARK: - Default stimp

    func testDefaultStimpDefaultsToTen() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertEqual(settings.defaultStimpFt, 10.0)
    }

    func testDefaultStimpPersists() {
        let settings = AppSettings(defaults: defaults)
        settings.defaultStimpFt = 12
        let reloaded = AppSettings(defaults: defaults)
        XCTAssertEqual(reloaded.defaultStimpFt, 12.0)
    }

    func testDefaultStimpClampsOnLoadWhenStoredOutOfRange() {
        // A future build could tighten the range; a stale value beyond the
        // current bounds should still clamp on read, same as PuttReadModel.
        defaults.set(30.0, forKey: "settings.defaultStimpFt")
        let settings = AppSettings(defaults: defaults)
        XCTAssertEqual(settings.defaultStimpFt, PuttReadModel.stimpMaxFt)

        defaults.set(1.0, forKey: "settings.defaultStimpFt")
        let low = AppSettings(defaults: defaults)
        XCTAssertEqual(low.defaultStimpFt, PuttReadModel.stimpMinFt)
    }

    // MARK: - Server origin: validation / normalization

    func testServerOriginDefaultsToNil() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertNil(settings.serverOrigin)
    }

    func testSetServerOriginAcceptsValidURL() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertTrue(settings.setServerOrigin("http://192.168.1.20:3000"))
        XCTAssertEqual(settings.serverOrigin, "http://192.168.1.20:3000")
    }

    func testSetServerOriginTrimsTrailingSlash() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertTrue(settings.setServerOrigin("https://golf.example.com/"))
        XCTAssertEqual(settings.serverOrigin, "https://golf.example.com")
    }

    func testSetServerOriginTrimsMultipleTrailingSlashes() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertTrue(settings.setServerOrigin("https://golf.example.com///"))
        XCTAssertEqual(settings.serverOrigin, "https://golf.example.com")
    }

    func testSetServerOriginTrimsWhitespace() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertTrue(settings.setServerOrigin("  http://localhost:4000  "))
        XCTAssertEqual(settings.serverOrigin, "http://localhost:4000")
    }

    func testSetServerOriginEmptyClearsOverride() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertTrue(settings.setServerOrigin("http://localhost:4000"))
        XCTAssertTrue(settings.setServerOrigin(""))
        XCTAssertNil(settings.serverOrigin)
    }

    func testSetServerOriginWhitespaceOnlyClearsOverride() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertTrue(settings.setServerOrigin("http://localhost:4000"))
        XCTAssertTrue(settings.setServerOrigin("   "))
        XCTAssertNil(settings.serverOrigin)
    }

    func testSetServerOriginRejectsHostOnly() {
        let settings = AppSettings(defaults: defaults)
        // No scheme — URL(string:) parses "localhost:3000" with scheme
        // "localhost" and no host, which must be rejected.
        XCTAssertFalse(settings.setServerOrigin("localhost:3000"))
        XCTAssertNil(settings.serverOrigin)
    }

    func testSetServerOriginRejectsPathOnly() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertFalse(settings.setServerOrigin("/api/v1"))
        XCTAssertNil(settings.serverOrigin)
    }

    func testSetServerOriginRejectsSchemeWithoutHost() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertFalse(settings.setServerOrigin("http://"))
        XCTAssertNil(settings.serverOrigin)
    }

    func testSetServerOriginFailureLeavesPreviousValueIntact() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertTrue(settings.setServerOrigin("http://localhost:4000"))
        XCTAssertFalse(settings.setServerOrigin("not a url"))
        XCTAssertEqual(settings.serverOrigin, "http://localhost:4000")
    }

    func testServerOriginPersists() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertTrue(settings.setServerOrigin("http://192.168.1.20:3000"))
        let reloaded = AppSettings(defaults: defaults)
        XCTAssertEqual(reloaded.serverOrigin, "http://192.168.1.20:3000")
    }

    func testServerOriginUsesSameKeyAppEnvironmentReads() {
        // AppEnvironment.resolvedServerOrigin() reads UserDefaults key
        // "serverOrigin" directly — AppSettings must write to the exact same
        // key for the override to take effect on next launch.
        let settings = AppSettings(defaults: defaults)
        XCTAssertTrue(settings.setServerOrigin("http://192.168.1.20:3000"))
        XCTAssertEqual(defaults.string(forKey: "serverOrigin"), "http://192.168.1.20:3000")
    }

    func testServerOriginClearRemovesKey() {
        let settings = AppSettings(defaults: defaults)
        XCTAssertTrue(settings.setServerOrigin("http://192.168.1.20:3000"))
        XCTAssertTrue(settings.setServerOrigin(""))
        XCTAssertNil(defaults.string(forKey: "serverOrigin"))
    }
}
