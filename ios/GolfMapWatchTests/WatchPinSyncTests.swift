import XCTest
@testable import GolfMapWatch

/// The pin channel end to end on the watch side: wire encode/decode
/// (`WatchPinPayload`), the store's daily expiry and course scoping, and the
/// Pin rung the ladder grows when a pin arrives.
@MainActor
final class WatchPinSyncTests: XCTestCase {

    private static let baseLat = 59.3293
    private static let baseLon = 18.0686
    private static let latPerMeter = 0.000008993

    private func point(northM: Double, eastM: Double = 0) -> LatLon {
        LatLon(
            lat: Self.baseLat + northM * Self.latPerMeter,
            lon: Self.baseLon + eastM * Self.latPerMeter / cos(Self.baseLat * .pi / 180)
        )
    }

    private func pair(northM: Double, eastM: Double = 0) -> [Double] {
        let p = point(northM: northM, eastM: eastM)
        return [p.lat, p.lon]
    }

    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "WatchPinSyncTests-\(UUID().uuidString)")
    }

    // MARK: - Wire format

    func testEncodeDecodeRoundTrip() {
        let pins = [3: point(northM: 300), 7: point(northM: 10, eastM: 5)]
        let context = WatchPinPayload.encode(courseId: "c-1", day: "2026-08-20", pins: pins)
        let decoded = try! XCTUnwrap(WatchPinPayload.decode(context))
        XCTAssertEqual(decoded.courseId, "c-1")
        XCTAssertEqual(decoded.day, "2026-08-20")
        XCTAssertEqual(decoded.pins, pins)
    }

    func testDecodeRejectsNonPinContextAndDropsMalformedEntries() {
        XCTAssertNil(WatchPinPayload.decode(["something": "else"]))
        let decoded = try! XCTUnwrap(WatchPinPayload.decode([
            WatchPinPayload.courseIdKey: "c-1",
            WatchPinPayload.dayKey: "2026-08-20",
            WatchPinPayload.pinsKey: ["3": [59.0, 18.0], "x": [59.0, 18.0], "4": [59.0]],
        ]))
        XCTAssertEqual(Array(decoded.pins.keys), [3], "only the well-formed entry survives")
    }

    func testEmptyPinSetIsAValidPayload() {
        let context = WatchPinPayload.encode(courseId: "c-1", day: "2026-08-20", pins: [:])
        let decoded = try! XCTUnwrap(WatchPinPayload.decode(context))
        XCTAssertTrue(decoded.pins.isEmpty, "clearing every pin is a payload, not a no-op")
    }

    // MARK: - Store

    func testStoreReportsTodaysPinForItsOwnCourse() {
        let today = Date(timeIntervalSince1970: 1_755_000_000)
        let store = PinStore(defaults: defaults, now: { today })
        let pin = point(northM: 305)
        store.apply(WatchPinPayload.Decoded(
            courseId: "c-1", day: WatchPinPayload.dayString(today), pins: [1: pin]
        ))

        XCTAssertEqual(store.pin(courseId: "c-1", holeNumber: 1), pin)
        XCTAssertNil(store.pin(courseId: "c-1", holeNumber: 2), "no pin on that hole")
        XCTAssertNil(store.pin(courseId: "c-2", holeNumber: 1), "pins are course-scoped")
    }

    func testYesterdaysPinIsNotReported() {
        let today = Date(timeIntervalSince1970: 1_755_000_000)
        let store = PinStore(defaults: defaults, now: { today })
        store.apply(WatchPinPayload.Decoded(
            courseId: "c-1", day: "2000-01-01", pins: [1: point(northM: 305)]
        ))
        XCTAssertNil(store.pin(courseId: "c-1", holeNumber: 1), "a pin is a daily fact")
    }

    func testStoreSurvivesRelaunch() {
        let today = Date(timeIntervalSince1970: 1_755_000_000)
        let pin = point(northM: 305)
        let store = PinStore(defaults: defaults, now: { today })
        store.apply(WatchPinPayload.Decoded(
            courseId: "c-1", day: WatchPinPayload.dayString(today), pins: [1: pin]
        ))

        let reloaded = PinStore(defaults: defaults, now: { today })
        XCTAssertEqual(reloaded.pin(courseId: "c-1", holeNumber: 1), pin,
                       "the phone may be out of reach at launch")
    }

    // MARK: - Ladder

    func testLadderGrowsAPinRungWithoutMovingTheGreenRow() {
        let hole = WatchHole(
            number: 1, par: 4,
            tee: pair(northM: 0),
            greenCenter: pair(northM: 300),
            greenFront: pair(northM: 290),
            greenBack: pair(northM: 310)
        )
        let fix = point(northM: 150)

        let withoutPin = WatchLadder.rows(fix: fix, hole: hole)
        XCTAssertNil(withoutPin.first { $0.isPin }, "no pin synced → no pin rung")

        let rows = WatchLadder.rows(fix: fix, hole: hole, pin: point(northM: 306))
        let pinRow = try! XCTUnwrap(rows.first { $0.isPin })
        XCTAssertEqual(pinRow.label, "Pin")
        XCTAssertEqual(pinRow.metersM, 156, accuracy: 1)
        let greenRow = try! XCTUnwrap(rows.first { $0.isGreen })
        XCTAssertEqual(greenRow.metersM, 150, accuracy: 1, "green row still measures to center")
        XCTAssertLessThan(
            rows.firstIndex(of: greenRow)!, rows.firstIndex(of: pinRow)!,
            "near→far order puts the center before a back pin"
        )
    }
}
