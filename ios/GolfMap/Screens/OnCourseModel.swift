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
    /// Holes sorted by number.
    private(set) var holes: [HoleData]

    private(set) var currentHoleIndex = 0
    /// Bumped whenever the camera should re-apply (hole change, recenter).
    private(set) var cameraToken = 0

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
    /// Set from `LocationProvider.isDenied` so the UI can explain the fallback.
    var isLocationDenied = false

    /// Selected tee name (persisted); nil = per-hole default (lowest sortOrder).
    private(set) var activeTeeName: String?

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

    /// Terrain elevation sampler (bundle terrain tiles); injected by the
    /// screen, stubbed in tests. Used for the user position and as a fallback
    /// for greens without a stored elevation.
    @ObservationIgnored var elevationSampler: (@Sendable (LatLon) async -> Double?)?

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var userElevationTask: Task<Void, Never>?
    /// Terrain fallback elevation for the current hole's green (only sampled
    /// when the green record has no stored elevation).
    private var greenTerrainElevation: Double?

    init(furniture: CourseFurniture, defaults: UserDefaults = .standard) {
        self.courseId = furniture.course.id
        self.courseName = furniture.course.name
        self.defaults = defaults

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
        loadTeeOverrides()
        loadAdjustOverrides()
        refreshGreenElevationFallback()
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
        guard index != currentHoleIndex else { return }
        currentHoleIndex = index
        holeDidChange()
    }

    /// Re-issues the current hole's camera fit (recenter button).
    func recenter() {
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
        toolFocusBounds = nil
        draggingHandleID = nil
        cameraToken += 1
        refreshGreenElevationFallback()
    }

    // MARK: - Map tools (transient modes over the normal hole view)

    /// A transient map tool over the normal hole view. Exactly one tool can be
    /// active at a time (entering one exits the other — `toolMode` is a single
    /// value); a tool may take over the camera via `focusBounds` (e.g. Green
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
    }

    private(set) var toolMode: MapToolMode = .none
    /// Camera target while a tool is active; nil keeps the hole framing.
    private var toolFocusBounds: MapCoordinateBounds?
    /// Whether entering the current tool re-framed the camera. When false
    /// (Adjust mode), the user's current zoom/pan is preserved on entry AND on
    /// exit — so tapping the tool button never yanks the view.
    private var toolDidRefitCamera = false

    /// Enter a tool, optionally re-aiming the camera at `focusBounds`
    /// (tight-fit, hole bearing kept so the view doesn't spin). Pass
    /// `refitCamera: false` (Adjust mode) to leave the camera exactly where the
    /// user has it — no token bump, so `cameraCommand` is unchanged and never
    /// re-applied.
    func enterTool(
        _ mode: MapToolMode,
        focusBounds: MapCoordinateBounds? = nil,
        refitCamera: Bool = true
    ) {
        guard mode != .none else {
            exitTool()
            return
        }
        toolMode = mode
        toolFocusBounds = focusBounds
        draggingHandleID = nil
        toolDidRefitCamera = refitCamera
        if refitCamera { cameraToken += 1 }
    }

    /// Leave the active tool. Restores the normal hole framing only if entering
    /// the tool had re-framed the camera; a no-refit tool (Adjust) leaves the
    /// view untouched. An in-flight Adjust drag is abandoned uncommitted.
    func exitTool() {
        guard toolMode != .none else { return }
        toolMode = .none
        toolFocusBounds = nil
        draggingHandleID = nil
        if toolDidRefitCamera { cameraToken += 1 }
        toolDidRefitCamera = false
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
    }

    func toggleGPS() { setGPSEnabled(!gpsEnabled) }

    /// In browse mode (`gpsEnabled == false`) the live fix is ignored entirely.
    var isBrowseMode: Bool { !gpsEnabled }

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
        userLocation = location
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

    // MARK: - Derived: origin

    /// The live fix, gated by the GPS switch: nil in browse mode.
    private var effectiveUserLocation: LatLon? {
        gpsEnabled ? userLocation : nil
    }

    /// True when distances derive from live GPS rather than the tee. False in
    /// browse mode even with a live fix.
    var isUsingGPS: Bool { effectiveUserLocation != nil }

    /// Where distances are measured from: the (gated) GPS fix, else the active
    /// tee (useful on the tee before GPS locks, with location denied, or in
    /// browse mode).
    var origin: LatLon? {
        effectiveUserLocation ?? currentTeePosition
    }

    private var currentTeePosition: LatLon? {
        currentHole.flatMap { teePosition(for: $0) }
    }

    private var originElevation: Double? {
        if effectiveUserLocation != nil { return userElevation }
        return currentHole.flatMap { teeElevation(for: $0) }
    }

    // MARK: - Derived: targets + distances

    var targets: HoleTargets {
        guard let hole = currentHole else { return HoleTargets() }
        let green = hole.green
        let activePin = hole.pins.first(where: \.active)

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
            activePin: activePin.map { LatLon(lat: $0.lat, lon: $0.lon) },
            activePinName: activePin?.name,
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
            targets: targets
        )
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
    /// changes or `recenter()` bumps the token. While a tool with focus
    /// bounds is active (Green view), fits those bounds tightly instead;
    /// exiting the tool bumps the token and restores the hole framing.
    var cameraCommand: MapCameraCommand? {
        if let toolFocusBounds {
            return .fitHole(
                toolFocusBounds,
                bearing: holeBearing,
                padding: 40,
                animated: true,
                token: cameraToken
            )
        }
        return holeBounds.map {
            .fitHole($0, bearing: holeBearing, padding: 70, animated: true, token: cameraToken)
        }
    }

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
    /// the aim is still closer to the green than the user is (not yet passed),
    /// chosen in tee→green order, and only when the user is farther from the
    /// green than `aimRoutingThresholdMeters`. Feature 3.
    var nextAimAhead: AimTarget? {
        guard
            let user = effectiveUserLocation,
            let green = targets.greenCenter
        else { return nil }
        let userToGreen = Distance.planarMeters(user, green)
        guard userToGreen > aimRoutingThresholdMeters else { return nil }
        return targets.aimPoints.first { aim in
            Distance.planarMeters(aim.position, green) < userToGreen
        }
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
        let originToGreen = Distance.planarMeters(origin, center)
        let forwardAims = targets.aimPoints
            .map(\.position)
            .filter { Distance.planarMeters($0, center) < originToGreen }
        return [origin] + forwardAims + [center]
    }

    // MARK: - Derived: route-leg labels (immersive on-map distances)

    /// The active-mode route's legs as on-map label data: browse = the full
    /// tee→aims→green `holeRoute`; GPS = the live origin forward through the
    /// not-yet-passed aims to the green (`gpsForwardRoute`). Lengths use the
    /// same planar-metre rounding as the card's leg capsules and TO AIM row,
    /// so the on-map figures always match the card.
    var routeLegLabels: [RouteLegLabel] {
        Self.routeLegLabels(along: isBrowseMode ? holeRoute : gpsForwardRoute)
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

        let line: [LatLon] = isBrowseMode ? holeRoute : gpsForwardRoute

        return MapOverlayState(
            distanceLine: line,
            targets: markers,
            userLocation: isUsingGPS ? userLocation.map { UserLocationMarker(position: $0) } : nil,
            routeLegLabels: showRouteLabels ? Self.routeLegLabels(along: line) : []
        )
    }
}
