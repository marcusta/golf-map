import XCTest
@testable import GolfMap

/// Green handoff (round loop R6, task T35): the ball-on-green card mode, its
/// green-card content (distance to hole, the read's ball/hole markers), the
/// pin-override-first hole resolution that closes laser-doc Q3, and the
/// per-round stimp that replaces the app default and feeds the read's figures.
@MainActor
final class GreenHandoffTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "GreenHandoffTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Fixture (hole 1: tee → one planned landing → green)

    private let tee = LatLon(lat: 58.3600, lon: 15.7100)
    private let landing = LatLon(lat: 58.3620, lon: 15.7090)
    private let greenCenter = LatLon(lat: 58.3640, lon: 15.7080)
    /// A pin a few metres off the green centre (the ball sits on the centre).
    private let furniturePin = LatLon(lat: 58.36405, lon: 15.70805)

    private func makeFurniture(withPin: Bool) -> CourseFurniture {
        let course = CourseRecord(
            id: "course-1", name: "Testville GC", status: "published",
            revision: 2, downloadedRevision: 2, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [
            HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 4, strokeIndex: 7),
        ]
        let tees = [
            TeeRecord(id: "t1d", holeId: "h1", name: "default", lat: tee.lat, lon: tee.lon, elevation: 10, sortOrder: 0),
        ]
        let greens = [
            GreenRecord(
                id: "g1", holeId: "h1",
                centerLat: greenCenter.lat, centerLon: greenCenter.lon,
                frontLat: 58.3638, frontLon: 15.7080,
                backLat: 58.3642, backLon: 15.7080,
                elevation: 25
            ),
        ]
        let pins = withPin
            ? [PinRecord(id: "p1", greenId: "g1", name: "Sunday", lat: furniturePin.lat, lon: furniturePin.lon, active: true)]
            : []
        let manifest = TileManifestRecord(
            courseId: "course-1", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: pins, aimPoints: [], manifest: manifest
        )
    }

    private func makePlan(clubs: [ClubRecord]) -> CoursePlan {
        CoursePlan.make(
            stored: StoredGamePlan(
                plan: GamePlanRecord(id: "plan-1", courseId: "course-1"),
                holes: [GamePlanHoleRecord(
                    id: "ph1", gamePlanId: "plan-1", holeNumber: 1, notes: nil
                )],
                shots: [PlanShotRecord(
                    id: "ps1", gamePlanHoleId: "ph1", sortOrder: 0,
                    lat: landing.lat, lon: landing.lon,
                    clubId: "c-drv", label: "Layup"
                )],
                gates: []
            ),
            clubs: clubs
        )
    }

    private func greenBox() -> FlatRing {
        let c = Sweref99TM.fromWGS84(greenCenter)
        let half = 20.0
        return FlatRing(points: [
            Vec2(x: c.x - half, y: c.y - half), Vec2(x: c.x + half, y: c.y - half),
            Vec2(x: c.x + half, y: c.y + half), Vec2(x: c.x - half, y: c.y + half),
        ], kind: "green")
    }

    /// Model on hole 1 with the plan + a green surface installed. `withPin`
    /// adds an active furniture pin near the green centre.
    private func makeModel(withPin: Bool = false) -> OnCourseModel {
        let model = OnCourseModel(furniture: makeFurniture(withPin: withPin), defaults: defaults)
        let bag = [ClubRecord(id: "c-drv", name: "Driver", carryM: 230, dispersionM: 40, sortOrder: 0)]
        model.setClubs(bag)
        model.setPlan(makePlan(clubs: bag))
        model.setSurfaces([greenBox()])
        return model
    }

    private func stroke(_ position: LatLon) -> OnCourseModel.RoundStroke {
        OnCourseModel.RoundStroke(holeNumber: 1, position: position)
    }

    // MARK: - R6: green-mode derivation

    func testBallOnGreenFlipsTheCardToGreenMode() throws {
        let model = makeModel()
        model.setActiveRound(strokes: [stroke(tee), stroke(greenCenter)])
        XCTAssertEqual(try XCTUnwrap(model.playingState).lie, .green, "ball is in the green ring")
        XCTAssertEqual(model.roundCardMode, .green)
    }

    func testGreenModeTakesPrecedenceOverPastPlanDecide() throws {
        // Four strokes have passed the 2-stroke plan (would be .decide, T31),
        // but the ball is on the green → R6 green mode wins.
        let model = makeModel()
        model.setActiveRound(strokes: [
            stroke(tee), stroke(landing), stroke(landing), stroke(greenCenter),
        ])
        let state = try XCTUnwrap(model.playingState)
        XCTAssertEqual(state.strokeIndex, 4)
        XCTAssertEqual(state.lie, .green)
        XCTAssertEqual(model.roundCardMode, .green, "green precedence over divergence")
    }

    func testBallOffGreenDoesNotEnterGreenMode() throws {
        let model = makeModel()
        // A ball short of the green (rough) matches no landing → decide, and
        // the green card is nil.
        let shortOfGreen = LatLon(lat: 58.3632, lon: 15.7083)
        model.setActiveRound(strokes: [stroke(tee), stroke(shortOfGreen)])
        XCTAssertNotEqual(try XCTUnwrap(model.playingState).lie, .green)
        XCTAssertNotEqual(model.roundCardMode, .green)
        XCTAssertNil(model.greenCard)
    }

    // MARK: - R6: green-card content + the read's hole (closes laser-doc Q3)

    func testGreenCardHoleIsTheFurnitureActivePinByDefault() throws {
        let model = makeModel(withPin: true)
        model.setActiveRound(strokes: [stroke(tee), stroke(greenCenter)])
        let card = try XCTUnwrap(model.greenCard)
        XCTAssertEqual(card.ballPosition, greenCenter)
        XCTAssertEqual(card.holePosition, furniturePin, "hole = active pin when no override")
        XCTAssertEqual(card.holeName, "Sunday")
        XCTAssertEqual(
            card.distanceM,
            Int(Distance.planarMeters(greenCenter, furniturePin).rounded())
        )
    }

    func testPlacedPinOverrideBecomesTheReadsHole() throws {
        // The lasered pin (today's-pin override) wins over the furniture pin —
        // the green card hands exactly this to the putt read (laser-doc Q3).
        let model = makeModel(withPin: true)
        let lasered = LatLon(lat: 58.36398, lon: 15.70792)
        model.setPinOverride(lasered, source: .laser, forHole: "h1")
        model.setActiveRound(strokes: [stroke(tee), stroke(greenCenter)])
        let card = try XCTUnwrap(model.greenCard)
        XCTAssertEqual(card.holePosition, lasered, "override wins over furniture pin")
        XCTAssertEqual(card.holeName, "Laser")
        XCTAssertEqual(
            card.distanceM,
            Int(Distance.planarMeters(greenCenter, lasered).rounded())
        )
    }

    func testGreenCardHoleIsNilWithNoPinAtAll() throws {
        let model = makeModel(withPin: false)
        model.setActiveRound(strokes: [stroke(tee), stroke(greenCenter)])
        let card = try XCTUnwrap(model.greenCard)
        XCTAssertNil(card.holePosition)
        XCTAssertNil(card.distanceM)
        XCTAssertEqual(card.ballPosition, greenCenter, "ball still hands off")
    }

    func testNoRoundYieldsNoGreenCard() {
        let model = makeModel(withPin: true)
        XCTAssertNil(model.roundCardMode)
        XCTAssertNil(model.greenCard)
    }
}

/// Per-round stimp (round loop R6): defaulted from the previous round at the
/// course, persisted with the local round record, and set without dirtying a
/// synced round (no server column — degrades gracefully out of sync).
@MainActor
final class RoundStimpTests: XCTestCase {

    private let holes = [HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 4)]

    private func makeModel(database: AppDatabase) -> RoundModel {
        RoundModel(courseId: "course-1", holes: holes, database: database)
    }

    func testStartRoundStampsTheSeedStimpWithNoPriorRound() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)
        let round = await model.startRound(stimpFt: 10.5)
        XCTAssertEqual(round?.stimpFt, 10.5, "seed (app default) with no prior round")
        let stored = try await database.activeRound(courseId: "course-1")
        XCTAssertEqual(stored?.stimpFt, 10.5, "persisted with the local round record")
    }

    func testStartRoundDefaultsStimpFromPreviousRoundAtCourse() async throws {
        let database = try AppDatabase.inMemory()
        let first = makeModel(database: database)
        await first.startRound(stimpFt: 9)
        await first.finishRound()

        // A new round defaults to the previous round's stimp, NOT the seed.
        let second = makeModel(database: database)
        let round = await second.startRound(stimpFt: 12)
        XCTAssertEqual(round?.stimpFt, 9, "previous round's stimp wins over the seed")
    }

    func testSetStimpPersistsWithoutFlippingSyncState() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)
        await model.startRound(stimpFt: 10)
        XCTAssertEqual(model.round?.syncState, .pending)

        await model.setStimp(12.5)
        XCTAssertEqual(model.round?.stimpFt, 12.5)
        XCTAssertEqual(
            model.round?.syncState, .pending,
            "stimp is local-only — the syncState is not dirtied"
        )
        let stored = try await database.activeRound(courseId: "course-1")
        XCTAssertEqual(stored?.stimpFt, 12.5, "persisted")
    }

    func testSetStimpNoOpsOnUnchangedValueAndWithoutARound() async throws {
        let database = try AppDatabase.inMemory()
        let model = makeModel(database: database)
        let noRound = await model.setStimp(10)
        XCTAssertNil(noRound, "no active round → no-op")

        await model.startRound(stimpFt: 10)
        let before = model.round
        let after = await model.setStimp(10)
        XCTAssertEqual(after, before, "unchanged value → no write")
    }
}
