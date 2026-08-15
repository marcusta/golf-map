import Foundation

/// The compact course payload the iPhone app syncs to the watch — everything
/// the watch needs for a full offline round, a few KB per course.
///
/// Compiled into BOTH the iOS app and the watch app (shared source, no
/// framework). Field names are the wire format (JSON via WatchConnectivity
/// file transfer) — additive changes only; never rename or repurpose a key.
public struct WatchCourseBundle: Codable, Sendable, Equatable {
    /// Bump when a breaking change is unavoidable; the watch ignores bundles
    /// with a newer major version than it understands.
    public var formatVersion: Int
    public var courseId: String
    public var name: String
    /// Sorted by hole number.
    public var holes: [WatchHole]
    /// When the phone built this payload (for "synced N days ago" UI).
    public var builtAt: Date

    public init(
        formatVersion: Int = 1,
        courseId: String,
        name: String,
        holes: [WatchHole],
        builtAt: Date
    ) {
        self.formatVersion = formatVersion
        self.courseId = courseId
        self.name = name
        self.holes = holes
        self.builtAt = builtAt
    }

    public static let currentFormatVersion = 1
}

/// One hole. Coordinates are WGS84 `[lat, lon]` pairs (arrays keep the JSON
/// compact; the watch converts at the edge).
public struct WatchHole: Codable, Sendable, Equatable {
    public var number: Int
    public var par: Int
    /// Default tee (lowest sortOrder) — the hole-detection anchor.
    public var tee: [Double]
    public var greenCenter: [Double]
    /// Stored front/back markers when authored (v1 UI ignores them; synced
    /// from day one so adding the front/back view needs no resync).
    public var greenFront: [Double]?
    public var greenBack: [Double]?
    /// Outer ring of the green polygon, `[[lat, lon], …]` — the future
    /// player-relative front/back + mini green map. Nil when unauthored.
    public var greenPolygon: [[Double]]?
    /// Fine elevation grid over the green + apron (~1 m cells) — plays-like
    /// green-side elevation. Nil when the phone had no terrain coverage.
    public var greenGrid: WatchElevationGrid?
    /// Coarse elevation grid over the playing corridor (~12 m cells,
    /// tee→aims→green) — the player-side elevation for plays-like.
    public var corridorGrid: WatchElevationGrid?
    /// Phone-pre-rendered slope shading of the green (the mini green map).
    public var greenImage: WatchGreenImage?

    public init(
        number: Int,
        par: Int,
        tee: [Double],
        greenCenter: [Double],
        greenFront: [Double]? = nil,
        greenBack: [Double]? = nil,
        greenPolygon: [[Double]]? = nil,
        greenGrid: WatchElevationGrid? = nil,
        corridorGrid: WatchElevationGrid? = nil,
        greenImage: WatchGreenImage? = nil
    ) {
        self.number = number
        self.par = par
        self.tee = tee
        self.greenCenter = greenCenter
        self.greenFront = greenFront
        self.greenBack = greenBack
        self.greenPolygon = greenPolygon
        self.greenGrid = greenGrid
        self.corridorGrid = corridorGrid
        self.greenImage = greenImage
    }
}

extension WatchCourseBundle {
    /// Stable filename for this course's synced bundle on both sides.
    public var fileName: String { Self.fileName(courseId: courseId) }
    public static func fileName(courseId: String) -> String {
        "watch-course-\(courseId).json"
    }
}
