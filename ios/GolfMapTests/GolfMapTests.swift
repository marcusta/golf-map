import XCTest
@testable import GolfMap

final class GolfMapTests: XCTestCase {
    @MainActor
    func testAppEnvironmentInitializes() {
        XCTAssertNotNil(AppEnvironment())
    }

    func testLinkedPackages() {
        // Touch one symbol from each SPM package so a link regression fails the suite.
        XCTAssertNotNil(StoreModule.linkedDatabaseQueueType())
        XCTAssertNotNil(MapModule.linkedMapViewType())
    }
}
