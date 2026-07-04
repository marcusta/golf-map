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

    /// True when distances derive from live GPS rather than the tee.
    var isUsingGPS: Bool { userLocation != nil }

    /// Where distances are measured from: the GPS fix, else the active tee
    /// (useful on the tee before GPS locks, or with location denied).
    var origin: LatLon? {
        userLocation ?? currentTeePosition
    }

    private var currentTeePosition: LatLon? {
        currentHole
            .flatMap { activeTee(for: $0) }
            .map { LatLon(lat: $0.lat, lon: $0.lon) }
    }

    private var originElevation: Double? {
        if userLocation != nil { return userElevation }
        return currentHole.flatMap { activeTee(for: $0)?.elevation }
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
            tee: activeTee(for: hole).map { LatLon(lat: $0.lat, lon: $0.lon) },
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
            let tee = activeTee(for: hole),
            let green = hole.green
        else { return 0 }
        return Distance.bearingDegrees(
            LatLon(lat: tee.lat, lon: tee.lon),
            LatLon(lat: green.centerLat, lon: green.centerLon)
        )
    }

    /// Bbox of everything that matters on the hole: active tee, green
    /// front/center/back, aim points, active pin. Nil when the hole has no
    /// placed furniture at all.
    var holeBounds: MapCoordinateBounds? {
        guard let hole = currentHole else { return nil }
        var points: [LatLon] = []
        if let tee = activeTee(for: hole) {
            points.append(LatLon(lat: tee.lat, lon: tee.lon))
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

    /// Distance line (origin → green center), F/C/B + pin markers, user dot.
    var overlays: MapOverlayState {
        let targets = targets
        var markers: [TargetMarker] = []
        if let p = targets.greenFront { markers.append(TargetMarker(kind: .front, position: p)) }
        if let p = targets.greenCenter { markers.append(TargetMarker(kind: .center, position: p)) }
        if let p = targets.greenBack { markers.append(TargetMarker(kind: .back, position: p)) }
        if let p = targets.activePin { markers.append(TargetMarker(kind: .pin, position: p)) }

        var line: [LatLon] = []
        if let origin, let center = targets.greenCenter {
            line = [origin, center]
        }

        return MapOverlayState(
            distanceLine: line,
            targets: markers,
            userLocation: userLocation.map { UserLocationMarker(position: $0) }
        )
    }
}
