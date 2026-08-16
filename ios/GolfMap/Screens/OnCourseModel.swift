import Foundation
import Observation

/// Backs the on-course screen: current hole navigation, per-hole furniture
/// lookups, active-tee selection (persisted per course), the live GPS fix +
/// elevations, and every derived output the UI needs (distances, playing
/// length, map overlays, camera command).
///
/// Constructed from a `CourseFurniture` snapshot (no database dependency) so
/// tests can drive it with synthetic fixtures. Terrain elevation sampling is
/// injected as a closure (`elevationSampler`) for the same reason.
@MainActor
@Observable
final class OnCourseModel {

    /// Everything for one hole, joined from the flat furniture arrays.
    struct HoleData: Identifiable {
        let hole: HoleRecord
        /// Sorted by `sortOrder`.
        let tees: [TeeRecord]
        let green: GreenRecord?
        let pins: [PinRecord]
        /// Sorted by `sortOrder`.
        let aimPoints: [AimPointRecord]
        var id: String { hole.id }
    }

    let courseId: String
    let courseName: String
    /// Tile-manifest coverage bounds — the plausibility fence for the live GPS
    /// fix (`isFarFromCourse`).
    private let courseBounds: MapCoordinateBounds
    /// Holes sorted by number.
    private(set) var holes: [HoleData]

    private(set) var currentHoleIndex = 0
    /// Bumped whenever the camera should re-apply (hole change, recenter).
    private(set) var cameraToken = 0

    /// Distance-ladder tap focus: when set, `cameraCommand` centers here instead
    /// of the hole fit, until the next `recenter()` or hole change. Reversible —
    /// the user's own pan afterwards is left alone (the command applies once).
    private(set) var mapFocus: LatLon?
    /// The ladder-rail row currently selected (drives the rail's highlight);
    /// cleared with `mapFocus`.
    private(set) var focusedLadderId: String?

    /// Per-tap relative zoom step + token for the +/- zoom buttons. Drives
    /// `MapZoomCommand` imperatively (applied on top of the map's *current* zoom
    /// level) so a tap never triggers a hole re-fit. `token` forces re-apply so
    /// two taps of the same button (identical `delta`) both register.
    private(set) var zoomStep = 0.0
    private(set) var zoomToken = 0

    /// Latest GPS fix; nil = no fix yet / denied → tee-based fallback.
    private(set) var userLocation: LatLon?
    /// Terrain-sampled elevation at `userLocation` (plays-like input).
    private(set) var userElevation: Double?
    /// Transient arbitrary origin selected while GPS is off. Nil means the
    /// active tee remains the browse origin. Never persisted into course data.
    private(set) var browseOrigin: LatLon?
    /// Terrain elevation sampled at `browseOrigin` for plays-like yardages.
    private(set) var browseOriginElevation: Double?
    /// The tapped course shape's inspection state: the banner row payload
    /// (`carry`) plus the geometry the map overlay highlights — the tapped
    /// ring outline and the two play-line points the front/carry figures
    /// measure to.
    struct InspectedFeature: Equatable {
        /// Label/kind/front/carry/side/centroid — the banner row payload.
        var carry: HazardCarry
        /// Tapped ring outline (WGS84) — the map highlight polygon.
        var ring: [LatLon]
        /// Measured near-edge point (WGS84) — on the ring boundary in ray
        /// mode, on the chosen line in browse-to mode.
        var frontPoint: LatLon
        /// Measured far-edge point (WGS84) — same anchoring as `frontPoint`.
        var carryPoint: LatLon
        /// The KEPT browse-to point whose origin→point line the figures were
        /// measured along; nil = ray mode (origin → tap through the shape).
        var lineTo: LatLon?
        /// The tapped planar ring itself — identity for the two-stage tap (a
        /// second tap inside the SAME ring converts to a point inspect).
        var sourceRing: FlatRing
    }

    /// The tapped course shape (bunker / water / green / trees / …) currently
    /// inspected: its near ("front") / far ("carry") extent along the play
    /// line from the current origin. Unlike `browseTarget` this works in GPS
    /// mode too — the readout is FROM the live fix.
    private(set) var inspectedFeature: InspectedFeature?
    /// Transient arbitrary point being inspected FROM the current browse
    /// origin. It becomes the origin only after explicit promotion.
    private(set) var browseTarget: LatLon?
    /// Terrain elevation sampled at `browseTarget` for its advice readout.
    private var browseTargetElevation: Double?
    /// Set from `LocationProvider.isDenied` so the UI can explain the fallback.
    var isLocationDenied = false

    /// Active GPS-bias calibration (spec §6 / decision L4), applied additively
    /// to the live fix in `effectiveUserLocation`. Nil = uncalibrated (raw GPS).
    ///
    /// NOT persisted across app restarts: a calibration captures the slow
    /// common-mode GPS bias, which is only trustworthy for minutes (spec §6.4).
    /// A calibration reloaded next session would be stale by definition, so it
    /// lives only in memory — re-solve (anchor / trilateration) each session.
    private(set) var originCalibration: OriginCalibration?

    /// Most recent fixed-feature laser read. It stays on the card for the hole
    /// even when the residual refresh itself was silent (R7), so every mapped
    /// shot still gives the player the free plain carry comparison.
    private(set) var lastLaserCarryCheck: LaserCarryCheck?

    /// App-level competition mode (DMD rule: distance only). Mirrored from
    /// `AppSettings` by the screen; when true, `distances` omits the slope-
    /// adjusted plays-like figures. Straight distances are unchanged.
    var competitionMode = false

    /// Selected tee name (persisted); nil = per-hole default (lowest sortOrder).
    private(set) var activeTeeName: String?

    /// The course's game plan (read-only, built on the web), loaded from the
    /// GRDB cache by the screen; nil = no plan → no plan UI anywhere.
    private(set) var plan: CoursePlan?

    /// The player's cached club bag (user-level, not per course), loaded from
    /// GRDB by the screen alongside the plan. Drives the distance card's club
    /// advice and the plan legs' suggested-club fallback. Empty = no advice.
    private(set) var clubs: [ClubRecord] = []

    /// Course hazard rings (bunker / water / penalty), EPSG:3006, parsed once
    /// from features.geojson by the screen. Feed the distance card's hazard
    /// carry rows (Part A) and the caddy context. Course-level (not per-hole) —
    /// the along-line query filters by geometry.
    @ObservationIgnored private var hazardRings: [FlatRing] = []
    /// Owning hole id per `hazardRings` entry (parallel), nil = course-level.
    @ObservationIgnored private var hazardHoleIds: [String?] = []
    /// Planar bbox per `hazardRings` entry (parallel), precomputed in `setHazards`
    /// so the carry pipeline can reject rings nowhere near the shot lines before
    /// the O(vertices) `nearLines`/ownership scans. `FlatRing` is parity-pinned
    /// (mirrors shared TS + golden fixtures), so the bboxes live here, not on it.
    @ObservationIgnored private var hazardBBoxes: [BBox] = []
    /// Bumped on every `setHazards` install; keys the `hazardCarries` memo so a
    /// re-install invalidates it without comparing the whole ring array.
    @ObservationIgnored private var hazardsVersion = 0

    /// Every course SURFACE ring (fairway/green/rough/bunker/water/…), EPSG:3006,
    /// TOPMOST-FIRST, parsed once from features.geojson by the screen. Feeds the
    /// shot-viz aim optimiser's lie classification (`PlanStrategy` → `optimizeAim`).
    /// Wider than `hazardRings` (which is the carry-hazard subset for the card).
    @ObservationIgnored private(set) var surfaces: [FlatRing] = []
    /// Planar bbox per `surfaces` entry (parallel), precomputed in `setSurfaces`
    /// so `lieAt` can reject rings whose box excludes the query point before the
    /// full `pointInRing` vertex walk — topmost-first order is preserved (the
    /// box only skips rings that cannot contain the point, never reorders).
    @ObservationIgnored private var surfaceBBoxes: [BBox] = []
    /// Bumped on every `setSurfaces` install; keys the `ladderRows` memo's layup
    /// lie filter without comparing the whole surface array.
    @ObservationIgnored private var surfacesVersion = 0

    /// Memoised shot-viz geometry (dispersion ellipses / ghost aim / confidence
    /// tints) + the input fingerprint it was built from. `optimizeAim` is too
    /// heavy to run on the per-body reactive path, so `planOverlay` reuses this
    /// unless the plan / hole / wind / bag / surfaces change (see
    /// `strategyGeometryForCurrentHole`). Never touched on the pan/gesture path.
    @ObservationIgnored private var strategyKey: StrategyKey?
    @ObservationIgnored private var strategyGeometry: PlanStrategy.Geometry = .empty
    /// Smart-caddy advice memo, keyed on the strategy enrich count so it
    /// recomputes only when the plan geometry does (never per SwiftUI render).
    @ObservationIgnored private var caddyAdviceKey: Int?
    @ObservationIgnored private var caddyAdviceCache: [CaddyAdvice] = []

    // MARK: - Reactive-path memos (per-tap render fan-out)
    //
    // A single map tap mutates observed state (`browseTarget` / `mapFocus`) and
    // then, a beat later, `browseTargetElevation` — each re-renders the on-course
    // view tree. `ladderRows` and `hazardCarries` are read several times per
    // render (rail + banner + ellipse + wind-hold) and each does course-wide
    // O(rings × holes) work, so without memoisation one tap ran that work a dozen
    // times. Each memo below stores its result plus an Equatable fingerprint of
    // every input it read; on access it rebuilds the fingerprint (cheap) and
    // reuses the cache when it matches. The fingerprint is self-invalidating — it
    // captures values (or an install-bumped version for the big ring arrays), so
    // no mutation site has to remember to clear anything. Storage is
    // `@ObservationIgnored` so writing the cache never trips SwiftUI observation.

    /// An axis-aligned planar (EPSG:3006) bounding box for spatial prefiltering.
    private struct BBox: Equatable {
        var minX: Double
        var minY: Double
        var maxX: Double
        var maxY: Double
        func contains(_ p: Vec2) -> Bool {
            p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
        }
        func intersects(_ other: BBox) -> Bool {
            minX <= other.maxX && maxX >= other.minX && minY <= other.maxY && maxY >= other.minY
        }
    }

    private static func bbox(_ points: [Vec2]) -> BBox {
        guard let first = points.first else {
            // Degenerate (empty) ring → inverted box: never contains/intersects.
            return BBox(minX: .infinity, minY: .infinity, maxX: -.infinity, maxY: -.infinity)
        }
        var b = BBox(minX: first.x, minY: first.y, maxX: first.x, maxY: first.y)
        for p in points.dropFirst() {
            b.minX = min(b.minX, p.x); b.minY = min(b.minY, p.y)
            b.maxX = max(b.maxX, p.x); b.maxY = max(b.maxY, p.y)
        }
        return b
    }

    private static func expanded(_ b: BBox, by pad: Double) -> BBox {
        BBox(minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad)
    }

    /// Everything the all-holes routed geometry (`holeRoutePlanar`) reads: the
    /// active tee name and every Adjust override, by value. Any tee/aim/green
    /// move changes it, invalidating the route cache and the hazard memo without
    /// a per-site dirty flag.
    private struct RouteFingerprint: Equatable {
        var activeTeeName: String?
        var teeOverrides: [String: [String: LatLon]]
        var aimOverrides: [String: [String: LatLon]]
        var greenOverrides: [String: LatLon]
    }

    private func routeFingerprint() -> RouteFingerprint {
        RouteFingerprint(
            activeTeeName: activeTeeName,
            teeOverrides: teeOverrides,
            aimOverrides: aimOverrides,
            greenOverrides: greenOverrides
        )
    }

    /// Per-hole planar route cache, keyed by `RouteFingerprint`. `hazardsByOwnership`
    /// projects every hole's route to classify untagged rings; those routes are
    /// stable across taps / GPS fixes and only move when a tee/aim/green does.
    @ObservationIgnored private var routeCacheFingerprint: RouteFingerprint?
    @ObservationIgnored private var routeCache: [String: [Vec2]] = [:]

    private func cachedHoleRoutePlanar(for hole: HoleData) -> [Vec2] {
        let fp = routeFingerprint()
        if fp != routeCacheFingerprint {
            routeCache.removeAll(keepingCapacity: true)
            routeCacheFingerprint = fp
        }
        if let cached = routeCache[hole.id] { return cached }
        let pts = holeRoutePlanar(for: hole)
        routeCache[hole.id] = pts
        return pts
    }

    /// Fingerprint of every input `hazardCarries` reads.
    private struct HazardKey: Equatable {
        var origin: LatLon
        var holeIndex: Int
        var greenCenter: LatLon?
        var nextAim: LatLon?
        var route: RouteFingerprint
        var hazardsVersion: Int
    }
    @ObservationIgnored private var hazardCarriesKey: HazardKey?
    @ObservationIgnored private var hazardCarriesCache: [HazardCarry] = []
    /// Count of full `hazardCarries` rebuilds (cache misses). Behaviour-neutral
    /// instrumentation the memo tests assert on; `@ObservationIgnored`.
    @ObservationIgnored private(set) var hazardCarriesBuildCount = 0

    /// Fingerprint of every input `ladderRows` reads.
    private struct LadderKey: Equatable {
        var origin: LatLon
        var distances: OnCourseDistances
        var targets: HoleTargets
        var planShots: [String]
        var competitionMode: Bool
        var clubs: [String]
        var hazards: [HazardCarry]
        var surfacesVersion: Int
    }
    @ObservationIgnored private var ladderRowsKey: LadderKey?
    @ObservationIgnored private var ladderRowsCache: [LadderRow] = []
    /// Count of full `ladderRows` rebuilds (cache misses). Behaviour-neutral
    /// instrumentation the memo tests assert on; `@ObservationIgnored`.
    @ObservationIgnored private(set) var ladderRowsBuildCount = 0

    /// Fingerprint of every input `selectedTargetVisualization` reads (the club is
    /// resolved from `clubName` to its carry/dispersion so a bag edit invalidates).
    private struct VisualizationKey: Equatable {
        var kind: LadderRow.Kind
        var origin: LatLon
        var target: LatLon
        var clubName: String
        var clubCarryM: Double
        var clubDispersionM: Double
        var elevationDeltaM: Int?
        var windSpeed: Double?
        var windDir: Double?
        var competitionMode: Bool
    }
    @ObservationIgnored private var visualizationKey: VisualizationKey?
    @ObservationIgnored private var visualizationCache: SelectedTargetVisualization?

    /// The bag fingerprint the ladder / visualization memos key on (id + carry +
    /// dispersion — the fields the layup, club naming and ellipse math read).
    private func clubsFingerprint() -> [String] {
        clubs.map { "\($0.id):\($0.carryM):\($0.dispersionM)" }
    }

    /// User-controllable plan-overlay switch (persisted per course, default
    /// ON, like `activeTeeName`). Only affects the MAP overlay — the distance
    /// card's plan row follows the plan itself.
    private(set) var planVisible: Bool

    /// User-controllable GPS switch (persisted per course, default ON). When
    /// off, the screen is in *browse* mode: `userLocation` is ignored, origin
    /// is the active tee, and the distance line follows the full hole route.
    private(set) var gpsEnabled: Bool

    /// Distance (m) beyond which GPS mode routes the primary distance line to
    /// the next aim ahead instead of the green. Persisted; default 230.
    private(set) var aimRoutingThresholdMeters: Double

    /// Per-(hole, tee) local tee-position overrides, loaded from `defaults`.
    /// Keyed by `hole.id` → tee name → moved position.
    private var teeOverrides: [String: [String: LatLon]] = [:]
    /// Per-hole aim-point overrides (Adjust mode), `hole.id` → aim record id →
    /// moved position.
    private var aimOverrides: [String: [String: LatLon]] = [:]
    /// Per-hole green-center overrides (Adjust mode), keyed by `hole.id`.
    /// Moves the CENTER target only — front/back markers and the
    /// green-analysis polygon keep their stored positions.
    private var greenOverrides: [String: LatLon] = [:]

    /// Today's-pin override for one hole (spec §5 / L3): the placed pin plus the
    /// input mode it came from. A pin is an ephemeral daily fact, so it persists
    /// per course + hole stamped with the local calendar day and is dropped on
    /// load once that day has passed (see `loadPinOverrides`).
    struct PinOverride: Equatable, Sendable {
        var position: LatLon
        var source: PinSpec.Source
    }
    /// Per-hole today's-pin overrides, keyed by `hole.id`. Wins over the
    /// furniture active pin in `targets`; loaded from `defaults` (today only).
    private(set) var pinOverrides: [String: PinOverride] = [:]

    /// Terrain elevation sampler (bundle terrain tiles); injected by the
    /// screen, stubbed in tests. Used for the user position and as a fallback
    /// for greens without a stored elevation. Injection happens AFTER `init`
    /// (where the sampler is still nil, so the constructor's sweep is a no-op),
    /// so priming the ladder cache is deferred to here.
    @ObservationIgnored var elevationSampler: (@Sendable (LatLon) async -> Double?)? {
        // Injection after init always primes the ladder-elevation cache — init's
        // own sweep ran while this was nil.
        didSet { refreshLadderElevations(force: true) }
    }

    @ObservationIgnored private let defaults: UserDefaults
    /// Injectable clock — the ONLY source of "now" for the daily pin-override
    /// expiry (spec L3). Defaults to the system clock; tests pin "today".
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private var userElevationTask: Task<Void, Never>?
    @ObservationIgnored private var browseOriginElevationTask: Task<Void, Never>?
    @ObservationIgnored private var browseTargetElevationTask: Task<Void, Never>?
    /// Terrain fallback elevation for the current hole's green (only sampled
    /// when the green record has no stored elevation).
    private var greenTerrainElevation: Double?

    /// A ~5 m planar (SWEREF99TM) grid cell — the quantisation key for
    /// `ladderTerrainElevations`. Collapses GPS jitter and near-coincident
    /// aim/layup points onto a single terrain sample.
    private struct LadderCellKey: Hashable {
        let gx: Int
        let gy: Int
        init(_ position: LatLon) {
            let p = Sweref99TM.fromWGS84(position)
            gx = Int((p.x / Self.gridM).rounded())
            gy = Int((p.y / Self.gridM).rounded())
        }
        private static let gridM = 5.0
    }

    /// Terrain-sampled elevations for ladder targets that carry no stored one —
    /// nil-elevation (moved / never-recorded) aim points and every layup
    /// landing point — keyed by a ~5 m grid cell. Filled asynchronously by
    /// `refreshLadderElevations`; writes here re-render the banner. Cleared on
    /// hole change and capped at `ladderElevationCacheCap` (a small, transient
    /// per-hole working set).
    private var ladderTerrainElevations: [LadderCellKey: Double] = [:]
    /// Cells with a sample in flight — dedupes concurrent samples for one cell.
    @ObservationIgnored private var ladderElevationInFlight: Set<LadderCellKey> = []
    /// Origin at the last ladder-elevation sweep; the move gate compares to it.
    @ObservationIgnored private var lastLadderSweepOrigin: LatLon?

    /// Safety cap on `ladderTerrainElevations`; the live working set is a
    /// handful of aims + layups per hole, so this only bounds pathological
    /// growth. Cleared wholesale (not LRU-evicted) when exceeded.
    private static let ladderElevationCacheCap = 64
    /// Planar origin move (m) that re-arms the ladder-elevation sweep. Under it,
    /// GPS jitter reuses the cached samples instead of re-sampling every fix.
    private static let ladderSweepMoveThresholdM = 5.0

    init(
        furniture: CourseFurniture,
        defaults: UserDefaults = .standard,
        now: @escaping () -> Date = { Date() }
    ) {
        self.courseId = furniture.course.id
        self.courseName = furniture.course.name
        self.courseBounds = MapCoordinateBounds(
            west: furniture.manifest.west,
            south: furniture.manifest.south,
            east: furniture.manifest.east,
            north: furniture.manifest.north
        )
        self.defaults = defaults
        self.now = now

        let teesByHole = Dictionary(grouping: furniture.tees, by: \.holeId)
        let greensByHole = Dictionary(
            furniture.greens.map { ($0.holeId, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        let pinsByGreen = Dictionary(grouping: furniture.pins, by: \.greenId)
        let aimsByHole = Dictionary(grouping: furniture.aimPoints, by: \.holeId)

        self.holes = furniture.holes
            .sorted { $0.number < $1.number }
            .map { hole in
                let green = greensByHole[hole.id]
                return HoleData(
                    hole: hole,
                    tees: (teesByHole[hole.id] ?? []).sorted { $0.sortOrder < $1.sortOrder },
                    green: green,
                    pins: green.flatMap { pinsByGreen[$0.id] } ?? [],
                    aimPoints: (aimsByHole[hole.id] ?? []).sorted { $0.sortOrder < $1.sortOrder }
                )
            }

        self.activeTeeName = defaults.string(forKey: Self.teeDefaultsKey(courseId: courseId))
        if defaults.object(forKey: Self.planVisibleKey(courseId: courseId)) != nil {
            self.planVisible = defaults.bool(forKey: Self.planVisibleKey(courseId: courseId))
        } else {
            self.planVisible = true
        }
        if defaults.object(forKey: Self.gpsEnabledKey(courseId: courseId)) != nil {
            self.gpsEnabled = defaults.bool(forKey: Self.gpsEnabledKey(courseId: courseId))
        } else {
            self.gpsEnabled = true
        }
        if defaults.object(forKey: Self.aimRoutingThresholdKey) != nil {
            self.aimRoutingThresholdMeters = defaults.double(forKey: Self.aimRoutingThresholdKey)
        } else {
            self.aimRoutingThresholdMeters = Self.defaultAimRoutingThresholdMeters
        }
        self.reticleShowsActual = defaults.bool(forKey: Self.reticleShowsActualKey)
        loadTeeOverrides()
        loadAdjustOverrides()
        loadPinOverrides()
        refreshGreenElevationFallback()
        refreshLadderElevations(force: true)
    }

    // MARK: - Hole navigation

    var currentHole: HoleData? {
        holes.indices.contains(currentHoleIndex) ? holes[currentHoleIndex] : nil
    }

    var currentHoleNumber: Int { currentHole?.hole.number ?? 0 }
    var canGoPrevious: Bool { currentHoleIndex > 0 }
    var canGoNext: Bool { currentHoleIndex + 1 < holes.count }

    func nextHole() {
        guard canGoNext else { return }
        currentHoleIndex += 1
        holeDidChange()
    }

    func previousHole() {
        guard canGoPrevious else { return }
        currentHoleIndex -= 1
        holeDidChange()
    }

    func goToHole(number: Int) {
        guard let index = holes.firstIndex(where: { $0.hole.number == number }) else { return }
        guard index != currentHoleIndex else {
            // Re-selecting the current hole re-issues the entry camera
            // (D-HF3): same solved frame, token bump so the map re-applies
            // it, and the same settle gating as a real hole change.
            cameraToken += 1
            beginHoleEntryFraming()
            return
        }
        currentHoleIndex = index
        holeDidChange()
    }

    /// Re-issues the current hole's camera fit (recenter button).
    func recenter() {
        mapFocus = nil
        focusedLadderId = nil
        clearBrowseTarget()
        restoreCamera = nil
        cameraToken += 1
    }

    /// Center the map on a distance-ladder feature (tap-to-locate). Overrides the
    /// hole fit until `recenter()` or a hole change. `ladderId` marks the rail
    /// row that drove it (nil for a non-rail focus).
    func focusMap(on position: LatLon, ladderId: String? = nil) {
        clearBrowseTarget()
        mapFocus = position
        focusedLadderId = ladderId
        // The centering animation itself reports through `reticleMoved`; the
        // flag lets it pass without releasing the fresh ladder focus.
        ladderFocusCameraSettled = false
        restoreCamera = nil
        cameraToken += 1
    }

    // MARK: - Zoom buttons

    /// One zoom level per tap.
    static let zoomButtonStep = 1.0

    /// Zoom the map in by one level (relative to its current zoom). Imperative —
    /// does not bump `cameraToken`, so it never re-fits the hole.
    func zoomIn() {
        zoomStep = Self.zoomButtonStep
        zoomToken += 1
    }

    /// Zoom the map out by one level.
    func zoomOut() {
        zoomStep = -Self.zoomButtonStep
        zoomToken += 1
    }

    /// Imperative zoom command for `CourseMapView`; nil until the first tap.
    /// Independent of `cameraCommand`.
    var zoomCommand: MapZoomCommand? {
        guard zoomToken > 0 else { return nil }
        return MapZoomCommand(delta: zoomStep, animated: true, token: zoomToken)
    }

    private func holeDidChange() {
        // Tools are per-hole/transient — navigating away always dismisses
        // (the screen observes `toolMode` and tears its tool UI down). An
        // in-flight Adjust drag is abandoned uncommitted.
        toolMode = .none
        toolFocus = nil
        toolCameraInsets = .zero
        draggingHandleID = nil
        resetPlanEditingState()
        mapFocus = nil
        focusedLadderId = nil
        browseOriginElevationTask?.cancel()
        browseTargetElevationTask?.cancel()
        browseOrigin = nil
        browseOriginElevation = nil
        browseTarget = nil
        browseTargetElevation = nil
        inspectedFeature = nil
        restoreCamera = nil
        cameraToken += 1
        // A decide-choice working target is per-hole transient state (R4).
        workingTarget = nil
        // A carry check describes one picked target on the hole just left.
        lastLaserCarryCheck = nil
        // The tee-geofence prompt/guard is keyed to the hole we were on (R5).
        teeGeofencePrompt = nil
        geofenceHandledHole = nil
        refreshGreenElevationFallback()
        // The per-hole target set changes; drop the old samples and re-sweep.
        ladderTerrainElevations.removeAll(keepingCapacity: true)
        lastLadderSweepOrigin = nil
        refreshLadderElevations(force: true)
        // D-HF1/D-HF3/D-HF4: the reticle aim is SET for the new hole in world
        // coordinates — never inherited from the previous hole, never derived
        // from a screen point mid-flight — the entry camera is solved from it,
        // and the reticle overlays hide until that camera settles.
        beginHoleEntryFraming()
    }

    // MARK: - Map tools (transient modes over the normal hole view)

    /// A transient map tool over the normal hole view. Exactly one tool can be
    /// active at a time (entering one exits the other — `toolMode` is a single
    /// value); a tool may take over the camera via `focus` (e.g. Green
    /// view zooms to the green). Hole navigation dismisses the active tool.
    ///
    /// `.measure` re-purposes the map tap: instead of toggling immersive
    /// chrome, a tap PLACES a measure point (see `MeasureModel`). `.adjust`
    /// turns on the draggable tee/aim/green handles (short-press drag moves
    /// them; the map keeps its framing). The elevation profile is
    /// deliberately NOT a tool — it's a non-modal sheet openable over any
    /// mode.
    enum MapToolMode: Equatable, Sendable {
        case none
        case greenView
        case measure
        case adjust
        /// Shot capture: the crosshair + optional target handle own the map
        /// touch (same drag plumbing as Adjust, without the gesture lock).
        case capture
        /// Plan editing: the planned landing points become draggable handles;
        /// a tap can place a new shot. Writes go through `planWriter` (GRDB
        /// dirty row + `PlanSyncService`).
        case plan
    }

    private(set) var toolMode: MapToolMode = .none
    /// Camera target while a tool is active; nil keeps the hole framing.
    private var toolFocus: MapCameraCommand.Target?
    /// Chrome covering the map while the tool is active (hole header on top,
    /// the tool's own panel at the bottom). The focus fit adds these to its
    /// padding so the focused shape lands centered in the VISIBLE map.
    private var toolCameraInsets: MapEdgeInsets = .zero
    /// Whether entering the current tool re-framed the camera. When false
    /// (Adjust mode), the user's current zoom/pan is preserved on entry AND on
    /// exit — so tapping the tool button never yanks the view.
    private var toolDidRefitCamera = false

    /// The live map camera, reported by `CourseMapView` on every idle. Used to
    /// snapshot where the user was before a re-framing tool (Green view) so it
    /// can be restored on exit. Not observed — pure bookkeeping.
    struct ObservedCamera: Equatable, Sendable {
        var center: LatLon
        var zoom: Double
        var bearing: Double
    }
    @ObservationIgnored private var lastObservedCamera: ObservedCamera?
    /// Where to return when a re-framing tool exits (captured on entry).
    @ObservationIgnored private var cameraBeforeRefitTool: ObservedCamera?
    /// A one-shot "restore this exact view" target; overrides the hole/tool
    /// bounds in `cameraCommand` until the next deliberate re-frame.
    private var restoreCamera: ObservedCamera?

    /// Called by the map (main actor) whenever the camera settles.
    func noteMapCamera(center: LatLon, zoom: Double, bearing: Double) {
        lastObservedCamera = ObservedCamera(center: center, zoom: zoom, bearing: bearing)
    }

    /// Enter a tool, optionally re-aiming the camera at `focus` (tight-fit, hole
    /// bearing kept so the view doesn't spin) with `insets` describing the
    /// chrome that covers the map. Pass `refitCamera: false` (Adjust mode) to
    /// leave the camera exactly where the user has it — no token bump, so
    /// `cameraCommand` is unchanged and never re-applied.
    func enterTool(
        _ mode: MapToolMode,
        focus: MapCameraCommand.Target? = nil,
        insets: MapEdgeInsets = .zero,
        refitCamera: Bool = true
    ) {
        guard mode != .none else {
            exitTool()
            return
        }
        toolMode = mode
        toolFocus = focus
        toolCameraInsets = insets
        draggingHandleID = nil
        toolDidRefitCamera = refitCamera
        restoreCamera = nil
        if refitCamera {
            // Remember the current view so exiting can return to it.
            cameraBeforeRefitTool = lastObservedCamera
            cameraToken += 1
        }
    }

    /// Re-fit the active tool's focus bounds with updated chrome insets. The
    /// panel's real height is only known once SwiftUI has laid it out, a frame
    /// AFTER `enterTool` — the screen calls this then, so the fit accounts for
    /// the panel that is actually covering the map. A no-op when the insets are
    /// unchanged (or no focus fit is active), so it never re-frames the map out
    /// from under the user.
    func refitTool(insets: MapEdgeInsets) {
        guard toolMode != .none, toolFocus != nil, toolDidRefitCamera else { return }
        guard insets != toolCameraInsets else { return }
        toolCameraInsets = insets
        restoreCamera = nil
        cameraToken += 1
    }

    /// Leave the active tool. If entering re-framed the camera (Green view),
    /// return to the exact view the user had before entering; a no-refit tool
    /// (Adjust) leaves the view untouched. An in-flight Adjust drag is abandoned.
    func exitTool() {
        guard toolMode != .none else { return }
        toolMode = .none
        toolFocus = nil
        toolCameraInsets = .zero
        draggingHandleID = nil
        resetPlanEditingState()
        if toolDidRefitCamera {
            restoreCamera = cameraBeforeRefitTool // nil → falls back to hole fit
            cameraToken += 1
        }
        toolDidRefitCamera = false
        cameraBeforeRefitTool = nil
    }

    // MARK: - Tee selection

    private static func teeDefaultsKey(courseId: String) -> String {
        "onCourse.activeTee.\(courseId)"
    }

    /// Tee names across the course, ordered by their lowest sortOrder.
    var availableTeeNames: [String] {
        var minOrder: [String: Int] = [:]
        for tee in holes.flatMap(\.tees) {
            minOrder[tee.name] = min(minOrder[tee.name] ?? .max, tee.sortOrder)
        }
        return minOrder
            .sorted { ($0.value, $0.key) < ($1.value, $1.key) }
            .map(\.key)
    }

    func selectTee(named name: String) {
        activeTeeName = name
        defaults.set(name, forKey: Self.teeDefaultsKey(courseId: courseId))
        // A deliberate tee choice is also a deliberate browse-origin reset.
        if isBrowseMode { resetBrowseOrigin() }
    }

    /// The tee used for this hole: the selected name when the hole has it,
    /// else the hole's lowest-sortOrder tee.
    func activeTee(for hole: HoleData) -> TeeRecord? {
        if let activeTeeName, let match = hole.tees.first(where: { $0.name == activeTeeName }) {
            return match
        }
        return hole.tees.first
    }

    /// The tee name actually in effect on the current hole (after fallback).
    var resolvedTeeName: String? {
        currentHole.flatMap { activeTee(for: $0)?.name }
    }

    /// One row of the tee picker for the current hole.
    struct TeeMenuEntry: Identifiable, Equatable {
        let name: String
        /// Playing length of THIS tee on the current hole, or nil for a tee not
        /// present on this hole (its position/length is undefined here).
        let length: HoleLength.PlayingLength?
        /// True when the tee is placed on the current hole (has a length).
        var isPresentOnHole: Bool { length != nil }
        var id: String { name }
    }

    /// Tee picker rows for the current hole. Tees placed on this hole come first,
    /// sorted DESCENDING by playing length (longest/championship tee at top),
    /// each carrying its own tee→aims→green length (same math as the header's
    /// `playingLength`, honoring any moved-tee override). Tees NOT placed on this
    /// hole (course-level names) follow, alphabetically, with a nil length shown
    /// as "—" in the UI — their position on this hole is undefined so no figure
    /// is claimed.
    var teeMenuEntries: [TeeMenuEntry] {
        guard let hole = currentHole else { return [] }

        let aims = hole.aimPoints.map { aimPosition(for: $0, in: hole) }
        let greenCenter = greenCenterPosition(for: hole)

        let present: [TeeMenuEntry] = hole.tees.map { tee in
            let position = teeOverrides[hole.id]?[tee.name] ?? LatLon(lat: tee.lat, lon: tee.lon)
            return TeeMenuEntry(
                name: tee.name,
                length: HoleLength.playingLength(tee: position, aims: aims, greenCenter: greenCenter)
            )
        }
        // Longest first; break ties by name for a stable order.
        .sorted { lhs, rhs in
            let l = lhs.length?.meters ?? .min
            let r = rhs.length?.meters ?? .min
            if l != r { return l > r }
            return lhs.name < rhs.name
        }

        let presentNames = Set(hole.tees.map(\.name))
        let absent: [TeeMenuEntry] = availableTeeNames
            .filter { !presentNames.contains($0) }
            .map { TeeMenuEntry(name: $0, length: nil) }

        return present + absent
    }

    // MARK: - GPS toggle + browse mode

    static let defaultAimRoutingThresholdMeters = 230.0

    private static func gpsEnabledKey(courseId: String) -> String {
        "onCourse.gpsEnabled.\(courseId)"
    }
    private static let aimRoutingThresholdKey = "onCourse.aimRoutingThresholdMeters"

    /// Flip the GPS/browse switch (persisted per course). Does NOT move the
    /// camera — the hole framing is the same in both modes.
    func setGPSEnabled(_ enabled: Bool) {
        guard enabled != gpsEnabled else { return }
        gpsEnabled = enabled
        defaults.set(enabled, forKey: Self.gpsEnabledKey(courseId: courseId))
        // An inspected target belongs to the origin it was measured from. Do
        // not carry it across the GPS/browse origin switch.
        clearBrowseInspection()
        // The origin flips between the GPS fix and the tee — force a sweep so
        // the new origin's layup landing positions are sampled even when no
        // further GPS fix arrives.
        refreshLadderElevations(force: true)
        // The origin flip is an origin change (D-HF1): the reticle aim is
        // re-resolved for the new origin instead of lingering where the old
        // origin pointed it.
        applyDefaultAim()
    }

    func toggleGPS() { setGPSEnabled(!gpsEnabled) }

    /// In browse mode (`gpsEnabled == false`) the live fix is ignored entirely.
    var isBrowseMode: Bool { !gpsEnabled }

    /// Explicitly move the transient browse origin. Map and ladder taps call
    /// the inspect methods below first; only the confirmation action calls this.
    func setBrowseOrigin(_ position: LatLon) {
        guard isBrowseMode else { return }
        clearBrowseInspection()
        browseOrigin = position
        browseOriginElevation = nil
        mapFocus = nil
        focusedLadderId = nil
        refreshLadderElevations(force: true)

        // "From here" is an origin change (D-HF1): the aim resets to the
        // resolver's default for the new origin, not the stale old aim.
        applyDefaultAim()

        browseOriginElevationTask?.cancel()
        guard let sampler = elevationSampler else { return }
        browseOriginElevationTask = Task { [weak self] in
            let elevation = await sampler(position)
            guard !Task.isCancelled else { return }
            self?.browseOriginElevation = elevation
        }
    }

    /// Inspect a tapped course shape (bunker / water / green / trees / …):
    /// hit-test the surface stack at the tap and, on a hit, surface the
    /// ring's front/carry window. Two measuring modes:
    ///
    ///  - Default (ray): along the ray origin → tap, extended through the
    ///    shape — "if I hit at that bunker, it's front to reach and carry to
    ///    clear". The figures anchor ON the shape's own lips.
    ///  - Browse-to (browse mode with an inspected `browseTarget`): the point
    ///    is KEPT and the shape's window is projected onto the CHOSEN line
    ///    origin → browse-to — "on the line I'm considering, when do I reach
    ///    / carry it". The figures anchor on that line.
    ///
    /// Works in GPS mode too (from the live fix). Returns false when the tap
    /// landed on no tappable shape OR inside the shape that is ALREADY
    /// inspected — the caller then dismisses the inspection (second tap =
    /// dismiss, both modes).
    @discardableResult
    func inspectTappedFeature(_ position: LatLon) -> Bool {
        guard let origin else { return false }
        let tapPlanar = Self.planar(position)
        guard let ring = tappableRing(at: tapPlanar) else { return false }
        // Second tap inside the SAME inspected shape → not consumed here; the
        // caller dismisses the inspection.
        if inspectedFeature?.sourceRing == ring { return false }

        let extent: HazardCarries.RingLineExtent?
        let lineTo: LatLon?
        if let browseTarget {
            extent = HazardCarries.extent(
                of: ring, along: [[Self.planar(origin), Self.planar(browseTarget)]]
            )
            lineTo = browseTarget
        } else {
            extent = HazardCarries.extent(of: ring, fromRay: Self.planar(origin), through: tapPlanar)
            lineTo = nil
        }
        guard let extent else { return false }
        mapFocus = nil
        focusedLadderId = nil
        inspectedFeature = InspectedFeature(
            carry: extent.carry,
            ring: ring.points.map { Sweref99TM.toWGS84(x: $0.x, y: $0.y) },
            frontPoint: Sweref99TM.toWGS84(x: extent.frontPoint.x, y: extent.frontPoint.y),
            carryPoint: Sweref99TM.toWGS84(x: extent.carryPoint.x, y: extent.carryPoint.y),
            lineTo: lineTo,
            sourceRing: ring
        )
        return true
    }

    /// The single distance-mode map-tap entry point (both GPS and browse):
    ///
    ///  1. Tap a NEW shape → inspect it (front/carry window).
    ///  2. Tap the shape ALREADY inspected, or open map → dismiss whatever is
    ///     inspected; with nothing up return false so the screen may toggle
    ///     its chrome.
    ///
    /// A tap never point-inspects: the reticle IS the aim point (both modes),
    /// so a tapped dot next to it would be a second, competing target.
    @discardableResult
    func handleDistanceTap(_ position: LatLon) -> Bool {
        if inspectTappedFeature(position) { return true }
        if inspectedFeature != nil || browseTarget != nil {
            clearBrowseInspection()
            return true
        }
        return false
    }

    /// Dismiss the tapped-shape inspection (GPS-mode tap on open map).
    func clearInspectedFeature() {
        inspectedFeature = nil
    }

    /// Topmost containing tappable ring at `p` — the surface stack is
    /// topmost-first, so the first hit is the ring the map paints on top (a
    /// bunker inside a green answers as the bunker). Bbox prefilter as `lieAt`.
    private func tappableRing(at p: Vec2) -> FlatRing? {
        for i in surfaces.indices where i < surfaceBBoxes.count {
            guard HazardCarries.tappableTypes.contains(surfaces[i].kind) else { continue }
            guard surfaceBBoxes[i].contains(p) else { continue }
            if pointInRing(p, surfaces[i].points) { return surfaces[i] }
        }
        return nil
    }

    /// Inspect an arbitrary map point FROM the current origin — the browse
    /// origin in browse mode, the live fix in GPS mode (an aim point on the
    /// green from the fairway). Does not issue a camera command, so a tap at
    /// the end of a pan stays harmless. Only the PROMOTION to a new browse
    /// origin stays browse-mode-only.
    func inspectBrowsePoint(_ position: LatLon) {
        mapFocus = nil
        focusedLadderId = nil
        inspectedFeature = nil
        browseTargetElevationTask?.cancel()
        browseTarget = position
        browseTargetElevation = nil

        guard let sampler = elevationSampler else { return }
        browseTargetElevationTask = Task { [weak self] in
            let elevation = await sampler(position)
            guard !Task.isCancelled, self?.browseTarget == position else { return }
            self?.browseTargetElevation = elevation
        }
    }

    /// Inspect a ladder rung and retain the current browse origin. The existing
    /// ladder focus drives its highlight, advice, and optional camera locate.
    func inspectBrowseLadder(_ row: LadderRow) {
        guard let position = row.position else { return }
        focusMap(on: position, ladderId: row.id)
    }

    /// Make the currently inspected map point or ladder rung the next origin.
    func promoteInspectedBrowseTarget() {
        guard isBrowseMode else { return }
        let position = browseTarget ?? selectedLadderRow?.position
        guard let position else { return }
        setBrowseOrigin(position)
    }

    /// Whether the card should offer the explicit promotion action.
    var canPromoteInspectedBrowseTarget: Bool {
        isBrowseMode && (browseTarget != nil || focusedLadderId != nil || inspectedFeature != nil)
    }

    /// Restore the selected tee as the browse origin.
    func resetBrowseOrigin() {
        browseOriginElevationTask?.cancel()
        browseOrigin = nil
        browseOriginElevation = nil
        clearBrowseInspection()
        refreshLadderElevations(force: true)
        // "From tee" is an origin change (D-HF1): re-resolve the default aim.
        applyDefaultAim()
    }

    /// A moved origin invalidates the settled reticle answer (it measures
    /// from the old origin). Drop it and re-settle at the unchanged aim —
    /// "From here"/"From tee" land with a fresh readout instead of a stale one.
    private func resettleReticleAfterOriginChange() {
        guard let target = reticleTarget else { return }
        reticleSettleTask?.cancel()
        reticleSettled = nil
        reticleMoved(target, panning: false)
    }

    // MARK: - Default aim (D-HF1 + D-HF2 — hole-select framing, slice 1)

    /// The explicit default aim for the current hole from the current origin
    /// (D-HF1): the plan's current-leg landing point, else the curated
    /// furniture aim point (farthest ahead-of-origin one within the longest
    /// club, plays-like), else the green center clamped to the longest club
    /// (plays-like), else the D-HF2 fairway-snap ring walk (corridor-scoped
    /// fairways). World coordinates, never derived from a screen point. Nil
    /// without a hole, origin, or green. The hole-entry camera solve (D-HF3,
    /// next slice) consumes this.
    var defaultAimTarget: LatLon? {
        guard let hole = currentHole, let origin,
              let green = greenCenterPosition(for: hole) else { return nil }
        // 1. A plan already picked a corridor-aware target for this leg.
        if let landing = defaultAimPlanLanding { return landing }

        let o = Self.planar(origin)
        let g = Self.planar(green)
        let fairways = fairwayRings(for: hole)
        // Curated aim points still ahead of the origin (the shared
        // forward-route chainage filter), in hole order — resolver rule 2.
        let aheadAims = keptForwardAimIndices(from: origin, toGreen: green)
            .map { Self.planar(targets.aimPoints[$0].position) }
        // Plays-like against the green: slope when both elevations are known
        // (same degradation as the card — raw otherwise), no wind (the clamp
        // is a plausibility gate, not a shot answer).
        let originElev = originElevation
        let greenElev = targets.greenElevation
        let bag = clubs
        let point = DefaultAim.resolve(DefaultAim.Input(
            origin: o,
            greenCenter: g,
            fairways: fairways,
            aimPoints: aheadAims,
            longestCarryM: bag.map(\.carryM).max() ?? 0,
            lateralDispersionM: { distanceM in
                guard let club = BrowseReticle.panClub(clubs: bag, distanceM: distanceM)
                else { return 0 }
                // Full width — the resolver's gate wants the full extent.
                return 2 * BrowseReticle.lateralHalfWidthM(club: club, atDistanceM: distanceM)
            },
            playsLikeM: { p in
                let raw = hypot(p.x - o.x, p.y - o.y)
                guard let oe = originElev, let ge = greenElev else { return raw }
                let stats = PlaysLike.segmentStats(
                    PlaysLike.Point(e: o.x, n: o.y, elevation: oe),
                    PlaysLike.Point(e: p.x, n: p.y, elevation: ge)
                )
                return stats.playsLikeSimple ?? raw
            }
        ))
        return Sweref99TM.toWGS84(x: point.x, y: point.y)
    }

    /// The plan's current-leg landing for the default aim: the first planned
    /// shot point not yet passed from the current ORIGIN (the
    /// `nextPlannedLanding` rule generalized off the GPS fix so browse mode
    /// resolves it from the tee/browse origin too); once every planned
    /// landing is behind the origin, the plan's last leg lands on the green.
    /// Nil without a plan.
    private var defaultAimPlanLanding: LatLon? {
        guard let holePlan = currentHolePlan, let hole = currentHole,
              let green = greenCenterPosition(for: hole), let origin else { return nil }
        let originToGreen = Distance.planarMeters(origin, green)
        if let shot = holePlan.shots.first(where: {
            Distance.planarMeters($0.position, green) < originToGreen
        }) {
            return shot.position
        }
        // Last leg — the plan's landing is the green itself (D-HF1 rule 1).
        return green
    }

    /// Fairway rings scoped to the hole's intended CORRIDOR, for the D-HF2
    /// ring walk. The surface stack is COURSE-WIDE and carries no holeIds,
    /// and an unfiltered walk snaps to whatever fairway happens to cross
    /// the ring — on real courses an ADJACENT hole's fairway, producing
    /// 45–90° aim bearings (device bug, holes 4/6/13/14/15/18 on Linkan).
    /// "My fairway" is geometric: the hole's intended play-line is its
    /// routed polyline (tee → curated aim points → green center,
    /// override-aware — `cachedHoleRoutePlanar`), and a fairway is the
    /// walk's when it comes within `fairwayCorridorHalfWidthM` of that
    /// line. Holes without a route (no tee/green data) keep every ring.
    private func fairwayRings(for hole: HoleData) -> [[Vec2]] {
        let all = surfaces.filter { $0.kind == "fairway" && $0.points.count >= 3 }
        let route = cachedHoleRoutePlanar(for: hole)
        guard route.count >= 2 else { return all.map(\.points) }
        return all
            .filter {
                Self.ringIntersectsCorridor(
                    $0.points, route: route, halfWidthM: Self.fairwayCorridorHalfWidthM
                )
            }
            .map(\.points)
    }

    /// Half-width of the fairway-scoping corridor around the routed
    /// play-line: wide enough to keep the hole's own fairway (offset
    /// landing zones included), well under hole-to-hole spacing.
    private static let fairwayCorridorHalfWidthM = 60.0

    /// Whether a ring comes within `halfWidthM` of the routed play-line.
    /// The route is sampled every ~10 m; a sample inside the ring, or
    /// within `halfWidthM` of a ring edge, is a hit. (Fairway rings are far
    /// wider than the step, so sampling cannot tunnel through one.)
    private static func ringIntersectsCorridor(
        _ ring: [Vec2], route: [Vec2], halfWidthM: Double
    ) -> Bool {
        guard route.count >= 2, ring.count >= 3 else { return false }
        for i in 0..<(route.count - 1) {
            let a = route[i]
            let b = route[i + 1]
            let steps = max(Int(hypot(b.x - a.x, b.y - a.y) / 10), 1)
            for s in 0...steps {
                let t = Double(s) / Double(steps)
                let p = Vec2(x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y))
                if pointInRing(p, ring) { return true }
                if Self.distanceToRingEdge(p, ring) <= halfWidthM { return true }
            }
        }
        return false
    }

    /// Minimum distance from a point to a ring's boundary (implicitly
    /// closed).
    private static func distanceToRingEdge(_ p: Vec2, _ ring: [Vec2]) -> Double {
        var best = Double.infinity
        let n = ring.count
        for i in 0..<n {
            let a = ring[i]
            let b = ring[(i + 1) % n]
            let dx = b.x - a.x
            let dy = b.y - a.y
            let len2 = dx * dx + dy * dy
            let t = len2 > 0 ? max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
            let qx = a.x + t * dx
            let qy = a.y + t * dy
            best = min(best, hypot(p.x - qx, p.y - qy))
        }
        return best
    }

    /// D-HF1 wiring: origin changes SET the reticle aim explicitly from the
    /// resolver — never inherited from the previous hole/origin. Only an
    /// ENGAGED reticle carries stale aim state; while the reticle is down
    /// there is nothing to inherit, and engaging it here would suppress the
    /// forward-route/plan overlays prematurely — hole entry engages via
    /// `beginHoleEntryFraming` (D-HF3/D-HF4) instead. Falls back to the old
    /// resettle-in-place when the default cannot be resolved (no green
    /// data), so the readout never goes stale.
    private func applyDefaultAim() {
        // An origin change while the entry camera is still in flight (GPS
        // fix adopted mid-animation) restarts the entry framing: the solve
        // re-freezes from the new origin and the settle gate stays up —
        // routing the new aim through `reticleMoved` would fight the gate.
        if reticleAwaitingEntrySettle {
            beginHoleEntryFraming()
            return
        }
        guard reticleTarget != nil else { return }
        guard let target = defaultAimTarget else {
            resettleReticleAfterOriginChange()
            return
        }
        reticleSettleTask?.cancel()
        reticleSettled = nil
        reticleMoved(target, panning: false)
    }

    // MARK: - Hole-entry framing (D-HF3 + D-HF4 — hole-select framing, slice 2)

    /// Solve inputs FROZEN at hole entry (origin + resolved default aim): the
    /// entry camera must not re-fly as the GPS origin walks or a plan edit
    /// re-resolves the aim — only a hole change / same-hole re-select
    /// re-frames. Viewport size and insets stay live so the first measured
    /// layout corrects the frame (same mechanism as `holeFitInsets`).
    private(set) var holeEntrySolveOrigin: LatLon?
    private(set) var holeEntrySolveAim: LatLon?

    /// Screen-measured full-bleed map viewport in points; `.zero` until the
    /// first layout (the solve stands down and the hole fit covers).
    ///
    /// The first non-zero measurement also closes the FIRST-HOLE gap: the hole
    /// shown on course open (including the `-openCourse` / `-openHole` launch
    /// paths) never passes through `holeDidChange`, so without this it would
    /// keep the old bounds fit and a disengaged reticle until the first hole
    /// navigation. Routing it through the same entry path once layout exists
    /// gives hole one the solved camera + the D-HF1 default aim.
    var mapViewportSize = CGSize.zero {
        didSet {
            guard !didFrameHoleEntry,
                  mapViewportSize.width > 0, mapViewportSize.height > 0
            else { return }
            beginHoleEntryFraming()
        }
    }
    /// True once an entry framing actually resolved a default aim. Guards the
    /// first-hole catch-up above from re-firing (and lets it retry while the
    /// aim is still unresolvable — no green data yet).
    @ObservationIgnored private var didFrameHoleEntry = false
    /// Distance-mode chrome insets (hole header top, distance card bottom),
    /// screen-measured. The solve always uses the card-up distance chrome —
    /// immersive/tool toggles never re-frame the entry camera, and D-HF5's
    /// expanded card is measured as if it were still compact.
    var distanceCameraInsets = MapEdgeInsets.zero

    /// Zoom clamps for the entry solve: never frame wider than the course
    /// tiles resolve, never tighter than the ortho detail ceiling (a short
    /// par 3 would otherwise zoom absurdly). When a clamp bites, the origin
    /// anchor holds and the aim drifts off the reticle anchor (D-HF3).
    static let holeEntryMinZoom = 13.0
    static let holeEntryMaxZoom = 19.0

    /// D-HF4 — true from hole entry until the first settle: the reticle
    /// line, labels and dispersion overlays are HIDDEN (not stale-frozen)
    /// while the entry camera flies, and reappear computed from the
    /// world-coordinate default aim.
    private(set) var reticleAwaitingEntrySettle = false
    /// True once the entry animation has reported idle. A panning report
    /// AFTER it is the user grabbing the map (lifts the gate, resumes the
    /// screen-anchor path); one DURING the flight is the animation itself
    /// and is ignored (never unproject the anchor mid-flight).
    @ObservationIgnored private var holeEntryCameraIdled = false

    /// D-HF3/D-HF4 — hole entry (and same-hole re-select): freeze the solve
    /// inputs, engage the reticle at the world-coordinate default aim (slice
    /// 1 left a disengaged reticle down; the entry camera now drives the
    /// first engagement), and gate the reticle overlays until the entry
    /// camera settles. Without a resolvable default (no green data) fall
    /// back to the slice-1 origin-change behavior so nothing goes stale.
    private func beginHoleEntryFraming() {
        holeEntryCameraIdled = false
        holeEntrySolveOrigin = origin
        holeEntrySolveAim = defaultAimTarget
        guard let aim = holeEntrySolveAim, holeEntrySolveOrigin != nil else {
            reticleAwaitingEntrySettle = false
            applyDefaultAim()
            return
        }
        reticleSettleTask?.cancel()
        reticleSettled = nil
        reticleIsPanning = false
        reticleTarget = aim
        reticleAwaitingEntrySettle = true
        didFrameHoleEntry = true
    }

    // MARK: - Distance card detent (D-HF5 — compact card)

    /// The distance card's two FIXED states — no free-drag continuum, so the
    /// chrome insets stay deterministic. Compact is the default.
    enum DistanceCardDetent: Equatable, Sendable {
        /// One row: to-green figure, advised club + carry, plays-like delta.
        case compact
        /// Today's full card (Laser, Pin, tee, profile, Browse, origin strip).
        case expanded
    }

    /// Session state, deliberately NOT persisted to defaults: the card opens
    /// compact on every app start (D-HF5), and a hole change never expands it
    /// — hole entry is exactly when the map matters most.
    private(set) var distanceCardDetent: DistanceCardDetent = .compact

    var isDistanceCardExpanded: Bool { distanceCardDetent == .expanded }

    /// Tapping the compact row (the whole row is the target) expands.
    func expandDistanceCard() { distanceCardDetent = .expanded }

    /// Back to one row. No-op when already compact.
    func collapseDistanceCard() { distanceCardDetent = .compact }

    /// An action COMPLETED inside the expanded card — tee picked, Laser or Pin
    /// sheet opened, Browse toggled — hands the map back.
    func distanceCardActionCompleted() { collapseDistanceCard() }

    /// A map tap in distance mode that nothing else consumed. Returns true when
    /// the tap was spent collapsing the expanded card, so the immersive toggle
    /// must NOT also fire: the ladder is one tap per step (expanded → compact →
    /// immersive).
    func collapseDistanceCardOnMapTap() -> Bool {
        guard isDistanceCardExpanded else { return false }
        collapseDistanceCard()
        return true
    }

    /// The compact row's content (D-HF5): the big to-green figure, the advised
    /// club with its carry (`7I · 155`), and the plays-like delta against the
    /// actual. Derived here so the row stays a dumb layout — and so the
    /// competition gating (which nils the club/slope figures inside
    /// `OnCourseDistances`) carries through unchanged.
    struct CompactCardLine: Equatable, Sendable {
        /// Straight distance to the green center, whole meters.
        var distanceM: Int?
        /// Advised club for the (wind-adjusted) plays-like center distance, or
        /// the max-advance layup club when the green is out of range.
        var clubName: String?
        /// That club's carry, whole meters.
        var clubCarryM: Int?
        /// Plays-like (wind-adjusted when known) to the center.
        var playsLikeM: Int?
        /// plays-like − actual; nil when either side is unknown.
        var deltaM: Int?
    }

    var compactCardLine: CompactCardLine {
        let distances = self.distances
        let actual = distances?.center
        let playsLike = distances?.windPlaysLikeCenter ?? distances?.playsLikeCenter
        var clubName = distances?.centerClubs?.center
        var clubCarryM: Int?
        if let name = clubName {
            clubCarryM = clubs.first { $0.name == name }.map { Int($0.carryM.rounded()) }
        } else if let aimClub = compactAimLegClub {
            // Green beyond the bag: the club for the AIM leg the reticle
            // shows (device bug: a to-green layup club — "7I" against a
            // 220 m aim line — contradicted the aim on screen).
            clubName = aimClub.name
            clubCarryM = Int(aimClub.carryM.rounded())
        } else if let layup = distances?.layup {
            // No resolvable aim: the honest max-advance club, same figure
            // the expanded card's layup row shows.
            clubName = layup.club
            clubCarryM = layup.carryM
        }
        var deltaM: Int?
        if let playsLike, let actual { deltaM = playsLike - actual }
        return CompactCardLine(
            distanceM: actual,
            clubName: clubName,
            clubCarryM: clubCarryM,
            playsLikeM: playsLike,
            deltaM: deltaM
        )
    }

    /// The compact row's club when the green is beyond the bag: the club for
    /// the AIM leg (D-HF1's default aim / the panned reticle target) — the
    /// settled reticle advice when it's in (plays-like pick, same answer the
    /// map's ellipse label shows), else the pan pick at the current aim
    /// distance. Advice → nil in competition mode / empty bag / no
    /// resolvable aim (the layup fallback then covers).
    private var compactAimLegClub: ClubRecord? {
        guard !competitionMode, !clubs.isEmpty else { return nil }
        if let name = reticleSettled?.advisedClub,
           let club = clubs.first(where: { $0.name == name }) {
            return club
        }
        guard let origin, let target = reticleTarget ?? defaultAimTarget else { return nil }
        // Whole meters (the card's unit): the D-HF2 walk lands aims exactly
        // ON club carries, and a sub-millimeter projection round-trip must
        // not tip `panClub` past the matching club.
        return BrowseReticle.panClub(
            clubs: clubs,
            distanceM: Distance.planarMeters(origin, target).rounded()
        )
    }

    /// D-HF3 — the solved hole-entry camera: origin at the ball anchor
    /// (center-x, 78% down the usable viewport), default aim at the reticle
    /// anchor (center-x, 30% — the crosshair's own constant), bearing =
    /// first shot up, zoom from the anchor separation. Nil before layout or
    /// without an origin/aim — `cameraCommand` falls back to the hole fit.
    var holeEntryCameraCommand: MapCameraCommand? {
        guard let origin = holeEntrySolveOrigin, let aim = holeEntrySolveAim,
              mapViewportSize.width > 0, mapViewportSize.height > 0
        else { return nil }
        // Dispersion margin input: the advised club's lateral half-width at
        // the aim (advice → competition-gated, like the ellipse itself).
        var dispersionHalfWidthM = 0.0
        if !competitionMode {
            let rawM = Distance.planarMeters(origin, aim)
            if let club = BrowseReticle.panClub(clubs: clubs, distanceM: rawM) {
                dispersionHalfWidthM = BrowseReticle.lateralHalfWidthM(
                    club: club, atDistanceM: rawM
                )
            }
        }
        guard let solved = AnchoredCameraSolve.solve(AnchoredCameraSolve.Input(
            origin: origin,
            aim: aim,
            viewportWidth: Double(mapViewportSize.width),
            viewportHeight: Double(mapViewportSize.height),
            insets: distanceCameraInsets,
            aimAnchorYFraction: Double(CourseMapView.Coordinator.reticleAnchorYFraction),
            minZoom: Self.holeEntryMinZoom,
            maxZoom: Self.holeEntryMaxZoom,
            dispersionHalfWidthM: dispersionHalfWidthM
        )) else { return nil }
        return .center(
            solved.center,
            zoom: solved.zoom,
            bearing: solved.bearing,
            animated: true,
            token: cameraToken
        )
    }

    private func clearBrowseTarget() {
        browseTargetElevationTask?.cancel()
        browseTarget = nil
        browseTargetElevation = nil
        inspectedFeature = nil
    }

    private func clearBrowseInspection() {
        mapFocus = nil
        focusedLadderId = nil
        clearBrowseTarget()
    }

    // MARK: - Reticle browse (pan-to-aim)

    /// Geo point currently under the fixed reticle anchor (RB2's callback
    /// feeds it). Live in both GPS and browse mode.
    private(set) var reticleTarget: LatLon?
    /// True from the first camera-change report until the map settles.
    private(set) var reticleIsPanning = false
    /// Full once-per-settle answer; nil while panning and before the first
    /// settle. Advice fields inside are competition-gated (distances stay).
    private(set) var reticleSettled: ReticleSettled?
    /// Origin the settled snapshot measured from. In GPS mode the origin walks
    /// with the player — drift past `reticleOriginResettleM` re-settles;
    /// browse origins re-settle explicitly via `resettleReticleAfterOriginChange`.
    @ObservationIgnored private var reticleSettledOrigin: LatLon?
    /// True once the ladder-focus centering animation has gone idle. While a
    /// ladder rung is focused, reticle pan reports before this are the
    /// focusing animation itself; the first pan AFTER it is the user taking
    /// the map back, which releases the focus to the reticle.
    @ObservationIgnored private var ladderFocusCameraSettled = false

    /// The settled big figure shows the raw ("actual") distance instead of
    /// plays-like. Tapping the figure toggles; a global (not per-course)
    /// preference — it is a reading habit, not course state.
    private(set) var reticleShowsActual = false
    private static let reticleShowsActualKey = "onCourse.reticleShowsActual"

    func toggleReticleDistanceMode() {
        reticleShowsActual.toggle()
        defaults.set(reticleShowsActual, forKey: Self.reticleShowsActualKey)
    }

    /// GPS drift beyond this re-settles the reticle answer (walking with the
    /// aim parked); below it, fix jitter keeps the settled snapshot stable.
    static let reticleOriginResettleM = 3.0

    /// Injectable settle debounce — 200 ms after the map goes idle per the
    /// design note. Tests swap in an instant sleep the same way `now` pins
    /// the clock.
    @ObservationIgnored var reticleSettleSleep: @Sendable () async throws -> Void = {
        try await Task.sleep(nanoseconds: 200_000_000)
    }
    @ObservationIgnored private var reticleSettleTask: Task<Void, Never>?

    /// The settled reticle snapshot — the expensive once-per-settle answer
    /// (elevation sample, plays-like, wind hold). The per-frame pan snapshot
    /// stays in the `reticlePan*` computed properties instead.
    struct ReticleSettled: Equatable {
        struct NeighborArc: Equatable {
            var clubName: String
            /// WGS84 open arc polyline (drawn dotted, not a polygon).
            var polyline: [LatLon]
        }
        /// Plays-like origin→aim through the wind, whole meters. Competition
        /// mode: the straight distance through the wind (slope withheld).
        var playsLikeM: Int
        /// Re-picked at the plays-like distance — may differ from the pan
        /// club (preview vs answer). Nil in competition mode / empty bag.
        var advisedClub: String?
        /// Advised club's wind-compensated dispersion ellipse (WGS84 ring).
        /// Empty in competition mode.
        var ellipse: [LatLon]
        /// Where the advised club's NAME is drawn on the map: the ellipse's
        /// rightmost point relative to the aim line, matching the neighbor
        /// arcs' right-end labels so all three club names sit on the same side
        /// (a HUD-only club chip was misread as the nearest arc's label).
        /// Nil whenever there is no ellipse.
        var ellipseLabelPosition: LatLon?
        /// Closest shorter + longer clubs at their own plays-like-adjusted
        /// carries. Empty in competition mode / at bag ends.
        var neighborArcs: [NeighborArc]
        /// Crosswind hold ("aim 6 m left") for the advised club, when it
        /// clears the visibility threshold. Nil in competition mode.
        var windHold: TargetWindHold?
        /// Aim→green-center, whole meters; nil without a green.
        var remainingToGreenM: Int?
    }

    /// Origin the reticle measures from — the same chain as `origin`: the
    /// (gated) live GPS fix, else the transient browse origin, else the
    /// active tee. GPS mode aims from the player's position; browse mode
    /// from the browse origin.
    private var reticleOrigin: LatLon? { origin }

    /// Raw planar origin→reticle distance — the pan-state big number. O(1),
    /// safe to read every camera-change frame.
    var reticlePanDistanceM: Double? {
        guard let origin = reticleOrigin, let target = reticleTarget else { return nil }
        return Distance.planarMeters(origin, target)
    }

    /// Pan club: first club whose carry reaches the raw distance (else the
    /// longest). Dispersion width is advice → competition-gated.
    var reticlePanClub: ClubRecord? {
        guard !competitionMode, let distance = reticlePanDistanceM else { return nil }
        return BrowseReticle.panClub(clubs: clubs, distanceM: distance)
    }

    /// Pan arc: the pan club's lateral dispersion drawn at the reticle
    /// distance, centered on the aim line (WGS84 open polyline). Nil without
    /// a pan club or when the reticle sits on the origin.
    var reticlePanArc: [LatLon]? {
        guard let origin = reticleOrigin, let target = reticleTarget,
              let distance = reticlePanDistanceM, distance > 0,
              let club = reticlePanClub
        else { return nil }
        let o = Sweref99TM.fromWGS84(origin)
        let t = Sweref99TM.fromWGS84(target)
        let arc = BrowseReticle.arcPolyline(
            origin: Vec2(x: o.x, y: o.y),
            bearingDeg: Self.planarBearing(from: o, to: t),
            radiusM: distance,
            halfWidthM: BrowseReticle.lateralHalfWidthM(club: club, atDistanceM: distance)
        )
        return arc.map { Sweref99TM.toWGS84(x: $0.x, y: $0.y) }
    }

    /// Raw planar aim→green-center, whole meters — the pan-state remaining
    /// figure. The settled snapshot carries its own plays-like-era copy
    /// (`ReticleSettled.remainingToGreenM`); identical geometry, cached there.
    var reticleRemainingToGreenM: Int? {
        guard let target = reticleTarget, reticleOrigin != nil,
              let green = targets.greenCenter else { return nil }
        return Int(Distance.planarMeters(target, green).rounded())
    }

    /// Dotted continuation past the aim along the same bearing — "where you
    /// end up if you fly it": the remaining green-line length, capped at how
    /// far past the aim the longest club would carry (the cap is club data →
    /// competition mode keeps the plain remaining length). Nil when nothing
    /// bounds it or the bounded length vanishes.
    var reticleDottedExtension: [LatLon]? {
        guard let origin = reticleOrigin, let target = reticleTarget,
              let raw = reticlePanDistanceM, raw > 0 else { return nil }
        var length = Double.infinity
        if let green = targets.greenCenter {
            length = Distance.planarMeters(target, green)
        }
        if !competitionMode, let longest = clubs.map(\.carryM).max() {
            length = min(length, max(0, longest - raw))
        }
        guard length.isFinite, length > 0.5 else { return nil }
        let o = Sweref99TM.fromWGS84(origin)
        let t = Sweref99TM.fromWGS84(target)
        return [
            target,
            Sweref99TM.toWGS84(
                x: t.x + (t.x - o.x) / raw * length,
                y: t.y + (t.y - o.y) / raw * length
            ),
        ]
    }

    /// The reticle group for the map (RB4): aim line + dotted extension +
    /// pan arc always; the settled pieces (ellipse, neighbor arcs, wind hold)
    /// only once the camera settles — pan-start empties them via
    /// `reticleSettled = nil`, so the settled layers hide while panning.
    var reticleOverlay: ReticleOverlay? {
        // A tool owning the map keeps a stale reticle target from drawing —
        // the reticle only reports (and only makes sense) in distance mode.
        guard toolMode == .none else { return nil }
        // D-HF4: nothing draws while the hole-entry camera flies — the line,
        // labels and dispersion overlays appear at first settle, computed
        // from the world-coordinate default aim.
        guard !reticleAwaitingEntrySettle else { return nil }
        guard let origin = reticleOrigin, let target = reticleTarget else { return nil }
        var overlay = ReticleOverlay(aimLine: [origin, target])
        overlay.dottedExtension = reticleDottedExtension ?? []
        overlay.panArc = reticlePanArc ?? []
        if !reticleIsPanning, let settled = reticleSettled {
            overlay.ellipse = settled.ellipse
            if let club = settled.advisedClub, let position = settled.ellipseLabelPosition {
                overlay.ellipseLabel = EllipseLabel(position: position, text: club, boxed: true)
            }
            overlay.neighborArcs = settled.neighborArcs.map {
                ReticleOverlay.NeighborArc(label: $0.clubName, polyline: $0.polyline)
            }
            overlay.windHold = settled.windHold
        }
        return overlay
    }

    /// The focused-ladder aim visuals, riding the reticle overlay group: while
    /// a rail rung is focused (tap in the ladder) the FOCUSED target owns the
    /// aim — a dotted origin→target line plus the recommended club's
    /// dispersion ellipse, on-map label and wind hold. The reticle's own line,
    /// arcs and ellipse stand down while this is up (`overlays` prefers it);
    /// the next user pan releases the focus and the reticle takes over again.
    /// Nil outside browse-mode ladder focus or without a positioned row.
    var ladderFocusOverlay: ReticleOverlay? {
        guard isBrowseMode, toolMode == .none, focusedLadderId != nil,
              let row = selectedLadderRow, let position = row.position,
              let origin else { return nil }
        var overlay = ReticleOverlay()
        overlay.dottedExtension = [origin, position]
        if let ellipse = selectedTargetEllipse { overlay.ellipse = ellipse }
        overlay.ellipseLabel = selectedTargetEllipseLabel
        overlay.windHold = selectedTargetWindHold
        return overlay
    }

    /// Camera reticle callback (RB2). While panning: track the point, drop
    /// the settled layer and any pending settle — the cheap pan snapshot IS
    /// the computed properties above, nothing is stored per frame. On idle:
    /// debounce `reticleSettleSleep` (200 ms), then compute the full settled
    /// snapshot once.
    func reticleMoved(_ p: LatLon, panning: Bool, metersPerPoint: Double? = nil) {
        guard currentHole != nil else { return }
        var p = p
        // D-HF4: while the hole-entry camera is in flight the screen anchor
        // is meaningless — panning reports are the animation itself
        // (ignored: the aim is never derived from unprojecting the anchor
        // mid-flight), and the idle report settles from the WORLD default
        // aim (with a clamped zoom the aim legitimately sits off-anchor).
        // The first pan AFTER the camera landed is the user taking over:
        // the gate lifts and the screen-anchor path resumes.
        if reticleAwaitingEntrySettle {
            if panning {
                guard holeEntryCameraIdled else { return }
                reticleAwaitingEntrySettle = false
            } else {
                holeEntryCameraIdled = true
                p = reticleTarget ?? p
            }
        }
        // A focused ladder rung owns the aim visuals (dotted line + advice
        // ellipse to the FOCUSED target). Camera reports from its own
        // centering animation only track the target quietly; once that settle
        // has landed, the next user pan hands the map back to the reticle.
        if focusedLadderId != nil {
            if !(panning && ladderFocusCameraSettled) {
                if !panning { ladderFocusCameraSettled = true }
                reticleTarget = p
                return
            }
            mapFocus = nil
            focusedLadderId = nil
        }
        reticleSettleTask?.cancel()
        reticleTarget = p
        if panning {
            reticleIsPanning = true
            reticleSettled = nil
            return
        }
        reticleIsPanning = false
        reticleSettleTask = Task { [weak self] in
            guard let sleep = self?.reticleSettleSleep else { return }
            try? await sleep()
            guard !Task.isCancelled, let self,
                  self.reticleTarget == p, !self.reticleIsPanning else { return }
            await self.settleReticle(at: p)
        }
    }

    /// The once-per-settle computation: elevation samples, plays-like, the
    /// re-picked club's ellipse + wind hold, neighbor arcs, remaining.
    private func settleReticle(at target: LatLon) async {
        guard let origin = reticleOrigin else { return }

        // Elevations: the origin's known value (browse-origin sample / tee
        // record), else a fresh terrain sample; the reticle point is always
        // sampled here — the once-per-settle budget covers it.
        var originElev = originElevation
        var targetElev: Double?
        if let sampler = elevationSampler {
            targetElev = await sampler(target)
            if originElev == nil { originElev = await sampler(origin) }
        }
        // Async gap: a new pan or hole switch invalidates this settle (a mode
        // flip cancels the task via `resettleReticleAfterOriginChange`).
        guard !Task.isCancelled, reticleTarget == target, !reticleIsPanning else { return }

        let o = Sweref99TM.fromWGS84(origin)
        let t = Sweref99TM.fromWGS84(target)
        let rawM = hypot(t.x - o.x, t.y - o.y)
        guard rawM > 0 else { return }
        let bearing = Self.planarBearing(from: o, to: t)

        // Plays-like: slope first (withheld in competition mode — same rule
        // as `playsAsAndElevation`), then the wind "plays as".
        var playsLike = rawM
        var elevationDeltaM: Int?
        if !competitionMode, let oe = originElev, let te = targetElev {
            let stats = PlaysLike.segmentStats(
                PlaysLike.Point(e: o.x, n: o.y, elevation: oe),
                PlaysLike.Point(e: t.x, n: t.y, elevation: te)
            )
            if let pl = stats.playsLikeSimple { playsLike = pl }
            elevationDeltaM = Int((te - oe).rounded())
        }
        if let wind = effectiveWind {
            playsLike = playsAsM(playsLike, windEffect(wind.speedMps, wind.directionDeg, bearing, playsLike))
        }

        var remainingToGreenM: Int?
        if let green = targets.greenCenter {
            remainingToGreenM = Int(Distance.planarMeters(target, green).rounded())
        }

        // Advice content — competition mode keeps the distances only (same
        // gating as `selectedTargetEllipse`).
        var advisedClub: String?
        var ellipse: [LatLon] = []
        var ellipseLabelPosition: LatLon?
        var neighborArcs: [ReticleSettled.NeighborArc] = []
        var windHold: TargetWindHold?
        if !competitionMode,
           let club = BrowseReticle.panClub(clubs: clubs, distanceM: playsLike) {
            advisedClub = club.name
            if let viz = computeSelectedTargetVisualization(
                origin: origin, targetPosition: target, club: club, elevationDeltaM: elevationDeltaM
            ) {
                ellipse = viz.ellipse
                windHold = viz.hold
                // Name the advised club ON the map, at the ellipse's right
                // edge — the same side `arcPolyline` ends on, so the three
                // club labels line up and read in distance order.
                let planarRing = ellipse.map { p -> Vec2 in
                    let s = Sweref99TM.fromWGS84(p)
                    return Vec2(x: s.x, y: s.y)
                }
                if let anchor = BrowseReticle.rightmostPoint(
                    ring: planarRing, bearingDeg: bearing
                ) {
                    ellipseLabelPosition = Sweref99TM.toWGS84(x: anchor.x, y: anchor.y)
                }
            }
            // Neighbor arcs at their own plays-like-adjusted carries: the
            // ground radius that plays like each club's nominal carry along
            // this line (rawM/playsLike ground meters per plays-like meter),
            // each arc at the club's own full-carry half-width.
            let groundPerPlaysLike = playsLike > 0 ? rawM / playsLike : 1
            let neighbors = BrowseReticle.neighborClubs(clubs: clubs, around: club)
            for neighbor in [neighbors.shorter, neighbors.longer].compactMap({ $0 }) {
                let radiusM = neighbor.carryM * groundPerPlaysLike
                guard radiusM > 0 else { continue }
                let arc = BrowseReticle.arcPolyline(
                    origin: Vec2(x: o.x, y: o.y),
                    bearingDeg: bearing,
                    radiusM: radiusM,
                    halfWidthM: BrowseReticle.lateralHalfWidthM(
                        club: neighbor, atDistanceM: neighbor.carryM
                    )
                )
                neighborArcs.append(ReticleSettled.NeighborArc(
                    clubName: neighbor.name,
                    polyline: arc.map { Sweref99TM.toWGS84(x: $0.x, y: $0.y) }
                ))
            }
        }

        reticleSettledOrigin = origin
        // D-HF4: first settle after hole entry — the gate lifts and the
        // overlays render from the settled world-coordinate aim.
        reticleAwaitingEntrySettle = false
        reticleSettled = ReticleSettled(
            playsLikeM: Int(playsLike.rounded()),
            advisedClub: advisedClub,
            ellipse: ellipse,
            ellipseLabelPosition: ellipseLabelPosition,
            neighborArcs: neighborArcs,
            windHold: windHold,
            remainingToGreenM: remainingToGreenM
        )
    }

    /// Compass bearing (0° = north, clockwise) between planar points.
    private static func planarBearing(from o: Sweref99TM.Point, to t: Sweref99TM.Point) -> Double {
        let deg = atan2(t.x - o.x, t.y - o.y) * 180 / .pi
        return deg < 0 ? deg + 360 : deg
    }

    /// Overridable for tests; the persisted default is 230 m.
    func setAimRoutingThresholdMeters(_ meters: Double) {
        aimRoutingThresholdMeters = meters
        defaults.set(meters, forKey: Self.aimRoutingThresholdKey)
    }

    // MARK: - Tee override (local tee move — Adjust mode + `-moveTee` debug hook)

    private static func teeOverrideKey(courseId: String, holeId: String, teeName: String) -> String {
        "onCourse.teeOverride.\(courseId).\(holeId).\(teeName)"
    }

    private func loadTeeOverrides() {
        teeOverrides = [:]
        for hole in holes {
            for tee in hole.tees {
                let key = Self.teeOverrideKey(courseId: courseId, holeId: hole.id, teeName: tee.name)
                if let encoded = defaults.string(forKey: key),
                   let point = Self.decodeLatLon(encoded) {
                    teeOverrides[hole.id, default: [:]][tee.name] = point
                }
            }
        }
    }

    private static func encodeLatLon(_ p: LatLon) -> String { "\(p.lat),\(p.lon)" }
    private static func decodeLatLon(_ s: String) -> LatLon? {
        let parts = s.split(separator: ",")
        guard parts.count == 2, let lat = Double(parts[0]), let lon = Double(parts[1]) else { return nil }
        return LatLon(lat: lat, lon: lon)
    }

    /// Central tee-position accessor: the moved override (browse-mode) when one
    /// exists for this hole's active tee, else the stored tee coordinate. ALL
    /// tee-position reads route through this so overrides are honored in
    /// bounds, bearing, route, distances and playing length.
    func teePosition(for hole: HoleData) -> LatLon? {
        guard let tee = activeTee(for: hole) else { return nil }
        if let moved = teeOverrides[hole.id]?[tee.name] {
            return moved
        }
        return LatLon(lat: tee.lat, lon: tee.lon)
    }

    /// Elevation for the tee origin: nil when an override is in effect (the
    /// moved point has no stored elevation — plays-like degrades to nil), else
    /// the stored tee elevation.
    private func teeElevation(for hole: HoleData) -> Double? {
        guard let tee = activeTee(for: hole) else { return nil }
        if teeOverrides[hole.id]?[tee.name] != nil { return nil }
        return tee.elevation
    }

    /// True when the current hole's active tee has a local override.
    var currentTeeHasOverride: Bool {
        guard let hole = currentHole, let tee = activeTee(for: hole) else { return false }
        return teeOverrides[hole.id]?[tee.name] != nil
    }

    /// Move the current hole's active tee to `position` and persist it.
    /// The browse-mode long-press that used to call this is RETIRED (it
    /// recognized simultaneously with MapLibre's quick-zoom, so the map
    /// zoomed while the tee moved) — moves now go through the Adjust-mode
    /// drag (`moveHandle`/`endHandleDrag`, same override storage). Kept for
    /// the `-moveTee` debug hook and tests.
    func moveActiveTee(to position: LatLon) {
        guard let hole = currentHole, let tee = activeTee(for: hole) else { return }
        teeOverrides[hole.id, default: [:]][tee.name] = position
        defaults.set(
            Self.encodeLatLon(position),
            forKey: Self.teeOverrideKey(courseId: courseId, holeId: hole.id, teeName: tee.name)
        )
        // No camera change — moving a tee must not re-frame (zoom) the map.
    }

    /// Remove the current hole's active-tee override (reset affordance).
    func resetActiveTee() {
        guard let hole = currentHole, let tee = activeTee(for: hole) else { return }
        guard teeOverrides[hole.id]?[tee.name] != nil else { return }
        teeOverrides[hole.id]?[tee.name] = nil
        defaults.removeObject(
            forKey: Self.teeOverrideKey(courseId: courseId, holeId: hole.id, teeName: tee.name)
        )
        // No camera change.
    }

    // MARK: - Adjust overrides (aim points + green center)

    /// Stable Adjust-handle id for the active tee.
    static let teeHandleID = "tee"
    /// Stable Adjust-handle id for the green center.
    static let greenHandleID = "green"
    /// Stable Adjust-handle id for one aim point record.
    static func aimHandleID(_ aimId: String) -> String { "aim.\(aimId)" }

    private static func aimOverrideKey(courseId: String, holeId: String, aimId: String) -> String {
        "onCourse.aimOverride.\(courseId).\(holeId).\(aimId)"
    }

    private static func greenOverrideKey(courseId: String, holeId: String) -> String {
        "onCourse.greenOverride.\(courseId).\(holeId)"
    }

    private func loadAdjustOverrides() {
        aimOverrides = [:]
        greenOverrides = [:]
        for hole in holes {
            for aim in hole.aimPoints {
                let key = Self.aimOverrideKey(courseId: courseId, holeId: hole.id, aimId: aim.id)
                if let encoded = defaults.string(forKey: key),
                   let point = Self.decodeLatLon(encoded) {
                    aimOverrides[hole.id, default: [:]][aim.id] = point
                }
            }
            if hole.green != nil {
                let key = Self.greenOverrideKey(courseId: courseId, holeId: hole.id)
                if let encoded = defaults.string(forKey: key),
                   let point = Self.decodeLatLon(encoded) {
                    greenOverrides[hole.id] = point
                }
            }
        }
    }

    /// Central aim-position accessor: the moved override when one exists,
    /// else the stored coordinate. ALL aim-position reads route through this
    /// (targets, route, leg labels, playing length, camera bounds).
    func aimPosition(for aim: AimPointRecord, in hole: HoleData) -> LatLon {
        aimOverrides[hole.id]?[aim.id] ?? LatLon(lat: aim.lat, lon: aim.lon)
    }

    /// Central green-center accessor: the moved override when one exists,
    /// else the stored center. Moves the CENTER target only — front/back
    /// markers and the green-analysis polygon keep their stored positions.
    func greenCenterPosition(for hole: HoleData) -> LatLon? {
        guard let green = hole.green else { return nil }
        return greenOverrides[hole.id] ?? LatLon(lat: green.centerLat, lon: green.centerLon)
    }

    // MARK: - Today's-pin override (per hole, per day — spec §5 / L3)

    private static func pinOverrideKey(courseId: String, holeId: String) -> String {
        "onCourse.pinOverride.\(courseId).\(holeId)"
    }

    /// Local-calendar day formatter (`yyyy-MM-dd`, en_US_POSIX, LOCAL time
    /// zone) — a pin day is a local-calendar day, so the stamp and the
    /// today-comparison both go through here.
    private static let pinDayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static func dayString(_ date: Date) -> String { pinDayFormatter.string(from: date) }

    private static func encodePinOverride(_ o: PinOverride, day: String) -> String {
        "\(o.position.lat),\(o.position.lon)|\(o.source.rawValue)|\(day)"
    }

    /// Decodes `"lat,lon|source|yyyy-MM-dd"`; nil on any malformed field.
    private static func decodePinOverride(_ s: String) -> (override: PinOverride, day: String)? {
        let parts = s.split(separator: "|", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        let coords = parts[0].split(separator: ",")
        guard coords.count == 2, let lat = Double(coords[0]), let lon = Double(coords[1]),
              let source = PinSpec.Source(rawValue: String(parts[1])) else { return nil }
        return (PinOverride(position: LatLon(lat: lat, lon: lon), source: source), String(parts[2]))
    }

    /// Loads today's pin overrides from `defaults`. An entry stamped with any
    /// day other than today (current calendar, local time zone) is a stale
    /// daily fact: it is dropped from memory AND its persisted default removed,
    /// so yesterday's pin never leaks into today's round (spec L3).
    private func loadPinOverrides() {
        pinOverrides = [:]
        let today = Self.dayString(now())
        for hole in holes {
            let key = Self.pinOverrideKey(courseId: courseId, holeId: hole.id)
            guard let encoded = defaults.string(forKey: key) else { continue }
            guard let decoded = Self.decodePinOverride(encoded), decoded.day == today else {
                defaults.removeObject(forKey: key)
                continue
            }
            pinOverrides[hole.id] = decoded.override
        }
    }

    /// Short source tag shown on the distance card's pin label when an override
    /// wins (replaces the furniture pin's name).
    static func pinSourceTag(_ source: PinSpec.Source) -> String {
        switch source {
        case .laser: return "Laser"
        case .sheet: return "Sheet"
        case .visual: return "Visual"
        }
    }

    /// Place today's pin for `holeId` and persist it (stamped with today's local
    /// day). Observable — `targets` picks it up on the next read.
    func setPinOverride(_ position: LatLon, source: PinSpec.Source, forHole holeId: String) {
        let override = PinOverride(position: position, source: source)
        pinOverrides[holeId] = override
        defaults.set(
            Self.encodePinOverride(override, day: Self.dayString(now())),
            forKey: Self.pinOverrideKey(courseId: courseId, holeId: holeId)
        )
    }

    /// Clear today's pin for `holeId`; `targets` falls back to the furniture pin.
    func clearPinOverride(forHole holeId: String) {
        guard pinOverrides[holeId] != nil else { return }
        pinOverrides[holeId] = nil
        defaults.removeObject(forKey: Self.pinOverrideKey(courseId: courseId, holeId: holeId))
    }

    // MARK: - GPS origin calibration (spec §6 / L4)

    /// Install a freshly solved GPS-bias calibration (anchor or trilateration).
    /// Observable — `origin` and every distance downstream pick up the
    /// correction on the next read. Not persisted (see `originCalibration`).
    func applyCalibration(_ c: OriginCalibration) {
        originCalibration = c
    }

    /// Drop the calibration entirely — distances revert to raw GPS.
    func clearCalibration() {
        originCalibration = nil
    }

    /// Feed one FIXED-feature laser residual (|laser − corrected-map distance|,
    /// metres) through the decay gate (spec §6.4) and replace `originCalibration`
    /// with the returned value. ≤ confirm refreshes it (solvedAt = now, base
    /// confidence restored); ≥ reject marks it stale; between is inconclusive.
    /// Returns the gate outcome (discardable). `.inconclusive` no-op when there
    /// is no active calibration to validate.
    @discardableResult
    func registerLaserResidual(_ residualM: Double) -> OriginCalibration.ResidualOutcome {
        guard let calibration = originCalibration else { return .inconclusive }
        let (updated, outcome) = calibration.registeringResidual(residualM, now: now())
        originCalibration = updated
        return outcome
    }

    /// Contextual route for the card's single laser entry. A calibration that
    /// exists but has decayed below the confidence floor is NOT live: the next
    /// fixed-feature shot starts/restarts trilateration rather than validating
    /// a correction that is no longer being applied.
    func laserRoute(distanceM: Double) -> LaserInputRouter.Route {
        let live: Bool
        if case .active = calibrationStatus { live = true } else { live = false }
        return LaserInputRouter.route(
            distanceM: distanceM,
            hasPickedFeature: browseTarget != nil,
            hasLiveCalibration: live,
            canSolvePin: currentGreenFrame != nil
        )
    }

    /// Record the plain carry comparison for a shot at `target`, using the
    /// corrected live fix when its confidence clears the floor and raw GPS
    /// otherwise. Browse mode deliberately does not substitute the tee/browse
    /// origin: this observation was physically shot from the player's GPS fix.
    @discardableResult
    func recordLaserCarry(distanceM: Double, target: LatLon) -> LaserCarryCheck? {
        guard let rawFix = userLocation else { return nil }
        let shotOrigin = Self.corrected(rawFix, with: originCalibration, now: now())
        let check = LaserCarryCheck(
            target: target,
            laserDistanceM: distanceM,
            mappedDistanceM: Distance.planarMeters(shotOrigin, target)
        )
        lastLaserCarryCheck = check
        return check
    }

    /// Live-calibration path for one fixed-feature laser shot. The same delta
    /// rendered as the carry check is the signed residual fed into §6.4's gate.
    /// Callers route first; if calibration is below the confidence floor this
    /// returns `.inconclusive` and leaves it for a new trilateration session.
    @discardableResult
    func registerLaserShot(distanceM: Double, target: LatLon) -> OriginCalibration.ResidualOutcome {
        guard case .active = calibrationStatus,
              let check = recordLaserCarry(distanceM: distanceM, target: target)
        else { return .inconclusive }
        return registerLaserResidual(check.deltaM)
    }

    /// UI-facing calibration state for the distance card's badge.
    enum CalibrationStatus: Equatable {
        /// No calibration installed — raw GPS.
        case none
        /// Live and applied; `confidence` is the effective (age × distance) trust.
        case active(confidence: Double)
        /// Installed but not trusted (decayed below the floor, or invalidated by
        /// a bad residual / GPS discontinuity) — raw GPS with an "uncalibrated"
        /// badge.
        case stale
    }

    /// The calibration state to show, evaluated at `now()` and the current raw
    /// fix's distance-from-solve (falls back to 0 distance when there is no fix,
    /// so age decay alone decides). `.active` iff the bias is actually being
    /// applied (effective confidence ≥ floor); otherwise `.stale`.
    var calibrationStatus: CalibrationStatus {
        guard let c = originCalibration else { return .none }
        let distanceFromSolveM = userLocation.map { Distance.planarMeters($0, c.solvedNear) } ?? 0
        guard c.appliedBias(now: now(), distanceFromSolveM: distanceFromSolveM) != nil else {
            return .stale
        }
        return .active(confidence: c.confidence(now: now(), distanceFromSolveM: distanceFromSolveM))
    }

    /// A between-fixes planar jump beyond this (metres) invalidates an active
    /// calibration (spec §6.4): normal walking between ~1 Hz fixes is a few
    /// metres, so a jump this large is canopy exit / signal reacquisition — a
    /// GPS discontinuity that may have shifted the common-mode bias.
    static let calibrationJumpInvalidationM = 50.0

    /// Mark an active calibration stale when the fix jumps past
    /// `calibrationJumpInvalidationM` between updates (spec §6.4 GPS
    /// discontinuity). Kept-but-stale so the badge flips to "uncalibrated"
    /// rather than silently trusting a bias solved before the discontinuity.
    /// No-op without an active (non-stale) calibration or without both fixes.
    private func invalidateCalibrationOnGPSJump(from previous: LatLon?, to next: LatLon?) {
        guard var c = originCalibration, !c.stale,
              let previous, let next,
              Distance.planarMeters(previous, next) > Self.calibrationJumpInvalidationM
        else { return }
        c.stale = true
        originCalibration = c
    }

    // MARK: - Pin placement orchestration (green frame + voice solve → override)

    /// The current hole's green-local frame (spec §3), built from the lie-map
    /// green ring, the active tee and the green centre (all EPSG:3006). Nil when
    /// any piece is missing or degenerate (no tee / no green / ring < 3 pts).
    var currentGreenFrame: GreenFrame? {
        guard let hole = currentHole,
              let center = greenCenterPosition(for: hole),
              let tee = teePosition(for: hole) else { return nil }
        let centerPlanar = Self.planar(center)
        let ring = greenRing(near: centerPlanar)
        guard ring.points.count >= 3 else { return nil }
        return GreenFrame(
            outerRing: ring.points,
            teePlanar: Self.planar(tee),
            greenCenterPlanar: centerPlanar
        )
    }

    /// Resolve a parsed voice phrase against the current green frame, measuring
    /// laser depth from the effective `origin` (GPS fix, else browse origin,
    /// else tee) in planar coords. Nil when there is no frame; a `.laser` phrase
    /// also needs an origin (the solver returns nil without one).
    func resolvePinPhrase(_ phrase: PinPhrase) -> PinPlacementSolver.Resolution? {
        guard let frame = currentGreenFrame else { return nil }
        return PinPlacementSolver.resolve(
            phrase: phrase,
            frame: frame,
            originPlanar: origin.map(Self.planar)
        )
    }

    /// Commit a resolved phrase as the current hole's today's-pin override
    /// (converts the spec back to WGS84 through the frame).
    func commitPin(_ resolution: PinPlacementSolver.Resolution) {
        guard let hole = currentHole, let frame = currentGreenFrame else { return }
        let position = PinPlacementSolver.pinWGS84(spec: resolution.spec, frame: frame)
        setPinOverride(position, source: resolution.spec.source, forHole: hole.id)
    }

    /// Direct commit of a drag-adjusted pin (position already WGS84) — the
    /// confirm UI's one-tap path.
    func commitPin(at position: LatLon, source: PinSpec.Source) {
        guard let hole = currentHole else { return }
        setPinOverride(position, source: source, forHole: hole.id)
    }

    // MARK: - Adjust mode (draggable handles)

    /// The draggable handles for the current hole: active tee ("T"), each aim
    /// point ("A1", "A2", …) and the green center ("G"), at their
    /// override-aware positions. Rendered + hit-tested by `CourseMapView`
    /// while `.adjust` is active.
    var adjustHandles: [AdjustHandle] {
        guard let hole = currentHole else { return [] }
        var handles: [AdjustHandle] = []
        if let tee = teePosition(for: hole) {
            handles.append(AdjustHandle(id: Self.teeHandleID, kind: .tee, label: "T", position: tee))
        }
        for (index, aim) in hole.aimPoints.enumerated() {
            handles.append(AdjustHandle(
                id: Self.aimHandleID(aim.id),
                kind: .aim,
                label: "A\(index + 1)",
                position: aimPosition(for: aim, in: hole)
            ))
        }
        if let green = greenCenterPosition(for: hole) {
            handles.append(AdjustHandle(id: Self.greenHandleID, kind: .green, label: "G", position: green))
        }
        return handles
    }

    /// The handle being dragged right now, or nil. Set by `beginHandleDrag`,
    /// cleared by `endHandleDrag` / tool exit / hole navigation.
    private(set) var draggingHandleID: String?

    /// A handle was grabbed on the map (Adjust mode only).
    func beginHandleDrag(id: String) {
        guard toolMode == .adjust, adjustHandles.contains(where: { $0.id == id }) else { return }
        draggingHandleID = id
    }

    /// Live drag frame OR direct move: updates the element's in-memory
    /// override so every derived output (route, distances, labels, handles)
    /// recomputes immediately. NOT persisted and no camera bump — the map
    /// must hold perfectly still under the finger; `endHandleDrag` /
    /// `setHandleOverride` persist.
    func moveHandle(id: String, to position: LatLon) {
        guard let hole = currentHole else { return }
        switch id {
        case Self.teeHandleID:
            guard let tee = activeTee(for: hole) else { return }
            teeOverrides[hole.id, default: [:]][tee.name] = position
        case Self.greenHandleID:
            guard hole.green != nil else { return }
            greenOverrides[hole.id] = position
        default:
            guard let aim = hole.aimPoints.first(where: { Self.aimHandleID($0.id) == id }) else { return }
            aimOverrides[hole.id, default: [:]][aim.id] = position
        }
    }

    /// Drop: persist the dragged handle's current position and end the drag.
    func endHandleDrag() {
        guard let id = draggingHandleID else { return }
        draggingHandleID = nil
        persistOverride(id: id)
    }

    /// Move + persist in one step — the same accessor/persistence path a drag
    /// commit takes. Used by the `-adjustMove` debug hook.
    func setHandleOverride(id: String, to position: LatLon) {
        moveHandle(id: id, to: position)
        persistOverride(id: id)
    }

    /// Writes the element's current in-memory override to `defaults`. A moved
    /// green center re-samples the terrain elevation at the new point (its
    /// stored elevation belongs to the original center).
    private func persistOverride(id: String) {
        guard let hole = currentHole else { return }
        switch id {
        case Self.teeHandleID:
            guard let tee = activeTee(for: hole),
                  let position = teeOverrides[hole.id]?[tee.name] else { return }
            defaults.set(
                Self.encodeLatLon(position),
                forKey: Self.teeOverrideKey(courseId: courseId, holeId: hole.id, teeName: tee.name)
            )
        case Self.greenHandleID:
            guard let position = greenOverrides[hole.id] else { return }
            defaults.set(
                Self.encodeLatLon(position),
                forKey: Self.greenOverrideKey(courseId: courseId, holeId: hole.id)
            )
            refreshGreenElevationFallback()
        default:
            guard let aim = hole.aimPoints.first(where: { Self.aimHandleID($0.id) == id }),
                  let position = aimOverrides[hole.id]?[aim.id] else { return }
            defaults.set(
                Self.encodeLatLon(position),
                forKey: Self.aimOverrideKey(courseId: courseId, holeId: hole.id, aimId: aim.id)
            )
            // A moved aim degrades its stored elevation to nil, so its rung now
            // depends on a terrain sample at the new point — force a re-sweep.
            refreshLadderElevations(force: true)
        }
    }

    /// Handle ids on the current hole that carry an override (badging + the
    /// Reset button's enabled state). Tee overrides are reported for the
    /// ACTIVE tee; `currentHoleHasAdjustments` also counts inactive tees.
    var overriddenHandleIDs: Set<String> {
        guard let hole = currentHole else { return [] }
        var ids: Set<String> = []
        if let tee = activeTee(for: hole), teeOverrides[hole.id]?[tee.name] != nil {
            ids.insert(Self.teeHandleID)
        }
        for aim in hole.aimPoints where aimOverrides[hole.id]?[aim.id] != nil {
            ids.insert(Self.aimHandleID(aim.id))
        }
        if greenOverrides[hole.id] != nil {
            ids.insert(Self.greenHandleID)
        }
        return ids
    }

    /// True when ANY element of the current hole is overridden (any tee name,
    /// any aim, or the green center) — the Reset button's enabled state.
    var currentHoleHasAdjustments: Bool {
        guard let hole = currentHole else { return false }
        return !(teeOverrides[hole.id]?.isEmpty ?? true)
            || !(aimOverrides[hole.id]?.isEmpty ?? true)
            || greenOverrides[hole.id] != nil
    }

    /// Per-hole reset: clears EVERY override on the current hole — all tee
    /// names, all aim points and the green center — in memory and in
    /// `defaults`, then re-fits the camera to the restored furniture.
    func resetCurrentHoleAdjustments() {
        guard let hole = currentHole else { return }
        draggingHandleID = nil
        for tee in hole.tees where teeOverrides[hole.id]?[tee.name] != nil {
            teeOverrides[hole.id]?[tee.name] = nil
            defaults.removeObject(
                forKey: Self.teeOverrideKey(courseId: courseId, holeId: hole.id, teeName: tee.name)
            )
        }
        for aim in hole.aimPoints where aimOverrides[hole.id]?[aim.id] != nil {
            aimOverrides[hole.id]?[aim.id] = nil
            defaults.removeObject(
                forKey: Self.aimOverrideKey(courseId: courseId, holeId: hole.id, aimId: aim.id)
            )
        }
        if greenOverrides[hole.id] != nil {
            greenOverrides[hole.id] = nil
            defaults.removeObject(forKey: Self.greenOverrideKey(courseId: courseId, holeId: hole.id))
            refreshGreenElevationFallback()
        }
        // No camera change — Reset hole must not re-frame (zoom) the map.
    }

    // MARK: - Location + elevation

    /// Feeds a GPS fix (or nil on loss) and kicks an async terrain sample for
    /// the plays-like elevation.
    func updateUserLocation(_ location: LatLon?) {
        // Adoption check input: whether an effective fix existed BEFORE this
        // update (nil → non-nil below is "GPS fix adopted", an origin change).
        let hadEffectiveFix = effectiveUserLocation != nil
        // Invalidate a calibration across a GPS discontinuity (spec §6.4) BEFORE
        // the fix is overwritten — the check compares the previous fix to the new one.
        invalidateCalibrationOnGPSJump(from: userLocation, to: location)
        userLocation = location
        // Re-sweep the ladder-target elevations. The sweep self-gates: it runs
        // when the origin has moved meaningfully OR any current target cell is
        // still uncached, so a stationary user whose bag/targets changed still
        // gets sampled; pure GPS jitter with a full cache reuses it.
        refreshLadderElevations()
        // Round loop R5: the live fix may have walked onto the next tee. Runs
        // BEFORE the elevation-sampler early-return below so the geofence still
        // fires when no terrain sampler is installed.
        refreshTeeGeofence()
        // GPS fix ADOPTED (origin flips tee → live fix): an origin change per
        // D-HF1 — the reticle aim resets to the resolver's default. Walking
        // drift below is NOT adoption: the aim stays parked and only the
        // settled answer re-measures.
        if !hadEffectiveFix, effectiveUserLocation != nil {
            applyDefaultAim()
        }
        // A settled reticle answer measures from the origin at settle time —
        // in GPS mode that origin walks with the player. Re-settle once the
        // fix drifts meaningfully; jitter below the threshold keeps the answer.
        else if reticleSettled != nil, let anchor = reticleSettledOrigin,
                let fix = effectiveUserLocation,
                Distance.planarMeters(anchor, fix) > Self.reticleOriginResettleM {
            resettleReticleAfterOriginChange()
        }
        userElevationTask?.cancel()
        guard let location, let sampler = elevationSampler else {
            userElevation = nil
            return
        }
        userElevationTask = Task { [weak self] in
            let elevation = await sampler(location)
            guard !Task.isCancelled else { return }
            self?.userElevation = elevation
        }
    }

    // MARK: - Tee geofence (round loop R5 — prompt-only hole advance)

    /// R5 tee-geofence radius: a live fix within this planar distance of the
    /// next hole's tee is treated as "the player is standing on the next tee".
    /// One place, tunable on course (sibling of `Divergence`).
    static let teeGeofenceRadiusM = 30.0

    /// The number of the next hole whose tee the live fix has walked into
    /// while the card is still on the current hole — i.e. the player moved on
    /// without holing out. A PROMPT to advance the card (R5): the screen shows
    /// an alert and calls `confirmTeeGeofenceAdvance()` / `dismissTeeGeofencePrompt()`.
    /// Never advances silently. nil = nothing pending. Only ever set while a
    /// round is active; cleared on hole change and when the fix leaves the ring.
    private(set) var teeGeofencePrompt: Int?

    /// The next-hole number a prompt was already answered for (advanced or
    /// declined), so a fix lingering inside the ring doesn't re-nag. Cleared
    /// when the fix leaves the ring (a genuine re-approach may prompt again)
    /// and on hole change.
    @ObservationIgnored private var geofenceHandledHole: Int?

    /// Re-evaluate the tee geofence against the latest (GPS-gated) fix (R5).
    /// Sets `teeGeofencePrompt` only when a round is active, a next hole
    /// exists, its tee is within `teeGeofenceRadiusM` of the fix, and we have
    /// not already answered a prompt for it. Leaving the ring clears any stale
    /// prompt and re-arms the nag guard. Browse mode (no gated fix) never
    /// fires. Capture-driven advance (hole-out) has already moved the card
    /// forward by the time the fix reaches the next tee, so this only fires
    /// when the previous hole truly has no hole-out.
    private func refreshTeeGeofence() {
        guard activeRoundStrokes != nil,
              let fix = effectiveUserLocation,
              currentHoleIndex + 1 < holes.count,
              let tee = teePosition(for: holes[currentHoleIndex + 1])
        else {
            teeGeofencePrompt = nil
            return
        }
        let nextNumber = holes[currentHoleIndex + 1].hole.number
        let inside = Distance.planarMeters(fix, tee) <= Self.teeGeofenceRadiusM
        guard inside else {
            if teeGeofencePrompt == nextNumber { teeGeofencePrompt = nil }
            if geofenceHandledHole == nextNumber { geofenceHandledHole = nil }
            return
        }
        guard geofenceHandledHole != nextNumber else { return }
        teeGeofencePrompt = nextNumber
    }

    /// The player accepted the geofence prompt: advance the card to the primed
    /// next hole (R5). Marks it handled and clears the prompt.
    func confirmTeeGeofenceAdvance() {
        guard let number = teeGeofencePrompt else { return }
        teeGeofencePrompt = nil
        geofenceHandledHole = number
        goToHole(number: number)
    }

    /// The player declined the geofence prompt: keep the card put and don't
    /// re-nag for this hole until the fix leaves and re-enters the ring (R5).
    func dismissTeeGeofencePrompt() {
        if let number = teeGeofencePrompt { geofenceHandledHole = number }
        teeGeofencePrompt = nil
    }

    /// Samples the green's terrain elevation when the record has none stored,
    /// or when the center is overridden (the stored elevation belongs to the
    /// original center, so a moved center degrades to a terrain sample at the
    /// new point).
    private func refreshGreenElevationFallback() {
        greenTerrainElevation = nil
        guard
            let hole = currentHole,
            let green = hole.green,
            green.elevation == nil || greenOverrides[hole.id] != nil,
            let sampler = elevationSampler,
            let center = greenCenterPosition(for: hole)
        else { return }
        Task { [weak self] in
            let elevation = await sampler(center)
            self?.greenTerrainElevation = elevation
        }
    }

    /// Samples terrain elevation for the CURRENT ladder targets that need one —
    /// aim points without a stored elevation, and every layup landing point —
    /// so those rungs show plays-as (elevation + wind), not just the actual
    /// distance. Fills `ladderTerrainElevations` (quantised to ~5 m) from
    /// weak-self tasks; each cell is sampled at most once (skips cells already
    /// cached or in flight).
    ///
    /// Self-healing gate: the sweep proceeds when `force` is set (hole change /
    /// sampler injection / clubs load / GPS flip / adjust commit), OR the origin
    /// moved > `ladderSweepMoveThresholdM` since the last sweep, OR any current
    /// target cell is still missing (uncached and not in flight). The move gate
    /// therefore short-circuits ONLY when a full cache means the sweep would do
    /// nothing anyway — so a stationary user whose targets appeared LATER (the
    /// bag loaded after the first fix) still gets those cells sampled, while
    /// pure GPS jitter over a full cache reuses it. Cheap on the GPS path:
    /// building the target list is a small walk over `ladderRows`.
    private func refreshLadderElevations(force: Bool = false) {
        guard let sampler = elevationSampler, let origin else { return }
        let targets = ladderElevationSampleTargets()
        guard ladderSweepShouldProceed(force: force, targets: targets, origin: origin) else { return }
        lastLadderSweepOrigin = origin

        // Bound pathological growth before this sweep's cells go in; the sweep
        // immediately repopulates whatever the current hole needs.
        if ladderTerrainElevations.count > Self.ladderElevationCacheCap {
            ladderTerrainElevations.removeAll(keepingCapacity: true)
        }

        for position in targets {
            let key = LadderCellKey(position)
            guard ladderTerrainElevations[key] == nil,
                  !ladderElevationInFlight.contains(key) else { continue }
            ladderElevationInFlight.insert(key)
            Task { [weak self] in
                let elevation = await sampler(position)
                guard let self else { return }
                self.ladderElevationInFlight.remove(key)
                if let elevation { self.ladderTerrainElevations[key] = elevation }
            }
        }
    }

    /// The self-healing sweep gate (see `refreshLadderElevations`): proceed when
    /// forced, when a current target cell is still missing (uncached and not in
    /// flight), or when the origin moved past the threshold since the last
    /// sweep. Shared by the production sweep and the DEBUG awaiting seam so both
    /// honor the identical gate.
    private func ladderSweepShouldProceed(force: Bool, targets: [LatLon], origin: LatLon) -> Bool {
        if force { return true }
        let hasMissingCell = targets.contains { position in
            let key = LadderCellKey(position)
            return ladderTerrainElevations[key] == nil && !ladderElevationInFlight.contains(key)
        }
        if hasMissingCell { return true }
        guard let last = lastLadderSweepOrigin else { return true }
        return Distance.planarMeters(origin, last) > Self.ladderSweepMoveThresholdM
    }

    /// The ladder targets whose plays-as depends on a terrain sample this hole:
    /// aim points without a stored elevation, then every layup landing point.
    /// These are the exact positions `targetElevation` later looks up, so the
    /// quantised cell keys line up between sampling and lookup.
    private func ladderElevationSampleTargets() -> [LatLon] {
        var positions: [LatLon] = []
        for aim in targets.aimPoints where aim.elevation == nil {
            positions.append(aim.position)
        }
        for row in ladderRows where row.kind == .layup {
            if let p = row.position { positions.append(p) }
        }
        return positions
    }

    /// The terrain elevation cached for `position`'s ~5 m grid cell, if the
    /// ladder-elevation sweep has filled it; nil until then.
    private func ladderTerrainElevation(at position: LatLon) -> Double? {
        ladderTerrainElevations[LadderCellKey(position)]
    }

    #if DEBUG
    /// Test seam: run a ladder-elevation sweep and AWAIT every sample, so tests
    /// assert on plays-as deterministically instead of polling the production
    /// fire-and-forget tasks. Shares both the target selection AND the gate
    /// (`ladderSweepShouldProceed`) with `refreshLadderElevations`, so a test
    /// can exercise the self-healing gate on the non-forced path by passing
    /// `force: false`. Returns whether the gate let the sweep proceed.
    ///
    /// Unlike production it does NOT skip in-flight cells (it awaits and writes
    /// them directly, idempotently): a fire-and-forget sweep the production
    /// triggers kicked may have already marked a cell in flight, and the test
    /// must still resolve it synchronously.
    @discardableResult
    func refreshLadderElevationsAwaiting(force: Bool = true) async -> Bool {
        guard let sampler = elevationSampler, let origin else { return false }
        let targets = ladderElevationSampleTargets()
        guard ladderSweepShouldProceed(force: force, targets: targets, origin: origin) else { return false }
        lastLadderSweepOrigin = origin
        if ladderTerrainElevations.count > Self.ladderElevationCacheCap {
            ladderTerrainElevations.removeAll(keepingCapacity: true)
        }
        for position in targets where ladderTerrainElevations[LadderCellKey(position)] == nil {
            if let elevation = await sampler(position) {
                ladderTerrainElevations[LadderCellKey(position)] = elevation
            }
        }
        return true
    }

    /// Test seam: drop the cached ladder terrain samples WITHOUT resetting the
    /// sweep origin, so a test can prove the self-healing gate re-samples the
    /// missing cells at an UNCHANGED origin (the move gate alone would block it).
    func debugClearLadderElevationCache() {
        ladderTerrainElevations.removeAll(keepingCapacity: true)
        ladderElevationInFlight.removeAll()
    }
    #endif

    // MARK: - Derived: origin

    /// A live fix farther than this outside the course's tile-manifest bounds
    /// is implausible as an on-course origin (course opened from home, or the
    /// simulator's default location): every raw distance against it is a
    /// meaningless multi-km figure and the layup engine rungs a ~28,000 km
    /// "hole". Such a fix is dropped in `effectiveUserLocation`, so the screen
    /// falls back to tee-based distances exactly like the no-fix case.
    static let farFromCourseThresholdM = 3_000.0

    /// Flat-earth meters from `point` to the nearest edge of `bounds`
    /// (0 inside). Deliberately NOT SWEREF99TM planar math: a far-from-course
    /// fix can be anywhere on the globe, far outside the projection's valid
    /// zone where the round-trip degrades to garbage. The equirectangular
    /// approximation is exact enough at threshold scale (km) and only grows
    /// more obviously "far" beyond it, which is all the gate needs.
    static func metersOutsideBounds(_ point: LatLon, _ bounds: MapCoordinateBounds) -> Double {
        let clampedLat = min(max(point.lat, bounds.south), bounds.north)
        let clampedLon = min(max(point.lon, bounds.west), bounds.east)
        let metersPerDegreeLat = 111_320.0
        let dLat = (point.lat - clampedLat) * metersPerDegreeLat
        let cosLat = max(cos(clampedLat * .pi / 180), 0.01)
        let dLon = (point.lon - clampedLon) * metersPerDegreeLat * cosLat
        return (dLat * dLat + dLon * dLon).squareRoot()
    }

    /// True when GPS is on and the live fix is implausibly far from the course
    /// (see `farFromCourseThresholdM`) — the UI explains the tee fallback with
    /// a "Far from course" state instead of showing absurd raw distances.
    var isFarFromCourse: Bool {
        guard gpsEnabled, let fix = userLocation else { return false }
        return Self.metersOutsideBounds(fix, courseBounds) > Self.farFromCourseThresholdM
    }

    /// The live fix, gated by the GPS switch and the far-from-course fence,
    /// and corrected by a live GPS-bias calibration: nil in browse mode.
    ///
    /// Correction seam (spec §6.1 / L4): this is the SINGLE insertion point the
    /// whole model inherits, because every distance derives from
    /// `origin`/`effectiveUserLocation`. ONLY the live GPS fix is corrected —
    /// browse origin and tee positions are map-anchored (not GPS), so `origin`'s
    /// `?? browseOrigin ?? currentTeePosition` fallbacks stay raw. A dropped bias
    /// (`appliedBias` nil: decayed / stale) yields the RAW fix, never a scaled
    /// correction (spec §6.4). Correction never nils a non-nil fix, so
    /// `isUsingGPS` and the `originElevation` presence checks are unaffected.
    private var effectiveUserLocation: LatLon? {
        guard gpsEnabled, let fix = userLocation, !isFarFromCourse else { return nil }
        return Self.corrected(fix, with: originCalibration, now: now())
    }

    /// True when distances derive from live GPS rather than the tee. False in
    /// browse mode even with a live fix.
    var isUsingGPS: Bool { effectiveUserLocation != nil }

    /// Where distances are measured from: the (gated) GPS fix, else the
    /// transient browse point, else the active tee.
    var origin: LatLon? {
        effectiveUserLocation ?? browseOrigin ?? currentTeePosition
    }

    /// Where the shot-capture crosshair drops: the live GPS fix, else (browse
    /// mode / no fix yet) the map center the user is looking at, else the
    /// active tee. Always adjustable by drag afterwards.
    var captureStartPosition: LatLon? {
        effectiveUserLocation ?? lastObservedCamera?.center ?? currentTeePosition
    }

    private var currentTeePosition: LatLon? {
        currentHole.flatMap { teePosition(for: $0) }
    }

    private var originElevation: Double? {
        if effectiveUserLocation != nil { return userElevation }
        if browseOrigin != nil { return browseOriginElevation }
        return currentHole.flatMap { teeElevation(for: $0) }
    }

    // MARK: - Derived: targets + distances

    var targets: HoleTargets {
        guard let hole = currentHole else { return HoleTargets() }
        let green = hole.green

        // activePin resolution (spec §3.3 / §5): today's-pin override → furniture
        // active pin → nil. When the override wins, the pin label becomes a short
        // source tag ("Laser"/"Sheet"/"Visual"); nothing else is disturbed.
        let furniturePin = hole.pins.first(where: \.active)
        let resolvedPin: LatLon?
        let resolvedPinName: String?
        if let override = pinOverrides[hole.id] {
            resolvedPin = override.position
            resolvedPinName = Self.pinSourceTag(override.source)
        } else {
            resolvedPin = furniturePin.map { LatLon(lat: $0.lat, lon: $0.lon) }
            resolvedPinName = furniturePin?.name
        }

        func point(_ lat: Double?, _ lon: Double?) -> LatLon? {
            guard let lat, let lon else { return nil }
            return LatLon(lat: lat, lon: lon)
        }

        // A moved green center degrades to the terrain-sampled elevation at
        // the new point (refreshGreenElevationFallback); moved aims degrade
        // their elevation to nil — the stored figures belong to the original
        // positions.
        let greenIsOverridden = greenOverrides[hole.id] != nil
        return HoleTargets(
            greenFront: point(green?.frontLat, green?.frontLon),
            greenCenter: greenCenterPosition(for: hole),
            greenBack: point(green?.backLat, green?.backLon),
            greenElevation: greenIsOverridden
                ? greenTerrainElevation
                : green?.elevation ?? greenTerrainElevation,
            activePin: resolvedPin,
            activePinName: resolvedPinName,
            aimPoints: hole.aimPoints.enumerated().map { index, aim in
                let label = aim.label.flatMap { $0.isEmpty ? nil : $0 } ?? "Aim \(index + 1)"
                let overridden = aimOverrides[hole.id]?[aim.id] != nil
                return AimTarget(
                    label: label,
                    position: aimPosition(for: aim, in: hole),
                    elevation: overridden ? nil : aim.elevation
                )
            }
        )
    }

    var distances: OnCourseDistances? {
        guard let origin else { return nil }
        return OnCourseDistances.compute(
            from: origin,
            originElevation: originElevation,
            targets: targets,
            competitionMode: competitionMode,
            wind: effectiveWind,
            clubs: clubs
        )
    }

    /// Install the course hazard rings (from features.geojson). Called by the
    /// screen after parsing the bundle. `holeIds` (parallel to `rings`) scopes
    /// each hazard to its hole; omit for untagged/course-level rings (they fall
    /// back to geometric hole assignment).
    func setHazards(_ rings: [FlatRing], holeIds: [String?]? = nil) {
        hazardRings = rings
        hazardHoleIds = holeIds ?? Array(repeating: nil, count: rings.count)
        hazardBBoxes = rings.map { Self.bbox($0.points) }
        hazardsVersion &+= 1
    }

    /// The course hazard rings — exposed for the caddy composition on the
    /// screen (same source as the card's carry rows).
    var courseHazardRings: [FlatRing] { hazardRings }

    /// Install the course surface stack (topmost-first, from
    /// `SurfaceFeatureStore`). Called by the screen after parsing the bundle;
    /// drives the shot-viz aim optimiser's lie classification. Invalidates the
    /// strategy memo so the overlay picks the surfaces up.
    func setSurfaces(_ rings: [FlatRing]) {
        surfaces = rings
        surfaceBBoxes = rings.map { Self.bbox($0.points) }
        surfacesVersion &+= 1
        strategyKey = nil
    }

    /// Hazard front/carry rows along the primary distance line (Part A): from
    /// the origin to the target the primary distance measures — the routed aim
    /// ahead in GPS mode, else the green center. RAW line distances (no
    /// plays-like / wind), sorted nearest-first and capped to the 3 ahead.
    /// Straight measured distances, so NOT gated in competition mode. Recomputed
    /// on origin / hole / target change, same cadence as `distances`.
    var hazardCarries: [HazardCarry] {
        guard let origin, !hazardRings.isEmpty else { return [] }
        // Scan the full tee/ball → green line so fairway hazards up to the green
        // are caught, not only those before the next aim.
        guard let targetLL = targets.greenCenter ?? nextAimAhead?.position else { return [] }

        let key = HazardKey(
            origin: origin,
            holeIndex: currentHoleIndex,
            greenCenter: targets.greenCenter,
            nextAim: nextAimAhead?.position,
            route: routeFingerprint(),
            hazardsVersion: hazardsVersion
        )
        if key == hazardCarriesKey { return hazardCarriesCache }

        let result = computeHazardCarries(origin: origin, targetLL: targetLL)
        hazardCarriesKey = key
        hazardCarriesCache = result
        hazardCarriesBuildCount += 1
        return result
    }

    /// Own-hazard play corridor half-width — this hole's fairway bunkers are
    /// shown even well off centre. Also the padding basis for the bbox prefilter:
    /// no ring farther than this (laterally) from a scan line can matter.
    private static let ownHazardCorridorHalfWidthM = 400.0
    /// Foreign-hazard corridor half-width — another hole's hazard shows only when
    /// it's genuinely near a play line.
    private static let foreignHazardCorridorHalfWidthM = 35.0
    /// How far past a line's end a hazard still counts (greenside bunkers).
    private static let hazardExtraAheadM = 40.0
    /// Slack added to the prefilter box for a ring's own extent: `nearLines`
    /// classifies a ring by its centroid but scans every vertex, so a ring whose
    /// centroid sits at the corridor edge can reach a little further out.
    private static let hazardScanBBoxMarginM = 50.0

    private func computeHazardCarries(origin: LatLon, targetLL: LatLon) -> [HazardCarry] {
        // Two play lines: the DIRECT line (ball → green, cutting a dogleg) and
        // the ROUTED line (ball → aims → green, round the corner). A hazard in
        // play on EITHER matters, and is measured along whichever it sits on.
        let directLine = [origin, targetLL].map(Self.planar)
        let routedLine = routedHazardLine(origin: origin, target: targetLL)
        let lines = routedLine.count > 2 ? [routedLine, directLine] : [directLine]

        // Spatial prefilter: only rings whose bbox meets the padded scan-line box
        // can land in a corridor; the rest cannot contribute a carry, so drop
        // them before the O(vertices) ownership + `nearLines` scans. The pad is
        // the WIDEST corridor (own) + the ahead extension + ring-extent slack, so
        // it never prunes a ring the narrower foreign corridor would still catch.
        let pad = Self.ownHazardCorridorHalfWidthM + Self.hazardExtraAheadM + Self.hazardScanBBoxMarginM
        let scanBox = Self.expanded(Self.bbox(lines.flatMap { $0 }), by: pad)
        let holeIds = hazardHoleIds.count == hazardRings.count
            ? hazardHoleIds
            : Array(repeating: nil, count: hazardRings.count)
        var rings: [FlatRing] = []
        var ids: [String?] = []
        for i in hazardRings.indices where i < hazardBBoxes.count && hazardBBoxes[i].intersects(scanBox) {
            rings.append(hazardRings[i])
            ids.append(holeIds[i])
        }
        guard !rings.isEmpty else { return [] }

        let split = hazardsByOwnership(rings: rings, ids: ids)
        // This hole's OWN hazards (by holeId, or nearest-route for untagged):
        // always shown, wide corridor. Other holes' hazards: shown ONLY when they
        // fall in the play corridor of one of the lines (in play despite belonging
        // elsewhere).
        let own = HazardCarries.nearLines(
            lines, hazards: split.own,
            corridorHalfWidthM: Self.ownHazardCorridorHalfWidthM,
            extraAheadM: Self.hazardExtraAheadM, cap: 8
        )
        let foreign = HazardCarries.nearLines(
            lines, hazards: split.foreign,
            corridorHalfWidthM: Self.foreignHazardCorridorHalfWidthM,
            extraAheadM: Self.hazardExtraAheadM, cap: 4
        )
        return (own + foreign)
            .sorted { $0.frontM != $1.frontM ? $0.frontM < $1.frontM : $0.carryM < $1.carryM }
            .prefix(8)
            .map { $0 }
    }

    /// The routed hazard line: ball → the current hole's aim points still
    /// ahead of the ball → target, using the SAME shared forward-route filter
    /// as the drawn distance line and the layup spine (ForwardRoute.swift), so
    /// iOS has one notion of "aim already passed". Returns just [ball, target]
    /// when there is no intervening aim (a straight hole), which the caller
    /// collapses to the single direct line.
    private func routedHazardLine(origin: LatLon, target: LatLon) -> [Vec2] {
        guard currentHole != nil else { return [] }
        let o = Self.planar(origin), g = Self.planar(target)
        guard o.x != g.x || o.y != g.y else { return [] } // degenerate: caller uses the direct line
        let aims = targets.aimPoints
        let kept = keptForwardAimIndices(from: origin, toGreen: target)
        return [o] + kept.map { Self.planar(aims[$0].position) } + [g]
    }

    /// Split course hazards into this hole's OWN (tagged to it by `holeId`, or —
    /// when untagged — nearest to its routed play-line) vs the rest (other
    /// holes' hazards + untagged-elsewhere). `holeId` is the primary signal;
    /// geometry only assigns untagged rings. The caller then always shows `own`
    /// and shows `foreign` only where it's genuinely in the play corridor.
    ///
    /// Operates on the already-prefiltered ring subset (with its parallel
    /// `ids`); classification is per-ring against every hole's route (untagged
    /// rings only), so dropping far rings beforehand never changes a survivor's
    /// verdict. All-hole routes come from `cachedHoleRoutePlanar`.
    private func hazardsByOwnership(rings: [FlatRing], ids: [String?]) -> (own: [FlatRing], foreign: [FlatRing]) {
        guard let current = currentHole else { return (rings, []) }
        let currentId = current.hole.id
        let routes: [(number: Int, pts: [Vec2])] = holes.compactMap { hole in
            let pts = cachedHoleRoutePlanar(for: hole)
            return pts.count >= 2 ? (hole.hole.number, pts) : nil
        }

        var own: [FlatRing] = []
        var foreign: [FlatRing] = []
        for (ring, holeId) in zip(rings, ids) {
            let mine: Bool
            if let holeId {
                mine = holeId == currentId
            } else if routes.count > 1, ring.points.count >= 3 {
                mine = nearestRouteNumber(Self.ringCentroid(ring), routes) == current.hole.number
            } else {
                mine = true // single hole / degenerate geometry → treat as own
            }
            if mine { own.append(ring) } else { foreign.append(ring) }
        }
        return (own, foreign)
    }

    private func nearestRouteNumber(_ c: Vec2, _ routes: [(number: Int, pts: [Vec2])]) -> Int? {
        var bestD = Double.infinity
        var best: Int?
        for route in routes {
            let d = Self.distancePointToPolyline(c, route.pts)
            if d < bestD { bestD = d; best = route.number }
        }
        return best
    }

    /// A hole's routed play-line as planar (EPSG:3006) points: active tee →
    /// aim points (in order) → green center. Override-aware.
    private func holeRoutePlanar(for hole: HoleData) -> [Vec2] {
        var pts: [LatLon] = []
        if let tee = teePosition(for: hole) { pts.append(tee) }
        pts.append(contentsOf: hole.aimPoints.map { aimPosition(for: $0, in: hole) })
        if let green = greenCenterPosition(for: hole) { pts.append(green) }
        return pts.map { let p = Sweref99TM.fromWGS84($0); return Vec2(x: p.x, y: p.y) }
    }

    private static func distancePointToPolyline(_ p: Vec2, _ pts: [Vec2]) -> Double {
        guard pts.count >= 2 else { return .infinity }
        var best = Double.infinity
        for i in 0..<(pts.count - 1) {
            best = min(best, distancePointToSegment(p, pts[i], pts[i + 1]))
        }
        return best
    }

    private static func ringCentroid(_ ring: FlatRing) -> Vec2 {
        guard !ring.points.isEmpty else { return Vec2(x: 0, y: 0) }
        var cx = 0.0, cy = 0.0
        for p in ring.points { cx += p.x; cy += p.y }
        let n = Double(ring.points.count)
        return Vec2(x: cx / n, y: cy / n)
    }

    private static func distancePointToSegment(_ p: Vec2, _ a: Vec2, _ b: Vec2) -> Double {
        let abx = b.x - a.x, aby = b.y - a.y
        let apx = p.x - a.x, apy = p.y - a.y
        let ab2 = abx * abx + aby * aby
        let t = ab2 > 0 ? max(0, min(1, (apx * abx + apy * aby) / ab2)) : 0
        return hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby))
    }

    /// Active-tee playing length of the current hole (tee → aims → green),
    /// honoring any moved tee/aim/green overrides.
    var playingLength: HoleLength.PlayingLength? {
        guard let hole = currentHole else { return nil }
        return HoleLength.playingLength(
            tee: teePosition(for: hole),
            aims: hole.aimPoints.map { aimPosition(for: $0, in: hole) },
            greenCenter: greenCenterPosition(for: hole)
        )
    }

    /// One row per hole for the quick hole picker (header title tap): number,
    /// par, stroke index and the active-tee playing length — the same math the
    /// header subtitle uses, so a picked hole shows the figure it will show
    /// once opened. Ordered by hole number (the `holes` order).
    var holePickerEntries: [HolePickerEntry] {
        holes.enumerated().map { index, hole in
            let length = HoleLength.playingLength(
                tee: teePosition(for: hole),
                aims: hole.aimPoints.map { aimPosition(for: $0, in: hole) },
                greenCenter: greenCenterPosition(for: hole)
            )
            return HolePickerEntry(
                number: hole.hole.number,
                par: hole.hole.par,
                strokeIndex: hole.hole.strokeIndex,
                lengthMeters: length.meters,
                lengthApproximate: length.approximate,
                isCurrent: index == currentHoleIndex
            )
        }
    }

    struct HolePickerEntry: Identifiable, Equatable {
        let number: Int
        let par: Int
        let strokeIndex: Int?
        /// Whole-meter active-tee playing length; nil when the hole has no
        /// usable tee→green path (no figure is claimed).
        let lengthMeters: Int?
        /// True when the length stops at the last aim point (green center
        /// missing) — shown with a leading '~' like the header subtitle.
        let lengthApproximate: Bool
        let isCurrent: Bool
        var id: Int { number }
    }

    // MARK: - Derived: map

    /// Tee → green-center bearing, i.e. the direction that points "up" when
    /// the camera fits the hole. 0 (north-up) when either end is missing.
    var holeBearing: Double {
        guard
            let hole = currentHole,
            let tee = teePosition(for: hole),
            let green = greenCenterPosition(for: hole)
        else { return 0 }
        return Distance.bearingDegrees(tee, green)
    }

    /// Bbox of everything that matters on the hole: active tee, green
    /// front/center/back, aim points, active pin. Nil when the hole has no
    /// placed furniture at all.
    var holeBounds: MapCoordinateBounds? {
        guard let hole = currentHole else { return nil }
        var points: [LatLon] = []
        if let tee = teePosition(for: hole) {
            points.append(tee)
        }
        let targets = targets
        for p in [targets.greenFront, targets.greenCenter, targets.greenBack, targets.activePin] {
            if let p { points.append(p) }
        }
        points.append(contentsOf: targets.aimPoints.map(\.position))
        guard let first = points.first else { return nil }
        var bounds = MapCoordinateBounds(west: first.lon, south: first.lat, east: first.lon, north: first.lat)
        for p in points.dropFirst() {
            bounds.west = min(bounds.west, p.lon)
            bounds.east = max(bounds.east, p.lon)
            bounds.south = min(bounds.south, p.lat)
            bounds.north = max(bounds.north, p.lat)
        }
        return bounds
    }

    /// Fit-the-hole camera command (hole direction up). Changes when the hole
    /// changes or `recenter()` bumps the token. While a tool with focus bounds
    /// is active (Green view), fits those bounds tightly instead; exiting such a
    /// tool restores the exact view the user had before it (`restoreCamera`).
    var cameraCommand: MapCameraCommand? {
        if let mapFocus {
            return .center(
                mapFocus, zoom: 17, bearing: holeBearing, animated: true, token: cameraToken
            )
        }
        if let restoreCamera {
            return .center(
                restoreCamera.center,
                zoom: restoreCamera.zoom,
                bearing: restoreCamera.bearing,
                animated: true,
                token: cameraToken
            )
        }
        if let toolFocus {
            // Small uniform padding — the real breathing room comes from the
            // chrome insets, which keep the focused shape inside the visible map.
            return MapCameraCommand(
                target: toolFocus,
                bearing: holeBearing,
                padding: 12,
                insets: toolCameraInsets,
                animated: true,
                token: cameraToken
            )
        }
        // D-HF3: the hole-entry camera is SOLVED (two anchors), never fitted
        // to the aim line; the old hole-bounds fit remains the fallback for
        // pre-layout frames and holes whose default aim cannot resolve.
        if let solved = holeEntryCameraCommand { return solved }
        return holeBounds.map {
            .fitHole(
                $0, bearing: holeBearing, padding: Self.holeFitPadding,
                insets: holeFitInsets, animated: true, token: cameraToken
            )
        }
    }

    /// Uniform edge padding for the default hole fit, points.
    static let holeFitPadding = 70.0

    /// Extra chrome insets for the default hole fit — the screen sets this
    /// from the map's measured height so the fitted hole sits with the green
    /// near the reticle anchor (30% line) and the tee toward the lower part
    /// (`CourseMapView.Coordinator.reticleFitInsets`). Applied in BOTH modes:
    /// browse↔GPS keeps identical framing (see `setGPSEnabled`), so the
    /// insets must not flip with the reticle.
    var holeFitInsets: MapEdgeInsets = .zero

    // MARK: - Derived: routing

    /// The full tee→green route for the current hole (honoring any tee/aim/
    /// green overrides): active tee → aim points (tee→green order) → green
    /// center. Par-3 / no-aim holes collapse to tee → green (or fewer if
    /// furniture is missing). Used as the browse-mode distance line.
    var holeRoute: [LatLon] {
        guard let hole = currentHole else { return [] }
        var route: [LatLon] = []
        if let tee = teePosition(for: hole) { route.append(tee) }
        route.append(contentsOf: hole.aimPoints.map { aimPosition(for: $0, in: hole) })
        if let green = greenCenterPosition(for: hole) {
            route.append(green)
        }
        return route
    }

    /// `holeRoute` as map geometry: the hole's authored routing drawn under
    /// every plan layer. Course DEFINITION, not strategy — it draws whether or
    /// not the course has a game plan, which is the point: the plan overlay's
    /// legs come from planned shots and collapse to a straight tee → green
    /// segment on an unplanned hole, hiding the dogleg the aim points encode.
    /// Empty on a hole without aim points: there the route IS tee → green, and
    /// a second line under the plan leg would only double the stroke.
    /// Override-resolved positions (same as `holeRoute` / the Adjust handles),
    /// so dragging an aim moves the drawn routing with it.
    var courseRouteOverlay: CourseRouteOverlay {
        guard let hole = currentHole, !hole.aimPoints.isEmpty else { return .empty }
        let route = holeRoute
        guard route.count >= 2 else { return .empty }
        return CourseRouteOverlay(
            line: route,
            aims: hole.aimPoints.map { aimPosition(for: $0, in: hole) }
        )
    }

    /// Per-leg distances along `holeRoute`, whole meters, in order
    /// (tee→aim1, aim1→aim2, …, →green). Empty for a < 2-point route.
    var routeLegs: [Int] {
        let route = holeRoute
        guard route.count >= 2 else { return [] }
        return (1..<route.count).map {
            Int(Distance.planarMeters(route[$0 - 1], route[$0]).rounded())
        }
    }

    /// The next aim point ahead of the user in GPS mode, or nil. "Ahead" means
    /// the first aim the shared forward-route filter keeps (the same filter the
    /// drawn line uses, so the card's TO AIM row and the line always agree),
    /// and only when the user is farther from the green than
    /// `aimRoutingThresholdMeters`. Feature 3.
    var nextAimAhead: AimTarget? {
        guard
            let user = effectiveUserLocation,
            let green = targets.greenCenter
        else { return nil }
        let userToGreen = Distance.planarMeters(user, green)
        guard userToGreen > aimRoutingThresholdMeters else { return nil }
        return keptForwardAimIndices(from: user, toGreen: green).first
            .map { targets.aimPoints[$0] }
    }

    /// The routed aim's label + distance-from-origin (GPS mode) for the card's
    /// "TO AIM" emphasis, or nil when routing to the green.
    var routedAimDistance: AimDistance? {
        guard let origin, let aim = nextAimAhead else { return nil }
        return AimDistance(
            label: aim.label,
            meters: Int(Distance.planarMeters(origin, aim.position).rounded())
        )
    }

    /// The distance line in GPS mode: when aim routing is active (feature 3),
    /// origin → every not-yet-passed aim (tee→green order) → green center;
    /// else origin → green center. The line used to stop at the routed aim —
    /// it now continues through the remaining forward aims to the green so
    /// the immersive leg labels have a line to sit on. The card's TO AIM
    /// emphasis still tracks the first leg (`routedAimDistance`).
    private var gpsForwardRoute: [LatLon] {
        guard let origin, let center = targets.greenCenter else {
            if let origin { return [origin] }
            return []
        }
        guard nextAimAhead != nil else { return [origin, center] }
        return forwardRoute(from: origin)
    }

    /// Browse-mode route from the arbitrary transient origin through only the
    /// remaining forward aims to the green. At the default tee this equals the
    /// full hole route. GATED like GPS mode (shared drawn-line policy, see
    /// `gatedForwardRoutePoints` in ForwardRoute.swift): within the user's
    /// `aimRoutingThresholdMeters` of the green the next shot targets the
    /// green, so the line goes straight — an aim a few meters ahead (still
    /// genuinely "ahead" by chainage) would only kink it. Beyond the
    /// threshold, the chainage-filtered route applies. Browse and GPS now
    /// draw the same line for the same origin.
    private var browseForwardRoute: [LatLon] {
        guard let origin else { return [] }
        if let center = targets.greenCenter,
           Distance.planarMeters(origin, center) <= aimRoutingThresholdMeters {
            return [origin, center]
        }
        return forwardRoute(from: origin)
    }

    /// The forward play-line from `origin`: `origin`, then every aim not yet
    /// passed (per the shared forward-route chainage filter, in tee→green
    /// order), then the green center. UNLIKE the drawn-line properties
    /// (`gpsForwardRoute` AND `browseForwardRoute`, both of which snap
    /// straight to the green within `aimRoutingThresholdMeters`) this is NOT
    /// gated — it always follows the hole's routing. It is the spine the
    /// layup ladder measures along and places rungs on, so a layup on a
    /// dogleg lands on the routed leg rather than the straight origin→green
    /// line, and `routedHazardLine`'s scan still rounds the corner. Collapses
    /// to `[origin]` when the green center is unknown (no target to route
    /// toward).
    private func forwardRoute(from origin: LatLon) -> [LatLon] {
        guard let center = targets.greenCenter else { return [origin] }
        let aims = targets.aimPoints
        let kept = keptForwardAimIndices(from: origin, toGreen: center)
        return [origin] + kept.map { aims[$0].position } + [center]
    }

    /// Indices into `targets.aimPoints` still ahead of `origin` per the shared
    /// forward-route filter (ForwardRoute.swift, the Swift mirror of
    /// `shared/strategy/forward-route.ts`): project `origin` onto the full hole
    /// route (tee → aims → `green`) and keep the aims whose chainage lies
    /// beyond the projection. Route inputs are the same override-resolved
    /// positions `holeRoute` uses (`teePosition(for:)` via the fingerprinted
    /// overrides; `targets.aimPoints` / `green` are already resolved). Always
    /// an in-order suffix. Replaces the v1 radial rule ("aim closer to the
    /// green than the origin"), which kept a dogleg corner the player had
    /// already passed laterally.
    private func keptForwardAimIndices(from origin: LatLon, toGreen green: LatLon) -> [Int] {
        let aims = targets.aimPoints
        guard !aims.isEmpty else { return [] }
        func sp(_ ll: LatLon) -> StrategyPoint {
            let p = Sweref99TM.fromWGS84(ll)
            return StrategyPoint(x: p.x, y: p.y)
        }
        return forwardAimIndices(ForwardAimsInput(
            origin: sp(origin),
            tee: currentHole.flatMap { teePosition(for: $0) }.map(sp),
            aims: aims.map { sp($0.position) },
            green: sp(green)
        ))
    }

    // MARK: - Game plan (read-only viewer)

    private static func planVisibleKey(courseId: String) -> String {
        "onCourse.planVisible.\(courseId)"
    }

    /// Installs the course plan (nil clears all plan UI). Called by the
    /// screen after reading the GRDB cache, and again when an online refresh
    /// lands. Viewer only — nothing here writes back.
    func setPlan(_ plan: CoursePlan?) {
        self.plan = plan
        if plan == nil { activeOptionShotIdByHole.removeAll() }
    }

    /// Installs the player's club bag (used for distance-card club advice and
    /// the plan-leg suggested-club fallback). Called by the screen after
    /// reading the GRDB cache, and again when an online refresh lands.
    func setClubs(_ clubs: [ClubRecord]) {
        self.clubs = clubs
        // Clubs define the layup rungs — force a sweep so the new landing
        // points get sampled when the bag loads (asynchronously, from the GRDB
        // cache / server) after the first location fix.
        refreshLadderElevations(force: true)
    }

    // MARK: - Playing state (on-course round loop — R1–R3)

    /// One captured stroke of the active round, as the playing state consumes
    /// it — a value snapshot the screen pushes from `RoundModel` (the same
    /// install pattern as `setPlan`/`setClubs`, so tests drive it without a
    /// database). `position` is where the stroke was played FROM (shot-capture
    /// §2), which is also the last known ball position between captures.
    struct RoundStroke: Equatable, Sendable {
        var holeNumber: Int
        var position: LatLon
        /// Penalty strokes attached to this stroke — score bookkeeping only
        /// (the decide card's probable-score baseline, R4). Defaults to 0 so
        /// pure position-driven callers/tests stay unchanged.
        var penaltyStrokes: Int = 0
    }

    /// The active round's captured strokes in capture order, or nil when no
    /// round is active. Nil ⇒ the entire round-loop surface below disappears
    /// (`playingState`/`roundCardMode` nil) and the card behaves exactly as
    /// before the round loop existed — R1's zero-regression guarantee.
    private(set) var activeRoundStrokes: [RoundStroke]?

    /// The day's authored-option choices, keyed by hole. This is transient
    /// round state (R8): it is never sent through `planWriter` and is cleared
    /// with the active round.
    private(set) var activeOptionShotIdByHole: [Int: String] = [:]

    /// Install (or clear, with nil) the active round's strokes. Called by the
    /// screen on round load and after every capture / scorecard edit —
    /// capture-driven advancement (R1): this is the ONLY thing that moves the
    /// playing state; live GPS never does.
    func setActiveRound(strokes: [RoundStroke]?) {
        // A capture (or scorecard edit) consumes the working target: the
        // decide choices re-derive from the NEW ball position (R4).
        if strokes != activeRoundStrokes { workingTarget = nil }
        activeRoundStrokes = strokes
        if strokes == nil { activeOptionShotIdByHole.removeAll() }
    }

    /// R3 divergence-rule constants — THE one place they live (tuned on
    /// course). Off-plan when the ball's distance to the nearest planned
    /// landing of the active line exceeds `radiusM(for:)` for that landing's
    /// club, or when the stroke count has passed the planned shot count.
    enum Divergence {
        /// Multiplier on the planned club's lateral dispersion SEMI-axis
        /// (`dispersionM / 2`, the ellipse convention — Ellipse.swift).
        static let dispersionMultiplier = 1.5
        /// Floor radius (m): even a tight wedge leg tolerates this much
        /// scatter before the card flips to *decide*.
        static let minRadiusM = 25.0
        /// The on-plan radius around a planned landing reached with `club`
        /// (nil — clubless leg / unknown id — falls back to the floor alone).
        static func radiusM(for club: ClubRecord?) -> Double {
            max(dispersionMultiplier * (club?.dispersionM ?? 0) / 2, minRadiusM)
        }
    }

    /// The round's spine (R1): where the ball is in the current hole's story,
    /// derived from the active round's captured strokes. Capture-driven —
    /// deliberately independent of the live GPS fix, so the card context only
    /// moves when a stroke is captured (or the hole/plan changes), never while
    /// walking.
    struct PlayingState: Equatable {
        /// The hole the state describes (the model's current hole).
        var holeNumber: Int
        /// 0-based; the next stroke to be played = captured strokes on the hole.
        var strokeIndex: Int
        /// Last captured position on the hole; nil = on the tee (no capture yet).
        var ballPosition: LatLon?
        /// Lie classified from `ballPosition` against the surface stack
        /// (`.tee` for stroke 0).
        var lie: Lie
        /// The plan line this round tracks: primary by default, or the
        /// round-scoped authored branch chosen on the card (R8).
        var activeLine: [CoursePlan.Shot]
        /// Index into `activeLine` of the planned landing the ball is AT
        /// (nearest landing within the R3 divergence radius); the leg after it
        /// is "your shot". Nil = on the tee, diverged, or past the plan.
        var currentLeg: Int?
    }

    /// Fingerprint of every input `playingState` reads — self-invalidating
    /// like `LadderKey`/`HazardKey` (values + install-bumped versions), so no
    /// mutation site has to clear anything.
    private struct PlayingKey: Equatable {
        var holeNumber: Int
        var strokes: [RoundStroke]
        var planShots: [CoursePlan.Shot]
        var surfacesVersion: Int
        var clubs: [String]
    }
    @ObservationIgnored private var playingStateKey: PlayingKey?
    @ObservationIgnored private var playingStateCache: PlayingState?
    /// Count of full `playingState` rebuilds (cache misses). Behaviour-neutral
    /// instrumentation the memo tests assert on; `@ObservationIgnored`.
    @ObservationIgnored private(set) var playingStateBuildCount = 0

    /// The playing state for the current hole, or nil when no round is active
    /// (today's behaviour, untouched). Memoised — the card reads it several
    /// times per render and `lieAt` walks the surface stack, so the derivation
    /// runs only when a capture / hole change / plan or bag change lands.
    var playingState: PlayingState? {
        guard let strokes = activeRoundStrokes, let hole = currentHole else { return nil }
        let line: [CoursePlan.Shot]
        if let holePlan = currentHolePlan,
           let chosen = activeOptionShotIdByHole[hole.hole.number],
           let chosenLine = holePlan.line(selecting: chosen) {
            line = chosenLine
        } else {
            line = currentHolePlan?.shots ?? []
        }
        let key = PlayingKey(
            holeNumber: hole.hole.number,
            strokes: strokes,
            planShots: line,
            surfacesVersion: surfacesVersion,
            clubs: clubsFingerprint()
        )
        if key == playingStateKey, let cached = playingStateCache { return cached }

        let holeStrokes = strokes.filter { $0.holeNumber == hole.hole.number }
        let ball = holeStrokes.last?.position
        let state = PlayingState(
            holeNumber: hole.hole.number,
            strokeIndex: holeStrokes.count,
            ballPosition: ball,
            lie: ball.map { lieAt(Self.planar($0)) } ?? .tee,
            activeLine: line,
            currentLeg: ball.flatMap { matchedLeg(ball: $0, activeLine: line) }
        )
        playingStateKey = key
        playingStateCache = state
        playingStateBuildCount += 1
        return state
    }

    /// R3 leg matching: the nearest planned landing to `ball`, kept only when
    /// it lies within that leg's divergence radius (the landing's club is the
    /// club that flies the ball TO it — the shot entity's club).
    private func matchedLeg(ball: LatLon, activeLine: [CoursePlan.Shot]) -> Int? {
        var best: (index: Int, distanceM: Double)?
        for (index, shot) in activeLine.enumerated() {
            let d = Distance.planarMeters(ball, shot.position)
            if best == nil || d < best!.distanceM { best = (index, d) }
        }
        guard let best else { return nil }
        let club = activeLine[best.index].clubId.flatMap { id in clubs.first { $0.id == id } }
        return best.distanceM <= Divergence.radiusM(for: club) ? best.index : nil
    }

    // MARK: - Round card modes (R2 — the card is a context machine)

    /// Card mode = f(PlayingState). The modes are legal scaffolding — the
    /// competition gating stays where it is today (club advice, plays-like);
    /// nothing here widens or narrows it.
    enum RoundCardMode: Equatable {
        /// On the tee (hole entry before any capture, or the tee shot just
        /// captured from it): the hole-plan summary strip. Leg 1 IS the shot.
        case teePreview
        /// Following the plan: `legIndex` is 1-based over the hole's legs
        /// (tee→shot1 = 1, …, →green = shots.count + 1) — the leg being played
        /// from the last captured position (`roundLegCard(legIndex:)`).
        case plan(legIndex: Int)
        /// R3 divergence (or past the planned shot count). The ranked-choices
        /// content is T33; T31 renders a placeholder. Divergence flips the
        /// card — it never edits the plan.
        case decide
        /// Ball on the green — derivation + content land in T35 (R6). Never
        /// produced here yet; the case exists so the card switch is stable.
        case green
    }

    /// One authored choice shown below the tee-preview / plan leg card. EV is
    /// intentionally absent: the sync shape carries no cached chain score and
    /// O4 forbids building a Swift `scoreOptionChain` mirror in T32.
    struct PlanOptionChip: Equatable, Identifiable {
        var id: String
        var label: String
        var clubName: String
        var isSelected: Bool
    }

    /// Sibling choices at the card's CURRENT decision point: roots on the tee,
    /// children of the landing the captured ball matched in plan mode.
    var planOptionChips: [PlanOptionChip] {
        guard activeRoundStrokes != nil,
              let holePlan = currentHolePlan,
              let state = playingState,
              let mode = roundCardMode
        else { return [] }

        let parentShotId: String?
        switch mode {
        case .teePreview:
            parentShotId = nil
        case .plan(let legIndex):
            let parentIndex = legIndex - 2
            guard state.activeLine.indices.contains(parentIndex) else { return [] }
            parentShotId = state.activeLine[parentIndex].id
        default:
            return []
        }

        let siblings = holePlan.children(of: parentShotId)
        guard siblings.count > 1 else { return [] }
        return siblings.enumerated().map { rank, shot in
            PlanOptionChip(
                id: shot.id,
                label: shot.label ?? "Option \(rank + 1)",
                clubName: shot.clubName ?? "Club open",
                isSelected: state.activeLine.contains { $0.id == shot.id }
            )
        }
    }

    /// Pick an authored sibling for this round. Resolving the full line is a
    /// pure `CoursePlan` read; critically, there is no plan-store/write call.
    func selectPlanOption(shotId: String) {
        guard let hole = currentHole,
              planOptionChips.contains(where: { $0.id == shotId }),
              currentHolePlan?.line(selecting: shotId) != nil
        else { return }
        activeOptionShotIdByHole[hole.hole.number] = shotId
        workingTarget = nil
    }

    /// The card mode for the active round, or nil when no round is active OR
    /// the hole has no planned line (the mode machine is a lens over the plan;
    /// without one the card behaves exactly as today — strokes still count).
    var roundCardMode: RoundCardMode? {
        guard let state = playingState, !state.activeLine.isEmpty else { return nil }
        guard let ball = state.ballPosition, state.strokeIndex > 0 else { return .teePreview }
        // R6 green handoff: the ball is on the green (point-in-ring — the same
        // lie classification capture uses). This sits ABOVE the past-plan-count
        // decide check so an approach that finds the green hands off to putting
        // even once the stroke count has passed the plan (green precedence over
        // divergence — T31 deferred this precedence to here).
        if state.lie == .green { return .green }
        // "strokeIndex has passed the planned shot count" (R3): the planned
        // count is one stroke per landing + the approach into the green.
        if state.strokeIndex > state.activeLine.count + 1 { return .decide }
        if let leg = state.currentLeg { return .plan(legIndex: leg + 2) }
        // Tee grace: a capture AT the tee (the tee shot, or a re-tee) is not
        // divergence — the ball is exactly where the plan starts, and R3's
        // nearest-landing distance is meaningless there. The tee-preview strip
        // already describes leg 1, so it stays up.
        if let tee = planTeePosition(),
           Distance.planarMeters(ball, tee) <= Divergence.minRadiusM {
            return .teePreview
        }
        return .decide
    }

    /// The plan tee for the mode machine's tee grace: the hole plan's tee when
    /// placed here, else the active tee (override-aware).
    private func planTeePosition() -> LatLon? {
        guard let hole = currentHole else { return nil }
        if let holePlan = currentHolePlan, let tee = planTee(for: hole, plan: holePlan) {
            return LatLon(lat: tee.lat, lon: tee.lon)
        }
        return teePosition(for: hole)
    }

    /// Tee-preview strip content (R2): the hole's plan in one line — tee club,
    /// first aim, the one hazard that matters, hole notes. Option chips land
    /// with T32.
    struct TeePreviewStrip: Equatable {
        /// Leg 1's planned club, nil when the plan leaves it open.
        var teeClubName: String?
        /// Fallback when leg 1 is clubless (nil in competition mode — the
        /// existing `suggestedClub` gate, untouched).
        var suggestedClubName: String?
        /// The first planned landing's authored label ("Layup").
        var aimLabel: String?
        /// Plan tee → first landing, whole meters (the tee shot's number).
        var firstLegMeters: Int?
        /// Nearest carry hazard on the line ("R Bunker") + its carry figure —
        /// the one hazard that matters off the tee.
        var hazardLabel: String?
        var hazardCarryM: Int?
        var notes: String?
    }

    /// Content for `.teePreview`, nil outside that mode.
    var teePreviewStrip: TeePreviewStrip? {
        guard roundCardMode == .teePreview,
              let hole = currentHole,
              let holePlan = currentHolePlan,
              let state = playingState,
              let firstShot = state.activeLine.first
        else { return nil }
        let tee = planTee(for: hole, plan: holePlan)
        let teePosition = tee.map { LatLon(lat: $0.lat, lon: $0.lon) }
        let firstLegMeters = teePosition.map {
            Int(Distance.planarMeters($0, firstShot.position).rounded())
        }
        let hazard = teeHazardThatMatters(firstLegMeters: firstLegMeters)
        return TeePreviewStrip(
            teeClubName: firstShot.clubName,
            suggestedClubName: firstShot.clubName == nil
                ? teePosition.flatMap {
                    suggestedClub(
                        from: $0, fromElevation: tee?.elevation,
                        to: firstShot.position, toElevation: firstShot.elevation
                    )
                }
                : nil,
            aimLabel: firstShot.label,
            firstLegMeters: firstLegMeters,
            hazardLabel: hazard?.displayLabel,
            hazardCarryM: hazard?.carryM,
            notes: holePlan.notes
        )
    }

    /// "The one hazard that matters" off the tee (R2): the farthest carry the
    /// tee shot must still clear on the way to the planned landing (fronts up
    /// to `hazardExtraAheadM` past it count — greenside-of-the-landing traps),
    /// NOT merely the nearest ring, which can be a bunker at your feet.
    private func teeHazardThatMatters(firstLegMeters: Int?) -> HazardCarry? {
        let carries = hazardCarries
        guard let legM = firstLegMeters else { return carries.first }
        return carries
            .filter { $0.frontM < legM + Int(Self.hazardExtraAheadM) }
            .max { $0.carryM < $1.carryM }
    }

    /// Plan-mode leg card content (R2): the shot the plan wants next —
    /// planned club, aim label, gate width at the leg, distance + plays-like
    /// to the planned landing (from the live origin, so it counts down as you
    /// walk), hole notes.
    struct RoundLegCard: Equatable {
        /// 1-based leg number over the hole ("Shot 2 of 3").
        var legIndex: Int
        var legCount: Int
        /// The planned club on the leg's landing shot; nil on the approach leg
        /// (no shot entity) or a clubless shot.
        var clubName: String?
        /// Fallback when `clubName` is nil (competition-gated upstream).
        var suggestedClubName: String?
        /// The landing's authored label ("Layup"), nil for the approach.
        var aimLabel: String?
        /// Total width (m) of the plan gate at this leg, nil without gates.
        var gateWidthM: Int?
        /// Straight meters origin → planned landing (nil without an origin).
        var distanceM: Int?
        /// Plays-as (slope + wind; competition-degraded upstream) to the
        /// landing, nil when elevations are unknown.
        var playsAsM: Int?
        var notes: String?
        /// The leg lands on the green (the approach — no landing shot entity).
        var toGreen: Bool
        /// The planned landing itself (T33's working-target seam).
        var landing: LatLon?
    }

    /// Content for `.plan(legIndex:)`, nil when the leg is out of range or the
    /// hole has no plan.
    func roundLegCard(legIndex: Int) -> RoundLegCard? {
        guard let hole = currentHole,
              let holePlan = currentHolePlan,
              let shots = playingState?.activeLine
        else { return nil }
        let legCount = shots.count + 1
        guard legIndex >= 1, legIndex <= legCount else { return nil }
        let toGreen = legIndex == legCount
        let landing: LatLon?
        let landingElevation: Double?
        let clubName: String?
        let aimLabel: String?
        if toGreen {
            landing = greenCenterPosition(for: hole)
            landingElevation = hole.green?.elevation
            clubName = nil
            aimLabel = nil
        } else {
            let shot = shots[legIndex - 1]
            landing = shot.position
            landingElevation = shot.elevation
            clubName = shot.clubName
            aimLabel = shot.label
        }
        var distanceM: Int?
        var playsAsM: Int?
        var suggested: String?
        if let origin, let landing {
            distanceM = Int(Distance.planarMeters(origin, landing).rounded())
            playsAsM = playsAsAndElevation(to: landing, elevation: landingElevation)?.playsAs
            if clubName == nil {
                suggested = suggestedClub(
                    from: origin, fromElevation: originElevation,
                    to: landing, toElevation: landingElevation
                )
            }
        }
        return RoundLegCard(
            legIndex: legIndex,
            legCount: legCount,
            clubName: clubName,
            suggestedClubName: suggested,
            aimLabel: aimLabel,
            gateWidthM: landing.flatMap { gateWidthM(near: $0, gates: holePlan.gates) },
            distanceM: distanceM,
            playsAsM: playsAsM,
            notes: holePlan.notes,
            toGreen: toGreen,
            landing: landing
        )
    }

    /// Total width (m) of the plan gate nearest `landing` — "the gate width at
    /// that leg". Gates are authored per leg, so nearest-by-center is the
    /// association; nil without gates.
    private func gateWidthM(near landing: LatLon, gates: [CoursePlan.Gate]) -> Int? {
        let nearest = gates.min {
            Distance.planarMeters($0.position, landing) < Distance.planarMeters($1.position, landing)
        }
        guard let nearest else { return nil }
        return Int((nearest.halfWidthLeftM + nearest.halfWidthRightM).rounded())
    }

    // MARK: - Green handoff (R6 — T35)

    /// Green-mode card content: the putt-first strip that leads once the ball
    /// is on the green. `distanceM` (ball → hole) leads; a tap on the read
    /// affordance opens the green view pre-placed at exactly these markers.
    /// The hole is `targets.activePin` — the today's-pin override when placed,
    /// else the furniture active pin (closing laser-doc open question 3: the
    /// lasered pin becomes the putt read's hole position).
    struct GreenCard: Equatable {
        /// Ball → hole, whole meters; nil when there is no resolved hole.
        var distanceM: Int?
        /// The captured ball position (PlayingState.ballPosition) — the read's
        /// ball marker on handoff.
        var ballPosition: LatLon
        /// today's-pin override ?? active pin — the read's hole marker; nil when
        /// the green has no pin at all (the read defaults to the green center).
        var holePosition: LatLon?
        /// A short source tag for an override pin ("Laser"/"Sheet"/"Visual"),
        /// else the furniture pin name — mirrors the pin block below the card.
        var holeName: String?
    }

    /// Content for `.green`, nil outside that mode. Ball = the last captured
    /// position; hole = the resolved active pin (override-first).
    var greenCard: GreenCard? {
        guard roundCardMode == .green,
              let ball = playingState?.ballPosition
        else { return nil }
        let hole = targets.activePin
        return GreenCard(
            distanceM: hole.map { Int(Distance.planarMeters(ball, $0).rounded()) },
            ballPosition: ball,
            holePosition: hole,
            holeName: targets.activePinName
        )
    }

    // MARK: - Decide moment (R4 — T33)

    /// One ranked decide choice: a shot the player can commit to from the
    /// actual ball position, carrying the R4 score/risk triple. Tap →
    /// `selectDecideChoice` makes it the working target.
    struct DecideChoice: Equatable, Identifiable {
        enum Kind: String, Equatable {
            /// Attack the hole target with a reaching club.
            case go
            /// Lay up to a full number (the par-5 rule's vocabulary).
            case layupFull = "layup-full"
            /// Lay back short of the first pinching hazard on the line.
            case layBack = "lay-back"
            /// Recovery-lie punch-out (take-your-medicine's escape).
            case punchOut = "punch-out"
            /// An authored plan option surviving from the current position
            /// (options tree, R4 merge — T37). Carries the option's OWN
            /// landing point as the target.
            case option
        }
        /// Stable per-derivation id ("go-c5i" / "lay-back-cpw").
        let id: String
        let kind: Kind
        /// e.g. "Go — 178 plays 186" / "Layup 7i → 95 m in".
        let headline: String
        let clubId: String?
        let clubName: String?
        /// The choice's landing point — the working target on tap.
        let target: LatLon
        /// Ball → landing along the line, whole meters.
        let distanceM: Int
        /// Probable hole score: strokes already taken on the hole (incl.
        /// penalties) + EV to hole out from here (R4).
        let probableScore: Double
        /// Penalty share of the dispersion samples at this choice, 0..1.
        let penaltyShare: Double
        /// Blow-up probable score (strokes taken + 1 + CVaR₈₀ tail) — only
        /// where the tail changes the call (gap ≥ the no-doubles
        /// `TAIL_GAP_WARN` gate); nil otherwise.
        let tailScore: Double?
        /// The R4 triple, through THE shared formatter (option chips reuse it).
        var triple: String {
            ScoreRiskFormat.triple(
                probableScore: probableScore, penaltyShare: penaltyShare, tailScore: tailScore
            )
        }
    }

    /// The decide card's content: ≤3 ranked choices + the top caddy headline
    /// (the "why" line under the list).
    struct DecideContent: Equatable {
        var choices: [DecideChoice]
        var caddyHeadline: String?
    }

    /// Fingerprint of every input `decideContent` reads — self-invalidating
    /// (same pattern as `PlayingKey`): the ball only moves on capture, so the
    /// derivation runs on capture / hole / bag / wind / surface change and
    /// NEVER continuously while walking (R4 compute cadence).
    private struct DecideKey: Equatable {
        var holeNumber: Int
        var strokes: [RoundStroke]
        var planShots: [CoursePlan.Shot]
        /// The WHOLE option tree, not just the active line — the authored
        /// decide candidates enumerate every sibling group (T37).
        var allPlanShots: [CoursePlan.Shot]
        /// The current hole's Adjust-mode green-centre override: the derivation
        /// reads the green through `greenCenterPosition(for:)`, so a moved
        /// green must invalidate the memo (T37 finding 4).
        var greenOverride: LatLon?
        var surfacesVersion: Int
        var hazardsVersion: Int
        var clubs: [String]
        var windSpeed: Double?
        var windDir: Double?
        var competitionMode: Bool
    }
    @ObservationIgnored private var decideKey: DecideKey?
    @ObservationIgnored private var decideCache: DecideContent?
    /// Cache-miss counter for the memo tests; `@ObservationIgnored`.
    @ObservationIgnored private(set) var decideBuildCount = 0

    /// The ranked decide choices for the current off-plan position, or nil
    /// outside decide mode / in competition mode (EV + club advice is advice —
    /// same gate as `planCaddyAdvice`) / without a ball, green, or bag.
    var decideContent: DecideContent? {
        guard !competitionMode,
              roundCardMode == .decide,
              let state = playingState,
              let ball = state.ballPosition,
              let hole = currentHole,
              let green = greenCenterPosition(for: hole),
              !clubs.isEmpty
        else { return nil }
        let key = DecideKey(
            holeNumber: state.holeNumber,
            strokes: activeRoundStrokes ?? [],
            planShots: state.activeLine,
            allPlanShots: currentHolePlan?.allShots ?? [],
            greenOverride: greenOverrides[hole.id],
            surfacesVersion: surfacesVersion,
            hazardsVersion: hazardsVersion,
            clubs: clubsFingerprint(),
            windSpeed: effectiveWind?.speedMps,
            windDir: effectiveWind?.directionDeg,
            competitionMode: competitionMode
        )
        if key == decideKey, let cached = decideCache { return cached }
        let content = buildDecideContent(state: state, ball: ball, hole: hole, green: green)
        decideKey = key
        decideCache = content
        decideBuildCount += 1
        return content
    }

    /// One candidate before pricing: a club committed to a distance along the
    /// ball → green line, or (authored options) to an authored landing point.
    private struct DecideCandidate {
        var kind: DecideChoice.Kind
        var club: ClubRecord
        /// Ball → intended landing, meters (along the green line for engine
        /// candidates; straight to `target` for authored options).
        var targetM: Double
        /// Authored-option landing override: the option's OWN point becomes
        /// the choice target (and the working target on tap); nil for engine
        /// candidates, whose landing derives along the ball → green line.
        var target: LatLon? = nil
        /// The authored shot behind an `.option` candidate (stable choice id
        /// + headline label); nil for engine candidates.
        var authoredShotId: String? = nil
        var authoredLabel: String? = nil
    }

    /// R4 merge (T37): the authored sibling options surviving from the
    /// current position, entered AHEAD of the engine candidates so they win
    /// dedupe/tie-breaks and inherit the pricing/ranking/vetoes/cap pipeline
    /// unchanged. An option is a member of a >1-sibling group (a real
    /// decision point, options doc O1); it survives when its landing still
    /// advances the ball toward the hole from here. The authored club is kept
    /// when its carry still fits the ball → landing distance; otherwise the
    /// option re-clubs like a layup (the plan's club was chosen from its
    /// parent's landing, not from a diverged ball) and drops out entirely when
    /// no club in the bag fits — it is not executable from here.
    private func authoredDecideCandidates(
        ball: LatLon, remainingM: Double, green: LatLon
    ) -> [DecideCandidate] {
        guard let holePlan = currentHolePlan else { return [] }
        let optionShots = Dictionary(grouping: holePlan.allShots, by: \.parentShotId)
            .values
            .filter { $0.count > 1 }
            .joined()
            .sorted { ($0.sortOrder, $0.id) < ($1.sortOrder, $1.id) }
        var candidates: [DecideCandidate] = []
        for shot in optionShots {
            let d = Distance.planarMeters(ball, shot.position)
            let landingRemainingM = Distance.planarMeters(shot.position, green)
            guard d >= 1, landingRemainingM < remainingM - 1 else { continue }
            let authoredClub = shot.clubId.flatMap { id in clubs.first { $0.id == id } }
            let club: ClubRecord?
            if let authoredClub, abs(authoredClub.carryM - d) <= LAYUP_TARGET_TOLERANCE_M {
                club = authoredClub
            } else {
                club = closestClub(clubs, d).flatMap {
                    abs($0.carryM - d) <= LAYUP_TARGET_TOLERANCE_M ? $0 : nil
                }
            }
            guard let club else { continue }
            candidates.append(DecideCandidate(
                kind: .option, club: club, targetM: d,
                target: shot.position,
                authoredShotId: shot.id, authoredLabel: shot.label
            ))
        }
        return candidates
    }

    /// Assemble the decide content: enumerate the par-5-trio-shaped engine
    /// candidates from the actual ball (go / lay-up-to-full-number /
    /// lay-back-of-pinch, + the recovery punch-out), price each through
    /// `optimizeAim` (EV / penalty share / tail off `Aim.swift`'s outputs —
    /// no chain scorer, O4), then let the caddy rules rank and veto.
    private func buildDecideContent(
        state: PlayingState, ball: LatLon, hole: HoleData, green: LatLon
    ) -> DecideContent {
        let o = Self.planar(ball)
        let g = Self.planar(green)
        let dx = g.x - o.x, dy = g.y - o.y
        let remainingM = hypot(dx, dy)
        guard remainingM > 0 else { return DecideContent(choices: [], caddyHeadline: nil) }
        let bearing = PlanStrategy.compassBearing(dx: dx, dy: dy)
        let wind = effectiveWind

        // Strokes already taken on the hole, penalties included (R4's
        // probable-score baseline).
        let strokesTaken = (activeRoundStrokes ?? [])
            .filter { $0.holeNumber == state.holeNumber }
            .reduce(0) { $0 + 1 + $1.penaltyStrokes }

        func effect(for club: ClubRecord) -> Double {
            wind.map { windEffect($0.speedMps, $0.directionDeg, bearing, club.carryM) } ?? 0
        }

        // --- Candidates (authored options first — R4 list order — then the
        // engine trio).
        var candidates = authoredDecideCandidates(
            ball: ball, remainingM: remainingM, green: green
        )

        // GO: the closest-carry club whose max carry still reaches. Hazards do
        // NOT drop it (unlike par5-attack) — the triple carries the risk.
        var goClub: ClubRecord?
        var goDiff = Double.infinity
        for club in clubs where maxCarryM(club.carryM, windEffect: effect(for: club)) >= remainingM {
            let diff = abs(club.carryM - remainingM)
            if diff < goDiff { goClub = club; goDiff = diff }
        }
        if let goClub {
            candidates.append(DecideCandidate(kind: .go, club: goClub, targetM: remainingM))
        }

        // LAY UP TO A FULL NUMBER (par5-attack vocabulary, any hole).
        let fullTargetM = remainingM - FULL_NUMBER_LAYUP_M
        if fullTargetM > 0,
           let club = closestClub(clubs, fullTargetM),
           abs(club.carryM - fullTargetM) <= LAYUP_TARGET_TOLERANCE_M {
            candidates.append(DecideCandidate(kind: .layupFull, club: club, targetM: fullTargetM))
        }

        // LAY BACK OF THE FIRST PINCH on the line.
        let pinches = hazardsAlongLine(o, bearing, hazardRings, maxM: remainingM)
            .filter { $0.frontM > LAY_BACK_OF_PINCH_BUFFER_M }
            .sorted { $0.frontM < $1.frontM }
        if let pinch = pinches.first {
            let layBackM = pinch.frontM - LAY_BACK_OF_PINCH_BUFFER_M
            if let club = closestClub(clubs, layBackM),
               abs(club.carryM - layBackM) <= LAYUP_TARGET_TOLERANCE_M {
                candidates.append(DecideCandidate(kind: .layBack, club: club, targetM: layBackM))
            }
        }

        // PUNCH OUT from jail (take-your-medicine's escape, same constants).
        if state.lie == .recovery, let escape = clubs.min(by: { $0.carryM < $1.carryM }) {
            let advanceM = min(
                remainingM,
                maxCarryM(escape.carryM, windEffect: effect(for: escape)) * ESCAPE_ADVANCE_FRACTION
            )
            if advanceM > 0 {
                candidates.append(DecideCandidate(kind: .punchOut, club: escape, targetM: advanceM))
            }
        }

        // Fallback so an out-of-reach, hazard-free position still gets its
        // honest "bomb it, here's what's left" line.
        if candidates.isEmpty, let bomb = longestLayup(clubs, remainingM) {
            candidates.append(DecideCandidate(kind: .layupFull, club: bomb.club, targetM: bomb.carryM))
        }

        // Dedupe (club, landing) — the full-number and lay-back clubs can
        // coincide. First (authored → go → …) wins.
        var seen = Set<String>()
        candidates = candidates.filter {
            seen.insert("\($0.club.id)@\(Int($0.targetM.rounded()))").inserted
        }

        // --- Price each candidate: one aim sweep from the ball (the same
        // surfaces stack the plan overlay classifies against), EV to hole out
        // = 1 + expected strokes from the landing distribution.
        let unit = bearingToUnitVector(bearing)
        struct Scored {
            var candidate: DecideCandidate
            var aim: AimResult
            var order: Int
        }
        var scored: [Scored] = []
        for (order, candidate) in candidates.enumerated() {
            // Authored options aim at their OWN landing, not down the green
            // line — the same single-shot Aim.swift pricing, just pointed at
            // the authored point (no chain scorer on device, O4).
            let aimBearing: Double
            if let authoredTarget = candidate.target {
                let t = Self.planar(authoredTarget)
                aimBearing = PlanStrategy.compassBearing(dx: t.x - o.x, dy: t.y - o.y)
            } else {
                aimBearing = bearing
            }
            let aim = optimizeAim(AimOptions(
                origin: o,
                club: candidate.club,
                targetBearingDeg: aimBearing,
                surfaces: surfaces,
                greenCenter: g,
                windSpeedMps: wind?.speedMps,
                windDirectionDeg: wind?.directionDeg,
                riskAversion: 0,
                fallbackLie: .rough
            ))
            scored.append(Scored(candidate: candidate, aim: aim, order: order))
        }

        // --- Caddy ranking/vetoes over ONE context from the ball: the
        // aggressive line's aim feeds the aim-reading rules; leg kind comes
        // from the classified lie (recovery wins), the go line, and the
        // stroke index (the web `caddyLegKind` port).
        let goAim = scored.first { $0.candidate.kind == .go }?.aim
        let legKind = Self.caddyLegKind(
            originLie: state.lie,
            landsOnGreen: goAim != nil,
            index: state.strokeIndex,
            par: hole.hole.par
        )
        let front = targets.greenFront.map(Self.planar) ?? g
        let back = targets.greenBack.map(Self.planar) ?? g
        let ctx = CaddyContext<ClubRecord>(
            leg: legKind,
            origin: StrategyPoint(x: o.x, y: o.y),
            target: CaddyGreenTarget(greenPoly: greenRing(near: g), center: g, front: front, back: back),
            aim: goAim ?? scored.first?.aim,
            hazards: courseHazardRings,
            clubs: clubs,
            wind: wind.map { FeatureWind(speedMps: $0.speedMps, directionDeg: $0.directionDeg) },
            hole: CaddyHole(par: hole.hole.par, index: hole.hole.strokeIndex ?? hole.hole.number),
            risk: RiskProfile(riskAversion: 0)
        )
        let advice = runCaddy(ctx, caddyRules())
        // Any emitted advice that vetoes the aggressive-line rules is the
        // caddy saying "don't fire at it" — demote GO below the safe plays.
        let vetoesAggressive = advice.contains { ($0.vetoes ?? []).contains("specific-target") }
        let medicineFired = advice.contains { $0.ruleId == "take-your-medicine" }

        // --- Rank: EV ascending, deterministic tie-break on candidate order;
        // then the caddy's vetoes reorder (punch-out first from jail, GO last
        // when the safety rules veto the aggressive line); cap at 3 (R4).
        var ranked = scored.sorted {
            let a = $0.aim.best.expectedStrokes
            let b = $1.aim.best.expectedStrokes
            return a != b ? a < b : $0.order < $1.order
        }
        if vetoesAggressive {
            let (goes, rest) = (ranked.filter { $0.candidate.kind == .go },
                                ranked.filter { $0.candidate.kind != .go })
            ranked = rest + goes
        }
        if medicineFired {
            let (punches, rest) = (ranked.filter { $0.candidate.kind == .punchOut },
                                   ranked.filter { $0.candidate.kind != .punchOut })
            ranked = punches + rest
        }

        let choices = ranked.prefix(3).map { item -> DecideChoice in
            let candidate = item.candidate
            let aim = item.aim
            let targetPoint: LatLon
            if let authored = candidate.target {
                targetPoint = authored
            } else if candidate.kind == .go {
                targetPoint = green
            } else {
                targetPoint = Sweref99TM.toWGS84(
                    x: o.x + unit.x * candidate.targetM,
                    y: o.y + unit.y * candidate.targetM
                )
            }
            // Authored options headline with their label + the option's own
            // remaining-in figure (the landing is off the green line, so the
            // engine's remaining − targetM arithmetic does not apply).
            let headline: String
            if candidate.kind == .option {
                let leftM = Int(Distance.planarMeters(targetPoint, green).rounded())
                headline = "\(candidate.authoredLabel ?? "Option") \(candidate.club.name) → \(leftM) m in"
            } else {
                headline = Self.decideHeadline(
                    candidate.kind, club: candidate.club, targetM: candidate.targetM,
                    remainingM: remainingM, bearing: bearing, wind: wind
                )
            }
            let ev = 1 + aim.best.expectedStrokes
            let gap = aim.best.tailStrokes - aim.best.expectedStrokes
            return DecideChoice(
                id: candidate.authoredShotId.map { "option-\($0)" }
                    ?? "\(candidate.kind.rawValue)-\(candidate.club.id)",
                kind: candidate.kind,
                headline: headline,
                clubId: candidate.club.id,
                clubName: candidate.club.name,
                target: targetPoint,
                distanceM: Int(candidate.targetM.rounded()),
                probableScore: Double(strokesTaken) + ev,
                penaltyShare: aim.best.breakdown[.penalty] ?? 0,
                tailScore: gap >= TAIL_GAP_WARN
                    ? Double(strokesTaken) + 1 + aim.best.tailStrokes
                    : nil
            )
        }
        return DecideContent(choices: Array(choices), caddyHeadline: advice.first?.headline)
    }

    /// One compact headline per choice kind — the R4 vocabulary ("Go — 178
    /// plays 186" / "Layup 7i → 95 m in").
    private static func decideHeadline(
        _ kind: DecideChoice.Kind, club: ClubRecord, targetM: Double,
        remainingM: Double, bearing: Double,
        wind: (speedMps: Double, directionDeg: Double)?
    ) -> String {
        switch kind {
        case .go:
            let actual = Int(remainingM.rounded())
            if let wind {
                let plays = Int(playsAsM(
                    remainingM, windEffect(wind.speedMps, wind.directionDeg, bearing, remainingM)
                ).rounded())
                if plays != actual { return "Go — \(actual) plays \(plays)" }
            }
            return "Go — \(actual)"
        case .layupFull, .layBack:
            let leftM = Int(max(0, remainingM - targetM).rounded())
            let verb = kind == .layBack ? "Lay back" : "Layup"
            return "\(verb) \(club.name) → \(leftM) m in"
        case .punchOut:
            return "Punch out \(club.name) — back in play"
        case .option:
            // Not reached: authored-option headlines are built inline in
            // `buildDecideContent` (they need the option's own landing
            // geometry, not the green-line projection).
            return "\(club.name) → \(Int(targetM.rounded())) m"
        }
    }

    // MARK: - Working target (decide choice → capture prefill, R4)

    /// The transient working target a tapped decide choice sets: the distance
    /// line, banner, and ghost pattern point here, and capture's target
    /// prefill reads it FIRST (before pin / plan landing / green). Round
    /// state, never a plan write (R8); cleared on capture and hole change.
    struct WorkingTarget: Equatable {
        var choiceId: String
        /// Banner title (the choice's headline).
        var label: String
        var position: LatLon
        var clubId: String?
        var clubName: String?
    }

    private(set) var workingTarget: WorkingTarget?

    static let workingTargetRowID = "working-target"

    /// Tap a decide choice: make it the working target (tap again to clear).
    func selectDecideChoice(_ choice: DecideChoice) {
        if workingTarget?.choiceId == choice.id {
            workingTarget = nil
            return
        }
        workingTarget = WorkingTarget(
            choiceId: choice.id,
            label: choice.headline,
            position: choice.target,
            clubId: choice.clubId,
            clubName: choice.clubName
        )
    }

    func clearWorkingTarget() {
        workingTarget = nil
    }

    /// The plan landings capture's target prefill scans (armCapture /
    /// rearmCapture): the round's chosen line when an authored option is
    /// selected (R8 — T37 finding 2), falling back to the primary-line
    /// projection — so the prefill follows the branch actually being played.
    var capturePlanLandings: [LatLon] {
        (playingState?.activeLine ?? currentHolePlan?.shots ?? []).map(\.position)
    }

    // MARK: - Plan editing (planner tool — task T3)

    /// Persistence sink for planner edits: the screen wires these to the GRDB
    /// plan-edit store + `PlanSyncService`. Nil in tests that only exercise the
    /// in-memory geometry path — the model updates its own `plan` regardless, so
    /// the map reflects edits even without a writer.
    struct PlanEditWriter: Sendable {
        /// Append a shot on `holeNumber` with the model-minted `shotId`.
        var addShot: @Sendable (_ holeNumber: Int, _ shotId: String, _ sortOrder: Int, _ parentShotId: String?, _ lat: Double, _ lon: Double, _ elevation: Double?, _ clubId: String?) async -> Void
        /// Persist a moved shot's coordinates (+ resampled elevation).
        var moveShot: @Sendable (_ shotId: String, _ lat: Double, _ lon: Double, _ elevation: Double?) async -> Void
        /// Persist a shot's club change.
        var setShotClub: @Sendable (_ shotId: String, _ clubId: String?) async -> Void
        /// Persist a shot removal.
        var removeShot: @Sendable (_ shotId: String) async -> Void
        /// Persist the plan-level (course-wide) wind. A nil pair = calm.
        var setPlanWind: @Sendable (_ speedMps: Double?, _ directionDeg: Double?) async -> Void
        /// Persist one hole's wind override. A nil pair clears the override.
        var setHoleWind: @Sendable (_ holeNumber: Int, _ speedMps: Double?, _ directionDeg: Double?) async -> Void
    }

    @ObservationIgnored var planWriter: PlanEditWriter?

    /// The selected plan shot (tap a handle), for the panel's row + delete.
    private(set) var selectedPlanShotId: String?
    /// True while the "add shot" affordance is armed — the next map tap places.
    private(set) var isAddingPlanShot = false
    /// Bumped on every plan edit (drop / add / remove / club) so the strategy
    /// memo re-enriches on the SETTLED plan. Observed → drives the overlay.
    private(set) var planEditToken = 0
    /// True only between a plan-shot grab and its drop — gates `planOverlay`
    /// onto the cheap ellipses-only path. `@ObservationIgnored`: the drag frames
    /// mutate `plan` (observed) which already re-renders; toggling this alone
    /// must not.
    @ObservationIgnored private var planDragActive = false
    @ObservationIgnored private var draggingPlanShotID: String?
    /// The dragged shot's position at grab — a drop that didn't move (a tap to
    /// select the handle) skips the redundant persist.
    @ObservationIgnored private var planDragStart: LatLon?

    /// Stable planner-tool handle id for one plan shot.
    static func planShotHandleID(_ shotId: String) -> String { "plan-shot.\(shotId)" }
    static func planShotID(fromHandle handleID: String) -> String? {
        let prefix = "plan-shot."
        return handleID.hasPrefix(prefix) ? String(handleID.dropFirst(prefix.count)) : nil
    }

    /// The current hole's plan shots in sortOrder (empty without a plan/hole).
    var planEditShots: [CoursePlan.Shot] {
        guard let hole = currentHole else { return [] }
        return (plan?.shots(holeNumber: hole.hole.number) ?? [])
            .sorted { $0.sortOrder < $1.sortOrder }
    }

    /// One row of the planner panel: a plan shot with its 1-based index, club,
    /// and the whole-metre length of the leg REACHING it (from the plan tee or
    /// the previous landing point).
    struct PlanEditRow: Identifiable, Equatable {
        let shotId: String
        let index: Int
        let clubId: String?
        let clubName: String?
        let meters: Int
        var id: String { shotId }
    }

    /// The planner panel's rows for the current hole (tee→green order).
    var planEditRows: [PlanEditRow] {
        guard let hole = currentHole else { return [] }
        let shots = planEditShots
        var previous: LatLon? = {
            if let holePlan = currentHolePlan ?? plan?.hole(number: hole.hole.number),
               let tee = planTee(for: hole, plan: holePlan) {
                return LatLon(lat: tee.lat, lon: tee.lon)
            }
            return activeTee(for: hole).map { LatLon(lat: $0.lat, lon: $0.lon) }
        }()
        return shots.enumerated().map { index, shot in
            let meters = previous.map { Int(Distance.planarMeters($0, shot.position).rounded()) } ?? 0
            previous = shot.position
            return PlanEditRow(
                shotId: shot.id, index: index + 1,
                clubId: shot.clubId, clubName: shot.clubName, meters: meters
            )
        }
    }

    /// Draggable handles for the plan shots (planner tool). `P1`, `P2`, … in
    /// tee→green order.
    var planEditHandles: [AdjustHandle] {
        planEditShots.enumerated().map { index, shot in
            AdjustHandle(
                id: Self.planShotHandleID(shot.id),
                kind: .planShot,
                label: "P\(index + 1)",
                position: shot.position
            )
        }
    }

    /// Ensure `plan` is a mutable value to edit into (synthesise an empty plan
    /// for a course that has none cached yet).
    private func beginPlanEditingIfNeeded() {
        if plan == nil {
            plan = CoursePlan.empty(courseId: courseId)
        }
    }

    /// Select a plan shot by handle id (tap), or clear with nil.
    func selectPlanShot(handleID: String?) {
        selectedPlanShotId = handleID.flatMap(Self.planShotID(fromHandle:))
    }

    /// Arm / disarm "add shot": the next map tap places a landing point.
    func setAddingPlanShot(_ armed: Bool) { isAddingPlanShot = armed }

    // MARK: Plan-shot drag (cheap per frame, persist on drop)

    /// Grab a plan-shot handle (selects it, starts the cheap drag path).
    func beginPlanShotDrag(handleID: String) {
        guard toolMode == .plan, let shotId = Self.planShotID(fromHandle: handleID),
              let hole = currentHole else { return }
        draggingPlanShotID = shotId
        selectedPlanShotId = shotId
        planDragActive = true
        planDragStart = plan?.shots(holeNumber: hole.hole.number).first { $0.id == shotId }?.position
    }

    /// Per-frame drag: move the shot's coordinates in the local plan only.
    /// Pure geometry — no network, no elevation sample, no aim optimisation.
    func movePlanShot(handleID: String, to position: LatLon) {
        guard let hole = currentHole,
              let shotId = Self.planShotID(fromHandle: handleID)
        else { return }
        plan = plan?.movingShot(
            holeNumber: hole.hole.number, shotId: shotId, to: position, elevation: nil
        )
    }

    /// Drop: end the cheap path, re-enrich (bump the memo token), and persist
    /// the settled position — resampling the terrain elevation at the drop point.
    func endPlanShotDrag(handleID: String) {
        guard let shotId = Self.planShotID(fromHandle: handleID), let hole = currentHole else { return }
        let start = planDragStart
        draggingPlanShotID = nil
        planDragStart = nil
        planDragActive = false
        planEditToken += 1
        guard let shot = plan?.shots(holeNumber: hole.hole.number).first(where: { $0.id == shotId }) else { return }
        let position = shot.position
        // A tap that selected the handle without moving it: nothing to persist.
        if let start, start == position { return }
        let holeNumber = hole.hole.number
        Task { [weak self] in
            let elevation = await self?.elevationSampler?(position) ?? nil
            guard let self else { return }
            // Fold the sampled elevation into the local plan so plays-like math
            // uses it, then persist.
            self.plan = self.plan?.movingShot(
                holeNumber: holeNumber, shotId: shotId, to: position, elevation: elevation
            )
            self.planEditToken += 1
            await self.planWriter?.moveShot(shotId, position.lat, position.lon, elevation)
        }
    }

    // MARK: Add / remove / club

    /// Place a new plan shot at `position` (armed "add shot" → map tap). Appends
    /// in sortOrder with an auto-selected club (closest to the new leg's
    /// wind-adjusted plays-like distance), selects it, and persists (sampling
    /// elevation). No-op unless the planner tool is active + armed.
    func placePlanShot(at position: LatLon) {
        guard toolMode == .plan, isAddingPlanShot else { return }
        isAddingPlanShot = false
        appendPlanShot(at: position)
    }

    /// The reticle's "+ Target" action: append a plan point at the current
    /// reticle aim without the planner tool being up. Turns the plan overlay
    /// on so the new point is visible immediately.
    func addReticlePlanTarget() {
        guard let target = reticleTarget else { return }
        setPlanVisible(true)
        appendPlanShot(at: target)
    }

    /// Shared core of `placePlanShot` / `addReticlePlanTarget`: append a shot
    /// in sortOrder with an auto-selected club, select it, persist (sampling
    /// elevation).
    private func appendPlanShot(at position: LatLon) {
        guard let hole = currentHole else { return }
        beginPlanEditingIfNeeded()
        let holeNumber = hole.hole.number
        let existing = plan?.shots(holeNumber: holeNumber) ?? []
        let parentShotId = existing.last?.id
        // The on-device editor still appends only to the primary line. In the
        // tree model that new child is rank 0 under the former tail (or the
        // sole rank-0 root when the hole was empty).
        let sortOrder = 0
        let shotId = UUID().uuidString
        let club = autoClubForNewShot(at: position, existing: existing, hole: hole)
        let shot = CoursePlan.Shot(
            id: shotId, position: position, elevation: nil,
            clubId: club?.id, clubName: club?.name, label: nil,
            sortOrder: sortOrder, parentShotId: parentShotId
        )
        plan = plan?.addingShot(holeNumber: holeNumber, shot)
        selectedPlanShotId = shotId
        planEditToken += 1
        Task { [weak self] in
            let elevation = await self?.elevationSampler?(position) ?? nil
            guard let self else { return }
            self.plan = self.plan?.movingShot(
                holeNumber: holeNumber, shotId: shotId, to: position, elevation: elevation
            )
            self.planEditToken += 1
            await self.planWriter?.addShot(
                holeNumber, shotId, sortOrder, parentShotId,
                position.lat, position.lon, elevation, club?.id
            )
        }
    }

    /// The auto club for a newly placed shot: the bag's closest to the new
    /// leg's (wind-adjusted, plays-like) distance from the previous landing
    /// point (or the plan tee). Mirrors the web planner's `autoClubForShot`.
    private func autoClubForNewShot(
        at position: LatLon, existing: [CoursePlan.Shot], hole: HoleData
    ) -> ClubRecord? {
        let previous = existing.sorted { $0.sortOrder < $1.sortOrder }.last
        let from: LatLon
        let fromElevation: Double?
        if let previous {
            from = previous.position
            fromElevation = previous.elevation
        } else if let holePlan = currentHolePlan ?? plan?.hole(number: hole.hole.number),
                  let tee = planTee(for: hole, plan: holePlan) {
            from = LatLon(lat: tee.lat, lon: tee.lon)
            fromElevation = tee.elevation
        } else if let tee = activeTee(for: hole) {
            from = LatLon(lat: tee.lat, lon: tee.lon)
            fromElevation = tee.elevation
        } else {
            return nil
        }
        return suggestedClubRecord(
            from: from, fromElevation: fromElevation, to: position, toElevation: nil
        )
    }

    /// Remove a plan shot (local + persist).
    func removePlanShot(id shotId: String) {
        guard let hole = currentHole else { return }
        plan = plan?.removingShot(holeNumber: hole.hole.number, shotId: shotId)
        if selectedPlanShotId == shotId { selectedPlanShotId = nil }
        planEditToken += 1
        Task { [weak self] in await self?.planWriter?.removeShot(shotId) }
    }

    /// Remove the selected plan shot, if any.
    func removeSelectedPlanShot() {
        guard let id = selectedPlanShotId else { return }
        removePlanShot(id: id)
    }

    /// Set a plan shot's club (local + persist). Passing nil clears the club.
    func setPlanShotClub(shotId: String, clubId: String?) {
        guard let hole = currentHole else { return }
        let name = clubId.flatMap { id in clubs.first(where: { $0.id == id })?.name }
        plan = plan?.settingClub(
            holeNumber: hole.hole.number, shotId: shotId, clubId: clubId, clubName: name
        )
        planEditToken += 1
        Task { [weak self] in await self?.planWriter?.setShotClub(shotId, clubId) }
    }

    /// Clears the transient planner-tool selection/arming (hole nav / tool exit).
    private func resetPlanEditingState() {
        selectedPlanShotId = nil
        isAddingPlanShot = false
        planDragActive = false
        draggingPlanShotID = nil
    }

    /// The effective wind for the current hole: the plan hole's wind override,
    /// else the plan-level default, else nil (calm / unknown).
    ///
    /// NOT competition-gated. The wind comes off a weather report, not a device
    /// reading of the course, so it stays live in competition — the chip, the
    /// editor and the wind "plays as" distances all work there. What competition
    /// mode still withholds is SLOPE and club advice, and every consumer that
    /// surfaces those carries its own `competitionMode` guard (the strategy
    /// overlay, caddy advice, dispersion ellipses, `OnCourseDistances`'
    /// club block, and `playsAsAndElevation`'s elevation term).
    var effectiveWind: (speedMps: Double, directionDeg: Double)? {
        guard let plan, let hole = currentHole else { return nil }
        return plan.wind(holeNumber: hole.hole.number)
    }

    // MARK: - Wind editing (on-course wind editor)

    /// The plan-level (course-wide) wind, ignoring the current hole's override.
    var planWind: (speedMps: Double, directionDeg: Double)? { plan?.planWind }

    /// The current hole's OWN wind override, or nil when it inherits the plan's.
    var currentHoleWindOverride: (speedMps: Double, directionDeg: Double)? {
        guard let plan, let hole = currentHole else { return nil }
        return plan.windOverride(holeNumber: hole.hole.number)
    }

    /// Tail of the serialized wind-write chain (see `enqueueWindWrite`).
    @ObservationIgnored private var windWriteChain: Task<Void, Never>?

    /// Wind writes MUST reach the store in the order they were made, so they run
    /// as a chain rather than as independent unstructured tasks.
    ///
    /// Unlike the shot writers — which patch disjoint rows/fields, so a reorder
    /// is harmless — every wind edit overwrites the SAME two columns. Two loose
    /// `Task`s racing (a slider settle immediately followed by "clear", or the
    /// scope picker's clear-then-set migration) can land in either order, and the
    /// loser silently persists + syncs the stale wind while the model shows the
    /// new one. Awaiting the previous task pins the order to the edit order.
    private func enqueueWindWrite(
        _ write: @escaping @Sendable (PlanEditWriter) async -> Void
    ) {
        guard let planWriter else { return }
        let previous = windWriteChain
        windWriteChain = Task {
            await previous?.value
            await write(planWriter)
        }
    }

    /// Set the plan-level wind (applies to every hole without an override).
    /// A nil pair = calm. Persists + syncs through `planWriter`.
    func setPlanWind(speedMps: Double?, directionDeg: Double?) {
        beginPlanEditingIfNeeded()
        plan = plan?.settingPlanWind(speedMps: speedMps, directionDeg: directionDeg)
        // Wind moves plays-as, aim and club advice — re-enrich on the settled
        // plan, exactly as a shot edit does.
        planEditToken += 1
        refreshLadderElevations(force: true)
        enqueueWindWrite { writer in
            await writer.setPlanWind(speedMps, directionDeg)
        }
    }

    /// Set the CURRENT hole's wind override; a nil pair clears it (the hole
    /// falls back to the plan wind). Persists + syncs through `planWriter`.
    func setCurrentHoleWind(speedMps: Double?, directionDeg: Double?) {
        guard let hole = currentHole else { return }
        let holeNumber = hole.hole.number
        beginPlanEditingIfNeeded()
        plan = plan?.settingHoleWind(
            holeNumber: holeNumber, speedMps: speedMps, directionDeg: directionDeg
        )
        planEditToken += 1
        refreshLadderElevations(force: true)
        enqueueWindWrite { writer in
            await writer.setHoleWind(holeNumber, speedMps, directionDeg)
        }
    }

    /// True when the course has any renderable plan content — gates the plan
    /// toggle's presence in the control stack.
    var courseHasPlan: Bool { plan?.hasContent ?? false }

    /// Flip the plan-overlay switch (persisted per course, like the tee).
    func setPlanVisible(_ visible: Bool) {
        guard visible != planVisible else { return }
        planVisible = visible
        defaults.set(visible, forKey: Self.planVisibleKey(courseId: courseId))
    }

    func togglePlanVisible() { setPlanVisible(!planVisible) }

    /// The current hole's plan, or nil when the hole has no plan content.
    var currentHolePlan: CoursePlan.HolePlan? {
        guard let plan, let hole = currentHole else { return nil }
        return plan.hole(number: hole.hole.number)
    }

    /// The tee the plan starts from on this hole: the plan's `teeId` when
    /// that tee is placed here, else the active tee.
    private func planTee(for hole: HoleData, plan holePlan: CoursePlan.HolePlan) -> TeeRecord? {
        if let teeId = holePlan.teeId, let match = hole.tees.first(where: { $0.id == teeId }) {
            return match
        }
        return activeTee(for: hole)
    }

    /// The planned route for the current hole: plan tee → planned landing
    /// points (sortOrder) → green center. STORED positions throughout — the
    /// plan is the server-side strategy; local Adjust overrides never move it.
    var planRoute: [LatLon] {
        guard let holePlan = currentHolePlan, let hole = currentHole else { return [] }
        var route: [LatLon] = []
        if let tee = planTee(for: hole, plan: holePlan) {
            route.append(LatLon(lat: tee.lat, lon: tee.lon))
        }
        route.append(contentsOf: holePlan.shots.map(\.position))
        if let green = hole.green {
            route.append(LatLon(lat: green.centerLat, lon: green.centerLon))
        }
        return route
    }

    /// One row of the card's plan strip: leg N's planned club + label + the
    /// leg's whole-meter planar length (plan geometry, EPSG:3006 like every
    /// other figure). The final leg into the green has no shot entity —
    /// `clubName`/`label` are nil and `toGreen` is true.
    struct PlanLeg: Equatable, Identifiable {
        /// 1-based stroke number, e.g. the "1" in "1 · Driver · 214 m".
        let index: Int
        let clubName: String?
        let label: String?
        let meters: Int
        let toGreen: Bool
        /// Fallback club when the leg carries no planned club: the club whose
        /// carry is nearest the leg's (wind-adjusted) plays-like distance.
        /// Shown with a "~" suggested marker. Nil when the leg has a planned
        /// club, in competition mode, or without a bag.
        let suggestedClubName: String?
        var id: Int { index }
    }

    /// Per-leg plan rows for the current hole (empty without a plan).
    var planLegs: [PlanLeg] {
        guard let holePlan = currentHolePlan, let hole = currentHole else { return [] }
        var legs: [PlanLeg] = []
        let tee = planTee(for: hole, plan: holePlan)
        var previous: LatLon? = tee.map { LatLon(lat: $0.lat, lon: $0.lon) }
        var previousElevation: Double? = tee?.elevation
        for shot in holePlan.shots {
            if let from = previous {
                legs.append(PlanLeg(
                    index: legs.count + 1,
                    clubName: shot.clubName,
                    label: shot.label,
                    meters: Int(Distance.planarMeters(from, shot.position).rounded()),
                    toGreen: false,
                    suggestedClubName: shot.clubName == nil
                        ? suggestedClub(from: from, fromElevation: previousElevation,
                                        to: shot.position, toElevation: shot.elevation)
                        : nil
                ))
            }
            previous = shot.position
            previousElevation = shot.elevation
        }
        if let green = hole.green, let from = previous {
            let center = LatLon(lat: green.centerLat, lon: green.centerLon)
            legs.append(PlanLeg(
                index: legs.count + 1,
                clubName: nil,
                label: nil,
                meters: Int(Distance.planarMeters(from, center).rounded()),
                toGreen: true,
                suggestedClubName: suggestedClub(from: from, fromElevation: previousElevation,
                                                 to: center, toElevation: green.elevation)
            ))
        }
        return legs
    }

    /// One row of the unified distance ladder (see `LadderBuilder`). Every
    /// feature/target ahead of the ball, tagged by `kind` for color + filter.
    struct LadderRow: Identifiable, Equatable {
        enum Kind: String, Equatable, CaseIterable { case plan, hazard, aim, layup, green, pin }
        let id: String
        let kind: Kind
        /// Primary label, e.g. "Bunker", "Plan P1", "Green", "Aim".
        let label: String
        /// Secondary detail, e.g. club "3 Hybrid", "front / carry", "58 m in · LW".
        let detail: String?
        /// The sort / primary distance from the ball, whole meters.
        let meters: Int
        /// Hazard far-edge (carry) distance, whole meters; nil for other kinds.
        let carryM: Int?
        /// Layup only: distance still LEFT to the green center after this layup
        /// lands, whole meters. Nil for every other kind. Structured so the rail
        /// renders it directly instead of parsing `detail`; `detail` stays the
        /// human-readable form the advice banner shows.
        var remainingM: Int? = nil
        /// Layup only: the club you'd play the approach with from where this
        /// layup leaves you — what makes one "Lay up" rung distinct from the
        /// next. Nil for every other kind (and nil when the bag can't name one).
        var approachClub: String? = nil
        /// Where the feature sits on the map (WGS84), for tap-to-focus. Nil when
        /// the row has no single point (e.g. an unlocatable projected hazard).
        let position: LatLon?
    }

    /// The unified distance ladder for the current origin — plan landings,
    /// hazard carries, aim points, layups, and the green/pin, merged near→far.
    /// Backs the tall state of the distance card. Empty without an origin.
    var ladderRows: [LadderRow] {
        guard let origin, let distances else { return [] }

        // Every input the build below reads, fingerprinted so the six per-render
        // reads (rail + banner + ellipse + wind-hold) rebuild it at most once and
        // the follow-up `browseTargetElevation` render reuses it (not an input).
        // `hazards` is the memoised `hazardCarries` — evaluated once, feeding both
        // the fingerprint and the build.
        let hazardCarries = self.hazardCarries
        let key = LadderKey(
            origin: origin,
            distances: distances,
            targets: targets,
            planShots: (currentHolePlan?.shots ?? []).map {
                "\($0.clubName ?? "")|\($0.position.lat)|\($0.position.lon)"
            },
            competitionMode: competitionMode,
            clubs: clubsFingerprint(),
            hazards: hazardCarries,
            surfacesVersion: surfacesVersion
        )
        if key == ladderRowsKey { return ladderRowsCache }

        let rows = buildLadderRows(origin: origin, distances: distances, hazardCarries: hazardCarries)
        ladderRowsKey = key
        ladderRowsCache = rows
        ladderRowsBuildCount += 1
        return rows
    }

    private func buildLadderRows(
        origin: LatLon, distances: OnCourseDistances, hazardCarries: [HazardCarry]
    ) -> [LadderRow] {
        let planShots = (currentHolePlan?.shots ?? []).enumerated().map { i, shot in
            LadderBuilder.PlanShot(
                index: i + 1,
                clubName: shot.clubName,
                meters: Int(Distance.planarMeters(origin, shot.position).rounded()),
                position: shot.position
            )
        }

        // Hazards carry their real centroid, so a tapped row focuses the actual
        // bunker/water (side hazards aren't on the line). Label is side-prefixed
        // ("R Bunker").
        let hazards = hazardCarries.map { hazard in
            LadderBuilder.HazardItem(
                id: hazard.id, label: hazard.displayLabel, frontM: hazard.frontM, carryM: hazard.carryM,
                position: Sweref99TM.toWGS84(x: hazard.centroid.x, y: hazard.centroid.y)
            )
        }

        // `distances.aims` is 1:1 with `targets.aimPoints` (same order) — zip to
        // recover each aim's on-map point.
        let aims = zip(distances.aims, targets.aimPoints).map { aim, target in
            LadderBuilder.AimItem(label: aim.label, meters: aim.meters, position: target.position)
        }

        var layups: [LadderBuilder.LayupItem] = []
        if !competitionMode, !clubs.isEmpty, targets.greenCenter != nil {
            // Measure AND place layups along the hole's routed play-line (ball →
            // forward aims → green), so a rung's distance-left and its map point
            // agree and a dogleg layup lands on the second leg, not off in the
            // trees on the straight origin→green line. The lie filter drops any
            // option whose landing point sits in an unplayable lie.
            // Deliberately UNGATED `forwardRoute` (unlike the drawn line, which
            // `browseForwardRoute`/`gpsForwardRoute` snap straight within the
            // aim-routing threshold): a layup exists precisely because the
            // green is out of reach, so its landing points must follow the
            // full routed line around the corner.
            let route = forwardRoute(from: origin)
            let routedTargetM = HoleLength.pathMeters(route)
            layups = LadderBuilder.ladderLayups(
                clubs: clubs,
                routedTargetM: routedTargetM,
                landingAcceptable: { carry in
                    guard let landing = HoleLength.pointAlong(route, meters: carry) else { return true }
                    let p = Sweref99TM.fromWGS84(landing)
                    return Self.isPlayableLayupLie(self.lieAt(Vec2(x: p.x, y: p.y)))
                }
            ).map { opt in
                LadderBuilder.LayupItem(
                    clubName: opt.club.name,
                    carryM: Int(opt.carryM.rounded()),
                    remainingM: Int(opt.remainingM.rounded()),
                    approachClub: opt.approachClub?.name,
                    position: HoleLength.pointAlong(route, meters: opt.carryM)
                )
            }
        }

        return LadderBuilder.build(
            planShots: planShots,
            hazards: hazards,
            aims: aims,
            layups: layups,
            green: LadderBuilder.Green(
                front: distances.front, center: distances.center, back: distances.back,
                pin: distances.pin, pinName: targets.activePinName,
                centerPosition: targets.greenCenter, pinPosition: targets.activePin
            )
        )
    }

    /// The "what do I do about this target" advice for the banner: club + the
    /// plays-as distance for whichever ladder rung is selected (default = the
    /// green). Targets get a reach club; hazards a carry club (or "lay up
    /// short"); an out-of-range green the honest layup. Nil in competition mode
    /// still shows the distance — only the club/plays-as advice is gated.
    struct TargetAdvice: Equatable {
        var title: String
        var kind: LadderRow.Kind
        /// The raw straight-line ("actual") distance, whole meters.
        var distanceM: Int
        /// Plays-like + wind ("plays as") distance — green/pin only; nil else.
        var playsAsM: Int?
        /// Signed elevation delta origin→target, whole meters (uphill positive);
        /// green/pin only. nil when unknown.
        var elevationDeltaM: Int?
        /// Reach / carry / bomb club; nil in competition mode or without a bag.
        var club: String?
        /// The advised club's wind/slope-adjusted ground carry, whole meters —
        /// the SAME figure the advice ellipse's geometry (and its on-map label)
        /// uses. Nil whenever the shot visualization is (competition mode,
        /// hazards, no club).
        var clubCarryM: Int?
        /// Hazard far edge, whole meters; nil for non-hazards.
        var carryM: Int?
        /// Trailing context: "58 m · LW", "3 Wood carries", "Lay up short".
        var note: String?
        /// SF Symbol drawn ahead of `note` (e.g. "flag.fill" = to the green) —
        /// the icon carries the destination so the note stays short.
        var noteSystemImage: String?
        /// Browse-tap rows: what's LEFT to the green center from the tapped
        /// point ("⚑ 141 · 8I"), so inspecting a landing spot keeps the
        /// approach in view. Nil for other rows / no green / on the green.
        var toGreenM: Int?
        var toGreenClub: String?
        /// Crosswind compensation on the ground, hidden below the 3 m visual
        /// threshold. The side is relative to the shot line, not map north.
        var windHoldM: Int?
        var windHoldSide: TargetWindHold.Side?
    }

    /// The target the banner + map advice reflect: an arbitrary inspected map
    /// point, else the focused ladder rung, else the green/pin/default row.
    private var selectedLadderRow: LadderRow? {
        // A decide-choice working target OWNS the banner/advice surface while
        // set (R4): the tapped choice is the shot being played.
        if let wt = workingTarget, let origin {
            return LadderRow(
                id: Self.workingTargetRowID,
                kind: .aim,
                label: wt.label,
                detail: nil,
                meters: Int(Distance.planarMeters(origin, wt.position).rounded()),
                carryM: nil,
                position: wt.position
            )
        }
        // A tapped course shape owns the banner while inspected: a hazard-kind
        // row whose meters/carryM are the shape's front/carry along the play
        // line, so the hazard banner (big carry + "carry · front N") renders it.
        if let feature = inspectedFeature, origin != nil {
            return LadderRow(
                id: Self.inspectedFeatureRowID,
                kind: .hazard,
                label: feature.carry.displayLabel,
                detail: "front / carry",
                meters: feature.carry.frontM,
                carryM: feature.carry.carryM,
                position: Sweref99TM.toWGS84(x: feature.carry.centroid.x, y: feature.carry.centroid.y)
            )
        }
        // Inspecting an arbitrary tapped point needs no ladder — return early so a
        // browse tap never builds the (course-wide) ladder it would not use.
        if let browseTarget, let origin {
            return LadderRow(
                id: Self.browseTargetRowID,
                kind: .aim,
                label: "Selected point",
                detail: nil,
                meters: Int(Distance.planarMeters(origin, browseTarget).rounded()),
                carryM: nil,
                position: browseTarget
            )
        }
        let rows = ladderRows
        guard !rows.isEmpty else { return nil }
        return focusedLadderId.flatMap { id in rows.first { $0.id == id } }
            ?? rows.first { $0.kind == .green }
            ?? rows.first { $0.kind == .pin }
            ?? rows.first
    }

    private static let browseTargetRowID = "browse-target"
    static let inspectedFeatureRowID = "inspected-feature"

    /// Minimum |adjusted carry − plays-as| before the advice names the gap
    /// ("+49 long") — under this the ellipse visually covers the target anyway.
    private static let clubGapNoteMinM = 5

    var selectedTargetAdvice: TargetAdvice? {
        guard let row = selectedLadderRow else { return nil }

        // Plays-as (plays-like + wind) + elevation delta for any target whose
        // elevation is known — stored (green / pin / aim / plan) or sampled from
        // the offline terrain DEM at the target (nil-elevation aims + layups).
        // Only hazards stay actual-only (their centroid is off the shot line;
        // see `targetElevation`).
        var playsAs: Int?
        var elevationDelta: Int?
        if let pos = row.position,
           let pae = playsAsAndElevation(to: pos, elevation: targetElevation(for: row)) {
            playsAs = pae.playsAs
            elevationDelta = pae.elevationDelta
        }

        var club: String?
        var note: String?
        var noteSystemImage: String?
        if !competitionMode, !clubs.isEmpty {
            if row.id == Self.workingTargetRowID, let chosen = workingTarget?.clubName {
                // The working target carries ITS choice's club — the banner
                // and ghost pattern must show what the player committed to,
                // not a re-derived closest club.
                club = chosen
            } else if row.kind == .hazard {
                if row.id == Self.inspectedFeatureRowID, inspectedFeature?.carry.kind == "green" {
                    // Tapped green ring: the front/back window IS the readout —
                    // a carry club or "Lay up short" note is hazard advice and
                    // reads wrong against the green.
                } else if let carry = row.carryM {
                    let longest = clubs.map(\.carryM).max() ?? 0
                    if Double(carry) <= longest {
                        club = closestClub(clubs, Double(carry))?.name
                        note = "carries"
                    } else {
                        note = "Lay up short"
                    }
                }
            } else if row.kind == .green, let layup = distances?.layup {
                // Green out of range → you're hitting a lay-up, not the green,
                // so plays-as / elevation to the green are noise; drop them and
                // let the "leaves" figure carry the row.
                club = layup.club
                // "⚑ 176 m · 5I" — the flag icon says "to the green" without
                // costing the words that clipped on narrow cards.
                note = "\(layup.remainingM) m" + (layup.approachClub.map { " · \($0)" } ?? "")
                noteSystemImage = "flag.fill"
                playsAs = nil
                elevationDelta = nil
            } else {
                // Club for what it actually plays (plays-as when known). The
                // layup rung's detail ("58 m in · LW") is worth showing; a plan
                // rung's detail is just its club, which the chip already covers.
                club = closestClub(clubs, Double(playsAs ?? row.meters))?.name
                if row.kind == .layup { note = row.detail }
            }
        }

        let shotViz = club.flatMap { clubName in
            selectedTargetVisualization(
                for: row, clubName: clubName, elevationDeltaM: elevationDelta
            )
        }
        // Inspected map point: keep the NEXT shot in view — distance from the
        // tap on to the green center plus the bag's approach club. Gated past
        // 15 m so taps on/around the green don't grow a noise chip.
        var toGreenM: Int?
        var toGreenClub: String?
        if row.id == Self.browseTargetRowID, let pos = row.position,
           let green = targets.greenCenter {
            let remaining = Int(Distance.planarMeters(pos, green).rounded())
            if remaining >= 15 {
                toGreenM = remaining
                toGreenClub = suggestedClub(
                    from: pos,
                    fromElevation: browseTargetElevation ?? ladderTerrainElevation(at: pos),
                    to: green,
                    toElevation: targets.greenElevation
                )
            }
        }
        // The closest club can still be well off the target (sparse bag) —
        // then its ellipse sits visibly long/short of the tap and reads as a
        // bug. Name the gap: adjusted carry vs what the target plays as.
        if note == nil, let viz = shotViz {
            // Both sides are GROUND meters from the origin: the ellipse
            // center's adjusted carry vs the target's straight distance (the
            // wind/slope the club fights is already inside viz.carryM —
            // comparing against plays-as would double-count it).
            let gap = viz.carryM - row.meters
            if abs(gap) >= Self.clubGapNoteMinM {
                note = gap > 0 ? "+\(gap) long" : "\(-gap) short"
            }
        }
        return TargetAdvice(
            title: row.label, kind: row.kind, distanceM: row.meters,
            playsAsM: playsAs, elevationDeltaM: elevationDelta,
            club: club, clubCarryM: shotViz?.carryM, carryM: row.carryM, note: note,
            noteSystemImage: noteSystemImage,
            toGreenM: toGreenM, toGreenClub: toGreenClub,
            windHoldM: shotViz?.hold?.meters,
            windHoldSide: shotViz?.hold?.side
        )
    }

    private struct SelectedTargetVisualization {
        var ellipse: [LatLon]
        var hold: TargetWindHold?
        /// The ellipse's (drift-shifted) center — the on-map label anchor.
        var center: LatLon
        /// Planar distance origin → ellipse center, whole meters — the SAME
        /// wind/slope-adjusted ground carry the ellipse geometry uses, so the
        /// label/chip figure can never disagree with the drawn pattern.
        var carryM: Int
        /// The club the ellipse was built for (label text).
        var clubName: String
    }

    /// Match the plan ghost's visibility threshold: below 3 m the connector is
    /// map noise and the compact card figure rounds too aggressively to matter.
    private static let selectedWindHoldMinM = 3.0

    /// Build the selected target's shot pattern and, when crosswind matters, a
    /// compensated aim. The correction iterates the bearing because moving the
    /// hold point slightly changes the wind component relative to the shot.
    /// Four passes converge well below map precision at golf-shot distances.
    private func selectedTargetVisualization(
        for row: LadderRow, clubName: String, elevationDeltaM: Int?
    ) -> SelectedTargetVisualization? {
        guard !competitionMode, row.kind != .hazard, let origin,
              let targetPosition = row.position,
              let club = clubs.first(where: { $0.name == clubName })
        else { return nil }

        // `selectedTargetAdvice`, `selectedTargetEllipse` and `selectedTargetWindHold`
        // each drive this (up to five calls per render), so memoise on the resolved
        // inputs — the dispersion ellipse + 4-pass crosswind solve then runs once.
        let key = VisualizationKey(
            kind: row.kind, origin: origin, target: targetPosition, clubName: clubName,
            clubCarryM: club.carryM, clubDispersionM: club.dispersionM,
            elevationDeltaM: elevationDeltaM,
            windSpeed: effectiveWind?.speedMps, windDir: effectiveWind?.directionDeg,
            competitionMode: competitionMode
        )
        if key == visualizationKey { return visualizationCache }

        let result = computeSelectedTargetVisualization(
            origin: origin, targetPosition: targetPosition, club: club, elevationDeltaM: elevationDeltaM
        )
        visualizationKey = key
        visualizationCache = result
        return result
    }

    private func computeSelectedTargetVisualization(
        origin: LatLon, targetPosition: LatLon, club: ClubRecord, elevationDeltaM: Int?
    ) -> SelectedTargetVisualization? {
        let o = Sweref99TM.fromWGS84(origin)
        let t = Sweref99TM.fromWGS84(targetPosition)
        let dx = t.x - o.x, dy = t.y - o.y
        let len = hypot(dx, dy)
        guard len > 0 else { return nil }

        func bearing(to point: Vec2) -> Double {
            let deg = atan2(point.x - o.x, point.y - o.y) * 180 / .pi
            return deg < 0 ? deg + 360 : deg
        }

        let target = Vec2(x: t.x, y: t.y)
        var aimBearing = bearing(to: target)
        var driftM = 0.0
        if let wind = effectiveWind {
            for _ in 0..<4 {
                driftM = crosswindDriftM(
                    club.carryM,
                    windComponents(wind.speedMps, wind.directionDeg, aimBearing).crosswindMph
                )
                let along = bearingToUnitVector(aimBearing)
                let right = Vec2(x: along.y, y: -along.x)
                let holdPoint = Vec2(
                    x: target.x - driftM * right.x,
                    y: target.y - driftM * right.y
                )
                aimBearing = bearing(to: holdPoint)
            }
            // Pin the reported/visible amount to the final corrected bearing.
            driftM = crosswindDriftM(
                club.carryM,
                windComponents(wind.speedMps, wind.directionDeg, aimBearing).crosswindMph
            )
        }

        let slope = elevationDeltaM.map { Double($0) / len }
        let wind = effectiveWind
        let ellipse = dispersionEllipse(DispersionEllipseOptions(
            origin: Vec2(x: o.x, y: o.y),
            bearingDeg: aimBearing,
            club: club,
            windSpeedMps: wind?.speedMps,
            windDirectionDeg: wind?.directionDeg,
            groundSlope: slope
        ))

        let hold: TargetWindHold?
        if abs(driftM) >= Self.selectedWindHoldMinM {
            let along = bearingToUnitVector(aimBearing)
            let right = Vec2(x: along.y, y: -along.x)
            let aim = Vec2(
                x: target.x - driftM * right.x,
                y: target.y - driftM * right.y
            )
            hold = TargetWindHold(
                aim: Sweref99TM.toWGS84(x: aim.x, y: aim.y),
                target: targetPosition,
                meters: Int(abs(driftM).rounded()),
                // Positive drift is shot-right, therefore hold left (and vice versa).
                side: driftM > 0 ? .left : .right
            )
        } else {
            hold = nil
        }

        return SelectedTargetVisualization(
            ellipse: ellipse.polygon.map { Sweref99TM.toWGS84(x: $0.x, y: $0.y) },
            hold: hold,
            center: Sweref99TM.toWGS84(x: ellipse.center.x, y: ellipse.center.y),
            carryM: Int(hypot(ellipse.center.x - o.x, ellipse.center.y - o.y).rounded()),
            clubName: club.name
        )
    }

    /// The recommended club's wind-compensated dispersion ellipse for the
    /// selected target. Nil in competition mode, for hazards, or without a
    /// resolvable origin/club.
    var selectedTargetEllipse: [LatLon]? {
        guard let row = selectedLadderRow,
              let advice = selectedTargetAdvice,
              let clubName = advice.club
        else { return nil }
        return selectedTargetVisualization(
            for: row, clubName: clubName, elevationDeltaM: advice.elevationDeltaM
        )?.ellipse
    }

    /// The advice ellipse's on-map label: "<club> · <adjusted carry>", anchored
    /// at the ellipse's center. The carry is the visualization's own
    /// origin→center distance, so label and geometry can never disagree.
    /// Present exactly when `selectedTargetEllipse` is.
    var selectedTargetEllipseLabel: EllipseLabel? {
        guard let row = selectedLadderRow,
              let advice = selectedTargetAdvice,
              let clubName = advice.club,
              let viz = selectedTargetVisualization(
                  for: row, clubName: clubName, elevationDeltaM: advice.elevationDeltaM
              )
        else { return nil }
        return EllipseLabel(position: viz.center, text: "\(viz.clubName) · \(viz.carryM)")
    }

    /// The map's rose "hold here" marker/connector for the selected target.
    var selectedTargetWindHold: TargetWindHold? {
        guard let row = selectedLadderRow,
              let advice = selectedTargetAdvice,
              let clubName = advice.club
        else { return nil }
        return selectedTargetVisualization(
            for: row, clubName: clubName, elevationDeltaM: advice.elevationDeltaM
        )?.hold
    }

    /// Known elevation of a ladder target, for plays-as. Green/pin share the
    /// green elevation; a plan rung carries its own. An aim uses its stored
    /// elevation, else the terrain sample the sweep cached at its position (so a
    /// moved / never-recorded aim still plays-as). A layup uses the terrain
    /// sample at its landing point. Hazards stay nil — deliberately actual-only:
    /// their ladder figures (front/carry) are projected onto the shot line while
    /// `position` is the hazard CENTROID, which sits off-line for side hazards,
    /// so a centroid plays-as would contradict the front/carry the rung shows.
    /// Parses the builder's row-id scheme ("aim-<i>", "plan-<index>").
    private func targetElevation(for row: LadderRow) -> Double? {
        if row.id == Self.browseTargetRowID { return browseTargetElevation }
        // Working target: sample the terrain at the committed landing (same
        // first-order treatment as layup rungs).
        if row.id == Self.workingTargetRowID { return row.position.flatMap(ladderTerrainElevation) }
        switch row.kind {
        case .green, .pin:
            return targets.greenElevation
        case .aim:
            guard let i = Int(row.id.dropFirst("aim-".count)),
                  targets.aimPoints.indices.contains(i) else { return nil }
            return targets.aimPoints[i].elevation ?? row.position.flatMap(ladderTerrainElevation)
        case .plan:
            guard let n = Int(row.id.dropFirst("plan-".count)),
                  let shots = currentHolePlan?.shots, shots.indices.contains(n - 1) else { return nil }
            return shots[n - 1].elevation
        case .layup:
            // First-order approximation: the true landing elevation is wherever
            // the club actually stops, but we sample the NOMINAL carry point and
            // do not iterate to the elevation-adjusted landing.
            return row.position.flatMap(ladderTerrainElevation)
        case .hazard:
            return nil
        }
    }

    /// Plays-as and the signed elevation delta origin→target.
    ///
    /// Normally plays-as is plays-like (slope) THEN wind, with the elevation
    /// delta alongside it; nil when either endpoint elevation is unknown.
    ///
    /// In competition mode slope is off limits but wind is not, so the pair
    /// degrades rather than vanishing: plays-as becomes the STRAIGHT distance
    /// put through the wind, and the elevation delta is nil (it IS the slope
    /// information the mode withholds). With no wind either, there is nothing
    /// left to say and the whole thing is nil.
    private func playsAsAndElevation(
        to target: LatLon, elevation: Double?
    ) -> (playsAs: Int, elevationDelta: Int?)? {
        guard let origin else { return nil }
        let a = Sweref99TM.fromWGS84(origin)
        let b = Sweref99TM.fromWGS84(target)

        /// Wind "plays as" over a base distance, along the origin→target line.
        func windAdjusted(_ base: Double) -> Double {
            guard let wind = effectiveWind else { return base }
            let deg = atan2(b.x - a.x, b.y - a.y) * 180 / .pi
            let bearing = deg < 0 ? deg + 360 : deg
            return playsAsM(base, windEffect(wind.speedMps, wind.directionDeg, bearing, base))
        }

        if competitionMode {
            guard effectiveWind != nil else { return nil }
            let straight = Distance.planarMeters(origin, target)
            return (Int(windAdjusted(straight).rounded()), nil)
        }

        guard let originElevation, let elevation else { return nil }
        let stats = PlaysLike.segmentStats(
            PlaysLike.Point(e: a.x, n: a.y, elevation: originElevation),
            PlaysLike.Point(e: b.x, n: b.y, elevation: elevation)
        )
        guard let playsLike = stats.playsLikeSimple else { return nil }
        return (
            Int(windAdjusted(playsLike).rounded()),
            Int((elevation - originElevation).rounded())
        )
    }

    /// Layup landing-lie filter: a routed layup is dropped when its landing point
    /// classifies as a lie you can't sensibly play the next shot from — penalty
    /// (water / OOB), recovery (trees / deep rough), or sand. Fairway, rough,
    /// green and tee are kept. Points in no surface ring lie as `.rough` (see
    /// `lieAt`), so with no surface map every layup is accepted — the filter is a
    /// refinement layered on top of the routing, never a hard gate on its own.
    private static func isPlayableLayupLie(_ lie: Lie) -> Bool {
        switch lie {
        case .penalty, .recovery, .sand: return false
        case .fairway, .rough, .green, .tee: return true
        }
    }

    /// Closest club to a leg's playing distance, or nil. Mirrors the card's
    /// composition: plays-like (when both endpoints have elevation) else the
    /// straight line, then the wind "plays as". Gated off in competition mode.
    private func suggestedClub(
        from: LatLon, fromElevation: Double?, to: LatLon, toElevation: Double?
    ) -> String? {
        guard !competitionMode else { return nil }
        return suggestedClubRecord(
            from: from, fromElevation: fromElevation, to: to, toElevation: toElevation
        )?.name
    }

    /// The bag's closest club to a leg's (plays-like + wind-adjusted) playing
    /// distance, as a record. Backs both the card's suggested-club label and the
    /// planner tool's auto-club on shot placement. NOT competition-gated (the
    /// planner picks a club to WRITE, not display advice).
    private func suggestedClubRecord(
        from: LatLon, fromElevation: Double?, to: LatLon, toElevation: Double?
    ) -> ClubRecord? {
        guard !clubs.isEmpty else { return nil }
        let a = Sweref99TM.fromWGS84(from)
        let b = Sweref99TM.fromWGS84(to)
        var base = Distance.planarMeters(from, to)
        if let fe = fromElevation, let te = toElevation {
            let stats = PlaysLike.segmentStats(
                PlaysLike.Point(e: a.x, n: a.y, elevation: fe),
                PlaysLike.Point(e: b.x, n: b.y, elevation: te)
            )
            if let pl = stats.playsLikeSimple { base = pl }
        }
        if let wind = effectiveWind {
            let deg = atan2(b.x - a.x, b.y - a.y) * 180 / .pi
            let bearing = deg < 0 ? deg + 360 : deg
            base = playsAsM(base, windEffect(wind.speedMps, wind.directionDeg, bearing, base))
        }
        return closestClub(clubs, base)
    }

    /// GPS mode: the next planned landing point ahead of the user — the FIRST
    /// planned shot point not yet passed along the hole, where "not yet
    /// passed" means the point is still closer to the green than the user is
    /// (the same rule as `nextAimAhead`, without the routing threshold: the
    /// plan row is informational, not a route switch). nil in browse mode,
    /// without a plan, or once every planned landing is behind the user (the
    /// green is then the target and the card's F/C/B already covers it).
    var nextPlannedLanding: CoursePlan.Shot? {
        guard
            let user = effectiveUserLocation,
            let holePlan = currentHolePlan,
            let green = currentHole?.green
        else { return nil }
        let center = LatLon(lat: green.centerLat, lon: green.centerLon)
        let userToGreen = Distance.planarMeters(user, center)
        return holePlan.shots.first { shot in
            Distance.planarMeters(shot.position, center) < userToGreen
        }
    }

    /// The card's "to plan" row: whole-meter distance from the current origin
    /// to the next planned landing point, with that landing's club/label.
    struct PlanTargetDistance: Equatable {
        let clubName: String?
        let label: String?
        let meters: Int
    }

    var planTargetDistance: PlanTargetDistance? {
        guard let origin, let shot = nextPlannedLanding else { return nil }
        return PlanTargetDistance(
            clubName: shot.clubName,
            label: shot.label,
            meters: Int(Distance.planarMeters(origin, shot.position).rounded())
        )
    }

    /// The map overlay for the current hole's plan, or nil when the toggle is
    /// off or there is nothing to draw. Derived per hole, so hole navigation
    /// swaps it automatically and it clears on plan-less holes/courses.
    ///
    /// The shot-viz extras (dispersion ellipses, ghost aim, confidence tints)
    /// ride ALONGSIDE the base line/nodes/gates and are hidden in competition
    /// mode (DMD rule: they are advice) — the base plan geometry still shows.
    var planOverlay: PlanOverlay? {
        // The plan overlay shows when the toggle is on OR while the planner
        // tool is active (editing must always see what it edits, even with the
        // toggle off).
        guard planVisible || toolMode == .plan, let holePlan = currentHolePlan else { return nil }
        // Competition mode hides all shot-viz advice. While a plan shot is
        // being dragged, only the cheap ellipses follow the finger — the
        // optimizeAim-backed ghost/tints freeze until release re-enriches
        // (task T3 drag cadence, mirroring the web planner).
        let strategy: PlanStrategy.Geometry
        if competitionMode {
            strategy = .empty
        } else if planDragActive {
            strategy = cheapStrategyForCurrentHole()
        } else {
            strategy = strategyGeometryForCurrentHole()
        }
        return PlanOverlay(
            line: planRoute,
            nodes: holePlan.shots.map(\.position),
            gates: holePlan.gates.map { gate in
                let endpoints = gate.endpoints
                return PlanOverlay.GateLine(left: endpoints.left, right: endpoints.right)
            },
            ellipses: visiblePlanEllipses(strategy.ellipses),
            ghosts: strategy.ghosts,
            legTints: strategy.legTints
        )
    }

    /// On-course plan-ellipse visibility is SELECTION-driven: the per-leg
    /// dispersion ellipses are anonymous clutter next to the cyan advice
    /// ellipse, so they draw only when a ladder plan row is selected — and then
    /// only that waypoint's INCOMING leg (landing on it) and OUTGOING leg
    /// (departing it; the last shot's is the approach-to-green). Any other
    /// selection (green/pin/hazard/aim/layup) or none → no plan ellipses; the
    /// plan polyline/nodes/gates and the ghost/tint visuals are untouched.
    /// While the planner TOOL is active every leg keeps its ellipse — editing
    /// must always see what it edits (including the per-frame drag ellipses).
    /// Matching by shot id, not position: the builders skip zero-length /
    /// clubless legs, so ellipse order ≠ leg index.
    private func visiblePlanEllipses(
        _ ellipses: [PlanStrategy.EllipseShape]
    ) -> [PlanStrategy.EllipseShape] {
        if toolMode == .plan { return ellipses }
        guard let row = selectedLadderRow, row.kind == .plan,
              let shotId = planShotId(forLadderRowId: row.id)
        else { return [] }
        return ellipses.filter { $0.toShotId == shotId || $0.fromShotId == shotId }
    }

    /// The `CoursePlan.Shot` id behind a ladder plan row. Row ids are
    /// "plan-<1-based index>" (`LadderBuilder`), indexing `currentHolePlan`'s
    /// shots in order.
    private func planShotId(forLadderRowId id: String) -> String? {
        guard id.hasPrefix("plan-"),
              let n = Int(id.dropFirst("plan-".count)),
              let shots = currentHolePlan?.shots,
              n >= 1, n <= shots.count
        else { return nil }
        return shots[n - 1].id
    }

    /// Fingerprint of every input the shot-viz geometry depends on. When it is
    /// unchanged the memoised `strategyGeometry` is reused, so `optimizeAim`
    /// runs only on a real plan/hole/wind/bag/surface change — never per frame.
    private struct StrategyKey: Equatable {
        var holeNumber: Int
        var windSpeed: Double?
        var windDir: Double?
        var teeName: String?
        var clubs: [String]
        var holePlan: CoursePlan.HolePlan
        var surfaceCount: Int
        /// Bumped on every plan edit-drop so a release re-enriches even when the
        /// dropped position rounds to the same `holePlan` (task T3 cadence).
        var editToken: Int
    }

    /// Count of FULL shot-viz recomputes (cache misses of the aim-enrichment
    /// pass). The drag path never bumps this — a burst of drag frames leaves it
    /// flat, and a drop bumps it exactly once. Behaviour-neutral instrumentation
    /// the cadence tests assert on (mirrors the web planner's `enrichCount`).
    /// `@ObservationIgnored` because it is written inside the geometry getter
    /// that the view reads — an observed write there would trip SwiftUI.
    @ObservationIgnored private(set) var strategyEnrichCount = 0

    /// The current hole's plan nodes (tee → landing shots → green), or empty.
    private func planNodesForCurrentHole() -> [PlanStrategy.Node] {
        guard let holePlan = currentHolePlan, let hole = currentHole else { return [] }
        var nodes: [PlanStrategy.Node] = []
        if let tee = planTee(for: hole, plan: holePlan) {
            nodes.append(PlanStrategy.Node(
                latLon: LatLon(lat: tee.lat, lon: tee.lon),
                elevation: tee.elevation, kind: .tee
            ))
        }
        for shot in holePlan.shots {
            nodes.append(PlanStrategy.Node(
                latLon: shot.position, elevation: shot.elevation,
                kind: .shot, clubId: shot.clubId, shotId: shot.id
            ))
        }
        if let green = hole.green {
            nodes.append(PlanStrategy.Node(
                latLon: LatLon(lat: green.centerLat, lon: green.centerLon),
                elevation: green.elevation, kind: .green
            ))
        }
        return nodes
    }

    /// The CHEAP per-frame drag slice: dispersion ellipses only (no aim sweep).
    /// Recomputed fresh each frame (cheap) and deliberately NOT memoised.
    private func cheapStrategyForCurrentHole() -> PlanStrategy.Geometry {
        let nodes = planNodesForCurrentHole()
        guard !nodes.isEmpty else { return .empty }
        return PlanStrategy.Geometry(
            ellipses: PlanStrategy.ellipsesOnly(nodes: nodes, clubs: clubs, wind: effectiveWind),
            ghosts: [], legTints: []
        )
    }

    /// Memoised shot-viz overlay for the current hole (competition mode is
    /// handled by the caller). Recomputes only when `StrategyKey` changes.
    private func strategyGeometryForCurrentHole() -> PlanStrategy.Geometry {
        guard let holePlan = currentHolePlan, let hole = currentHole else {
            return .empty
        }
        let wind = effectiveWind
        let key = StrategyKey(
            holeNumber: hole.hole.number,
            windSpeed: wind?.speedMps,
            windDir: wind?.directionDeg,
            teeName: resolvedTeeName,
            clubs: clubs.map { "\($0.id):\($0.carryM):\($0.dispersionM)" },
            holePlan: holePlan,
            surfaceCount: surfaces.count,
            editToken: planEditToken
        )
        if key == strategyKey { return strategyGeometry }

        let geometry = PlanStrategy.compute(
            nodes: planNodesForCurrentHole(), clubs: clubs, surfaces: surfaces, wind: wind
        )
        strategyKey = key
        strategyGeometry = geometry
        strategyEnrichCount += 1
        return geometry
    }

    // MARK: - Smart caddy (plan editor)

    /// Ranked smart-caddy advice for the current hole's plan — the iOS mirror of
    /// the web planner's `computeCaddyAdvice`. Reuses the per-leg `AimResult`
    /// the memoised strategy geometry already computed (so NO second
    /// `optimizeAim` sweep for the aim-reading rules), builds a `CaddyContext`
    /// per clubbed leg, and runs the full `caddyRules()` set over each — the
    /// rules self-gate. Withheld in competition mode (advice, like plays-like).
    /// Memoised on `strategyEnrichCount` so it recomputes only when the plan
    /// geometry does — never on the per-frame drag path (advice freezes mid-drag
    /// and re-computes on release, mirroring the web).
    ///
    /// NB: `green-slope-half` never fires here — it needs a `GreenSlopeSummary`,
    /// which only the Green view samples (see `CaddyAdviceModel`). The other five
    /// rules cover plan editing.
    var planCaddyAdvice: [CaddyAdvice] {
        guard !competitionMode else { return [] }
        let geometry = strategyGeometryForCurrentHole()
        if caddyAdviceKey == strategyEnrichCount { return caddyAdviceCache }
        let advice = computePlanCaddyAdvice(geometry.legPlans)
        caddyAdviceKey = strategyEnrichCount
        caddyAdviceCache = advice
        return advice
    }

    private func computePlanCaddyAdvice(_ legPlans: [PlanStrategy.LegPlan]) -> [CaddyAdvice] {
        guard let hole = currentHole, !legPlans.isEmpty else { return [] }
        let par = hole.hole.par
        let index = hole.hole.strokeIndex ?? hole.hole.number
        let hazards = courseHazardRings
        let wind = effectiveWind.map { FeatureWind(speedMps: $0.speedMps, directionDeg: $0.directionDeg) }
        // Green ref points: the terminal node is the hole green centre (shared by
        // every leg — the aim scoring target). front/back are the hole's actual
        // green edges when known (only green-slope reads them, and it is inert
        // here), else the centre. The green polygon comes from the lie-map stack.
        let center = legPlans[0].greenCenterPlanar
        let front = targets.greenFront.map(Self.planar) ?? center
        let back = targets.greenBack.map(Self.planar) ?? center
        let greenPoly = greenRing(near: center)

        var advice: [CaddyAdvice] = []
        for lp in legPlans {
            let originLie = lieAt(lp.fromPlanar)
            let leg = Self.caddyLegKind(
                originLie: originLie, landsOnGreen: lp.landsOnGreen,
                index: lp.legIndex - 1, par: par
            )
            let ctx = CaddyContext<ClubRecord>(
                leg: leg,
                origin: StrategyPoint(x: lp.fromPlanar.x, y: lp.fromPlanar.y),
                target: CaddyGreenTarget(
                    greenPoly: greenPoly,
                    center: lp.greenCenterPlanar,
                    front: front,
                    back: back
                ),
                aim: lp.aim,
                hazards: hazards,
                clubs: clubs,
                wind: wind,
                hole: CaddyHole(par: par, index: index),
                risk: RiskProfile(riskAversion: 0)
            )
            advice.append(contentsOf: runCaddy(ctx, caddyRules()))
        }
        return advice
    }

    /// Leg-kind classification — faithful port of the web `caddyLegKind` (LOCKED
    /// order): a recovery lie wins over everything; a leg into the green is an
    /// approach; the tee shot (index 0) is a tee; a par-5 second shot is a layup;
    /// anything else falls back to tee. `index` is the 0-based leg index.
    static func caddyLegKind(originLie: Lie, landsOnGreen: Bool, index: Int, par: Int) -> CaddyLeg {
        if originLie == .recovery { return .recovery }
        if landsOnGreen { return .approach }
        if index == 0 { return .tee }
        if par == 5 && index == 1 { return .layup }
        return .tee
    }

    /// Classify the lie at a planar point against the topmost-first surface
    /// stack (first containing ring wins, D23) — the same rule `optimizeAim`
    /// uses. Points in no ring lie as `.rough`.
    private func lieAt(_ p: Vec2) -> Lie {
        // Topmost-first: the first CONTAINING ring wins (D23). The bbox precheck
        // only skips rings whose box excludes `p` (they cannot contain it), so it
        // never reorders — a skipped ring could not have won anyway.
        for (index, ring) in surfaces.enumerated() where ring.points.count >= 3 {
            if index < surfaceBBoxes.count, !surfaceBBoxes[index].contains(p) { continue }
            if pointInRing(p, ring.points) { return lieFromFeatureType(ring.kind) }
        }
        return .rough
    }

    /// The green polygon for par5-attack: the lie-map green ring containing the
    /// green centre, else the nearest green ring by vertex, else an empty ring
    /// (par5-attack then degrades to hazards-only, still correct).
    private func greenRing(near center: Vec2) -> FlatRing {
        let greens = surfaces.filter { $0.kind == "green" && $0.points.count >= 3 }
        if let containing = greens.first(where: { pointInRing(center, $0.points) }) {
            return containing
        }
        let nearest = greens.min { a, b in
            Self.minVertexDistance(center, a.points) < Self.minVertexDistance(center, b.points)
        }
        return nearest ?? FlatRing(points: [], kind: "green")
    }

    private static func minVertexDistance(_ p: Vec2, _ points: [Vec2]) -> Double {
        points.map { hypot($0.x - p.x, $0.y - p.y) }.min() ?? .infinity
    }

    private static func planar(_ ll: LatLon) -> Vec2 {
        let p = Sweref99TM.fromWGS84(ll)
        return Vec2(x: p.x, y: p.y)
    }

    /// Applies a live calibration's bias to a raw WGS84 fix in the EPSG:3006
    /// planar frame, returning WGS84. Distance-from-solve (for the decay) is
    /// planar from the raw fix to `solvedNear`. No calibration, or a dropped bias
    /// (stale / below the confidence floor) → the raw fix unchanged (spec §6.4:
    /// dropped, never scaled).
    private static func corrected(_ fix: LatLon, with calibration: OriginCalibration?, now: Date) -> LatLon {
        guard let calibration else { return fix }
        let distanceFromSolveM = Distance.planarMeters(fix, calibration.solvedNear)
        guard let bias = calibration.appliedBias(now: now, distanceFromSolveM: distanceFromSolveM)
        else { return fix }
        let p = Sweref99TM.fromWGS84(fix)
        return Sweref99TM.toWGS84(x: p.x + bias.e, y: p.y + bias.n)
    }

    // MARK: - Advised club + recommended aim (plan editor actions)

    /// The wind + plays-like advised club for the plan shot's reaching leg (the
    /// leg from the previous landing / plan tee to this shot), or nil without a
    /// bag / hole. Backs the panel's one-tap "use advised club" chip.
    func advisedClub(forShotId shotId: String) -> ClubRecord? {
        guard let hole = currentHole else { return nil }
        let shots = planEditShots
        guard let idx = shots.firstIndex(where: { $0.id == shotId }) else { return nil }
        let to = shots[idx]
        let from: LatLon
        let fromElevation: Double?
        if idx > 0 {
            from = shots[idx - 1].position
            fromElevation = shots[idx - 1].elevation
        } else if let holePlan = currentHolePlan ?? plan?.hole(number: hole.hole.number),
                  let tee = planTee(for: hole, plan: holePlan) {
            from = LatLon(lat: tee.lat, lon: tee.lon)
            fromElevation = tee.elevation
        } else if let tee = activeTee(for: hole) {
            from = LatLon(lat: tee.lat, lon: tee.lon)
            fromElevation = tee.elevation
        } else {
            return nil
        }
        return suggestedClubRecord(
            from: from, fromElevation: fromElevation, to: to.position, toElevation: to.elevation
        )
    }

    /// The recommended-aim landing point for a plan shot (the ghost marker its
    /// leg draws), or nil when the shot has no enriched leg (mid-drag / no bag).
    private func legPlan(forShotId shotId: String) -> PlanStrategy.LegPlan? {
        guard let shot = planEditShots.first(where: { $0.id == shotId }) else { return nil }
        let nodes = planNodesForCurrentHole()
        guard let idx = nodes.firstIndex(where: { $0.kind == .shot && $0.latLon == shot.position })
        else { return nil }
        // Leg `idx` ends at node `idx` (leg indices are 1-based over the nodes).
        return strategyGeometryForCurrentHole().legPlans.first { $0.legIndex == idx }
    }

    /// True when the selected shot has a caddy-recommended aim line to snap to.
    var selectedShotHasRecommendedAim: Bool {
        guard !competitionMode, let id = selectedPlanShotId else { return false }
        return legPlan(forShotId: id) != nil
    }

    /// Snap the selected shot onto its leg's caddy-recommended aim line (the
    /// ghost landing point) and persist — mirror of the web `applyRecommendedAim`.
    /// Routes through the same move + resample-elevation + persist path as a
    /// drag drop, bumping `planEditToken` so the overlay + advice re-enrich.
    func applyRecommendedAimForSelectedShot() {
        guard !competitionMode, let hole = currentHole, let shotId = selectedPlanShotId,
              let lp = legPlan(forShotId: shotId) else { return }
        let target = lp.landingWGS84
        let holeNumber = hole.hole.number
        plan = plan?.movingShot(holeNumber: holeNumber, shotId: shotId, to: target, elevation: nil)
        planEditToken += 1
        Task { [weak self] in
            let elevation = await self?.elevationSampler?(target) ?? nil
            guard let self else { return }
            self.plan = self.plan?.movingShot(
                holeNumber: holeNumber, shotId: shotId, to: target, elevation: elevation
            )
            self.planEditToken += 1
            await self.planWriter?.moveShot(shotId, target.lat, target.lon, elevation)
        }
    }

    // MARK: - Derived: route-leg labels (immersive on-map distances)

    /// The active-mode route's legs as on-map label data: browse = the full
    /// tee→aims→green `holeRoute`; GPS = the live origin forward through the
    /// not-yet-passed aims to the green (`gpsForwardRoute`). Lengths use the
    /// same planar-metre rounding as the card's leg capsules and TO AIM row,
    /// so the on-map figures always match the card.
    var routeLegLabels: [RouteLegLabel] {
        Self.routeLegLabels(along: isBrowseMode ? browseForwardRoute : gpsForwardRoute)
    }

    /// Pure leg decomposition: consecutive route vertices → (midpoint, whole
    /// metres). The midpoint is computed in projected SWEREF 99 TM so it is
    /// the true halfway point of the measured leg.
    nonisolated static func routeLegLabels(along route: [LatLon]) -> [RouteLegLabel] {
        guard route.count >= 2 else { return [] }
        return (1..<route.count).map { index in
            let a = route[index - 1]
            let b = route[index]
            let pa = Sweref99TM.fromWGS84(a)
            let pb = Sweref99TM.fromWGS84(b)
            return RouteLegLabel(
                start: a,
                end: b,
                midpoint: Sweref99TM.toWGS84(x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2),
                meters: Int(Distance.planarMeters(a, b).rounded())
            )
        }
    }

    // MARK: - Derived: map

    /// Distance line + F/C/B + pin markers + user dot. In browse mode the line
    /// is the full hole route and the user dot is hidden; in GPS mode it's the
    /// user→aims→green forward route (feature 3) with the live dot shown.
    var overlays: MapOverlayState { overlays(showRouteLabels: false) }

    /// `overlays` with the immersive flag applied: `showRouteLabels` adds the
    /// per-leg distance labels along the line (immersive mode — the screen
    /// owns the chrome flag; when the chrome is up the card already shows the
    /// legs, so the map stays clean).
    func overlays(showRouteLabels: Bool) -> MapOverlayState {
        let targets = targets
        var markers: [TargetMarker] = []
        if let p = targets.greenFront { markers.append(TargetMarker(kind: .front, position: p)) }
        if let p = targets.greenCenter { markers.append(TargetMarker(kind: .center, position: p)) }
        if let p = targets.greenBack { markers.append(TargetMarker(kind: .back, position: p)) }
        if let p = targets.activePin { markers.append(TargetMarker(kind: .pin, position: p)) }

        // While the reticle is active it OWNS the white line: the tapped-point
        // / tapped-shape line and the browse forward route are both suppressed
        // so only the reticle aim line + dotted extension draw (device
        // feedback: the near-parallel extra lines read as clutter).
        // Tap-a-shape inspection itself is untouched — the card, ring wash and
        // edge figures stay, only its LINE goes. A focused ladder rung takes
        // the group over entirely (dotted line + advice ellipse to the FOCUSED
        // target, no reticle line/arcs) until the next user pan releases it.
        let reticle = ladderFocusOverlay ?? reticleOverlay

        // A working target (decide choice, R4) owns the distance line while
        // set: origin straight to the committed landing.
        let line: [LatLon]
        if let wt = workingTarget, let origin {
            line = [origin, wt.position]
        } else if reticle != nil {
            line = []
        } else if let feature = inspectedFeature, let origin {
            if let lineTo = feature.lineTo {
                // Browse-to mode: draw the CHOSEN line, extended out to the
                // far edge when the shape reaches past the browse-to point.
                let farEnd = Distance.planarMeters(origin, feature.carryPoint)
                    > Distance.planarMeters(origin, lineTo) ? feature.carryPoint : lineTo
                line = [origin, farEnd]
            } else {
                // Ray mode: origin straight through the shape to its far lip.
                line = [origin, feature.carryPoint]
            }
        } else if let browseTarget, let origin {
            // Inspecting an arbitrary map point (browse origin or live fix):
            // the line IS the inspected shot, origin straight to the tap (the
            // hole route would suggest the tap measures via the aims).
            // Cleared with the inspection.
            line = [origin, browseTarget]
        } else {
            line = isBrowseMode ? browseForwardRoute : gpsForwardRoute
        }

        // Ellipse labels follow their ellipses' visibility (advice ellipse +
        // the selection-scoped plan leg ellipses) — deliberately NOT behind
        // `showRouteLabels`: they name a selected visualization, unlike the
        // immersive-only route-leg figures.
        // While the reticle group is up (panning OR ladder focus) the plan
        // overlay and the authored course route hide with the other lines —
        // the same device-feedback clutter call: the reticle aim line is the
        // shot being considered, and the near-parallel plan/route strokes plus
        // the plan's dispersion ellipses only compete with it.
        let plan = reticle == nil ? planOverlay : nil
        var ellipseLabels: [EllipseLabel] = []
        // While the reticle is active its labeled ellipse is THE club answer;
        // the legacy selected-target ellipse/label/wind-hold would put a second
        // club label on screen at once (same clutter class the device-feedback
        // round flagged for the lines), so they yield to the reticle too.
        if reticle == nil, let label = selectedTargetEllipseLabel { ellipseLabels.append(label) }
        for ellipse in plan?.ellipses ?? [] {
            let text = ellipse.clubName.map { "\($0) · \(ellipse.legMeters)" }
                ?? "\(ellipse.legMeters)"
            ellipseLabels.append(EllipseLabel(position: ellipse.center, text: text))
        }
        // Tapped-shape inspection: the front/carry figures printed AT the two
        // measured edge points (pre-rendered label images — same pipeline as
        // the ellipse labels; the offline style has no glyphs). Each label is
        // nudged a few meters OUTWARD along the measuring line (front toward
        // the origin, carry past the far edge) so the two never collide over
        // a narrow shape.
        // Reticle clubs: the advised club named on its ellipse's right edge and
        // each neighbor at its arc's END (also the right edge) — same boxed
        // image pipeline, all three on one side so they read in distance order.
        // A mid-arc label would collide with the aim line.
        if let label = reticle?.ellipseLabel { ellipseLabels.append(label) }
        for arc in reticle?.neighborArcs ?? [] {
            guard let end = arc.polyline.last else { continue }
            ellipseLabels.append(EllipseLabel(position: end, text: arc.label, boxed: true))
        }
        if let feature = inspectedFeature {
            let front = Sweref99TM.fromWGS84(feature.frontPoint)
            let far = Sweref99TM.fromWGS84(feature.carryPoint)
            let dx = far.x - front.x, dy = far.y - front.y
            let len = hypot(dx, dy)
            let nudge = 8.0
            let ux = len > 1e-9 ? dx / len : 0, uy = len > 1e-9 ? dy / len : 1
            ellipseLabels.append(EllipseLabel(
                position: Sweref99TM.toWGS84(x: front.x - ux * nudge, y: front.y - uy * nudge),
                text: "\(feature.carry.frontM)", boxed: true
            ))
            ellipseLabels.append(EllipseLabel(
                position: Sweref99TM.toWGS84(x: far.x + ux * nudge, y: far.y + uy * nudge),
                text: "\(feature.carry.carryM)", boxed: true
            ))
        }

        return MapOverlayState(
            distanceLine: line,
            targets: markers,
            // The corrected fix, deliberately: with a calibration active the
            // marker must sit where distances measure from — a raw-fix dot
            // metres off the measuring origin reads as a bug on the ortho.
            userLocation: isUsingGPS ? effectiveUserLocation.map { UserLocationMarker(position: $0) } : nil,
            routeLegLabels: showRouteLabels ? Self.routeLegLabels(along: line) : [],
            plan: plan,
            courseRoute: reticle == nil ? courseRouteOverlay : .empty,
            highlight: isBrowseMode
                ? browseTarget ?? mapFocus ?? browseOrigin
                : browseTarget ?? mapFocus,
            inspectedFeature: inspectedFeature.map {
                InspectedFeatureOverlay(
                    ring: $0.ring, frontPoint: $0.frontPoint, carryPoint: $0.carryPoint
                )
            },
            // The explicit browse origin gets its own persistent dot — the
            // highlight ring moves to whatever was tapped last, so without
            // this the "measuring from here" point vanishes on inspection.
            browseFrom: isBrowseMode ? browseOrigin : nil,
            selectedEllipse: reticle == nil ? selectedTargetEllipse : nil,
            selectedWindHold: reticle == nil ? selectedTargetWindHold : nil,
            reticle: reticle,
            ellipseLabels: ellipseLabels
        )
    }
}
