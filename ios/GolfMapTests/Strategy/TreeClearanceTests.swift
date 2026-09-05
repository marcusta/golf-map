import XCTest
@testable import GolfMap

/// One-to-one port of `shared/strategy/tree-clearance.test.ts` so the Swift
/// `TreeClearance.swift` and the TS module stay in parity. Hand-computed
/// planar fixtures; the shot line runs from (0,0) east along +x.
final class TreeClearanceTests: XCTestCase {

    private func trees(
        _ minX: Double, _ maxX: Double,
        _ attributes: [String: FeatureAttributeValue]? = nil,
        type: String = "trees"
    ) -> TreeFeatureInput {
        TreeFeatureInput(
            type: type,
            points: [
                Vec2(x: minX, y: -10),
                Vec2(x: maxX, y: -10),
                Vec2(x: maxX, y: 10),
                Vec2(x: minX, y: 10),
            ],
            attributes: attributes
        )
    }

    private let O = Vec2(x: 0, y: 0)
    private let T = Vec2(x: 200, y: 0)

    // MARK: - treeHeightM

    func testTreeHeightPrefersP90FallsBackToMaxElseNil() {
        XCTAssertEqual(treeHeightM(trees(0, 1, ["heightP90M": .number(18), "heightMaxM": .number(25)])), 18)
        XCTAssertEqual(treeHeightM(trees(0, 1, ["heightMaxM": .number(25)])), 25)
        XCTAssertNil(treeHeightM(trees(0, 1, ["heightMeanM": .number(12)])))
        XCTAssertNil(treeHeightM(trees(0, 1)))
        XCTAssertNil(treeHeightM(trees(0, 1, nil)))
    }

    func testTreeHeightNonPositiveOrNonNumericCountsAsMissing() {
        XCTAssertEqual(treeHeightM(trees(0, 1, ["heightP90M": .number(0), "heightMaxM": .number(20)])), 20)
        XCTAssertNil(treeHeightM(trees(0, 1, ["heightP90M": .string("tall")])))
    }

    // MARK: - treeCrossingsAlongLine

    func testMissReportsNothing() {
        var off = trees(50, 80)
        off.points = off.points.map { Vec2(x: $0.x, y: $0.y + 100) }
        XCTAssertEqual(treeCrossingsAlongLine(O, T, [off]), [])
    }

    func testSingleCrossingReportsEntryExitFeatureAndHeight() {
        let f = trees(130, 150, ["heightP90M": .number(18)])
        let out = treeCrossingsAlongLine(O, T, [f])
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].feature, f)
        XCTAssertEqual(out[0].entryM, 130, accuracy: 1e-9)
        XCTAssertEqual(out[0].exitM, 150, accuracy: 1e-9)
        XCTAssertEqual(out[0].treeHeightM, 18)
    }

    func testOriginInsideRingReportsEntryZero() {
        let out = treeCrossingsAlongLine(Vec2(x: 20, y: 0), Vec2(x: 200, y: 0), [trees(10, 40)])
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].entryM, 0)
        XCTAssertEqual(out[0].exitM, 20, accuracy: 1e-9)
    }

    func testTwoTreesBothReportedSortedByEntry() {
        let far = trees(150, 170)
        let near = trees(60, 80)
        let out = treeCrossingsAlongLine(O, T, [far, near])
        XCTAssertEqual(out.map(\.entryM), [60, 150])
    }

    func testNonTreeFeaturesAndDegenerateRingsIgnoredZeroLengthLineYieldsNothing() {
        let bunker = trees(60, 80, nil, type: "bunker")
        let degenerate = TreeFeatureInput(type: "trees", points: [Vec2(x: 60, y: 0), Vec2(x: 80, y: 0)])
        XCTAssertEqual(treeCrossingsAlongLine(O, T, [bunker, degenerate]), [])
        XCTAssertEqual(treeCrossingsAlongLine(O, O, [trees(60, 80)]), [])
    }

    // MARK: - trajectoryHeightAt (model)

    private let carry = 200.0
    private let apex = 30.0

    func testModelZeroAtBothEndsAndOutsideTheFlight() {
        XCTAssertEqual(trajectoryHeightAt(0, carryM: carry, apexM: apex), 0)
        XCTAssertEqual(trajectoryHeightAt(carry, carryM: carry, apexM: apex), 0)
        XCTAssertEqual(trajectoryHeightAt(-5, carryM: carry, apexM: apex), 0)
        XCTAssertEqual(trajectoryHeightAt(250, carryM: carry, apexM: apex), 0)
    }

    func testModelApexSitsAt62PercentOfCarryAndEqualsApexM() {
        var bestD = 0.0
        var bestH = -1.0
        var d = 0.0
        while d <= carry {
            let h = trajectoryHeightAt(d, carryM: carry, apexM: apex)
            if h > bestH {
                bestH = h
                bestD = d
            }
            d += 0.5
        }
        XCTAssertEqual(bestD / carry, APEX_CARRY_FRACTION, accuracy: 0.005)
        XCTAssertEqual(bestH, apex, accuracy: 1e-6)
        XCTAssertGreaterThanOrEqual(APEX_CARRY_FRACTION, 0.6)
        XCTAssertLessThanOrEqual(APEX_CARRY_FRACTION, 0.65)
    }

    func testModelMonotoneRisingBeforeApexAndFallingAfter() {
        let apexD = APEX_CARRY_FRACTION * carry
        var prev = -1.0
        var d = 0.0
        while d <= apexD {
            let h = trajectoryHeightAt(d, carryM: carry, apexM: apex)
            XCTAssertGreaterThan(h, prev)
            prev = h
            d += 1
        }
        prev = .infinity
        d = apexD
        while d <= carry {
            let h = trajectoryHeightAt(d, carryM: carry, apexM: apex)
            XCTAssertLessThan(h, prev)
            prev = h
            d += 1
        }
    }

    func testModelDescentSteeperThanLaunch() {
        XCTAssertLessThan(
            trajectoryHeightAt(20, carryM: carry, apexM: apex),
            trajectoryHeightAt(carry - 20, carryM: carry, apexM: apex)
        )
    }

    func testModelInvalidCarryOrApexYieldsZero() {
        XCTAssertEqual(trajectoryHeightAt(50, carryM: 0, apexM: apex), 0)
        XCTAssertEqual(trajectoryHeightAt(50, carryM: carry, apexM: 0), 0)
    }

    // MARK: - trajectoryHeightAt (samples)

    private let samples = [
        TrajectorySample(d: 0, h: 0),
        TrajectorySample(d: 50, h: 12),
        TrajectorySample(d: 120, h: 28),
        TrajectorySample(d: 180, h: 10),
        TrajectorySample(d: 200, h: 0),
    ]

    func testSamplesInterpolateLinearlyAndHitSamplePointsExactly() {
        XCTAssertEqual(trajectoryHeightAt(50, carryM: 999, apexM: 999, samples: samples), 12)
        XCTAssertEqual(trajectoryHeightAt(25, carryM: 999, apexM: 999, samples: samples), 6, accuracy: 1e-9)
        XCTAssertEqual(trajectoryHeightAt(150, carryM: 999, apexM: 999, samples: samples), 19, accuracy: 1e-9)
    }

    func testSamplesOutsideRangeIsZeroAndFewerThanTwoFallsBackToModel() {
        XCTAssertEqual(trajectoryHeightAt(-1, carryM: 999, apexM: 999, samples: samples), 0)
        XCTAssertEqual(trajectoryHeightAt(201, carryM: 999, apexM: 999, samples: samples), 0)
        XCTAssertEqual(
            trajectoryHeightAt(124, carryM: 200, apexM: 30, samples: [TrajectorySample(d: 0, h: 0)]),
            30, accuracy: 1e-6
        )
    }

    // MARK: - treeClearance

    private let shot = TreeClearanceShot(carryM: 200, apexM: 30)

    func testLowTreesUnderTheApexClearSummaryNamesThemWorst() {
        let f = trees(110, 130, ["heightP90M": .number(10)])
        let r = treeClearance(O, T, [f], shot)
        XCTAssertEqual(r.crossings.count, 1)
        XCTAssertEqual(r.crossings[0].status, .clears)
        XCTAssertGreaterThan(r.crossings[0].minClearanceM!, 2)
        XCTAssertFalse(r.crossings[0].landsIn)
        XCTAssertEqual(r.summary.status, .clears)
        XCTAssertEqual(r.summary.worst, r.crossings[0])
        XCTAssertEqual(r.beyondCarry, [])
    }

    func testTallTreesNearOriginBlockWithWorstPointAtEntryEdge() {
        // Ball at d=10 is ~4.6 m up; an 18 m tree wall blocks it.
        let f = trees(10, 30, ["heightP90M": .number(18)])
        let r = treeClearance(O, T, [f], shot)
        XCTAssertEqual(r.crossings[0].status, .blocked)
        XCTAssertLessThan(r.crossings[0].minClearanceM!, 0)
        XCTAssertEqual(r.crossings[0].worstAtM, 10)
        XCTAssertEqual(r.summary.status, .blocked)
    }

    func testMarginalWhenClearanceUnderMarginAndMarginIsConfigurable() {
        // Ball at the apex (124 m) is exactly 30 m; a 28.5 m tree leaves 1.5 m.
        let f = trees(123, 125, ["heightP90M": .number(28.5)])
        let r = treeClearance(O, T, [f], shot)
        XCTAssertEqual(r.crossings[0].status, .marginal)
        XCTAssertGreaterThanOrEqual(r.crossings[0].minClearanceM!, 0)
        XCTAssertLessThan(r.crossings[0].minClearanceM!, 2)
        XCTAssertEqual(
            treeClearance(O, T, [f], shot, TreeClearanceOptions(marginM: 1)).crossings[0].status,
            .clears
        )
    }

    func testHandDrawnTreeWithoutAttributesIsUnknown() {
        let r = treeClearance(O, T, [trees(110, 130)], shot)
        XCTAssertEqual(r.crossings[0].status, .unknown)
        XCTAssertNil(r.crossings[0].minClearanceM)
        XCTAssertNil(r.crossings[0].worstAtM)
        XCTAssertEqual(r.summary.status, .unknown)
        XCTAssertNil(r.summary.worst)
    }

    func testUphillTreeLineLowersClearanceFlatGroundClears() {
        let f = trees(110, 130, ["heightP90M": .number(20)])
        let flat = treeClearance(O, T, [f], shot)
        XCTAssertEqual(flat.crossings[0].status, .clears)

        // 12 m rise at the tree line (10% grade): 20 m trees on 12 m ground vs 30 m ball.
        let uphill = treeClearance(O, T, [f], shot, TreeClearanceOptions(groundAt: { $0 * 0.1 }))
        XCTAssertLessThan(uphill.crossings[0].minClearanceM!, flat.crossings[0].minClearanceM!)
        XCTAssertEqual(uphill.crossings[0].status, .blocked)
    }

    func testOriginGroundDefaultsToGroundAtZeroSoUniformOffsetCancels() {
        let f = trees(110, 130, ["heightP90M": .number(20)])
        let flat = treeClearance(O, T, [f], shot)
        let raised = treeClearance(O, T, [f], shot, TreeClearanceOptions(groundAt: { _ in 250 }))
        XCTAssertEqual(raised.crossings[0].minClearanceM!, flat.crossings[0].minClearanceM!, accuracy: 1e-9)
    }

    func testTreesWhollyBeyondCarryAreBeyondCarryNotCrossings() {
        let f = trees(210, 230, ["heightP90M": .number(18)])
        let r = treeClearance(O, Vec2(x: 300, y: 0), [f], shot)
        XCTAssertEqual(r.crossings, [])
        XCTAssertEqual(r.beyondCarry.count, 1)
        XCTAssertEqual(r.beyondCarry[0].feature, f)
        XCTAssertEqual(r.beyondCarry[0].entryM, 210, accuracy: 1e-9)
        XCTAssertEqual(r.summary.status, .clears)
    }

    func testRingTheBallLandsInIsFlaggedLandsInAndEvaluatedOnlyUpToCarry() {
        let f = trees(190, 230, ["heightP90M": .number(18)])
        let r = treeClearance(O, Vec2(x: 300, y: 0), [f], shot)
        XCTAssertEqual(r.crossings.count, 1)
        XCTAssertTrue(r.crossings[0].landsIn)
        XCTAssertEqual(r.crossings[0].status, .blocked)
        XCTAssertEqual(r.crossings[0].worstAtM, 200)
    }

    func testSummaryPrecedenceAndWorstIsLowestClearance() {
        let low = trees(60, 70, ["heightP90M": .number(5)]) // clears
        let unknown = trees(80, 90) // unknown
        let marginal = trees(123, 125, ["heightP90M": .number(28.5)])
        let wall = trees(150, 160, ["heightP90M": .number(40)]) // blocked

        XCTAssertEqual(treeClearance(O, T, [low], shot).summary.status, .clears)
        XCTAssertEqual(treeClearance(O, T, [low, unknown], shot).summary.status, .unknown)
        XCTAssertEqual(treeClearance(O, T, [low, unknown, marginal], shot).summary.status, .marginal)
        let all = treeClearance(O, T, [low, unknown, marginal, wall], shot)
        XCTAssertEqual(all.summary.status, .blocked)
        XCTAssertEqual(all.summary.worst?.feature, wall)
        XCTAssertEqual(all.crossings.map(\.feature), [low, unknown, marginal, wall])
    }

    func testRealTrajectorySamplesDriveTheEvaluationInsteadOfTheModel() {
        let f = trees(110, 130, ["heightP90M": .number(20)])
        // A flat 5 m flight never clears a 20 m tree even though apexM says 30.
        let flat = [
            TrajectorySample(d: 0, h: 0), TrajectorySample(d: 10, h: 5),
            TrajectorySample(d: 190, h: 5), TrajectorySample(d: 200, h: 0),
        ]
        let r = treeClearance(O, T, [f], TreeClearanceShot(carryM: 200, apexM: 30, samples: flat))
        XCTAssertEqual(r.crossings[0].status, .blocked)
        XCTAssertEqual(r.crossings[0].minClearanceM!, -15, accuracy: 1e-9)
    }

    func testNoTreesAtAllIsAClearSummaryWithNilWorst() {
        let r = treeClearance(O, T, [], shot)
        XCTAssertEqual(
            r,
            TreeClearanceResult(
                crossings: [], beyondCarry: [],
                summary: TreeClearanceResult.Summary(status: .clears, worst: nil)
            )
        )
    }
}
