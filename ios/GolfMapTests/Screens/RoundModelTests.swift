import XCTest
@testable import GolfMap

/// The round lifecycle + local-first stroke writes: start snapshots the plan
/// link/wind, one active round per course, resume across "restarts" (a fresh
/// model over the same database), the §2 recording convention fields, and
/// after-the-fact edits flagging rows for sync.
@MainActor
final class RoundModelTests: XCTestCase {

    private let holes = [
        HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 4),
        HoleRecord(id: "h2", courseId: "course-1", number: 2, par: 3),
    ]

    private func makeModel(database: AppDatabase) -> RoundModel {
        RoundModel(courseId: "course-1", holes: holes, database: database)
    }

    func testStartRoundSnapshotsPlanLinkAndWind() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)

        let round = await model.startRound(gamePlanId: "plan-1", wind: (5.5, 220))
        XCTAssertEqual(round?.gamePlanId, "plan-1")
        XCTAssertEqual(round?.windSpeedMps, 5.5)
        XCTAssertEqual(round?.windDirectionDeg, 220)
        XCTAssertEqual(round?.syncState, .pending)

        // Persisted immediately (offline-first).
        let stored = try await database.activeRound(courseId: "course-1")
        XCTAssertEqual(stored?.id, round?.id)
    }

    func testStartIsIdempotentWhileARoundIsActive() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)

        let first = await model.startRound()
        let second = await model.startRound(gamePlanId: "plan-2")
        XCTAssertEqual(first?.id, second?.id, "one active round max per course")
        XCTAssertNil(second?.gamePlanId, "the existing round is resumed unchanged")
    }

    func testResumeAfterRestartFindsTheActiveRoundAndItsStrokes() async throws {
        let database = try AppDatabase.inMemory()
        let before = makeModel(database: database)
        await before.startRound()
        await before.recordStroke(
            holeNumber: 1,
            position: LatLon(lat: 58.351, lon: 15.721),
            clubId: "club-dr",
            shotType: .full,
            target: LatLon(lat: 58.353, lon: 15.723)
        )

        // "App restart": a fresh model over the same database.
        let after = makeModel(database: database)
        await after.loadActiveRound()
        XCTAssertTrue(after.hasActiveRound)
        XCTAssertEqual(after.round?.id, before.round?.id)
        XCTAssertEqual(after.strokeCount(holeNumber: 1), 1)
        XCTAssertEqual(after.shots[0].clubId, "club-dr")
    }

    func testFinishedRoundDoesNotResume() async throws {
        let database = try AppDatabase.inMemory()
        let before = makeModel(database: database)
        await before.startRound()
        await before.finishRound()
        XCTAssertFalse(before.hasActiveRound)

        let after = makeModel(database: database)
        await after.loadActiveRound()
        XCTAssertFalse(after.hasActiveRound)
    }

    func testRecordStrokeWritesTheSection2Convention() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)
        await model.startRound()

        let position = LatLon(lat: 58.3515, lon: 15.7215)
        let target = LatLon(lat: 58.353, lon: 15.723)
        let shot = await model.recordStroke(
            holeNumber: 1, position: position, clubId: "club-7i",
            shotType: .full, target: target
        )
        XCTAssertEqual(shot?.lat, position.lat, "recorded AT the position played FROM")
        XCTAssertEqual(shot?.target, target)
        XCTAssertEqual(shot?.sortOrder, 0)
        XCTAssertEqual(shot?.penaltyStrokes, 0)

        // Ordinals are per hole.
        let second = await model.recordStroke(
            holeNumber: 1, position: target, clubId: nil, shotType: .putt, target: target
        )
        XCTAssertEqual(second?.sortOrder, 1)
        let otherHole = await model.recordStroke(
            holeNumber: 2, position: position, clubId: nil, shotType: .full, target: nil
        )
        XCTAssertEqual(otherHole?.sortOrder, 0)
        XCTAssertEqual(model.strokeCount(holeNumber: 1), 2)
        XCTAssertEqual(model.strokeCount(holeNumber: 2), 1)
    }

    func testPenaltyAndEditsFlagSyncedRowsDirty() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)
        await model.startRound()
        let shot = await model.recordStroke(
            holeNumber: 1, position: LatLon(lat: 58.351, lon: 15.721),
            clubId: "club-dr", shotType: .full, target: nil
        )
        let shotId = try XCTUnwrap(shot?.id)

        // Pending rows stay pending through edits (one add carries it all).
        let withPenalty = await model.addPenalty(shotId: shotId)
        XCTAssertEqual(withPenalty?.penaltyStrokes, 1)
        XCTAssertEqual(withPenalty?.syncState, .pending)

        // A synced row goes dirty on edit.
        var synced = try XCTUnwrap(withPenalty)
        synced.serverId = "srv-1"
        synced.serverVersion = 1
        synced.syncState = .synced
        try await database.saveShot(synced)
        let reloaded = makeModel(database: database)
        await reloaded.loadActiveRound()
        let edited = await reloaded.updateStroke(id: shotId, shotType: .recovery)
        XCTAssertEqual(edited?.shotType, .recovery)
        XCTAssertEqual(edited?.syncState, .dirty)
    }

    func testDeleteStrokeUpdatesScorecard() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)
        await model.startRound()
        let first = await model.recordStroke(
            holeNumber: 1, position: LatLon(lat: 58.351, lon: 15.721),
            clubId: nil, shotType: .full, target: nil
        )
        await model.recordStroke(
            holeNumber: 1, position: LatLon(lat: 58.352, lon: 15.722),
            clubId: nil, shotType: .putt, target: nil
        )
        XCTAssertEqual(model.scorecard.line(holeNumber: 1)?.strokes, 2)

        await model.deleteStroke(id: try XCTUnwrap(first?.id))
        XCTAssertEqual(model.scorecard.line(holeNumber: 1)?.strokes, 1)
        XCTAssertEqual(model.scorecard.line(holeNumber: 1)?.putts, 1)
    }
}
