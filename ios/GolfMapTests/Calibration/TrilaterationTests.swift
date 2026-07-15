import XCTest
@testable import GolfMap

/// Synthetic-geometry tests for the laser trilateration solver (spec §6.3):
/// a known true position, exact distances to fixed features, and a raw fix
/// displaced by a known bias — the solver must recover that bias.
final class TrilaterationTests: XCTestCase {

    private let truePos = Vec2(x: 500_000, y: 6_480_000)
    /// Raw GPS fix = truth displaced by (−3.2, +2.1) — the solved bias must
    /// be the negation's inverse: +3.2 east… i.e. `true − raw = (3.2, −2.1)`.
    private var rawFix: Vec2 { Vec2(x: truePos.x - 3.2, y: truePos.y + 2.1) }

    private func shot(to feature: Vec2) -> Trilateration.Shot {
        let dx = feature.x - truePos.x
        let dy = feature.y - truePos.y
        return Trilateration.Shot(
            featurePlanar: feature,
            laserDistanceM: (dx * dx + dy * dy).squareRoot()
        )
    }

    func testTwoShotsAtRightAngleRecoverExactBias() {
        let shots = [
            shot(to: Vec2(x: truePos.x, y: truePos.y + 150)),   // due north
            shot(to: Vec2(x: truePos.x + 120, y: truePos.y)),   // due east
        ]
        let s = Trilateration.solve(rawFixPlanar: rawFix, shots: shots)!
        XCTAssertEqual(s.biasE, 3.2, accuracy: 0.001)
        XCTAssertEqual(s.biasN, -2.1, accuracy: 0.001)
        XCTAssertEqual(s.rmsResidualM, 0, accuracy: 0.001)
        XCTAssertFalse(s.weakAxis)
    }

    func testThreeShotsOverdetermined() {
        let shots = [
            shot(to: Vec2(x: truePos.x - 90, y: truePos.y + 140)),
            shot(to: Vec2(x: truePos.x + 200, y: truePos.y + 60)),
            shot(to: Vec2(x: truePos.x + 40, y: truePos.y - 180)),
        ]
        let s = Trilateration.solve(rawFixPlanar: rawFix, shots: shots)!
        XCTAssertEqual(s.biasE, 3.2, accuracy: 0.001)
        XCTAssertEqual(s.biasN, -2.1, accuracy: 0.001)
        XCTAssertFalse(s.weakAxis)
    }

    func testContradictoryDistancesReportResidual() {
        // North and south shots BOTH read 0.5 m long: no position can fit
        // both (moving toward one moves away from the other), so the fit
        // splits the error — the bias stays exact and the rms is forced to
        // √((0.5² + 0.5²) / 4) ≈ 0.354. Three shots and two unknowns leave
        // one redundant DOF, which symmetric noise can silently absorb; this
        // opposing-pair design is the honest misfit case.
        var shots = [
            shot(to: Vec2(x: truePos.x, y: truePos.y + 150)),
            shot(to: Vec2(x: truePos.x + 120, y: truePos.y)),
            shot(to: Vec2(x: truePos.x, y: truePos.y - 130)),
            shot(to: Vec2(x: truePos.x - 110, y: truePos.y)),
        ]
        shots[0].laserDistanceM += 0.5
        shots[2].laserDistanceM += 0.5
        let s = Trilateration.solve(rawFixPlanar: rawFix, shots: shots)!
        XCTAssertEqual(s.biasE, 3.2, accuracy: 0.05)
        XCTAssertEqual(s.biasN, -2.1, accuracy: 0.05)
        XCTAssertEqual(s.rmsResidualM, (0.125).squareRoot(), accuracy: 0.05)
        XCTAssertFalse(s.weakAxis)
    }

    func testCollinearFeaturesFlagWeakAxisAndProject() {
        // Both features due north: only the north component is constrained.
        let shots = [
            shot(to: Vec2(x: truePos.x, y: truePos.y + 150)),
            shot(to: Vec2(x: truePos.x, y: truePos.y + 220)),
        ]
        let s = Trilateration.solve(rawFixPlanar: rawFix, shots: shots)!
        XCTAssertTrue(s.weakAxis)
        // North (along-bearing) component recovered; east component dropped
        // by the projection.
        XCTAssertEqual(s.biasN, -2.1, accuracy: 0.05)
        XCTAssertEqual(s.biasE, 0, accuracy: 0.05)
    }

    func testDegenerateInputsReturnNil() {
        // One shot: underdetermined.
        XCTAssertNil(Trilateration.solve(
            rawFixPlanar: rawFix,
            shots: [shot(to: Vec2(x: truePos.x, y: truePos.y + 150))]
        ))
        // Implausibly large bias (mis-identified feature) rejected.
        let far = Trilateration.Shot(
            featurePlanar: Vec2(x: truePos.x, y: truePos.y + 150),
            laserDistanceM: 250
        )
        let far2 = Trilateration.Shot(
            featurePlanar: Vec2(x: truePos.x + 120, y: truePos.y),
            laserDistanceM: 220
        )
        XCTAssertNil(Trilateration.solve(rawFixPlanar: rawFix, shots: [far, far2]))
    }
}
