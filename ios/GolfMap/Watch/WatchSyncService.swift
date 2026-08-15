import Foundation
import WatchConnectivity

/// Pushes course bundles to the watch app over WatchConnectivity.
///
/// The watch is a full offline client during a round — the phone's only job
/// is delivering the static `WatchCourseBundle` payload ahead of time. File
/// transfers are queued by the system and survive the watch being out of
/// reach, so "send on course open" is enough: by the first tee the bundle is
/// there.
@MainActor
final class WatchSyncService: NSObject {

    private var session: WCSession? {
        WCSession.isSupported() ? WCSession.default : nil
    }

    /// Payload built before the session finished activating (activation is
    /// async at launch); flushed from the activation callback.
    private var pendingBundle: WatchCourseBundle?

    override init() {
        super.init()
        guard let session else { return }
        session.delegate = self
        session.activate()
    }

    /// Builds and queues the course payload for the watch. No-ops without a
    /// paired watch with the app installed, and skips transfers whose payload
    /// is content-identical to the last one sent for this course. Building is
    /// async when a sampler is provided — the elevation grids + green images
    /// sample the terrain pyramid off the main actor.
    func sendCourse(
        furniture: CourseFurniture,
        featuresGeoJSON: Data?,
        elevationSampler: GridElevationSampler? = nil
    ) {
        Task { [weak self] in
            let bundle = await Self.buildBundle(
                furniture: furniture,
                featuresGeoJSON: featuresGeoJSON,
                elevationSampler: elevationSampler
            )
            self?.send(bundle)
        }
    }

    private func send(_ bundle: WatchCourseBundle) {
        guard let session else { return }
        guard session.activationState == .activated else {
            pendingBundle = bundle
            return
        }
        guard session.isPaired, session.isWatchAppInstalled else { return }

        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            // Stable key order so the dedupe hash is deterministic.
            encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(bundle)

            let dedupeKey = "watchSync.lastSent.\(bundle.courseId)"
            // Hash with builtAt zeroed — it is fresh on every build, and
            // hashing it would defeat the dedupe entirely (every course open
            // would re-queue a transfer).
            var probe = bundle
            probe.builtAt = Date(timeIntervalSince1970: 0)
            let hash = Self.fnv1a(try encoder.encode(probe))
            if UserDefaults.standard.string(forKey: dedupeKey) == hash { return }

            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(bundle.fileName)
            try data.write(to: url, options: .atomic)
            session.transferFile(url, metadata: ["courseId": bundle.courseId])
            UserDefaults.standard.set(hash, forKey: dedupeKey)
        } catch {
            print("Watch sync failed for \(bundle.courseId): \(error)")
        }
    }

    // MARK: - Payload construction

    /// Joins the flat furniture arrays into the watch payload. The green
    /// polygon comes from `features.geojson` when provided (same resolution
    /// rules as `GreenPolygonStore`); holes without a green are skipped — the
    /// watch has nothing to measure to. With an elevation sampler, each hole
    /// additionally gets its elevation grids (green + corridor tiers) and the
    /// pre-rendered slope image of the green.
    nonisolated static func buildBundle(
        furniture: CourseFurniture,
        featuresGeoJSON: Data?,
        elevationSampler: GridElevationSampler? = nil
    ) async -> WatchCourseBundle {
        let polygons = featuresGeoJSON.flatMap { try? GreenPolygonStore(featuresGeoJSON: $0) }

        let teesByHole = Dictionary(grouping: furniture.tees, by: \.holeId)
        let greensByHole = Dictionary(
            furniture.greens.map { ($0.holeId, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        let aimsByHole = Dictionary(grouping: furniture.aimPoints, by: \.holeId)

        var holes: [WatchHole] = []
        for hole in furniture.holes.sorted(by: { $0.number < $1.number }) {
            guard let green = greensByHole[hole.id] else { continue }
            // Hole-detection anchor: the default tee (lowest sortOrder).
            guard let tee = teesByHole[hole.id]?.min(by: { $0.sortOrder < $1.sortOrder })
            else { continue }

            let center = LatLon(lat: green.centerLat, lon: green.centerLon)
            let polygon = polygons?.green(forHoleId: hole.id, greenCenter: center)
            var front: [Double]?
            if let lat = green.frontLat, let lon = green.frontLon { front = [lat, lon] }
            var back: [Double]?
            if let lat = green.backLat, let lon = green.backLon { back = [lat, lon] }

            var greenGrid: WatchElevationGrid?
            var corridorGrid: WatchElevationGrid?
            var greenImage: WatchGreenImage?
            if let sampler = elevationSampler {
                if let rings = polygon?.rings, !rings.isEmpty {
                    greenGrid = await WatchElevationPatchBuilder.greenGrid(
                        rings: rings, sampler: sampler
                    )
                    greenImage = await WatchGreenImageRenderer.render(
                        rings: rings, sampler: sampler
                    )
                }
                // Playing line: tee → aim points (authored order) → green.
                var path = [Sweref99TM.fromWGS84(LatLon(lat: tee.lat, lon: tee.lon))]
                for aim in (aimsByHole[hole.id] ?? []).sorted(by: { $0.sortOrder < $1.sortOrder }) {
                    path.append(Sweref99TM.fromWGS84(LatLon(lat: aim.lat, lon: aim.lon)))
                }
                path.append(Sweref99TM.fromWGS84(center))
                corridorGrid = await WatchElevationPatchBuilder.corridorGrid(
                    path: path, sampler: sampler
                )
            }

            holes.append(WatchHole(
                number: hole.number,
                par: hole.par,
                tee: [tee.lat, tee.lon],
                greenCenter: [green.centerLat, green.centerLon],
                greenFront: front,
                greenBack: back,
                greenPolygon: polygon?.wgs84Rings.first?.map { [$0.lat, $0.lon] },
                greenGrid: greenGrid,
                corridorGrid: corridorGrid,
                greenImage: greenImage
            ))
        }

        return WatchCourseBundle(
            courseId: furniture.course.id,
            name: furniture.course.name,
            holes: holes,
            builtAt: Date()
        )
    }

    /// FNV-1a over the payload bytes — cheap content fingerprint for dedupe.
    private static func fnv1a(_ data: Data) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in data {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return String(hash, radix: 16)
    }
}

extension WatchSyncService: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: (any Error)?
    ) {
        guard activationState == .activated else { return }
        Task { @MainActor in
            if let pending = self.pendingBundle {
                self.pendingBundle = nil
                self.send(pending)
            }
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        // Watch switched — reactivate for the new pairing.
        session.activate()
    }
}
