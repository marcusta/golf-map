import XCTest
@testable import GolfMap

/// Round-trips the Keychain helper against the simulator keychain. Uses a
/// unique per-test service so runs never collide with real app credentials.
final class KeychainTests: XCTestCase {
    private var keychain: Keychain!

    override func setUp() {
        super.setUp()
        keychain = Keychain(service: "com.marcusandersson.golfmap.tests.\(UUID().uuidString)")
    }

    override func tearDown() {
        keychain.clear()
        keychain = nil
        super.tearDown()
    }

    func testLoadEmptyReturnsNil() {
        XCTAssertNil(keychain.load())
    }

    func testSaveThenLoadRoundTrips() {
        keychain.save(.init(username: "marcus", password: "change-me"))
        let loaded = keychain.load()
        XCTAssertEqual(loaded, Keychain.Credentials(username: "marcus", password: "change-me"))
    }

    func testSaveOverwritesPreviousCredential() {
        keychain.save(.init(username: "marcus", password: "old"))
        keychain.save(.init(username: "marcus", password: "new"))
        XCTAssertEqual(keychain.load()?.password, "new")
    }

    func testSaveOverwritesDifferentUsername() {
        keychain.save(.init(username: "alice", password: "a"))
        keychain.save(.init(username: "bob", password: "b"))
        // Only one slot exists after overwrite.
        let loaded = keychain.load()
        XCTAssertEqual(loaded, Keychain.Credentials(username: "bob", password: "b"))
    }

    func testClearRemovesCredential() {
        keychain.save(.init(username: "marcus", password: "change-me"))
        keychain.clear()
        XCTAssertNil(keychain.load())
    }

    func testPasswordWithUnicodeRoundTrips() {
        keychain.save(.init(username: "user", password: "pä$$wörd🏌️"))
        XCTAssertEqual(keychain.load()?.password, "pä$$wörd🏌️")
    }
}
