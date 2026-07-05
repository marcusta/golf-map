import XCTest
@testable import GolfMap

/// The measure tool's state machine: place/undo/clear, totals delegating to
/// `PlaysLike` on a synthetic path, and the async elevation seq-guard
/// (a stale sample from a cleared path must never patch the new one).
@MainActor
final class MeasureModelTests: XCTestCase {

    // Around Landeryd (well inside SWEREF 99 TM's sweet spot).
    private let pointA = LatLon(lat: 58.3600, lon: 15.7100)
    private let pointB = LatLon(lat: 58.3610, lon: 15.7120)
    private let pointC = LatLon(lat: 58.3615, lon: 15.7105)

    /// Deterministic terrain: a north-tilted plane in projected meters.
    private static let planeSampler: @Sendable (LatLon) async -> Double? = { ll in
        let p = Sweref99TM.fromWGS84(ll)
        return 50 + 0.02 * (p.y - 6_470_000)
    }

    private func waitForElevations(_ model: MeasureModel) async throws {
        for _ in 0..<200 where model.points.contains(where: { $0.elevation == nil }) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertFalse(model.points.contains { $0.elevation == nil }, "elevations resolved")
    }

    // MARK: - State machine

    func testPlaceCachesProjectionAndResolvesElevation() async throws {
        let model = MeasureModel()
        model.elevationSampler = Self.planeSampler

        model.place(pointA)
        XCTAssertEqual(model.points.count, 1)
        XCTAssertFalse(model.hasPath)

        let projected = Sweref99TM.fromWGS84(pointA)
        XCTAssertEqual(model.points[0].e, projected.x, accuracy: 1e-9)
        XCTAssertEqual(model.points[0].n, projected.y, accuracy: 1e-9)

        try await waitForElevations(model)
        let expected = 50 + 0.02 * (projected.y - 6_470_000)
        XCTAssertEqual(try XCTUnwrap(model.points[0].elevation), expected, accuracy: 1e-9)
    }

    func testUndoAndClear() {
        let model = MeasureModel()
        model.place(pointA)
        model.place(pointB)
        model.place(pointC)
        XCTAssertEqual(model.points.count, 3)

        model.undoLast()
        XCTAssertEqual(model.points.map(\.position), [pointA, pointB])

        model.clear()
        XCTAssertTrue(model.points.isEmpty)
        XCTAssertFalse(model.hasPath)

        // Undo on empty is a no-op.
        model.undoLast()
        XCTAssertTrue(model.points.isEmpty)
    }

    // MARK: - Stats delegate to PlaysLike

    func testTotalsMatchPlaysLikeOnSyntheticPath() async throws {
        let model = MeasureModel()
        model.elevationSampler = Self.planeSampler
        model.place(pointA)
        model.place(pointB)
        model.place(pointC)
        try await waitForElevations(model)

        // Independent computation straight through the Geo layer.
        let expectedPath = [pointA, pointB, pointC].map { ll -> PlaysLike.Point in
            let p = Sweref99TM.fromWGS84(ll)
            return PlaysLike.Point(e: p.x, n: p.y, elevation: 50 + 0.02 * (p.y - 6_470_000))
        }
        let expectedTotals = PlaysLike.pathTotals(PlaysLike.pathSegmentStats(expectedPath))

        XCTAssertEqual(model.segments.count, 2)
        let totals = model.totals
        XCTAssertEqual(totals.horizontal, expectedTotals.horizontal, accuracy: 1e-9)
        XCTAssertEqual(
            try XCTUnwrap(totals.elevationDelta),
            try XCTUnwrap(expectedTotals.elevationDelta),
            accuracy: 1e-9
        )
        XCTAssertEqual(
            try XCTUnwrap(totals.playsLikeSimple),
            try XCTUnwrap(expectedTotals.playsLikeSimple),
            accuracy: 1e-9
        )
        XCTAssertEqual(
            try XCTUnwrap(totals.slopePct),
            try XCTUnwrap(expectedTotals.slopePct),
            accuracy: 1e-9
        )
        XCTAssertEqual(totals.measuredSegments, 2)

        // Cross-check horizontal against the planar distance helper.
        let independent = Distance.planarMeters(pointA, pointB) + Distance.planarMeters(pointB, pointC)
        XCTAssertEqual(totals.horizontal, independent, accuracy: 1e-9)
    }

    func testMissingElevationDegradesToNilNotWrongNumbers() {
        let model = MeasureModel() // no sampler at all
        model.place(pointA)
        model.place(pointB)
        let totals = model.totals
        XCTAssertGreaterThan(totals.horizontal, 0)
        XCTAssertNil(totals.elevationDelta)
        XCTAssertNil(totals.playsLikeSimple)
        XCTAssertEqual(totals.measuredSegments, 0)
    }

    // MARK: - Seq-guard staleness

    func testStaleElevationFromClearedPathIsDropped() async throws {
        // First sample call blocks until released; later calls resolve fast.
        let gate = AsyncGate()
        let calls = Counter()
        let model = MeasureModel()
        model.elevationSampler = { _ in
            if await calls.next() == 1 {
                await gate.wait()
                return 111 // the stale value that must never land
            }
            return 5
        }

        model.place(pointA) // call 1 — blocked in flight
        model.clear()
        model.place(pointB) // call 2 — resolves fast, same index 0
        for _ in 0..<200 where model.points.first?.elevation == nil {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(model.points.first?.elevation, 5)

        await gate.open() // stale sample lands now
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(model.points.first?.elevation, 5, "stale sample dropped by seq guard")
    }

    func testStaleElevationAfterUndoRePlaceIsDroppedByIdentityCheck() async throws {
        let gate = AsyncGate()
        let calls = Counter()
        let model = MeasureModel()
        model.elevationSampler = { _ in
            if await calls.next() == 1 {
                await gate.wait()
                return 111
            }
            return 7
        }

        model.place(pointA) // call 1 — blocked
        model.undoLast()
        model.place(pointC) // call 2 — same index 0, different position
        for _ in 0..<200 where model.points.first?.elevation == nil {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(model.points.first?.elevation, 7)

        await gate.open()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(model.points.first?.elevation, 7, "identity check rejects the old point's sample")
    }

    // MARK: - Labels

    func testPointAndSegmentLabels() {
        XCTAssertEqual(MeasureOverlay.pointLabel(0), "A")
        XCTAssertEqual(MeasureOverlay.pointLabel(2), "C")
        XCTAssertEqual(MeasureOverlay.pointLabel(26), "A", "wraps past Z")
        XCTAssertEqual(MeasureModel.segmentLabel(0), "A→B")
        XCTAssertEqual(MeasureModel.segmentLabel(1), "B→C")
    }
}

// MARK: - Async test helpers

/// A one-shot async gate: `wait()` suspends until `open()`.
private actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        for waiter in waiters { waiter.resume() }
        waiters = []
    }
}

/// Monotonic call counter usable from a @Sendable closure.
private actor Counter {
    private var value = 0
    func next() -> Int {
        value += 1
        return value
    }
}
