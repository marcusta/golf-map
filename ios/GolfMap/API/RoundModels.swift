import Foundation

// MARK: - Rounds API models
//
// Transcribed from `shared/api/rounds.gen.ts` response shapes (camelCase
// JSON, no CodingKeys). The iOS app captures rounds/shots offline and pushes
// them through `rounds/start`, `rounds/end`, `rounds/shots/add|update|remove`
// — only the shapes those endpoints return live here.

/// A round row: `POST /api/rounds/start` and `POST /api/rounds/end` response.
public struct Round: Codable, Sendable, Equatable {
    public let id: String
    public let courseId: String
    public let userId: String?
    public let startedAt: String
    public let endedAt: String?
    public let notes: String?
    public let gamePlanId: String?
    public let windSpeedMps: Double?
    public let windDirectionDeg: Double?
    public let stimpFt: Double?
    public let version: Int
    public let createdAt: String
    public let updatedAt: String
}

/// A shot row: `POST /api/rounds/shots/add` and `/update` response.
public struct Shot: Codable, Sendable, Equatable {
    public let id: String
    public let roundId: String
    public let holeNumber: Int
    public let sortOrder: Int
    public let lat: Double
    public let lon: Double
    public let clubId: String?
    public let lie: String?
    /// Raw server string ('full' | 'partial' | 'putt' | 'recovery').
    public let shotType: String
    public let targetLat: Double?
    public let targetLon: Double?
    public let penaltyStrokes: Int
    public let recordedAt: String
    public let version: Int
    public let createdAt: String
    public let updatedAt: String
}
