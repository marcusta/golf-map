import XCTest
@testable import GolfMap

/// Golden table for the deterministic pin-placement voice grammar
/// (docs/feature-laser-pin-and-calibration.md §4.2). Covers every example in
/// the spec table, both languages per mode, digit and number-word variants,
/// the "middle right" combo fractions, modifier pushes, ranking of ambiguous
/// readings, and no-parse garbage.
///
/// Expected fractions are computed through `PinWordFractions` (never literals)
/// so the goldens track the constants bit-for-bit — the same arithmetic the
/// parser runs.
final class PinPhraseParserTests: XCTestCase {

    // Fraction shorthands, all via the single source of truth.
    private let near = PinWordFractions.near          // 0.15
    private let middle = PinWordFractions.middle      // 0.5
    private let far = PinWordFractions.far            // 0.85
    private let nearEdge = PinWordFractions.nearEdge  // 0.05
    private let farEdge = PinWordFractions.farEdge    // 0.95
    private var middleRight: Double { (PinWordFractions.middle + PinWordFractions.far) / 2 }   // 0.675
    private var middleLeft: Double { (PinWordFractions.middle + PinWordFractions.near) / 2 }   // 0.325

    private typealias Row = (line: UInt, text: String, locale: PinVoiceLocale, expected: [PinPhrase])

    func testGoldenTable() {
        let rows: [Row] = [
            // ── Sheet mode (two numeric clauses, front + left) ──
            (#line, "pin is 4 from front, 5 from left", .english,
             [.sheet(depthFromFrontM: 4, lateralFromLeftM: 5)]),
            (#line, "4.5 from front, 3 from left", .english,
             [.sheet(depthFromFrontM: 4.5, lateralFromLeftM: 3)]),
            (#line, "pinnen 4 från framkant, 5 från vänster", .swedish,
             [.sheet(depthFromFrontM: 4, lateralFromLeftM: 5)]),
            // Swedish decimal comma.
            (#line, "4,5 från framkant, 3 från vänster", .swedish,
             [.sheet(depthFromFrontM: 4.5, lateralFromLeftM: 3)]),

            // ── Hybrid mode (front depth number + word lateral) ──
            (#line, "6 from front, middle right", .english,
             [.hybrid(depthFromFrontM: 6, lateralFraction: middleRight)]),
            (#line, "flaggan 6 från framkant, mitten höger", .swedish,
             [.hybrid(depthFromFrontM: 6, lateralFraction: middleRight)]),
            // Swedish number word bound to a from-front clause.
            (#line, "sju från framkant, mitten vänster", .swedish,
             [.hybrid(depthFromFrontM: 7, lateralFraction: middleLeft)]),
            // "N from front" alone → lateral defaults to middle.
            (#line, "pin 4 from front", .english,
             [.hybrid(depthFromFrontM: 4, lateralFraction: middle)]),

            // ── Laser mode (bare number ≥ 40 + optional side) ──
            (#line, "one forty three, right", .english,
             [.laser(distanceM: 143, lateralFraction: far)]),
            (#line, "143 right", .english,
             [.laser(distanceM: 143, lateralFraction: far)]),
            (#line, "one hundred and forty three", .english,
             [.laser(distanceM: 143, lateralFraction: nil)]),
            (#line, "hundred and forty three, left", .english,
             [.laser(distanceM: 143, lateralFraction: near)]),
            (#line, "a hundred", .english,
             [.laser(distanceM: 100, lateralFraction: nil)]),
            (#line, "143 meters left", .english,
             [.laser(distanceM: 143, lateralFraction: near)]),
            (#line, "45", .english,
             [.laser(distanceM: 45, lateralFraction: nil)]),
            (#line, "hundratrettionio, vänster", .swedish,
             [.laser(distanceM: 139, lateralFraction: near)]),
            (#line, "etthundrafyrtiotre, höger", .swedish,
             [.laser(distanceM: 143, lateralFraction: far)]),
            (#line, "143 höger", .swedish,
             [.laser(distanceM: 143, lateralFraction: far)]),
            (#line, "fyrtiofem", .swedish,
             [.laser(distanceM: 45, lateralFraction: nil)]),

            // ── Visual mode (no numbers, only words) ──
            (#line, "close to back, far left", .english,
             [.visual(depthFraction: farEdge, lateralFraction: nearEdge)]),
            (#line, "nära bak, långt vänster", .swedish,
             [.visual(depthFraction: farEdge, lateralFraction: nearEdge)]),
            (#line, "close to front, far right", .english,
             [.visual(depthFraction: nearEdge, lateralFraction: farEdge)]),
            (#line, "middle right", .english,
             [.visual(depthFraction: middle, lateralFraction: middleRight)]),
            (#line, "middle left", .english,
             [.visual(depthFraction: middle, lateralFraction: middleLeft)]),
            (#line, "far right", .english,
             [.visual(depthFraction: middle, lateralFraction: farEdge)]),
            (#line, "long right", .swedish,
             [.visual(depthFraction: middle, lateralFraction: farEdge)]),
            (#line, "left", .english,
             [.visual(depthFraction: middle, lateralFraction: near)]),
            (#line, "back", .english,
             [.visual(depthFraction: far, lateralFraction: middle)]),
            (#line, "mitten", .swedish,
             [.visual(depthFraction: middle, lateralFraction: middle)]),

            // ── Small-number laser (implausible, still a single candidate) ──
            (#line, "30", .english,
             [.laser(distanceM: 30, lateralFraction: nil)]),

            // ── No parse ──
            (#line, "hello world", .english, []),
            (#line, "the pin", .english, []),
            (#line, "hej på dig", .swedish, []),
            (#line, "", .english, []),
        ]

        for row in rows {
            let got = PinPhraseParser.parse(row.text, locale: row.locale)
            XCTAssertEqual(
                got, row.expected,
                "parse(\"\(row.text)\", \(row.locale)) mismatch",
                line: row.line
            )
        }
    }

    /// Rule 5 ranking: a bare number < 40 with no context is an implausible
    /// laser and must rank AFTER a word-based reading. Here the from-front
    /// depth clause yields a hybrid that must precede the small-number laser.
    func testSmallNumberLaserRanksAfterWordCandidate() {
        let got = PinPhraseParser.parse("6 from front, 20", locale: .english)
        XCTAssertEqual(got, [
            .hybrid(depthFromFrontM: 6, lateralFraction: middle),
            .laser(distanceM: 20, lateralFraction: nil),
        ])
    }

    /// A large bare number alongside a front-depth clause: both are plausible,
    /// the depth reading ranks first, the laser second.
    func testFrontClauseAndLaserBothEmittedRanked() {
        let got = PinPhraseParser.parse("6 from front, 143", locale: .english)
        XCTAssertEqual(got, [
            .hybrid(depthFromFrontM: 6, lateralFraction: middle),
            .laser(distanceM: 143, lateralFraction: nil),
        ])
    }

    /// "N from right" / "N from back" numeric clauses have no representation in
    /// `PinPhrase` (documented) — they yield no candidate rather than a wrong one.
    func testUnrepresentableNumericClausesReturnEmpty() {
        XCTAssertEqual(PinPhraseParser.parse("4 from front, 5 from right", locale: .english), [])
        XCTAssertEqual(PinPhraseParser.parse("4 from back, 5 from left", locale: .english), [])
    }

    /// Digits are the primary path and must win identically across locales.
    func testDigitsAreLocaleIndependent() {
        let en = PinPhraseParser.parse("143 left", locale: .english)
        let sv = PinPhraseParser.parse("143 vänster", locale: .swedish)
        XCTAssertEqual(en, [.laser(distanceM: 143, lateralFraction: near)])
        XCTAssertEqual(sv, [.laser(distanceM: 143, lateralFraction: near)])
    }

    /// The one-laser entry does not own a second voice-number grammar: its
    /// extraction API must reuse the exact PinPhraseParser digit/word path.
    func testLaserDistanceReusesPinPhraseNumericPath() {
        let rows: [(String, PinVoiceLocale, Double)] = [
            ("143", .english, 143),
            ("one forty three", .english, 143),
            ("etthundrafyrtiotre", .swedish, 143),
            ("4,5", .swedish, 4.5),
        ]
        for (text, locale, expected) in rows {
            XCTAssertEqual(PinPhraseParser.laserDistance(text, locale: locale), expected)
            let parsed = PinPhraseParser.parse(text, locale: locale)
            XCTAssertTrue(parsed.contains { phrase in
                guard case let .laser(distance, _) = phrase else { return false }
                return distance == expected
            })
        }
        XCTAssertNil(PinPhraseParser.laserDistance("not a number", locale: .english))
    }
}
