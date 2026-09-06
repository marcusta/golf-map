import Foundation

/// Crown kind from the pipeline classifier (leaf-off ortho greenness).
public enum TreeKind: Int, Equatable, Sendable {
    case broadleaf = 0
    case conifer = 1
    case unknown = 2
}

/// EPSG:3006 position, RH2000 ground elevation, all in metres.
public struct TreeStem: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var heightM: Double
    public var crownRadiusM: Double
    public var groundM: Double
    /// Version 1 assets carry no kind; every stem reads as unknown.
    public var kind: TreeKind

    public init(x: Double, y: Double, heightM: Double, crownRadiusM: Double, groundM: Double, kind: TreeKind = .unknown) {
        self.x = x
        self.y = y
        self.heightM = heightM
        self.crownRadiusM = crownRadiusM
        self.groundM = groundM
        self.kind = kind
    }

    public var feature: TreeFeatureInput {
        TreeFeatureInput(type: "trees", points: [], stem: self)
    }
}

public enum TreeStemsAsset {
    private struct Asset: Decodable {
        let version: Int
        let crs: String
        let fields: [String]
        let trees: [[Double]]
    }
    public enum ParseError: Error { case invalidAsset }

    static let fieldsV1 = ["x", "y", "heightM", "crownRadiusM", "groundM"]
    static let fieldsV2 = fieldsV1 + ["kind"]

    /// Invalid assets fail as a whole; an empty valid asset remains authoritative.
    /// Accepts version 1 (five columns) and version 2 (kind appended).
    public static func parse(_ data: Data) throws -> [TreeStem] {
        let asset = try JSONDecoder().decode(Asset.self, from: data)
        let fields: [String]
        switch asset.version {
        case 1: fields = fieldsV1
        case 2: fields = fieldsV2
        default: throw ParseError.invalidAsset
        }
        guard asset.crs == "EPSG:3006", asset.fields == fields else {
            throw ParseError.invalidAsset
        }
        return try asset.trees.map { row in
            guard row.count == fields.count, row.allSatisfy(\.isFinite), row[2] > 0, row[3] > 0 else {
                throw ParseError.invalidAsset
            }
            var kind = TreeKind.unknown
            if row.count == 6 {
                guard row[5] == row[5].rounded(), let parsed = TreeKind(rawValue: Int(row[5])) else {
                    throw ParseError.invalidAsset
                }
                kind = parsed
            }
            return TreeStem(x: row[0], y: row[1], heightM: row[2], crownRadiusM: row[3], groundM: row[4], kind: kind)
        }
    }
}
