import XCTest
@testable import GolfMap

/// Pure model tests for `ClubsModel` — validation accept/reject/revert per the
/// exact web ranges (`web/src/player/player-settings.component.ts`), the
/// derived length-dispersion display, add-requires-name, and reorder updating
/// `sortOrder`. No GRDB/networking: the `ClubEditWriter` is a set of recording
/// closures, mirroring how `OnCourseModel`'s tests fake `PlanEditWriter`.
@MainActor
final class ClubsModelTests: XCTestCase {

    /// Records every call the model makes through the writer, so tests can
    /// assert both the model's in-memory state AND what would have been
    /// persisted/pushed.
    private final class WriterSpy: @unchecked Sendable {
        struct UpdateCall: Equatable { let id: String; let name: String?; let carryM: Double?; let dispersionM: Double? }
        struct CreateCall: Equatable { let id: String; let name: String; let carryM: Double; let dispersionM: Double }

        var creates: [CreateCall] = []
        var updates: [UpdateCall] = []
        var removes: [String] = []
        var reorders: [[String]] = []

        func writer() -> ClubsModel.ClubEditWriter {
            ClubsModel.ClubEditWriter(
                create: { [weak self] id, name, carryM, dispersionM in
                    self?.creates.append(.init(id: id, name: name, carryM: carryM, dispersionM: dispersionM))
                },
                update: { [weak self] id, name, carryM, dispersionM in
                    self?.updates.append(.init(id: id, name: name, carryM: carryM, dispersionM: dispersionM))
                },
                remove: { [weak self] id in self?.removes.append(id) },
                reorder: { [weak self] ids in self?.reorders.append(ids) }
            )
        }
    }

    private func makeClub(id: String = "c1", name: String = "Driver", carryM: Double = 215, dispersionM: Double = 22, sortOrder: Int = 0) -> ClubRecord {
        ClubRecord(id: id, name: name, carryM: carryM, dispersionM: dispersionM, sortOrder: sortOrder, serverId: id, syncState: .synced)
    }

    // MARK: - Carry validation

    func testValidCarryCommitsAndClearsError() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())
        model.setClubs([makeClub(carryM: 215)])

        await model.commitCarry(id: "c1", text: "230")

        XCTAssertEqual(model.rows[0].club.carryM, 230)
        XCTAssertNil(model.rows[0].carryError)
        XCTAssertEqual(spy.updates, [.init(id: "c1", name: nil, carryM: 230, dispersionM: nil)])
    }

    func testCarryBelowMinimumRevertsAndErrors() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())
        model.setClubs([makeClub(carryM: 215)])

        await model.commitCarry(id: "c1", text: "9.9")

        XCTAssertEqual(model.rows[0].club.carryM, 215, "reverted to the stored value")
        XCTAssertNotNil(model.rows[0].carryError)
        XCTAssertTrue(spy.updates.isEmpty, "invalid input never reaches the writer")
    }

    func testCarryAboveMaximumRevertsAndErrors() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())
        model.setClubs([makeClub(carryM: 215)])

        await model.commitCarry(id: "c1", text: "400.1")

        XCTAssertEqual(model.rows[0].club.carryM, 215)
        XCTAssertNotNil(model.rows[0].carryError)
    }

    func testCarryBoundaryValuesAreValid() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())
        model.setClubs([makeClub(carryM: 215)])

        await model.commitCarry(id: "c1", text: "10")
        XCTAssertNil(model.rows[0].carryError)
        XCTAssertEqual(model.rows[0].club.carryM, 10)

        await model.commitCarry(id: "c1", text: "400")
        XCTAssertNil(model.rows[0].carryError)
        XCTAssertEqual(model.rows[0].club.carryM, 400)
    }

    func testCarryNonNumericTextRevertsAndErrors() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())
        model.setClubs([makeClub(carryM: 215)])

        await model.commitCarry(id: "c1", text: "abc")

        XCTAssertEqual(model.rows[0].club.carryM, 215)
        XCTAssertNotNil(model.rows[0].carryError)
        XCTAssertTrue(spy.updates.isEmpty)
    }

    // MARK: - Dispersion validation (full width, not a semi-axis)

    func testValidDispersionCommits() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())
        model.setClubs([makeClub(dispersionM: 22)])

        await model.commitDispersion(id: "c1", text: "18")

        XCTAssertEqual(model.rows[0].club.dispersionM, 18)
        XCTAssertNil(model.rows[0].dispersionError)
        XCTAssertEqual(spy.updates, [.init(id: "c1", name: nil, carryM: nil, dispersionM: 18)])
    }

    func testDispersionOutOfRangeReverts() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())
        model.setClubs([makeClub(dispersionM: 22)])

        await model.commitDispersion(id: "c1", text: "0.5")
        XCTAssertEqual(model.rows[0].club.dispersionM, 22)
        XCTAssertNotNil(model.rows[0].dispersionError)

        await model.commitDispersion(id: "c1", text: "100.5")
        XCTAssertEqual(model.rows[0].club.dispersionM, 22)
        XCTAssertNotNil(model.rows[0].dispersionError)
    }

    // MARK: - Name

    func testEmptyNameRevertsAndErrors() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())
        model.setClubs([makeClub(name: "Driver")])

        await model.commitName(id: "c1", text: "   ")

        XCTAssertEqual(model.rows[0].club.name, "Driver")
        XCTAssertNotNil(model.rows[0].nameError)
        XCTAssertTrue(spy.updates.isEmpty)
    }

    func testValidNameCommitsTrimmed() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())
        model.setClubs([makeClub(name: "Driver")])

        await model.commitName(id: "c1", text: "  Big Dog  ")

        XCTAssertEqual(model.rows[0].club.name, "Big Dog")
        XCTAssertEqual(spy.updates, [.init(id: "c1", name: "Big Dog", carryM: nil, dispersionM: nil)])
    }

    // MARK: - Derived length dispersion (read-only, 1 decimal)

    func testDerivedLengthDispersionMatchesTieredPercentages() {
        XCTAssertEqual(ClubsModel.lengthDispersionText(carryM: 215), "17.2") // >150 -> 8%
        XCTAssertEqual(ClubsModel.lengthDispersionText(carryM: 150), "9.0")  // ==150 -> 6% (inclusive)
        XCTAssertEqual(ClubsModel.lengthDispersionText(carryM: 100), "6.0")  // ==100 -> 6% (inclusive)
        XCTAssertEqual(ClubsModel.lengthDispersionText(carryM: 90), "4.5")   // <100 -> 5%
    }

    // MARK: - Add

    func testAddRequiresNonEmptyName() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())

        let error = await model.addClub(name: "  ", carryText: "200", dispersionText: "20")

        XCTAssertNotNil(error)
        XCTAssertTrue(model.rows.isEmpty)
        XCTAssertTrue(spy.creates.isEmpty)
    }

    func testAddRejectsInvalidCarryOrDispersion() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())

        let carryError = await model.addClub(name: "Wedge", carryText: "5", dispersionText: "20")
        XCTAssertNotNil(carryError)
        XCTAssertTrue(model.rows.isEmpty)

        let dispersionError = await model.addClub(name: "Wedge", carryText: "90", dispersionText: "500")
        XCTAssertNotNil(dispersionError)
        XCTAssertTrue(model.rows.isEmpty)
    }

    func testAddValidClubAppendsAtEndOfBagAndCreates() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())
        model.setClubs([makeClub(id: "c1", sortOrder: 0)])

        let error = await model.addClub(name: "Lob wedge", carryText: "60", dispersionText: "6")

        XCTAssertNil(error)
        XCTAssertEqual(model.rows.count, 2)
        XCTAssertEqual(model.rows[1].club.name, "Lob wedge")
        XCTAssertEqual(model.rows[1].club.sortOrder, 1)
        XCTAssertEqual(spy.creates.count, 1)
        XCTAssertEqual(spy.creates[0].name, "Lob wedge")
        XCTAssertEqual(spy.creates[0].carryM, 60)
        XCTAssertEqual(spy.creates[0].dispersionM, 6)
    }

    // MARK: - Delete / reorder

    func testDeleteRemovesRowReindexesAndCallsWriter() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())
        model.setClubs([
            makeClub(id: "c1", sortOrder: 0),
            makeClub(id: "c2", name: "7 iron", sortOrder: 1),
        ])

        await model.delete(atOffsets: IndexSet(integer: 0))

        XCTAssertEqual(model.rows.map(\.id), ["c2"])
        XCTAssertEqual(model.rows[0].club.sortOrder, 0, "reindexed after the delete")
        XCTAssertEqual(spy.removes, ["c1"])
    }

    func testMoveUpdatesSortOrderAndPushesReorder() async {
        let spy = WriterSpy()
        let model = ClubsModel(writer: spy.writer())
        model.setClubs([
            makeClub(id: "c1", sortOrder: 0),
            makeClub(id: "c2", name: "7 iron", sortOrder: 1),
            makeClub(id: "c3", name: "PW", sortOrder: 2),
        ])

        // Move the last club to the front.
        await model.move(fromOffsets: IndexSet(integer: 2), toOffset: 0)

        XCTAssertEqual(model.rows.map(\.id), ["c3", "c1", "c2"])
        XCTAssertEqual(model.rows.map(\.club.sortOrder), [0, 1, 2], "sortOrder reflects the new positions")
        XCTAssertEqual(spy.reorders, [["c3", "c1", "c2"]])
    }
}
