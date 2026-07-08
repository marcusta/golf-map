import Foundation

/// Wire structs for the green-scan payload contract v1
/// (`docs/reference/green-scan-payload.md`), the body of
/// `POST /api/green-calibration/scans`. The server stores payloads verbatim
/// (schema-agnostic), so THESE structs are the interpretable contract — field
/// names, nesting and units must match the doc exactly. Version every payload;
/// consumers ignore kinds/versions they don't understand.
///
/// Two payload kinds share one envelope:
///  - `spot_level` (task D2) — a single phone-laid-flat IMU level reading.
///  - `corridor`   (task E1) — the out-and-back LiDAR line-walk. The corridor
///    structs are defined here so E1 has the exact shapes ready; D2 only
///    produces `spot_level`.
///
/// The server emits/consumes camelCase JSON, so the property names ARE the
/// wire names — no CodingKeys. All types are `Sendable` value types.

// MARK: - Envelope

/// `kind` discriminator — duplicated in the payload on purpose (the payload
/// must be self-describing when read in bulk). Matches the
/// `'corridor' | 'spot_level'` union in `shared/api/green-calibration.gen.ts`.
public enum GreenScanKind: String, Codable, Sendable, Equatable {
    case spotLevel = "spot_level"
    case corridor
}

/// A WGS84 location with horizontal accuracy — the contract's `location` /
/// `ball` / `hole` shape.
public struct GreenScanLocation: Codable, Sendable, Equatable {
    public var lat: Double
    public var lon: Double
    public var horizontalAccuracyM: Double

    public init(lat: Double, lon: Double, horizontalAccuracyM: Double) {
        self.lat = lat
        self.lon = lon
        self.horizontalAccuracyM = horizontalAccuracyM
    }
}

// MARK: - spot_level payload

/// The `spot_level` payload (v1): envelope fields + one gravity-anchored level
/// reading. Encodes to exactly the contract's `spot_level` object.
///
/// The two `endpointLevels` readings of a `corridor` payload reuse the SAME
/// shape (contract: "`<spot_level-shaped reading at ball>`"), so this is also
/// the corridor endpoint level struct.
public struct SpotLevelPayload: Codable, Sendable, Equatable {
    // Envelope
    public var version: Int
    public var kind: GreenScanKind
    public var capturedAt: String
    public var device: String
    public var appVersion: String

    // spot_level body
    public var location: GreenScanLocation
    /// Tilt magnitude, rise/run × 100.
    public var slopePct: Double
    /// DOWNHILL compass bearing, degrees.
    public var fallLineBearingDeg: Double
    public var sampleDurationS: Double
    public var sampleCount: Int
    /// Std-dev of tilt over the window — settling / refuse signal.
    public var tiltStdDeg: Double
    /// Compass accuracy — the weak link for the bearing; consumer down-weights.
    public var headingAccuracyDeg: Double

    public init(
        version: Int = 1,
        kind: GreenScanKind = .spotLevel,
        capturedAt: String,
        device: String,
        appVersion: String,
        location: GreenScanLocation,
        slopePct: Double,
        fallLineBearingDeg: Double,
        sampleDurationS: Double,
        sampleCount: Int,
        tiltStdDeg: Double,
        headingAccuracyDeg: Double
    ) {
        self.version = version
        self.kind = kind
        self.capturedAt = capturedAt
        self.device = device
        self.appVersion = appVersion
        self.location = location
        self.slopePct = slopePct
        self.fallLineBearingDeg = fallLineBearingDeg
        self.sampleDurationS = sampleDurationS
        self.sampleCount = sampleCount
        self.tiltStdDeg = tiltStdDeg
        self.headingAccuracyDeg = headingAccuracyDeg
    }
}

// MARK: - corridor payload (task E1)

/// A poly2 surface fit over the gravity-frame corridor points. `type` is a
/// switch point: v1 is `"poly2"`; a future `"tps"` may be added — consumers
/// MUST switch on `type` and ignore unknown fits.
public struct CorridorFit: Codable, Sendable, Equatable {
    /// Fit family, e.g. `"poly2"`. Kept as a raw string (not an enum) so an
    /// unknown future type round-trips instead of failing to decode.
    public var type: String
    /// poly2 coefficients [c00, c10, c01, c20, c11, c02] for
    /// h(x,y) = c00 + c10·x + c01·y + c20·x² + c11·xy + c02·y².
    public var coefficients: [Double]
    public var rmseM: Double
    public var corridorWidthM: Double
    public var coverageFrac: Double

    public init(
        type: String,
        coefficients: [Double],
        rmseM: Double,
        corridorWidthM: Double,
        coverageFrac: Double
    ) {
        self.type = type
        self.coefficients = coefficients
        self.rmseM = rmseM
        self.corridorWidthM = corridorWidthM
        self.coverageFrac = coverageFrac
    }
}

/// The local gravity-frame definition: the ball→hole line at scan start.
public struct CorridorFrame: Codable, Sendable, Equatable {
    public var originalLineBearingDeg: Double
    public var lineLengthM: Double

    public init(originalLineBearingDeg: Double, lineLengthM: Double) {
        self.originalLineBearingDeg = originalLineBearingDeg
        self.lineLengthM = lineLengthM
    }
}

/// One directional pass of the out-and-back walk.
public struct CorridorPass: Codable, Sendable, Equatable {
    /// `"out"` or `"back"`.
    public var direction: String
    public var fit: CorridorFit

    public init(direction: String, fit: CorridorFit) {
        self.direction = direction
        self.fit = fit
    }
}

/// The `corridor` payload (v1): the out-and-back LiDAR line-walk. Origin at the
/// BALL anchor, +z up along gravity, +x = horizontal ball→hole direction at
/// scan start, +y left of the line (right-handed). Produced by task E1.
public struct CorridorPayload: Codable, Sendable, Equatable {
    // Envelope
    public var version: Int
    public var kind: GreenScanKind
    public var capturedAt: String
    public var device: String
    public var appVersion: String

    // corridor body
    public var ball: GreenScanLocation
    public var hole: GreenScanLocation
    /// The two static IMU readings bracketing the walk (ball, then hole) — the
    /// free drift check. Reuses the spot_level shape.
    public var endpointLevels: [SpotLevelPayload]
    public var frame: CorridorFrame
    /// Decimated gravity-frame point cloud, ≤ 5000 points, meters: [[x, y, z]].
    public var points: [[Double]]
    /// Combined-pass fit.
    public var fit: CorridorFit
    /// Per-direction fits.
    public var passes: [CorridorPass]
    /// Mean |slope difference| between out and back — THE quality number.
    public var passMismatchSlopePct: Double

    public init(
        version: Int = 1,
        kind: GreenScanKind = .corridor,
        capturedAt: String,
        device: String,
        appVersion: String,
        ball: GreenScanLocation,
        hole: GreenScanLocation,
        endpointLevels: [SpotLevelPayload],
        frame: CorridorFrame,
        points: [[Double]],
        fit: CorridorFit,
        passes: [CorridorPass],
        passMismatchSlopePct: Double
    ) {
        self.version = version
        self.kind = kind
        self.capturedAt = capturedAt
        self.device = device
        self.appVersion = appVersion
        self.ball = ball
        self.hole = hole
        self.endpointLevels = endpointLevels
        self.frame = frame
        self.points = points
        self.fit = fit
        self.passes = passes
        self.passMismatchSlopePct = passMismatchSlopePct
    }
}

// MARK: - quality_json

/// Scan verdict — gates the UI: green = show read, yellow = suggest re-scan,
/// red = refuse. Server rule: only green/yellow count toward calibration
/// (yellow at half weight); red is stored but never used.
public enum GreenScanVerdict: String, Codable, Sendable, Equatable {
    case green
    case yellow
    case red
}

/// The `quality_json` companion to a scan. For `spot_level` the verdict derives
/// from `tiltStdDeg` settling and the mismatch/rmse/coverage fields are omitted
/// (corridor-only); Codable's optional handling drops the nils on encode.
public struct GreenScanQuality: Codable, Sendable, Equatable {
    public var verdict: GreenScanVerdict
    public var passMismatchSlopePct: Double?
    public var rmseM: Double?
    public var coverageFrac: Double?
    public var endpointLevelDeltaPct: Double?

    public init(
        verdict: GreenScanVerdict,
        passMismatchSlopePct: Double? = nil,
        rmseM: Double? = nil,
        coverageFrac: Double? = nil,
        endpointLevelDeltaPct: Double? = nil
    ) {
        self.verdict = verdict
        self.passMismatchSlopePct = passMismatchSlopePct
        self.rmseM = rmseM
        self.coverageFrac = coverageFrac
        self.endpointLevelDeltaPct = endpointLevelDeltaPct
    }
}
