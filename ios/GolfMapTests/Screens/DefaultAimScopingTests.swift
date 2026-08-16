import XCTest
@testable import GolfMap

/// Regression for the device bug where the D-HF2 ring walk snapped to an
/// ADJACENT hole's fairway (the surface stack is course-wide and carries no
/// holeIds), aiming the entry camera 45–90° off the hole — Linkan holes
/// 4/6/13/14/15/18. Par 3s were always fine because the plays-like clamp
/// resolves to the green center before the walk ever runs.
///
/// Fixture: hole 1 is a 480 m par 5 straight north whose OWN fairway starts
/// beyond the longest carry (so the ring at longest-carry radius misses it);
/// hole 2 is a par 3 to the east whose fairway DOES cross that ring. The
/// default aim must stay in a sane bearing cone of the origin→green line
/// (here: the no-fairway fallback straight up the line), never the foreign
/// arc ~70° right.
@MainActor
final class DefaultAimScopingTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    /// Planar base every fixture coordinate is measured from (EPSG:3006
    /// meters, {x east, y north}).
    private let base = Sweref99TM.fromWGS84(LatLon(lat: 58.3600, lon: 15.7100))

    override func setUp() {
        super.setUp()
        suiteName = "DefaultAimScopingTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Fixture

    private func latLon(_ dx: Double, _ dy: Double) -> LatLon {
        Sweref99TM.toWGS84(x: base.x + dx, y: base.y + dy)
    }

    private func planar(_ p: LatLon) -> Vec2 {
        let q = Sweref99TM.fromWGS84(p)
        return Vec2(x: q.x - base.x, y: q.y - base.y)
    }

    /// Axis-aligned rectangle ring in base-relative planar meters.
    private func rect(_ minX: Double, _ minY: Double, _ maxX: Double, _ maxY: Double) -> [Vec2] {
        [
            Vec2(x: base.x + minX, y: base.y + minY),
            Vec2(x: base.x + maxX, y: base.y + minY),
            Vec2(x: base.x + maxX, y: base.y + maxY),
            Vec2(x: base.x + minX, y: base.y + maxY),
        ]
    }

    /// Hole 1: par 5, tee at the base, green 480 m due north (beyond the
    /// 220 m longest carry). Hole 2: par 3, 200 m east — tee at (200, −50),
    /// green at (200, 150), its fairway spanning x 170…230, y 0…150 (the
    /// rect the 220 m ring around hole 1's tee crosses at ~50–90° right).
    private func makeFurniture(aimPoints: [AimPointRecord] = []) -> CourseFurniture {
        let course = CourseRecord(
            id: "course-scope", name: "Scoping GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [
            HoleRecord(id: "h1", courseId: "course-scope", number: 1, par: 5, strokeIndex: 1),
            HoleRecord(id: "h2", courseId: "course-scope", number: 2, par: 3, strokeIndex: 17),
        ]
        let tees = [
            TeeRecord(id: "t1", holeId: "h1", name: "default", lat: latLon(0, 0).lat, lon: latLon(0, 0).lon, elevation: 10, sortOrder: 0),
            TeeRecord(id: "t2", holeId: "h2", name: "default", lat: latLon(200, -50).lat, lon: latLon(200, -50).lon, elevation: 10, sortOrder: 0),
        ]
        let g1c = latLon(0, 480), g1f = latLon(0, 470), g1b = latLon(0, 490)
        let g2c = latLon(200, 150), g2f = latLon(200, 140), g2b = latLon(200, 160)
        let greens = [
            GreenRecord(
                id: "g1", holeId: "h1",
                centerLat: g1c.lat, centerLon: g1c.lon,
                frontLat: g1f.lat, frontLon: g1f.lon,
                backLat: g1b.lat, backLon: g1b.lon,
                elevation: 10
            ),
            GreenRecord(
                id: "g2", holeId: "h2",
                centerLat: g2c.lat, centerLon: g2c.lon,
                frontLat: g2f.lat, frontLon: g2f.lon,
                backLat: g2b.lat, backLon: g2b.lon,
                elevation: 10
            ),
        ]
        let manifest = TileManifestRecord(
            courseId: "course-scope", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: aimPoints, manifest: manifest
        )
    }

    private func makeModel(
        ownFairway: [Vec2]?,
        foreignFairway: [Vec2]?,
        aimPoints: [AimPointRecord] = []
    ) -> OnCourseModel {
        let model = OnCourseModel(furniture: makeFurniture(aimPoints: aimPoints), defaults: defaults)
        model.setGPSEnabled(false)
        model.reticleSettleSleep = {}
        model.setClubs([
            ClubRecord(id: "pw", name: "PW", carryM: 100, dispersionM: 14, sortOrder: 0),
            ClubRecord(id: "6i", name: "6i", carryM: 160, dispersionM: 22, sortOrder: 1),
            ClubRecord(id: "dr", name: "Dr", carryM: 220, dispersionM: 40, sortOrder: 2),
        ])
        var surfaces: [FlatRing] = []
        if let ownFairway { surfaces.append(FlatRing(points: ownFairway, kind: "fairway")) }
        if let foreignFairway { surfaces.append(FlatRing(points: foreignFairway, kind: "fairway")) }
        model.setSurfaces(surfaces)
        return model
    }

    /// Unsigned angle (degrees) between the origin→aim and origin→green
    /// directions, planar.
    private func bearingErrorDeg(model: OnCourseModel, aim: LatLon) -> Double {
        let hole = model.currentHole!
        let origin = planar(model.origin!)
        let green = planar(LatLon(
            lat: hole.green!.centerLat, lon: hole.green!.centerLon
        ))
        let a = Vec2(x: green.x - origin.x, y: green.y - origin.y)
        let b = planar(aim)
        let bv = Vec2(x: b.x - origin.x, y: b.y - origin.y)
        let dot = a.x * bv.x + a.y * bv.y
        let cross = a.x * bv.y - a.y * bv.x
        return abs(atan2(cross, dot)) * 180 / .pi
    }

    // MARK: - Adjacent-fairway capture (the device bug)

    func testAdjacentHoleFairwayNeverCapturesTheRingWalk() throws {
        // Hole 1's own fairway starts at 250 m — beyond every walked ring —
        // so the only fairway the 220 m ring crosses belongs to hole 2. The
        // aim must fall back to the bearing fallback (straight up the green
        // line at longest carry), NOT snap ~70° right into hole 2's fairway.
        let model = makeModel(
            ownFairway: rect(-30, 250, 30, 450),
            foreignFairway: rect(170, 0, 230, 150)
        )
        let aim = try XCTUnwrap(model.defaultAimTarget)
        let error = bearingErrorDeg(model: model, aim: aim)
        XCTAssertLessThanOrEqual(
            error, 30,
            "aim bearing is \(error)° off the green line — adjacent-hole fairway captured the walk"
        )
        // And specifically the no-fairway-hit fallback: longest carry along
        // the origin→green bearing (flat ground → ground radius = carry).
        let p = planar(aim)
        let origin = planar(model.origin!)
        XCTAssertEqual(hypot(p.x - origin.x, p.y - origin.y), 220, accuracy: 2)
    }

    func testOwnFairwayStillDrivesTheRingWalk() throws {
        // Same foreign fairway present, but hole 1's own fairway now spans
        // the 220 m ring — the walk must land in it, centered on the line.
        let model = makeModel(
            ownFairway: rect(-30, 150, 30, 450),
            foreignFairway: rect(170, 0, 230, 150)
        )
        let aim = try XCTUnwrap(model.defaultAimTarget)
        let p = planar(aim)
        XCTAssertEqual(p.x, 0, accuracy: 1)
        XCTAssertEqual(p.y, 220, accuracy: 1)
    }

    // MARK: - Curated furniture aim points (D-HF1 rule 2)

    func testFurnitureAimPointBeatsTheRingWalkOnDevice() throws {
        // Hole 1 carries a curated "Aim 1" 200 m out and 40 m right of the
        // chord. The own fairway spans the 220 ring (the walk WOULD land at
        // (0, 220)) — the curated point must win anyway.
        let aimLL = latLon(40, 200)
        let model = makeModel(
            ownFairway: rect(-30, 150, 30, 450),
            foreignFairway: rect(170, 0, 230, 150),
            aimPoints: [
                AimPointRecord(id: "a1", holeId: "h1", sortOrder: 0, lat: aimLL.lat, lon: aimLL.lon)
            ]
        )
        let aim = try XCTUnwrap(model.defaultAimTarget)
        let p = planar(aim)
        XCTAssertEqual(p.x, 40, accuracy: 1)
        XCTAssertEqual(p.y, 200, accuracy: 1)
    }

    func testUnreachableAimPointSteersTheBearingFallback() throws {
        // Curated point 300 m out on a dogleg line (beyond the 220 carry):
        // the aim is the longest carry along origin -> aim point, not along
        // the origin -> green chord and not an adjacent fairway.
        let aimLL = latLon(150, 260)
        let model = makeModel(
            ownFairway: nil,
            foreignFairway: rect(170, 0, 230, 150),
            aimPoints: [
                AimPointRecord(id: "a1", holeId: "h1", sortOrder: 0, lat: aimLL.lat, lon: aimLL.lon)
            ]
        )
        let aim = try XCTUnwrap(model.defaultAimTarget)
        let p = planar(aim)
        let scale = 220.0 / 300.0
        XCTAssertEqual(p.x, 150 * scale, accuracy: 1)
        XCTAssertEqual(p.y, 260 * scale, accuracy: 1)
    }

    func testPar3ResolvesToGreenCenterIgnoringFairways() throws {
        // Hole 2 plays 200 m ≤ the 220 m longest carry: the plays-like clamp
        // resolves to the green center before the ring walk runs — the
        // device pattern "par 3s always fine".
        let model = makeModel(
            ownFairway: rect(-30, 250, 30, 450),
            foreignFairway: rect(170, 0, 230, 150)
        )
        model.goToHole(number: 2)
        let aim = try XCTUnwrap(model.defaultAimTarget)
        let p = planar(aim)
        XCTAssertEqual(p.x, 200, accuracy: 1)
        XCTAssertEqual(p.y, 150, accuracy: 1)
    }
}
