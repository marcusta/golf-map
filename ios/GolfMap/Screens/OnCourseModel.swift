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
    /// Keyed by `hole.id` → tee name → moved position. Browse-mode only.
    private var teeOverrides: [String: [String: LatLon]] = [:]

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

    private func holeDidChange() {
        cameraToken += 1
        refreshGreenElevationFallback()
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

    // MARK: - GPS toggle + browse mode

    static let defaultAimRoutingThresholdMeters = 230.0

    private static func gpsEnabledKey(courseId: String) -> String {
        "onCourse.gpsEnabled.\(courseId)"
    }
    private static let aimRoutingThresholdKey = "onCourse.aimRoutingThresholdMeters"

    /// Flip the GPS/browse switch (persisted per course). Bumps the camera so
    /// the hole re-fits when the origin semantics change.
    func setGPSEnabled(_ enabled: Bool) {
        guard enabled != gpsEnabled else { return }
        gpsEnabled = enabled
        defaults.set(enabled, forKey: Self.gpsEnabledKey(courseId: courseId))
        cameraToken += 1
    }

    func toggleGPS() { setGPSEnabled(!gpsEnabled) }

    /// In browse mode (`gpsEnabled == false`) the live fix is ignored entirely.
    var isBrowseMode: Bool { !gpsEnabled }

    /// Overridable for tests; the persisted default is 230 m.
    func setAimRoutingThresholdMeters(_ meters: Double) {
        aimRoutingThresholdMeters = meters
        defaults.set(meters, forKey: Self.aimRoutingThresholdKey)
    }

    // MARK: - Tee override (browse-mode local tee move)

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

    /// Move the current hole's active tee to `position` (browse-mode gesture).
    /// Persisted per (course, hole, tee); recomputes route/bounds/distances.
    func moveActiveTee(to position: LatLon) {
        guard let hole = currentHole, let tee = activeTee(for: hole) else { return }
        teeOverrides[hole.id, default: [:]][tee.name] = position
        defaults.set(
            Self.encodeLatLon(position),
            forKey: Self.teeOverrideKey(courseId: courseId, holeId: hole.id, teeName: tee.name)
        )
        cameraToken += 1
    }

    /// Remove the current hole's active-tee override (reset affordance).
    func resetActiveTee() {
        guard let hole = currentHole, let tee = activeTee(for: hole) else { return }
        guard teeOverrides[hole.id]?[tee.name] != nil else { return }
        teeOverrides[hole.id]?[tee.name] = nil
        defaults.removeObject(
            forKey: Self.teeOverrideKey(courseId: courseId, holeId: hole.id, teeName: tee.name)
        )
        cameraToken += 1
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

    /// Samples the green's terrain elevation when the record has none stored.
    private func refreshGreenElevationFallback() {
        greenTerrainElevation = nil
        guard
            let green = currentHole?.green,
            green.elevation == nil,
            let sampler = elevationSampler
        else { return }
        let center = LatLon(lat: green.centerLat, lon: green.centerLon)
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

        return HoleTargets(
            greenFront: point(green?.frontLat, green?.frontLon),
            greenCenter: green.map { LatLon(lat: $0.centerLat, lon: $0.centerLon) },
            greenBack: point(green?.backLat, green?.backLon),
            greenElevation: green?.elevation ?? greenTerrainElevation,
            activePin: activePin.map { LatLon(lat: $0.lat, lon: $0.lon) },
            activePinName: activePin?.name,
            aimPoints: hole.aimPoints.enumerated().map { index, aim in
                let label = aim.label.flatMap { $0.isEmpty ? nil : $0 } ?? "Aim \(index + 1)"
                return AimTarget(
                    label: label,
                    position: LatLon(lat: aim.lat, lon: aim.lon),
                    elevation: aim.elevation
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

    /// Active-tee playing length of the current hole (tee → aims → green).
    var playingLength: HoleLength.PlayingLength? {
        guard let hole = currentHole else { return nil }
        return HoleLength.playingLength(
            tee: teePosition(for: hole),
            aims: hole.aimPoints.map { LatLon(lat: $0.lat, lon: $0.lon) },
            greenCenter: hole.green.map { LatLon(lat: $0.centerLat, lon: $0.centerLon) }
        )
    }

    // MARK: - Derived: map

    /// Tee → green-center bearing, i.e. the direction that points "up" when
    /// the camera fits the hole. 0 (north-up) when either end is missing.
    var holeBearing: Double {
        guard
            let hole = currentHole,
            let tee = teePosition(for: hole),
            let green = hole.green
        else { return 0 }
        return Distance.bearingDegrees(
            tee,
            LatLon(lat: green.centerLat, lon: green.centerLon)
        )
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
    /// changes or `recenter()` bumps the token.
    var cameraCommand: MapCameraCommand? {
        holeBounds.map {
            .fitHole($0, bearing: holeBearing, padding: 70, animated: true, token: cameraToken)
        }
    }

    // MARK: - Derived: routing

    /// The full tee→green route for the current hole (honoring any tee
    /// override): active tee → aim points (tee→green order) → green center.
    /// Par-3 / no-aim holes collapse to tee → green (or fewer if furniture is
    /// missing). Used as the browse-mode distance line.
    var holeRoute: [LatLon] {
        guard let hole = currentHole else { return [] }
        var route: [LatLon] = []
        if let tee = teePosition(for: hole) { route.append(tee) }
        route.append(contentsOf: hole.aimPoints.map { LatLon(lat: $0.lat, lon: $0.lon) })
        if let green = hole.green {
            route.append(LatLon(lat: green.centerLat, lon: green.centerLon))
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

    /// The primary distance line in GPS mode: user → next aim ahead (when one
    /// exists past the threshold), else user → green center.
    private var gpsPrimaryLine: [LatLon] {
        guard let origin, let center = targets.greenCenter else {
            if let origin { return [origin] }
            return []
        }
        if let aim = nextAimAhead {
            return [origin, aim.position]
        }
        return [origin, center]
    }

    // MARK: - Derived: map

    /// Distance line + F/C/B + pin markers + user dot. In browse mode the line
    /// is the full hole route and the user dot is hidden; in GPS mode it's the
    /// user→aim/green primary line (feature 3) with the live dot shown.
    var overlays: MapOverlayState {
        let targets = targets
        var markers: [TargetMarker] = []
        if let p = targets.greenFront { markers.append(TargetMarker(kind: .front, position: p)) }
        if let p = targets.greenCenter { markers.append(TargetMarker(kind: .center, position: p)) }
        if let p = targets.greenBack { markers.append(TargetMarker(kind: .back, position: p)) }
        if let p = targets.activePin { markers.append(TargetMarker(kind: .pin, position: p)) }

        let line: [LatLon] = isBrowseMode ? holeRoute : gpsPrimaryLine

        return MapOverlayState(
            distanceLine: line,
            targets: markers,
            userLocation: isUsingGPS ? userLocation.map { UserLocationMarker(position: $0) } : nil
        )
    }
}
