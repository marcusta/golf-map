import Foundation

/// Pure scorecard aggregation over the recorded strokes of one round
/// (docs/feature-shot-capture.md §2: a shot row = one stroke; penalties ride
/// on the stroke that caused them, so a hole's score is
/// `rows + Σ penaltyStrokes`). No I/O — built from the in-memory shot list.
struct Scorecard: Equatable, Sendable {

    /// One hole line. Holes without strokes are "not played" (`strokes == 0`)
    /// and excluded from the vs-par totals — an in-progress round must not
    /// read as 18 holes under par.
    struct HoleLine: Equatable, Sendable, Identifiable {
        let holeNumber: Int
        let par: Int
        /// Recorded stroke rows on the hole.
        let strokes: Int
        /// Rows with `shotType == .putt`.
        let putts: Int
        /// Σ `penaltyStrokes` across the hole's rows.
        let penalties: Int

        var id: Int { holeNumber }
        var played: Bool { strokes > 0 }
        /// The hole's score: strokes + penalty strokes.
        var score: Int { strokes + penalties }
        /// Score − par; nil when the hole hasn't been played.
        var vsPar: Int? { played ? score - par : nil }
    }

    /// Aggregate over a subset of lines (front nine / back nine / total).
    struct Summary: Equatable, Sendable {
        let holesPlayed: Int
        let score: Int
        let putts: Int
        let penalties: Int
        /// Σ vsPar over PLAYED holes; nil when none are played.
        let vsPar: Int?
    }

    /// All course holes in number order (played or not).
    let lines: [HoleLine]

    /// Holes 1–9.
    var front: Summary { summarize(lines.filter { $0.holeNumber <= 9 }) }
    /// Holes 10–18.
    var back: Summary { summarize(lines.filter { $0.holeNumber > 9 }) }
    var total: Summary { summarize(lines) }

    func line(holeNumber: Int) -> HoleLine? {
        lines.first { $0.holeNumber == holeNumber }
    }

    private func summarize(_ subset: [HoleLine]) -> Summary {
        let played = subset.filter(\.played)
        return Summary(
            holesPlayed: played.count,
            score: played.reduce(0) { $0 + $1.score },
            putts: played.reduce(0) { $0 + $1.putts },
            penalties: played.reduce(0) { $0 + $1.penalties },
            vsPar: played.isEmpty ? nil : played.reduce(0) { $0 + ($1.vsPar ?? 0) }
        )
    }

    /// Builds the card from the course's holes + the round's live strokes.
    /// Strokes on hole numbers the course doesn't know are ignored (can only
    /// happen with corrupted data).
    static func build(holes: [HoleRecord], shots: [ShotRecord]) -> Scorecard {
        let byHole = Dictionary(grouping: shots, by: \.holeNumber)
        let lines = holes
            .sorted { $0.number < $1.number }
            .map { hole -> HoleLine in
                let holeShots = byHole[hole.number] ?? []
                return HoleLine(
                    holeNumber: hole.number,
                    par: hole.par,
                    strokes: holeShots.count,
                    putts: holeShots.filter { $0.shotType == .putt }.count,
                    penalties: holeShots.reduce(0) { $0 + $1.penaltyStrokes }
                )
            }
        return Scorecard(lines: lines)
    }

    /// "+3" / "−2" / "E" formatting for a vs-par figure.
    static func formatVsPar(_ value: Int?) -> String {
        guard let value else { return "–" }
        if value == 0 { return "E" }
        return value > 0 ? "+\(value)" : "\(value)"
    }
}
