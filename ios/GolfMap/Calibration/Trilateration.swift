import Foundation

/// Solves the GPS bias from laser shots at fixed, mapped features
/// (docs/feature-laser-pin-and-calibration.md §6.3).
///
/// Each shot constrains the player's true position along one bearing (1D);
/// the GPS offset is 2D, so ≥ 2 shots with angular spread are required.
/// Gauss–Newton over `r_i = |p − f_i| − d_i` with 2 unknowns, seeded at the
/// raw fix — the bias is metres, far inside the basin of the correct
/// circle-intersection root.
enum Trilateration {

    struct Shot: Equatable, Sendable {
        /// The mapped feature's planar (EPSG:3006) position.
        var featurePlanar: Vec2
        /// The lasered distance to it, metres.
        var laserDistanceM: Double
    }

    struct Solution: Equatable, Sendable {
        /// The solved true position.
        var positionPlanar: Vec2
        /// `positionPlanar − rawFix` — ADD to raw fixes to correct them.
        var biasE: Double
        var biasN: Double
        /// RMS of the post-fit residuals, metres — the calibration's base
        /// confidence input (large = inconsistent shots or a moved feature).
        var rmsResidualM: Double
        /// True when the shots' angular spread constrained only one axis
        /// (spec: < ~25°). The delta was projected onto the well-constrained
        /// direction; the caller must assign low confidence.
        var weakAxis: Bool
    }

    enum Tuning {
        /// λ_min/n of the normal matrix below this ⇒ weak axis. For two
        /// shots this corresponds to ~25° of bearing spread.
        static let minEigenFraction = 0.05
        static let maxIterations = 12
        /// Convergence: step shorter than this stops iterating.
        static let stepEpsilonM = 1e-4
        /// A solved bias beyond this is not a GPS bias — reject (a feature
        /// was misidentified or a distance misheard).
        static let maxPlausibleBiasM = 15.0
    }

    /// `nil` for < 2 shots, a shot on top of a feature, divergence, or an
    /// implausibly large solution.
    static func solve(rawFixPlanar: Vec2, shots: [Shot]) -> Solution? {
        guard shots.count >= 2 else { return nil }

        var p = rawFixPlanar
        for _ in 0..<Tuning.maxIterations {
            // Normal equations: (JᵀJ + εI) δ = −Jᵀr, J rows = unit vectors
            // feature→position.
            var a11 = 0.0, a12 = 0.0, a22 = 0.0
            var b1 = 0.0, b2 = 0.0
            for shot in shots {
                let dx = p.x - shot.featurePlanar.x
                let dy = p.y - shot.featurePlanar.y
                let dist = (dx * dx + dy * dy).squareRoot()
                guard dist > 1 else { return nil }
                let ux = dx / dist
                let uy = dy / dist
                let r = dist - shot.laserDistanceM
                a11 += ux * ux
                a12 += ux * uy
                a22 += uy * uy
                b1 -= ux * r
                b2 -= uy * r
            }
            let damping = 1e-9 * (a11 + a22)
            a11 += damping
            a22 += damping
            let det = a11 * a22 - a12 * a12
            guard det > 1e-12 else { return nil }
            let stepX = (b1 * a22 - b2 * a12) / det
            let stepY = (b2 * a11 - b1 * a12) / det
            p = Vec2(x: p.x + stepX, y: p.y + stepY)
            if (stepX * stepX + stepY * stepY).squareRoot() < Tuning.stepEpsilonM { break }
        }

        // Post-fit geometry check: eigenvalues of the (undamped) normal
        // matrix at the solution.
        var a11 = 0.0, a12 = 0.0, a22 = 0.0
        var sumSq = 0.0
        for shot in shots {
            let dx = p.x - shot.featurePlanar.x
            let dy = p.y - shot.featurePlanar.y
            let dist = (dx * dx + dy * dy).squareRoot()
            guard dist > 1 else { return nil }
            let ux = dx / dist
            let uy = dy / dist
            let r = dist - shot.laserDistanceM
            a11 += ux * ux
            a12 += ux * uy
            a22 += uy * uy
            sumSq += r * r
        }
        let mean = (a11 + a22) / 2
        let spread = (((a11 - a22) / 2) * ((a11 - a22) / 2) + a12 * a12).squareRoot()
        let lambdaMin = mean - spread
        let n = Double(shots.count)

        var biasX = p.x - rawFixPlanar.x
        var biasY = p.y - rawFixPlanar.y
        var weakAxis = false
        if lambdaMin / n < Tuning.minEigenFraction {
            // Project the delta onto the dominant eigenvector — report only
            // the well-constrained component (spec §6.3).
            weakAxis = true
            let lambdaMax = mean + spread
            // Eigenvector of the 2×2 symmetric matrix for λ_max.
            var vx = a12
            var vy = lambdaMax - a11
            if abs(vx) < 1e-12, abs(vy) < 1e-12 {
                vx = lambdaMax - a22
                vy = a12
            }
            let len = (vx * vx + vy * vy).squareRoot()
            guard len > 1e-12 else { return nil }
            vx /= len
            vy /= len
            let along = biasX * vx + biasY * vy
            biasX = along * vx
            biasY = along * vy
            p = Vec2(x: rawFixPlanar.x + biasX, y: rawFixPlanar.y + biasY)
        }

        guard (biasX * biasX + biasY * biasY).squareRoot() <= Tuning.maxPlausibleBiasM else {
            return nil
        }

        return Solution(
            positionPlanar: p,
            biasE: biasX,
            biasN: biasY,
            rmsResidualM: (sumSq / n).squareRoot(),
            weakAxis: weakAxis
        )
    }
}
