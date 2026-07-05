import XCTest
@testable import GolfMap

/// The immersive on-map route-leg distance labels: `OnCourseModel`'s leg
/// decomposition (browse route vs GPS forward route), midpoint correctness,
/// figure parity with the distance card, and the show/hide gate in
/// `overlays(showRouteLabels:)`.
@MainActor
final class RouteLegLabelsTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "RouteLegLabelsTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // Same single-hole geometry as the OnCourseModelTests fixture hole 1:
    // tee → aim1 → aim2 → green, all a few hundred metres apart.
    private let tee = LatLon(lat: 58.3600, lon: 15.7100)
    private let aim1 = LatLon(lat: 58.3615, lon: 15.7092)
    private let aim2 = LatLon(lat: 58.3625, lon: 15.7088)
    private let green = LatLon(lat: 58.3640, lon: 15.7080)

    private func makeModel() -> OnCourseModel {
        let course = CourseRecord(
            id: "course-legs", name: "Legs GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let hole = HoleRecord(id: "h1", courseId: "course-legs", number: 1, par: 5, strokeIndex: 1)
        let manifest = TileManifestRecord(
            courseId: "course-legs", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        let furniture = CourseFurniture(
            course: course,
            holes: [hole],
            tees: [TeeRecord(id: "t1", holeId: "h1", name: "default", lat: tee.lat, lon: tee.lon, sortOrder: 0)],
            greens: [GreenRecord(id: "g1", holeId: "h1", centerLat: green.lat, centerLon: green.lon)],
            pins: [],
            aimPoints: [
                AimPointRecord(id: "a1", holeId: "h1", sortOrder: 0, lat: aim1.lat, lon: aim1.lon, label: nil),
                AimPointRecord(id: "a2", holeId: "h1", sortOrder: 1, lat: aim2.lat, lon: aim2.lon, label: nil),
            ],
            manifest: manifest
        )
        return OnCourseModel(furniture: furniture, defaults: defaults)
    }

    private func legMeters(_ a: LatLon, _ b: LatLon) -> Int {
        Int(Distance.planarMeters(a, b).rounded())
    }

    // MARK: - Pure leg decomposition

    func testLegLabelsEmptyBelowTwoPoints() {
        XCTAssertEqual(OnCourseModel.routeLegLabels(along: []), [])
        XCTAssertEqual(OnCourseModel.routeLegLabels(along: [tee]), [])
    }

    func testLegLengthsMatchPlanarMetersAndMidpointsBisectTheLeg() {
        let route = [tee, aim1, aim2, green]
        let labels = OnCourseModel.routeLegLabels(along: route)
        XCTAssertEqual(labels.count, 3)
        for (index, label) in labels.enumerated() {
            let a = route[index]
            let b = route[index + 1]
            XCTAssertEqual(label.meters, legMeters(a, b), "leg \(index) length")
            // The midpoint halves the leg and lies on it (the two halves sum
            // to the whole within projection rounding).
            let toMid = Distance.planarMeters(a, label.midpoint)
            let fromMid = Distance.planarMeters(label.midpoint, b)
            XCTAssertEqual(toMid, fromMid, accuracy: 0.01, "leg \(index) midpoint bisects")
            XCTAssertEqual(
                toMid + fromMid, Distance.planarMeters(a, b), accuracy: 0.01,
                "leg \(index) midpoint sits on the leg"
            )
        }
    }

    // MARK: - Browse mode

    func testBrowseLabelsFollowHoleRouteAndMatchCardCapsules() {
        let model = makeModel()
        model.setGPSEnabled(false)
        let labels = model.routeLegLabels
        XCTAssertEqual(labels.count, 3, "tee→A1, A1→A2, A2→green")
        XCTAssertEqual(
            labels.map(\.meters), model.routeLegs,
            "on-map figures must equal the card's leg capsules"
        )
        XCTAssertEqual(labels.map(\.meters), [
            legMeters(tee, aim1), legMeters(aim1, aim2), legMeters(aim2, green),
        ])
    }

    func testBrowseLabelsHonorMovedTee() {
        let model = makeModel()
        model.setGPSEnabled(false)
        let moved = LatLon(lat: 58.3585, lon: 15.7110)
        model.moveActiveTee(to: moved)
        XCTAssertEqual(model.routeLegLabels.first?.meters, legMeters(moved, aim1))
        XCTAssertEqual(model.routeLegLabels.map(\.meters), model.routeLegs, "still matches the card")
    }

    // MARK: - GPS mode

    func testGPSLabelsRunFromUserThroughForwardAimsToGreen() {
        let model = makeModel()
        // Behind the tee: > 230 m from the green, both aims still ahead.
        let user = LatLon(lat: 58.3595, lon: 15.7100)
        model.updateUserLocation(user)
        XCTAssertGreaterThan(Distance.planarMeters(user, green), 230)

        let labels = model.routeLegLabels
        XCTAssertEqual(labels.map(\.meters), [
            legMeters(user, aim1), legMeters(aim1, aim2), legMeters(aim2, green),
        ], "user→A1, A1→A2, A2→green")
        // First on-map figure == the card's TO AIM emphasis figure.
        XCTAssertEqual(labels.first?.meters, model.routedAimDistance?.meters)
        // The drawn line covers the same forward route (labels sit on it).
        XCTAssertEqual(model.overlays.distanceLine, [user, aim1, aim2, green])
    }

    func testGPSLabelsSkipPassedAims() {
        let model = makeModel()
        // Between A1 and A2 (past A1, still > 230 m from the green).
        let user = LatLon(lat: 58.3618, lon: 15.7091)
        model.updateUserLocation(user)
        let userToGreen = Distance.planarMeters(user, green)
        XCTAssertGreaterThan(userToGreen, 230)
        XCTAssertGreaterThan(Distance.planarMeters(aim1, green), userToGreen, "A1 is behind the user")

        XCTAssertEqual(model.routeLegLabels.map(\.meters), [
            legMeters(user, aim2), legMeters(aim2, green),
        ], "passed A1 is skipped; route runs user→A2→green")
        // The first label updates with the fix (a new fix, a new first leg).
        let user2 = LatLon(lat: 58.3620, lon: 15.7090)
        model.updateUserLocation(user2)
        XCTAssertEqual(model.routeLegLabels.first?.meters, legMeters(user2, aim2))
    }

    func testGPSLabelsCollapseToSingleLegNearGreen() {
        let model = makeModel()
        // Within the 230 m aim-routing threshold: no aim routing, one leg.
        let user = LatLon(lat: 58.3630, lon: 15.7085)
        model.updateUserLocation(user)
        XCTAssertLessThan(Distance.planarMeters(user, green), 230)

        let labels = model.routeLegLabels
        XCTAssertEqual(labels.map(\.meters), [legMeters(user, green)])
        XCTAssertEqual(labels.first?.meters, model.distances?.center, "matches the card's CENTER figure")
    }

    // MARK: - Visibility gate

    func testOverlaysCarryLabelsOnlyWhenRequested() {
        let model = makeModel()
        model.setGPSEnabled(false)
        XCTAssertTrue(model.overlays.routeLegLabels.isEmpty, "default overlays hide the labels")
        XCTAssertTrue(model.overlays(showRouteLabels: false).routeLegLabels.isEmpty)
        XCTAssertEqual(
            model.overlays(showRouteLabels: true).routeLegLabels,
            model.routeLegLabels,
            "immersive overlays carry the active-mode legs"
        )
    }
}
