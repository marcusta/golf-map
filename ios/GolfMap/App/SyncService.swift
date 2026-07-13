import Foundation

/// Orchestrates downloading one course's full offline bundle.
///
/// This is the **wiring layer** the Store module deliberately left out: it
/// fetches every piece of a course from `GolfAPIClient`, adapts the API models
/// into Store record/DTO types (`CourseFurniture`), and hands a
/// `BundleDownloadRequest` to `BundleDownloader` — which fetches the tile
/// pyramid + `features.geojson` and, on success, calls
/// `AppDatabase.saveCompletedBundle`.
///
/// Design:
/// - **struct, `Sendable`**: holds only the client, downloader, and server
///   origin (all `Sendable`); it owns no mutable state, so it needn't be an
///   actor. The async work it kicks off lives on the downloader actor.
/// - The mapping is a set of pure static functions (`makeFurniture`, per-record
///   adapters) so they're trivially unit-testable from fixtures without any I/O.
struct SyncService: Sendable {
    private let client: GolfAPIClient
    private let downloader: BundleDownloader
    /// Server origin, e.g. `http://localhost:3000`. `/tiles` is appended for the
    /// bundle downloader's tile base URL.
    private let serverOrigin: URL

    init(client: GolfAPIClient, downloader: BundleDownloader, serverOrigin: URL) {
        self.client = client
        self.downloader = downloader
        self.serverOrigin = serverOrigin
    }

    // MARK: - Public API

    /// Fetches all course data from the server, assembles the `CourseFurniture`,
    /// and starts the bundle download. Returns a handle whose `progress` stream
    /// can drive UI and whose `result` resolves when the bundle is on disk +
    /// saved. Throws before returning the handle if the course metadata can't be
    /// fetched (e.g. no network, auth failure, or the course has no tile
    /// manifest).
    func startBundleDownload(courseId: String) async throws -> BundleDownloadHandle {
        let furniture = try await fetchFurniture(courseId: courseId)
        let request = BundleDownloadRequest(
            tileBaseURL: serverOrigin.appendingPathComponent("tiles"),
            furniture: furniture,
            featuresGeoJSON: { [client] in
                try await client.featuresGeoJSONData(courseId: courseId)
            },
            resolvedFeaturesGeoJSON: { [client] in
                try await client.featuresGeoJSONData(courseId: courseId, resolved: true)
            }
        )
        return await downloader.startDownload(request)
    }

    /// Releases expensive downloaded map data while retaining cheap cached
    /// and user-authored course data.
    func deleteBundle(courseId: String) async throws {
        try await downloader.deleteBundle(courseId: courseId)
    }

    // MARK: - Fetch + assemble

    /// Fetches every API piece for a course and adapts it into `CourseFurniture`.
    /// Greens are fetched per hole and tolerated as nil. Pins are fetched
    /// per-course in one call and grouped by green. Throws
    /// `SyncError.noTileManifest` if the course has no `tile_manifest` asset.
    func fetchFurniture(courseId: String) async throws -> CourseFurniture {
        // Asset ownership depends on the course's site identity, so resolve the
        // course first. The remaining independent requests still run together.
        let course = try await client.course(id: courseId)
        async let holesTask = client.holes(courseId: courseId)
        async let teesTask = client.tees(courseId: courseId)
        async let pinsTask = client.pins(courseId: courseId)
        async let assetsTask = fetchAssets(for: course)

        let holes = try await holesTask
        let tees = try await teesTask
        let pinsByCourse = try await pinsTask

        // Greens + aim points are per-hole. Fetch concurrently, tolerating nil greens.
        var greens: [Green] = []
        var aimPoints: [AimPoint] = []
        try await withThrowingTaskGroup(of: (Green?, [AimPoint]).self) { group in
            for hole in holes {
                let holeId = hole.id
                group.addTask { [client] in
                    async let green = client.green(holeId: holeId)
                    async let aims = client.aimPoints(holeId: holeId)
                    return try await (green, aims)
                }
            }
            for try await (green, aims) in group {
                if let green { greens.append(green) }
                aimPoints.append(contentsOf: aims)
            }
        }

        let assets = try await assetsTask
        guard let manifest = Self.tileManifest(from: assets) else {
            throw SyncError.noTileManifest(courseId: courseId)
        }

        return Self.makeFurniture(
            course: course,
            holes: holes,
            tees: tees,
            greens: greens,
            pinsByCourse: pinsByCourse,
            aimPoints: aimPoints,
            manifest: manifest
        )
    }

    enum AssetScope: Equatable {
        case site(String)
        case course(String)
    }

    /// Pure selector kept separate so the site/legacy fallback contract is
    /// testable without making a full furniture request graph.
    static func assetScope(for course: Course) -> AssetScope {
        if let siteId = course.siteId { return .site(siteId) }
        return .course(course.id)
    }

    private func fetchAssets(for course: Course) async throws -> [CourseAsset] {
        switch Self.assetScope(for: course) {
        case let .site(siteId):
            try await client.assets(siteId: siteId)
        case let .course(courseId):
            try await client.assets(courseId: courseId)
        }
    }

    /// Extracts the tile pyramid manifest from a course's asset list.
    ///
    /// IMPORTANT: several asset kinds (`ortho_cog`, `dem_cog`, `tile_manifest`)
    /// all embed a manifest-shaped `metaJson`, so we must select the asset whose
    /// `kind == .tileManifest` — it carries the authoritative bounds + zoom
    /// ranges of the *served tile set* (e.g. ortho z14-20, terrain z12-17),
    /// which differ from the source-raster COG bounds.
    static func tileManifest(from assets: [CourseAsset]) -> TileManifest? {
        assets.first { $0.kind == .tileManifest }?.tileManifest()
    }

    // MARK: - Pure adapters (API models → Store records)

    /// Assembles `CourseFurniture` from decoded API models. Pure — no I/O, so
    /// it's directly unit-testable against the API fixtures.
    static func makeFurniture(
        course: Course,
        holes: [Hole],
        tees: [Tee],
        greens: [Green],
        pinsByCourse: [Pin],
        aimPoints: [AimPoint],
        manifest: TileManifest
    ) -> CourseFurniture {
        CourseFurniture(
            course: courseRecord(course),
            holes: holes.map(holeRecord),
            tees: tees.map(teeRecord),
            greens: greens.map(greenRecord),
            pins: pinsByCourse.map(pinRecord),
            aimPoints: aimPoints.map(aimPointRecord),
            manifest: manifestRecord(course: course, manifest: manifest)
        )
    }

    static func courseRecord(_ c: Course) -> CourseRecord {
        CourseRecord(
            id: c.id,
            siteId: c.siteId,
            name: c.name,
            status: c.status,
            revision: c.revision,
            homeLat: c.homeLat,
            homeLon: c.homeLon,
            updatedAt: c.updatedAt
            // bundleState/downloadedRevision are managed by AppDatabase on save.
        )
    }

    static func holeRecord(_ h: Hole) -> HoleRecord {
        HoleRecord(id: h.id, courseId: h.courseId, number: h.number, par: h.par, strokeIndex: h.strokeIndex)
    }

    static func teeRecord(_ t: Tee) -> TeeRecord {
        TeeRecord(
            id: t.id, holeId: t.holeId, name: t.name, color: t.color,
            lat: t.lat, lon: t.lon, elevation: t.elevation, sortOrder: t.sortOrder
        )
    }

    /// API `Green` carries a `boundaryJson` polygon that the Store green record
    /// does not persist — dropped here by design (feature polygons live in
    /// `features.geojson`).
    static func greenRecord(_ g: Green) -> GreenRecord {
        GreenRecord(
            id: g.id, holeId: g.holeId,
            centerLat: g.centerLat, centerLon: g.centerLon,
            frontLat: g.frontLat, frontLon: g.frontLon,
            backLat: g.backLat, backLon: g.backLon,
            elevation: g.elevation
        )
    }

    static func pinRecord(_ p: Pin) -> PinRecord {
        PinRecord(
            id: p.id, greenId: p.greenId, name: p.name,
            lat: p.lat, lon: p.lon, difficulty: p.difficulty, active: p.active
        )
    }

    static func aimPointRecord(_ a: AimPoint) -> AimPointRecord {
        AimPointRecord(
            id: a.id, holeId: a.holeId, sortOrder: a.sortOrder,
            lat: a.lat, lon: a.lon, elevation: a.elevation, label: a.label
        )
    }

    static func manifestRecord(course: Course, manifest m: TileManifest) -> TileManifestRecord {
        TileManifestRecord(
            courseId: course.id,
            west: m.bounds.west, south: m.bounds.south, east: m.bounds.east, north: m.bounds.north,
            orthoMinZoom: m.layers.ortho.minzoom, orthoMaxZoom: m.layers.ortho.maxzoom,
            terrainMinZoom: m.layers.terrain.minzoom, terrainMaxZoom: m.layers.terrain.maxzoom,
            elevMin: m.elevation.min, elevMax: m.elevation.max,
            generatedAt: m.generatedAt, versionParam: m.versionParam
        )
    }
}

/// Errors surfaced by `SyncService` before a download starts.
enum SyncError: Error, Equatable {
    /// The course has no `tile_manifest` asset — nothing to download offline.
    case noTileManifest(courseId: String)
}
