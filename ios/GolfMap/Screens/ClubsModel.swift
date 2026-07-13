import Foundation
import Observation

/// Owns the club-bag rows shown by `ClubsScreen`: validation, the derived
/// length-dispersion display, and dispatching writes through an injected
/// `ClubEditWriter` — kept pure of GRDB/networking so it's unit-testable with
/// fake closures (mirrors `OnCourseModel`'s `PlanEditWriter` shape).
///
/// Validation constants and accept/reject rules are a faithful port of the
/// web club matrix (`web/src/player/player-settings.component.ts`): carry
/// finite in [10, 400]; dispersion finite in [1, 100]; invalid input reverts
/// the stored value and surfaces an inline error instead of writing through.
@MainActor
@Observable
final class ClubsModel {

    /// Struct-of-closures write surface, backed in production by
    /// `Screens/ClubEditStore.swift` (GRDB + `ClubSyncService`) and by plain
    /// recording closures in tests.
    struct ClubEditWriter: Sendable {
        var create: @Sendable (_ id: String, _ name: String, _ carryM: Double, _ dispersionM: Double) async -> Void
        var update: @Sendable (_ id: String, _ name: String?, _ carryM: Double?, _ dispersionM: Double?) async -> Void
        var remove: @Sendable (_ id: String) async -> Void
        var reorder: @Sendable (_ orderedIds: [String]) async -> Void
    }

    /// One bag row: the stored club plus any per-field validation error
    /// currently displayed (cleared on the next valid commit for that field).
    struct Row: Identifiable, Equatable {
        var club: ClubRecord
        var nameError: String?
        var carryError: String?
        var dispersionError: String?
        var id: String { club.id }
    }

    // MARK: - Validation (exact web ranges)

    static let carryRange = 10.0...400.0
    static let dispersionRange = 1.0...100.0

    static let nameRequiredMessage = "Name is required."
    static let carryRangeMessage = "Carry must be a number between 10 and 400 m."
    static let dispersionRangeMessage = "Dispersion must be a number between 1 and 100 m."

    static func isValidCarry(_ value: Double) -> Bool {
        value.isFinite && carryRange.contains(value)
    }

    static func isValidDispersion(_ value: Double) -> Bool {
        value.isFinite && dispersionRange.contains(value)
    }

    /// Derived length (depth) dispersion for display — 1 decimal, meters.
    /// Read-only: never sent to the server, always recomputed from carry.
    static func lengthDispersionText(carryM: Double) -> String {
        String(format: "%.1f", lengthDispersionM(carryM))
    }

    // MARK: - State

    private(set) var rows: [Row] = []
    private let writer: ClubEditWriter

    init(writer: ClubEditWriter) {
        self.writer = writer
    }

    /// Replaces the displayed rows (called after the initial `allClubs()`
    /// read and after each course-open refresh — see `CourseScreen.swift`).
    func setClubs(_ clubs: [ClubRecord]) {
        rows = clubs
            .sorted { $0.sortOrder < $1.sortOrder }
            .map { Row(club: $0) }
    }

    // MARK: - Field commits (autosave on change/blur, revert on invalid)

    /// Commits an edited name. Empty (after trimming) is rejected — unlike
    /// carry/dispersion, this uses "required" phrasing to match the web copy.
    func commitName(id: String, text: String) async {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            rows[index].nameError = Self.nameRequiredMessage
            return
        }
        rows[index].nameError = nil
        guard trimmed != rows[index].club.name else { return }
        rows[index].club.name = trimmed
        await writer.update(id, trimmed, nil, nil)
    }

    /// Commits an edited carry. Invalid input reverts (the stored value is
    /// left untouched — the caller re-reads `rows[i].club.carryM` to restore
    /// the text field buffer) and shows the inline range error.
    func commitCarry(id: String, text: String) async {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        guard let value = Double(text), Self.isValidCarry(value) else {
            rows[index].carryError = Self.carryRangeMessage
            return
        }
        rows[index].carryError = nil
        guard value != rows[index].club.carryM else { return }
        rows[index].club.carryM = value
        await writer.update(id, nil, value, nil)
    }

    /// Commits an edited lateral dispersion (a FULL width, not a semi-axis —
    /// see `Strategy/Club.swift`). Same revert-on-invalid rule as carry.
    func commitDispersion(id: String, text: String) async {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        guard let value = Double(text), Self.isValidDispersion(value) else {
            rows[index].dispersionError = Self.dispersionRangeMessage
            return
        }
        rows[index].dispersionError = nil
        guard value != rows[index].club.dispersionM else { return }
        rows[index].club.dispersionM = value
        await writer.update(id, nil, nil, value)
    }

    // MARK: - Add / delete / reorder

    /// Adds a club. Returns an inline error message (and leaves `rows`
    /// untouched) when name/carry/dispersion fail validation; nil on success.
    @discardableResult
    func addClub(name: String, carryText: String, dispersionText: String) async -> String? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return Self.nameRequiredMessage }
        guard let carry = Double(carryText), Self.isValidCarry(carry) else {
            return Self.carryRangeMessage
        }
        guard let dispersion = Double(dispersionText), Self.isValidDispersion(dispersion) else {
            return Self.dispersionRangeMessage
        }

        let id = UUID().uuidString
        let sortOrder = rows.count
        let club = ClubRecord(
            id: id, name: trimmedName, carryM: carry, dispersionM: dispersion,
            sortOrder: sortOrder, syncState: .pending
        )
        rows.append(Row(club: club))
        await writer.create(id, trimmedName, carry, dispersion)
        return nil
    }

    /// Removes rows at `offsets` (List `.onDelete`) and reindexes the rest.
    func delete(atOffsets offsets: IndexSet) async {
        let ids = offsets.map { rows[$0].id }
        rows.remove(atOffsets: offsets)
        reindexSortOrder()
        for id in ids {
            await writer.remove(id)
        }
    }

    /// Reorders rows (List `.onMove`) and pushes the new order.
    func move(fromOffsets offsets: IndexSet, toOffset destination: Int) async {
        rows.move(fromOffsets: offsets, toOffset: destination)
        reindexSortOrder()
        await writer.reorder(rows.map(\.id))
    }

    private func reindexSortOrder() {
        for index in rows.indices {
            rows[index].club.sortOrder = index
        }
    }
}
