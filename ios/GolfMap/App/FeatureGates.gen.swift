// Generated from shared/feature-gates.json. Do not edit by hand.
// Run: bun run feature-gates:generate

enum FeatureGateKey: String, CaseIterable, Sendable {
    case pinEntry
    case laserCalibration
    case planEditing
    case planOptionsTree
    case decideMode
    case puttRead
    case referencePhotos
}

struct FeatureGates: Equatable, Sendable {
    let pinEntry: Bool
    let laserCalibration: Bool
    let planEditing: Bool
    let planOptionsTree: Bool
    let decideMode: Bool
    let puttRead: Bool
    let referencePhotos: Bool

    static let generatedDefaults = FeatureGates(
        pinEntry: false,
        laserCalibration: false,
        planEditing: false,
        planOptionsTree: false,
        decideMode: false,
        puttRead: false,
        referencePhotos: true,
    )

    subscript(_ key: FeatureGateKey) -> Bool {
        switch key {
        case .pinEntry: return pinEntry
        case .laserCalibration: return laserCalibration
        case .planEditing: return planEditing
        case .planOptionsTree: return planOptionsTree
        case .decideMode: return decideMode
        case .puttRead: return puttRead
        case .referencePhotos: return referencePhotos
        }
    }

    func applying(_ overrides: [FeatureGateKey: Bool]) -> FeatureGates {
        FeatureGates(
            pinEntry: overrides[.pinEntry] ?? pinEntry,
            laserCalibration: overrides[.laserCalibration] ?? laserCalibration,
            planEditing: overrides[.planEditing] ?? planEditing,
            planOptionsTree: overrides[.planOptionsTree] ?? planOptionsTree,
            decideMode: overrides[.decideMode] ?? decideMode,
            puttRead: overrides[.puttRead] ?? puttRead,
            referencePhotos: overrides[.referencePhotos] ?? referencePhotos,
        )
    }
}
