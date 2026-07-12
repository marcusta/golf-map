import XCTest
import GRDB
@testable import GolfMap

/// The v4 schema (per-green calibration cache): migration, round trips,
/// replace-per-course semantics, and the FK cascade that ties a green's
/// calibration to its downloaded course bundle.
final class GreenCalibrationStoreTests: XCTestCase {

    /// Calibration rows FK to `course`, so the course bundle must exist first
    /// (matching production: calibration is only fetched for a downloaded
    /// course). Green id `course-1-g1` matches `StoreFixtures.furniture`.
    private func makeDatabaseWithCourse() async throws -> AppDatabase {
        let database = try AppDatabase.inMemory()
        try await database.saveCompletedBundle(StoreFixtures.furniture())
        return database
    }

    private func record(
        greenId: String = "course-1-g1",
        courseId: String = "course-1",
        confidence: Double = 0.667,
        sampleCount: Double = 2,
        biasTiltE: Double? = 0.004,
        biasTiltN: Double? = -0.002
    ) -> GreenCalibrationCacheRecord {
        GreenCalibrationCacheRecord(
            greenId: greenId, courseId: courseId,
            confidence: confidence, sampleCount: sampleCount,
            biasTiltE: biasTiltE, biasTiltN: biasTiltN
        )
    }

    func testMigrationCreatesCalibrationTable() throws {
        let database = try AppDatabase.inMemory()
        let tables = try database.dbQueue.read { db in
            try String.fetchAll(
                db,
                sql: "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        XCTAssertTrue(tables.contains("greenCalibration"), "missing greenCalibration table")
    }

    func testRoundTrip() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGreenCalibrations(courseId: "course-1", [record()])

        let rows = try await database.greenCalibrations(courseId: "course-1")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].greenId, "course-1-g1")
        XCTAssertEqual(rows[0].confidence, 0.667, accuracy: 1e-12)
        XCTAssertEqual(rows[0].sampleCount, 2, accuracy: 1e-12)
        XCTAssertEqual(rows[0].biasTiltE ?? 0, 0.004, accuracy: 1e-12)
        XCTAssertEqual(rows[0].biasTiltN ?? 0, -0.002, accuracy: 1e-12)

        let none = try await database.greenCalibrations(courseId: "other-course")
        XCTAssertTrue(none.isEmpty)
    }

    func testNilBiasRoundTrips() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGreenCalibrations(
            courseId: "course-1",
            [record(confidence: 0.5, sampleCount: 1, biasTiltE: nil, biasTiltN: nil)]
        )
        let rows = try await database.greenCalibrations(courseId: "course-1")
        XCTAssertNil(rows[0].biasTiltE)
        XCTAssertNil(rows[0].biasTiltN)
    }

    func testSaveReplacesTheCourseCalibration() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGreenCalibrations(
            courseId: "course-1", [record(confidence: 0.5, sampleCount: 1)]
        )
        try await database.saveGreenCalibrations(
            courseId: "course-1", [record(confidence: 0.8, sampleCount: 4, biasTiltE: 0.01, biasTiltN: 0)]
        )

        let rows = try await database.greenCalibrations(courseId: "course-1")
        XCTAssertEqual(rows.count, 1, "one row per green after replace")
        XCTAssertEqual(rows[0].confidence, 0.8, accuracy: 1e-12)
        XCTAssertEqual(rows[0].sampleCount, 4, accuracy: 1e-12)
    }

    func testDeletingTheCourseCascadesToCalibration() async throws {
        let database = try await makeDatabaseWithCourse()
        try await database.saveGreenCalibrations(courseId: "course-1", [record()])

        try await database.deleteCourse(id: "course-1")

        let count = try await database.dbQueue.read { db in
            try GreenCalibrationCacheRecord.fetchCount(db)
        }
        XCTAssertEqual(count, 0)
    }

    func testCalibrationRequiresItsCourseRow() async throws {
        let database = try AppDatabase.inMemory()
        await XCTAssertThrowsErrorAsync(
            try await database.saveGreenCalibrations(
                courseId: "missing-course",
                [self.record(courseId: "missing-course")]
            )
        )
    }
}
