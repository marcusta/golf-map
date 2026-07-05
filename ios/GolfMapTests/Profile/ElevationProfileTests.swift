import XCTest
@testable import GolfMap

/// The elevation-profile series builder (cumulative EPSG:3006 distances,
/// shared-vertex dedupe, nil-elevation passthrough, per-leg sample clamps,
/// presentation smoothing) and the sheet model's seq-guarded async refresh.
final class ElevationProfileTests: XCTestCase {

    private let tee = LatLon(lat: 58.3600, lon: 15.7100)
    private let aim = LatLon(lat: 58.3620, lon: 15.7120)
    private let green = LatLon(lat: 58.3640, lon: 15.7110)

    /// Deterministic terrain: an east-tilted plane in projected meters.
    private static let planeSampler: @Sendable (LatLon) async -> Double? = { ll in
        let p = Sweref99TM.fromWGS84(ll)
        return 40 + 0.05 * (p.x - 541_000)
    }

    private static func plane(_ ll: LatLon) -> Double {
        let p = Sweref99TM.fromWGS84(ll)
        return 40 + 0.05 * (p.x - 541_000)
    }

    // MARK: - Vertex distances

    func testVertexDistancesAreCumulativePlanarMeters() {
        let path = [tee, aim, green]
        let distances = ElevationProfile.vertexDistances(along: path)
        XCTAssertEqual(distances.count, 3)
        XCTAssertEqual(distances[0], 0)
        XCTAssertEqual(distances[1], Distance.planarMeters(tee, aim), accuracy: 1e-9)
        XCTAssertEqual(
            distances[2],
            Distance.planarMeters(tee, aim) + Distance.planarMeters(aim, green),
            accuracy: 1e-9
        )
        XCTAssertEqual(ElevationProfile.vertexDistances(along: []), [])
        XCTAssertEqual(ElevationProfile.vertexDistances(along: [tee]), [0])
    }

    // MARK: - Series

    func testSeriesCumulativeDistanceAndVertexDedupe() async {
        let path = [tee, aim, green]
        let samples = await ElevationProfile.series(along: path, sampler: Self.planeSampler)

        let leg1 = Distance.planarMeters(tee, aim)
        let leg2 = Distance.planarMeters(aim, green)
        let n1 = max(2, min(200, Int((leg1 / 2).rounded(.up)) + 1))
        let n2 = max(2, min(200, Int((leg2 / 2).rounded(.up)) + 1))
        // Second leg skips its start sample (shared vertex with leg 1).
        XCTAssertEqual(samples.count, n1 + n2 - 1)

        XCTAssertEqual(samples.first?.distanceMeters, 0)
        XCTAssertEqual(
            samples.last?.distanceMeters ?? -1,
            leg1 + leg2,
            accuracy: 1e-6,
            "last sample sits at the total path length"
        )

        // Strictly increasing distances — the dedupe leaves no duplicate x.
        for i in 1..<samples.count {
            XCTAssertGreaterThan(samples[i].distanceMeters, samples[i - 1].distanceMeters)
        }

        // Elevations match the plane (lat/lon lerp ≙ projected lerp to well
        // under a millimeter at this scale).
        XCTAssertEqual(samples.first?.elevation ?? .nan, Self.plane(tee), accuracy: 0.001)
        XCTAssertEqual(samples.last?.elevation ?? .nan, Self.plane(green), accuracy: 0.001)
        let vertexSample = samples[n1 - 1]
        XCTAssertEqual(vertexSample.distanceMeters, leg1, accuracy: 1e-6)
        XCTAssertEqual(vertexSample.elevation ?? .nan, Self.plane(aim), accuracy: 0.001)
    }

    func testSeriesShortPathsAndNilElevations() async {
        let empty = await ElevationProfile.series(along: [tee], sampler: Self.planeSampler)
        XCTAssertTrue(empty.isEmpty)

        // Coverage hole: nil beyond half the leg → nils pass through as gaps.
        let start = tee
        let leg = Distance.planarMeters(tee, aim)
        let samples = await ElevationProfile.series(along: [tee, aim]) { ll in
            Distance.planarMeters(start, ll) > leg / 2 ? nil : 10
        }
        XCTAssertTrue(samples.contains { $0.elevation == nil })
        XCTAssertTrue(samples.contains { $0.elevation != nil })
        XCTAssertEqual(samples.first?.elevation, 10)
        XCTAssertNil(samples.last?.elevation)
    }

    func testSeriesClampsSamplesPerLeg() async {
        // ~1.1 km leg at 2 m interval would be ~560 samples — clamped to 200.
        let far = LatLon(lat: 58.3700, lon: 15.7100)
        let samples = await ElevationProfile.series(along: [tee, far], sampler: Self.planeSampler)
        XCTAssertEqual(samples.count, 200)
        XCTAssertEqual(
            samples.last?.distanceMeters ?? -1,
            Distance.planarMeters(tee, far),
            accuracy: 1e-6
        )
    }

    // MARK: - Smoothing

    func testSmoothingFlattensStairStepsButKeepsGapsAndCount() {
        // 0.1 m quantized stair-step series.
        var samples = (0..<20).map {
            ElevationProfile.Sample(
                distanceMeters: Double($0) * 2,
                elevation: ($0 % 2 == 0) ? 50.0 : 50.1
            )
        }
        samples[10].elevation = nil // coverage gap must survive
        let smoothed = ElevationProfile.smoothed(samples)
        XCTAssertEqual(smoothed.count, samples.count)
        XCTAssertNil(smoothed[10].elevation)
        // Interior smoothed values sit strictly between the raw extremes.
        for sample in smoothed[2..<8] {
            let e = try! XCTUnwrap(sample.elevation)
            XCTAssertGreaterThan(e, 50.0)
            XCTAssertLessThan(e, 50.1)
        }
        // Distances untouched.
        XCTAssertEqual(smoothed.map(\.distanceMeters), samples.map(\.distanceMeters))
    }

    // MARK: - Model (seq guard + markers)

    @MainActor
    func testModelResolvesMarkersAndDeltas() async throws {
        let model = ElevationProfileModel()
        model.elevationSampler = Self.planeSampler
        model.update(path: [tee, aim, green], labels: ["Tee", "Aim 1", "Green"])

        XCTAssertEqual(model.markers.map(\.label), ["Tee", "Aim 1", "Green"])
        for _ in 0..<200 where model.isLoading {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertFalse(model.isLoading)
        XCTAssertFalse(model.samples.isEmpty)

        let teeElevation = try XCTUnwrap(model.markers.first?.elevation)
        let greenElevation = try XCTUnwrap(model.markers.last?.elevation)
        XCTAssertEqual(teeElevation, Self.plane(tee), accuracy: 0.001)
        XCTAssertEqual(greenElevation, Self.plane(green), accuracy: 0.001)
        XCTAssertEqual(
            try XCTUnwrap(model.totalDelta),
            Self.plane(green) - Self.plane(tee),
            accuracy: 0.002
        )
        XCTAssertEqual(model.legDeltas.map(\.label), ["Tee→Aim 1", "Aim 1→Green"])
        XCTAssertEqual(
            model.totalDistance,
            Distance.planarMeters(tee, aim) + Distance.planarMeters(aim, green),
            accuracy: 1e-6
        )
    }

    @MainActor
    func testModelDropsSupersededBatch() async throws {
        // Path 1's samples (lat < 58.38) block until released; path 2's
        // resolve immediately with a distinct value.
        let gate = TestGate()
        let model = ElevationProfileModel()
        model.elevationSampler = { ll in
            if ll.lat < 58.38 {
                await gate.wait()
                return 10
            }
            return 20
        }

        model.update(path: [tee, aim], labels: ["Tee", "Green"]) // batch 1, blocked
        let path2 = [LatLon(lat: 58.3900, lon: 15.7100), LatLon(lat: 58.3910, lon: 15.7110)]
        model.update(path: path2, labels: ["A", "B"]) // batch 2, fast

        for _ in 0..<200 where model.isLoading {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(model.path, path2)
        XCTAssertEqual(model.markers.map(\.label), ["A", "B"])
        XCTAssertTrue(model.samples.allSatisfy { $0.elevation == 20 })
        let count = model.samples.count

        await gate.open() // stale batch 1 lands now — must be dropped
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(model.samples.count, count)
        XCTAssertTrue(model.samples.allSatisfy { $0.elevation == 20 }, "superseded batch dropped")
    }

    @MainActor
    func testModelClearAndShortPath() {
        let model = ElevationProfileModel()
        model.elevationSampler = Self.planeSampler
        model.update(path: [tee], labels: ["Tee"])
        XCTAssertEqual(model.markers.count, 1)
        XCTAssertTrue(model.samples.isEmpty)
        XCTAssertFalse(model.isLoading)
        XCTAssertNil(model.totalDelta)

        model.clear()
        XCTAssertTrue(model.markers.isEmpty)
        XCTAssertTrue(model.path.isEmpty)
    }
}

/// A one-shot async gate: `wait()` suspends until `open()`.
private actor TestGate {
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
