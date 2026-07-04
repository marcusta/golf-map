import XCTest
@testable import GolfMap

final class GolfMapTests: XCTestCase {
    @MainActor
    func testAppEnvironmentInitializes() throws {
        let env = AppEnvironment(
            serverOrigin: URL(string: "http://localhost:3000")!,
            database: try AppDatabase.inMemory(),
            bundlePaths: BundlePaths(rootDirectory: FileManager.default.temporaryDirectory
                .appending(path: "smoke-\(UUID().uuidString)"))
        )
        XCTAssertNotNil(env)
    }

    func testLinkedPackages() {
        // Touch one symbol from each SPM package so a link regression fails the suite.
        XCTAssertNotNil(StoreModule.linkedDatabaseQueueType())
        XCTAssertNotNil(MapModule.linkedMapViewType())
    }
}
