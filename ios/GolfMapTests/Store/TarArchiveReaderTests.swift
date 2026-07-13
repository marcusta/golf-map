import XCTest
@testable import GolfMap

final class TarArchiveReaderTests: XCTestCase {

    private func collect(_ data: Data) throws -> [TarEntry] {
        var entries: [TarEntry] = []
        try TarArchiveReader.read(data) { entries.append($0) }
        return entries
    }

    // MARK: - Happy path

    func testReadsRegularFilesInOrder() throws {
        let archive = makeTarArchive([
            ("19/1/1.webp", Data("alpha".utf8)),
            ("19/1/2.webp", Data(repeating: 0x42, count: 700)), // spans two blocks
            ("20/2/2.webp", Data()), // zero-length entry
        ])

        let entries = try collect(archive)
        XCTAssertEqual(entries.map(\.name), ["19/1/1.webp", "19/1/2.webp", "20/2/2.webp"])
        XCTAssertEqual(entries[0].data, Data("alpha".utf8))
        XCTAssertEqual(entries[1].data, Data(repeating: 0x42, count: 700))
        XCTAssertEqual(entries[2].data, Data())
    }

    func testToleratesMissingTrailingZeroBlocks() throws {
        var archive = makeTarArchive([("a/b.png", Data("x".utf8))])
        archive.removeLast(1024) // strip the two zero blocks
        let entries = try collect(archive)
        XCTAssertEqual(entries.map(\.name), ["a/b.png"])
    }

    func testSkipsNonRegularEntries() throws {
        var archive = Data()
        archive.append(rawHeader(name: "somedir/", size: 0, typeflag: UInt8(ascii: "5")))
        archive.append(rawHeader(name: "somedir/tile.webp", size: 3, typeflag: UInt8(ascii: "0")))
        archive.append(padded(Data("abc".utf8)))
        archive.append(Data(count: 1024))

        let entries = try collect(archive)
        XCTAssertEqual(entries.map(\.name), ["somedir/tile.webp"])
    }

    // MARK: - Malformed input

    func testTruncatedBodyThrows() throws {
        var archive = makeTarArchive([("a.webp", Data(repeating: 1, count: 600))])
        archive.removeLast(1024 + 100) // drop terminator + part of the body
        XCTAssertThrowsError(try collect(archive)) { error in
            XCTAssertEqual(error as? TarArchiveError, .truncated)
        }
    }

    func testTruncatedHeaderThrows() {
        let archive = Data(repeating: 0x41, count: 100) // <512, not all zero
        XCTAssertThrowsError(try collect(archive)) { error in
            XCTAssertEqual(error as? TarArchiveError, .truncated)
        }
    }

    func testInvalidSizeOctalThrows() {
        var header = [UInt8](repeating: 0, count: 512)
        for (i, b) in Array("bad.webp".utf8).enumerated() { header[i] = b }
        for (i, b) in Array("notoctal".utf8).enumerated() { header[124 + i] = b }
        header[156] = UInt8(ascii: "0")
        let archive = Data(header) + Data(count: 1024)
        XCTAssertThrowsError(try collect(archive)) { error in
            XCTAssertEqual(error as? TarArchiveError, .invalidHeader)
        }
    }

    // MARK: - Name traversal / safety

    func testRejectsParentTraversalName() {
        let archive = makeTarArchive([("../escape.webp", Data("x".utf8))])
        XCTAssertThrowsError(try collect(archive)) { error in
            guard case .unsafeEntryName("../escape.webp") = (error as? TarArchiveError) else {
                return XCTFail("got \(error)")
            }
        }
    }

    func testRejectsNestedParentTraversalName() {
        let archive = makeTarArchive([("19/../../etc/passwd", Data("x".utf8))])
        XCTAssertThrowsError(try collect(archive)) { error in
            guard case .unsafeEntryName = (error as? TarArchiveError) else {
                return XCTFail("got \(error)")
            }
        }
    }

    func testRejectsAbsolutePathName() {
        let archive = makeTarArchive([("/etc/passwd", Data("x".utf8))])
        XCTAssertThrowsError(try collect(archive)) { error in
            guard case .unsafeEntryName = (error as? TarArchiveError) else {
                return XCTFail("got \(error)")
            }
        }
    }

    func testRejectsEmptyName() {
        let archive = makeTarArchive([("", Data("x".utf8))])
        XCTAssertThrowsError(try collect(archive)) { error in
            guard case .unsafeEntryName = (error as? TarArchiveError) else {
                return XCTFail("got \(error)")
            }
        }
    }

    // MARK: - Raw header helpers (for cases makeTarArchive can't express)

    private func rawHeader(name: String, size: Int, typeflag: UInt8) -> Data {
        var header = [UInt8](repeating: 0, count: 512)
        for (i, b) in Array(name.utf8).prefix(100).enumerated() { header[i] = b }
        for (i, b) in Array(String(format: "%011o", size).utf8).enumerated() { header[124 + i] = b }
        header[156] = typeflag
        for (i, b) in Array("ustar".utf8).enumerated() { header[257 + i] = b }
        // Checksum with the checksum field as spaces.
        for i in 148..<156 { header[i] = UInt8(ascii: " ") }
        let sum = header.reduce(0) { $0 + Int($1) }
        for (i, b) in Array(String(format: "%06o", sum).utf8).enumerated() { header[148 + i] = b }
        header[154] = 0
        header[155] = UInt8(ascii: " ")
        return Data(header)
    }

    private func padded(_ data: Data) -> Data {
        let pad = (512 - (data.count % 512)) % 512
        return pad > 0 ? data + Data(count: pad) : data
    }
}
