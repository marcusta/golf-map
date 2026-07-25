import Foundation

/// Async client for the golf-map server API.
///
/// Design:
/// - **`actor`** (not `@MainActor final class`): the client owns mutable state
///   — the credentials-provider hook and the in-flight re-login guard — and does
///   only async network I/O, never touches UIKit. An actor gives us safe
///   serialized access to that state off the main thread under Swift 6 strict
///   concurrency, without forcing callers onto the main actor.
/// - **Cookie session**: uses `URLSession`'s default `HTTPCookieStorage`, which
///   carries the `session` cookie set by `/api/auth/login` automatically. No
///   manual header handling.
/// - **Auto re-login on 401**: if a `credentialsProvider` is set, a 401 triggers
///   one silent re-login and one retry of the original request. A per-request
///   flag prevents infinite loops.
public actor GolfAPIClient {
    /// Supplies `(username, password)` for silent re-login, or nil to abort.
    /// Keychain storage is out of scope for this client — this is just the hook.
    public typealias CredentialsProvider = @Sendable () async -> (username: String, password: String)?

    /// API base, e.g. `http://localhost:3000/api`.
    private let apiBaseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private var credentialsProvider: CredentialsProvider?

    /// - Parameters:
    ///   - baseURL: server origin, e.g. `http://localhost:3000`. The `/api`
    ///     prefix is appended internally.
    ///   - session: defaults to `.shared` so the process-wide cookie storage is
    ///     used. Tests inject a `URLSession` with a mock `URLProtocol`.
    ///   - credentialsProvider: optional hook for silent re-login on 401.
    public init(
        baseURL: URL,
        session: URLSession = .shared,
        credentialsProvider: CredentialsProvider? = nil
    ) {
        self.apiBaseURL = baseURL.appendingPathComponent("api")
        self.session = session
        self.decoder = JSONDecoder()
        self.credentialsProvider = credentialsProvider
    }

    /// Sets (or clears) the re-login hook after construction.
    public func setCredentialsProvider(_ provider: CredentialsProvider?) {
        self.credentialsProvider = provider
    }

    // MARK: - Auth

    @discardableResult
    public func login(username: String, password: String) async throws -> AuthUser {
        let body = try JSONSerialization.data(withJSONObject: ["username": username, "password": password])
        return try await request(
            path: "auth/login",
            method: "POST",
            body: body,
            allowRelogin: false
        )
    }

    @discardableResult
    public func logout() async throws -> OKResponse {
        try await request(path: "auth/logout", method: "POST", allowRelogin: false)
    }

    public func me() async throws -> AuthUser {
        try await request(path: "auth/me")
    }

    // MARK: - Meta (unauthenticated)

    public func meta() async throws -> Meta {
        try await request(path: "meta", allowRelogin: false)
    }

    // MARK: - Courses

    public func courses(offset: Int = 0, limit: Int = 100) async throws -> CoursePage {
        try await request(path: "courses", query: ["offset": String(offset), "limit": String(limit)])
    }

    /// Course list filtered to published courses only (the iOS app never shows drafts).
    public func publishedCourses(offset: Int = 0, limit: Int = 100) async throws -> [CourseSummary] {
        let page = try await courses(offset: offset, limit: limit)
        return page.items.filter { $0.status == "published" }
    }

    public func course(id: String) async throws -> Course {
        try await request(path: "courses/get", query: ["id": id])
    }

    // MARK: - Holes

    public func holes(courseId: String) async throws -> [Hole] {
        try await request(path: "holes", query: ["courseId": courseId])
    }

    // MARK: - Tees

    public func tees(courseId: String) async throws -> [Tee] {
        try await request(path: "tees/by-course", query: ["courseId": courseId])
    }

    // MARK: - Greens

    /// Green for a hole, or nil when the hole has none (server returns JSON `null`).
    public func green(holeId: String) async throws -> Green? {
        try await requestOptional(path: "greens", query: ["holeId": holeId])
    }

    // MARK: - Pins

    public func pins(greenId: String) async throws -> [Pin] {
        try await request(path: "pins", query: ["greenId": greenId])
    }

    public func pins(courseId: String) async throws -> [Pin] {
        try await request(path: "pins/by-course", query: ["courseId": courseId])
    }

    // MARK: - Aim points

    public func aimPoints(holeId: String) async throws -> [AimPoint] {
        try await request(path: "aim-points", query: ["holeId": holeId])
    }

    // MARK: - Game plans (read-only viewer)

    /// The player's game plan for a course, or nil when none exists (the
    /// server returns JSON `null`).
    public func gamePlan(courseId: String) async throws -> GamePlan? {
        try await requestOptional(path: "game-plans/by-course", query: ["courseId": courseId])
    }

    // MARK: - Game plans (write — offline planner sync)

    /// Lazily creates (or, with a `version`, updates) the plan for a course
    /// (`POST /api/game-plans/upsert`). The planner sync calls this WITHOUT a
    /// version on first edit — the server creates the plan when none exists; a
    /// present-but-mismatched version returns 409 (re-sync the tree).
    ///
    /// `wind` is a PATCH: nil leaves the server's wind untouched, a patch whose
    /// values are nil clears it to calm (see `PlanWindPatch`).
    public func upsertGamePlan(
        courseId: String,
        version: Int? = nil,
        wind: PlanWindPatch? = nil
    ) async throws -> GamePlan {
        try await postJSON(path: "game-plans/upsert", body: UpsertGamePlanRequest(
            courseId: courseId,
            version: version,
            wind: wind
        ))
    }

    /// Creates (or, with a `version`, updates) a plan hole row
    /// (`POST /api/game-plans/set-hole`). The planner sync calls this WITHOUT a
    /// version to lazily create the hole so its shots can attach, and WITH one
    /// to push an edited per-hole wind override.
    ///
    /// `wind` is a PATCH, as for `upsertGamePlan`: a patch of nils clears the
    /// hole override so the hole inherits the plan-level wind again.
    public func setPlanHole(
        planId: String,
        holeNumber: Int,
        version: Int? = nil,
        wind: PlanWindPatch? = nil
    ) async throws -> GamePlanHole {
        try await postJSON(path: "game-plans/set-hole", body: SetPlanHoleRequest(
            planId: planId, holeNumber: holeNumber, version: version, wind: wind
        ))
    }

    /// Adds a plan shot (`POST /api/game-plans/shots/add`). The server assigns
    /// `sortOrder` by insert order — the sync engine pushes adds in sortOrder.
    public func addPlanShot(
        gamePlanHoleId: String,
        lat: Double,
        lon: Double,
        elevation: Double? = nil,
        clubId: String? = nil,
        label: String? = nil
    ) async throws -> PlanShot {
        try await postJSON(path: "game-plans/shots/add", body: AddPlanShotRequest(
            gamePlanHoleId: gamePlanHoleId,
            lat: lat, lon: lon, elevation: elevation, clubId: clubId, label: label
        ))
    }

    /// Updates a plan shot (`POST /api/game-plans/shots/update`,
    /// optimistic-locked). Nil fields are omitted (unchanged on the server).
    public func updatePlanShot(
        id: String,
        version: Int,
        lat: Double? = nil,
        lon: Double? = nil,
        elevation: Double? = nil,
        clubId: String? = nil,
        label: String? = nil
    ) async throws -> PlanShot {
        try await postJSON(path: "game-plans/shots/update", body: UpdatePlanShotRequest(
            id: id, version: version,
            lat: lat, lon: lon, elevation: elevation, clubId: clubId, label: label
        ))
    }

    /// Removes a plan shot (`POST /api/game-plans/shots/remove`,
    /// optimistic-locked).
    @discardableResult
    public func removePlanShot(id: String, version: Int) async throws -> OKResponse {
        try await postJSON(path: "game-plans/shots/remove", body: RemovePlanShotRequest(id: id, version: version))
    }

    // Both wind-carrying requests encode the wind keys BY HAND. The server
    // patches only the keys present in the body (an absent key means "leave
    // alone"), and Swift's synthesized `Encodable` omits nil optionals — so a
    // synthesized encoder could never clear a wind back to calm/inherit. With
    // a `wind` patch attached the keys are always written, as a number or an
    // explicit JSON null; with no patch they stay absent.

    private struct UpsertGamePlanRequest: Encodable {
        let courseId: String
        let version: Int?
        let wind: PlanWindPatch?

        enum CodingKeys: String, CodingKey {
            case courseId, version, windSpeedMps, windDirectionDeg
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(courseId, forKey: .courseId)
            try container.encodeIfPresent(version, forKey: .version)
            try wind?.encode(into: &container, speed: .windSpeedMps, direction: .windDirectionDeg)
        }
    }

    private struct SetPlanHoleRequest: Encodable {
        let planId: String
        let holeNumber: Int
        let version: Int?
        let wind: PlanWindPatch?

        enum CodingKeys: String, CodingKey {
            case planId, holeNumber, version, windSpeedMps, windDirectionDeg
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(planId, forKey: .planId)
            try container.encode(holeNumber, forKey: .holeNumber)
            try container.encodeIfPresent(version, forKey: .version)
            try wind?.encode(into: &container, speed: .windSpeedMps, direction: .windDirectionDeg)
        }
    }

    private struct AddPlanShotRequest: Encodable {
        let gamePlanHoleId: String
        let lat: Double
        let lon: Double
        let elevation: Double?
        let clubId: String?
        let label: String?
    }

    private struct UpdatePlanShotRequest: Encodable {
        let id: String
        let version: Int
        let lat: Double?
        let lon: Double?
        let elevation: Double?
        let clubId: String?
        let label: String?
    }

    private struct RemovePlanShotRequest: Encodable {
        let id: String
        let version: Int
    }

    // MARK: - Clubs

    /// The player's club bag (id → name lookup for plan shots).
    public func clubs() async throws -> [Club] {
        try await request(path: "clubs")
    }

    // MARK: - Clubs (write — offline club-settings sync)

    /// Creates a club (`POST /api/clubs/create`). `userId` is inferred
    /// server-side from the session — the sync engine never sends it.
    public func createClub(name: String, carryM: Double, dispersionM: Double) async throws -> Club {
        try await postJSON(path: "clubs/create", body: CreateClubRequest(
            name: name, carryM: carryM, dispersionM: dispersionM
        ))
    }

    /// Updates a club (`POST /api/clubs/update`, optimistic-locked). Nil
    /// fields are omitted (unchanged on the server).
    public func updateClub(
        id: String,
        version: Int,
        name: String? = nil,
        carryM: Double? = nil,
        dispersionM: Double? = nil
    ) async throws -> Club {
        try await postJSON(path: "clubs/update", body: UpdateClubRequest(
            id: id, version: version, name: name, carryM: carryM, dispersionM: dispersionM
        ))
    }

    /// Removes a club (`POST /api/clubs/remove`, optimistic-locked).
    @discardableResult
    public func removeClub(id: String, version: Int) async throws -> OKResponse {
        try await postJSON(path: "clubs/remove", body: RemoveClubRequest(id: id, version: version))
    }

    /// Reassigns the whole bag's order (`POST /api/clubs/reorder`) — the
    /// server reassigns `sortOrder` to match `orderedIds`'s index in a
    /// transaction. Not optimistic-locked (no single row/version to check).
    @discardableResult
    public func reorderClubs(orderedIds: [String]) async throws -> OKResponse {
        try await postJSON(path: "clubs/reorder", body: ReorderClubsRequest(orderedIds: orderedIds))
    }

    private struct CreateClubRequest: Encodable {
        let name: String
        let carryM: Double
        let dispersionM: Double
    }

    private struct UpdateClubRequest: Encodable {
        let id: String
        let version: Int
        let name: String?
        let carryM: Double?
        let dispersionM: Double?
    }

    private struct RemoveClubRequest: Encodable {
        let id: String
        let version: Int
    }

    private struct ReorderClubsRequest: Encodable {
        let orderedIds: [String]
    }

    // MARK: - Assets

    public func assets(courseId: String) async throws -> [CourseAsset] {
        try await request(path: "assets/by-course", query: ["courseId": courseId])
    }

    /// Assets owned by a shared site. Course bundles use this route whenever
    /// the course has a `siteId`, because tile manifests belong to the shared
    /// map rather than either individual course.
    public func assets(siteId: String) async throws -> [CourseAsset] {
        try await request(path: "assets/by-site", query: ["siteId": siteId])
    }

    // MARK: - Course features

    /// Raw GeoJSON FeatureCollection bytes — hand straight to MapLibre.
    /// `resolved` asks the server for the render-only surface-stack variant
    /// (overlaps clipped so translucent fills don't compound); keep the raw
    /// variant for analysis consumers (greens, hazards).
    public func featuresGeoJSONData(courseId: String, resolved: Bool = false) async throws -> Data {
        var query = ["courseId": courseId]
        if resolved { query["resolved"] = "true" }
        return try await requestData(path: "features.geojson", query: query).0
    }

    /// Decoded course features (type + polygon rings) for distance math.
    public func features(courseId: String) async throws -> [CourseFeature] {
        let data = try await featuresGeoJSONData(courseId: courseId)
        do {
            return try decoder.decode(CourseFeatureCollection.self, from: data).features
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    // MARK: - Rounds + shots (offline capture sync)

    /// Starts a round on the server (`POST /api/rounds/start`). Called by the
    /// sync engine when a locally captured round is first pushed — `startedAt`
    /// is the LOCAL capture time, not the sync time.
    public func startRound(
        courseId: String,
        startedAt: String,
        gamePlanId: String? = nil,
        windSpeedMps: Double? = nil,
        windDirectionDeg: Double? = nil,
        stimpFt: Double? = nil
    ) async throws -> Round {
        try await postJSON(path: "rounds/start", body: StartRoundRequest(
            courseId: courseId,
            startedAt: startedAt,
            gamePlanId: gamePlanId,
            windSpeedMps: windSpeedMps,
            windDirectionDeg: windDirectionDeg,
            stimpFt: stimpFt
        ))
    }

    /// Ends a round (`POST /api/rounds/end`, optimistic-locked). `stimpFt`
    /// carries the round's final green-speed reading — the end push is the
    /// one guaranteed sync point after mid-round stimp edits.
    public func endRound(
        id: String,
        version: Int,
        endedAt: String,
        notes: String? = nil,
        stimpFt: Double? = nil
    ) async throws -> Round {
        try await postJSON(path: "rounds/end", body: EndRoundRequest(
            id: id, version: version, endedAt: endedAt, notes: notes, stimpFt: stimpFt
        ))
    }

    /// Adds a shot (`POST /api/rounds/shots/add`). The server assigns
    /// `sortOrder` by insert order — the sync engine pushes in capture order.
    public func addShot(
        roundId: String,
        holeNumber: Int,
        lat: Double,
        lon: Double,
        clubId: String? = nil,
        shotType: String? = nil,
        targetLat: Double? = nil,
        targetLon: Double? = nil,
        penaltyStrokes: Int? = nil,
        recordedAt: String? = nil
    ) async throws -> Shot {
        try await postJSON(path: "rounds/shots/add", body: AddShotRequest(
            roundId: roundId,
            holeNumber: holeNumber,
            lat: lat,
            lon: lon,
            clubId: clubId,
            shotType: shotType,
            targetLat: targetLat,
            targetLon: targetLon,
            penaltyStrokes: penaltyStrokes,
            recordedAt: recordedAt
        ))
    }

    /// Updates a shot (`POST /api/rounds/shots/update`, optimistic-locked).
    /// Nil fields are omitted from the body (unchanged on the server).
    public func updateShot(
        id: String,
        version: Int,
        lat: Double? = nil,
        lon: Double? = nil,
        holeNumber: Int? = nil,
        clubId: String? = nil,
        shotType: String? = nil,
        targetLat: Double? = nil,
        targetLon: Double? = nil,
        penaltyStrokes: Int? = nil
    ) async throws -> Shot {
        try await postJSON(path: "rounds/shots/update", body: UpdateShotRequest(
            id: id,
            version: version,
            lat: lat,
            lon: lon,
            holeNumber: holeNumber,
            clubId: clubId,
            shotType: shotType,
            targetLat: targetLat,
            targetLon: targetLon,
            penaltyStrokes: penaltyStrokes
        ))
    }

    /// Removes a shot (`POST /api/rounds/shots/remove`, optimistic-locked).
    @discardableResult
    public func removeShot(id: String, version: Int) async throws -> OKResponse {
        try await postJSON(path: "rounds/shots/remove", body: RemoveShotRequest(id: id, version: version))
    }

    /// Encodes `body` and POSTs it — shared by the rounds endpoints.
    /// Synthesized Codable omits nil optionals, matching the server's
    /// "absent means unchanged/default" validation.
    private func postJSON<Body: Encodable, T: Decodable>(path: String, body: Body) async throws -> T {
        let data: Data
        do {
            data = try JSONEncoder().encode(body)
        } catch {
            throw APIError.decoding("Failed to encode \(path) body: \(error)")
        }
        return try await request(path: path, method: "POST", body: data)
    }

    private struct StartRoundRequest: Encodable {
        let courseId: String
        let startedAt: String
        let gamePlanId: String?
        let windSpeedMps: Double?
        let windDirectionDeg: Double?
        let stimpFt: Double?
    }

    private struct EndRoundRequest: Encodable {
        let id: String
        let version: Int
        let endedAt: String
        let notes: String?
        let stimpFt: Double?
    }

    private struct AddShotRequest: Encodable {
        let roundId: String
        let holeNumber: Int
        let lat: Double
        let lon: Double
        let clubId: String?
        let shotType: String?
        let targetLat: Double?
        let targetLon: Double?
        let penaltyStrokes: Int?
        let recordedAt: String?
    }

    private struct UpdateShotRequest: Encodable {
        let id: String
        let version: Int
        let lat: Double?
        let lon: Double?
        let holeNumber: Int?
        let clubId: String?
        let shotType: String?
        let targetLat: Double?
        let targetLon: Double?
        let penaltyStrokes: Int?
    }

    private struct RemoveShotRequest: Encodable {
        let id: String
        let version: Int
    }

    // MARK: - Green calibration (scan upload)

    /// Uploads one green scan to `POST /api/green-calibration/scans`.
    ///
    /// The server (task S1) stores `payload` and `quality` verbatim as opaque
    /// JSON; the request body is the `ingestScan` input shape from
    /// `shared/api/green-calibration.gen.ts`:
    /// `{ greenId, kind, capturedAt, payload, quality? }`. `payload` and
    /// `quality` are the typed contract structs from `GreenScanPayloads.swift`,
    /// re-encoded inline here so the outer envelope carries the discriminators
    /// the row columns need while the nested payload stays self-describing.
    @discardableResult
    public func postGreenScan<Payload: Encodable & Sendable, Quality: Encodable & Sendable>(
        greenId: String,
        kind: GreenScanKind,
        capturedAt: String,
        payload: Payload,
        quality: Quality?
    ) async throws -> GreenScanIngestResponse {
        let body = ScanIngestRequest(
            greenId: greenId,
            kind: kind,
            capturedAt: capturedAt,
            payload: payload,
            quality: quality
        )
        let data: Data
        do {
            data = try JSONEncoder().encode(body)
        } catch {
            throw APIError.decoding("Failed to encode green scan: \(error)")
        }
        return try await request(
            path: "green-calibration/scans",
            method: "POST",
            body: data
        )
    }

    /// Per-green calibration confidence + fitted bias for a course
    /// (`GET /api/green-calibration/confidence`) — the READ side of the scan
    /// round-trip. The putt read syncs this on course open and applies it
    /// (confidence lift + bias correction) to the terrain-tile surface. Returns
    /// one row per green on the course (calibrated greens carry a bias; the
    /// rest report the DEM prior).
    public func courseConfidence(courseId: String) async throws -> [GreenConfidenceDTO] {
        let response: CourseConfidenceResponse = try await request(
            path: "green-calibration/confidence",
            query: ["courseId": courseId]
        )
        return response.greens
    }

    /// The `ingestScan` request body. `payload`/`quality` encode inline (not as
    /// strings) — the server parses the JSON and stores it verbatim.
    private struct ScanIngestRequest<Payload: Encodable, Quality: Encodable>: Encodable {
        let greenId: String
        let kind: GreenScanKind
        let capturedAt: String
        let payload: Payload
        let quality: Quality?
    }

    // MARK: - Putt estimate (training quiz)

    /// Records one scored putt-quiz estimate (`POST /api/putt-estimates/samples`).
    /// The call site (`PuttQuizModel.submit`) uses this fire-and-forget — a
    /// lost training sample must never block the reveal — but this method
    /// itself throws normally so a caller can await/handle errors if wanted.
    @discardableResult
    public func recordPuttEstimateSample(
        greenId: String?,
        distanceM: Double,
        stimpFt: Double,
        actualSlopePct: Double,
        estimatedSlopePct: Double,
        actualAimOffsetM: Double,
        estimatedAimOffsetM: Double,
        actualPlaysLikeM: Double,
        estimatedPlaysLikeM: Double,
        breakSideActual: String,
        breakSideEstimated: String
    ) async throws -> PuttEstimateSample {
        try await postJSON(path: "putt-estimates/samples", body: RecordPuttEstimateSampleRequest(
            greenId: greenId,
            distanceM: distanceM,
            stimpFt: stimpFt,
            actualSlopePct: actualSlopePct,
            estimatedSlopePct: estimatedSlopePct,
            actualAimOffsetM: actualAimOffsetM,
            estimatedAimOffsetM: estimatedAimOffsetM,
            actualPlaysLikeM: actualPlaysLikeM,
            estimatedPlaysLikeM: estimatedPlaysLikeM,
            breakSideActual: breakSideActual,
            breakSideEstimated: breakSideEstimated
        ))
    }

    /// `recordSample` request body — matches `RecordSampleInput` in
    /// `server/api/putt-estimate.api.ts` exactly (`shared/api/putt-estimate.gen.ts`).
    /// Hand-written `encode(to:)`: `greenId` uses `encode` (not
    /// `encodeIfPresent`) so a nil green (Tier-3 manual read, no surface)
    /// emits JSON `null` rather than an omitted key — the schema requires the
    /// key present (`null | string`), unlike the rounds endpoints' bodies
    /// above where an absent key means "unchanged".
    private struct RecordPuttEstimateSampleRequest: Encodable {
        let greenId: String?
        let distanceM: Double
        let stimpFt: Double
        let actualSlopePct: Double
        let estimatedSlopePct: Double
        let actualAimOffsetM: Double
        let estimatedAimOffsetM: Double
        let actualPlaysLikeM: Double
        let estimatedPlaysLikeM: Double
        let breakSideActual: String
        let breakSideEstimated: String

        private enum CodingKeys: String, CodingKey {
            case greenId, distanceM, stimpFt, actualSlopePct, estimatedSlopePct
            case actualAimOffsetM, estimatedAimOffsetM, actualPlaysLikeM, estimatedPlaysLikeM
            case breakSideActual, breakSideEstimated
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(greenId, forKey: .greenId)
            try container.encode(distanceM, forKey: .distanceM)
            try container.encode(stimpFt, forKey: .stimpFt)
            try container.encode(actualSlopePct, forKey: .actualSlopePct)
            try container.encode(estimatedSlopePct, forKey: .estimatedSlopePct)
            try container.encode(actualAimOffsetM, forKey: .actualAimOffsetM)
            try container.encode(estimatedAimOffsetM, forKey: .estimatedAimOffsetM)
            try container.encode(actualPlaysLikeM, forKey: .actualPlaysLikeM)
            try container.encode(estimatedPlaysLikeM, forKey: .estimatedPlaysLikeM)
            try container.encode(breakSideActual, forKey: .breakSideActual)
            try container.encode(breakSideEstimated, forKey: .breakSideEstimated)
        }
    }

    // MARK: - Request core

    private func makeURL(path: String, query: [String: String]) -> URL {
        let base = apiBaseURL.appendingPathComponent(path)
        guard !query.isEmpty,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { return base }
        components.queryItems = query
            .sorted { $0.key < $1.key }
            .map { URLQueryItem(name: $0.key, value: $0.value) }
        return components.url ?? base
    }

    /// Performs the HTTP call, applies the 401 → re-login → retry policy, and
    /// returns `(data, status)` for any 2xx response. Throws `APIError` otherwise.
    private func requestData(
        path: String,
        method: String = "GET",
        query: [String: String] = [:],
        body: Data? = nil,
        allowRelogin: Bool = true
    ) async throws -> (Data, Int) {
        var attemptedRelogin = false

        while true {
            var req = URLRequest(url: makeURL(path: path, query: query))
            req.httpMethod = method
            if let body {
                req.httpBody = body
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
            req.setValue("application/json", forHTTPHeaderField: "Accept")

            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await session.data(for: req)
            } catch {
                throw APIError.transport(String(describing: error))
            }

            guard let http = response as? HTTPURLResponse else {
                throw APIError.transport("Non-HTTP response.")
            }

            if (200..<300).contains(http.statusCode) {
                return (data, http.statusCode)
            }

            if http.statusCode == 401 {
                if allowRelogin, !attemptedRelogin, let provider = credentialsProvider,
                   let creds = await provider() {
                    attemptedRelogin = true
                    // Re-login itself must not recurse into the retry loop.
                    _ = try? await login(username: creds.username, password: creds.password)
                    continue
                }
                throw APIError.unauthorized
            }

            throw APIError.http(status: http.statusCode, message: decodeErrorMessage(data))
        }
    }

    /// Decodes a 2xx body into `T`.
    private func request<T: Decodable>(
        path: String,
        method: String = "GET",
        query: [String: String] = [:],
        body: Data? = nil,
        allowRelogin: Bool = true
    ) async throws -> T {
        let (data, _) = try await requestData(
            path: path, method: method, query: query, body: body, allowRelogin: allowRelogin
        )
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    /// Like `request`, but tolerates a JSON `null` body → nil.
    private func requestOptional<T: Decodable>(
        path: String,
        method: String = "GET",
        query: [String: String] = [:],
        body: Data? = nil,
        allowRelogin: Bool = true
    ) async throws -> T? {
        let (data, _) = try await requestData(
            path: path, method: method, query: query, body: body, allowRelogin: allowRelogin
        )
        let trimmed = data.trimmingLeadingWhitespace()
        if trimmed.isEmpty || trimmed == Data("null".utf8) {
            return nil
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    private func decodeErrorMessage(_ data: Data) -> String? {
        if let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data) {
            return envelope.error
        }
        let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (text?.isEmpty == false) ? text : nil
    }
}

private extension Data {
    /// Returns the data with leading ASCII whitespace bytes removed.
    func trimmingLeadingWhitespace() -> Data {
        let whitespace: Set<UInt8> = [0x20, 0x09, 0x0A, 0x0D]
        guard let firstNonWS = firstIndex(where: { !whitespace.contains($0) }) else {
            return Data()
        }
        return subdata(in: firstNonWS..<endIndex)
    }
}
