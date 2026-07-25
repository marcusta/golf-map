import Foundation
import XCTest
@testable import GolfMap

// MARK: - Fixtures

enum StoreFixtures {
    /// A small two-hole course with manifest bounds (0,0)-(10,10). Tile
    /// contents come from the mock archive the test scripts, not from the
    /// manifest's zoom range.
    /// `orthoMaxZoom` defaults to 20 — what an UNCAPPED builder publishes, so
    /// the archive request lands on the device ceiling (19). Pass a lower value
    /// to simulate a capped VPS manifest (deploy split §9).
    static func furniture(
        courseId: String = "course-1",
        siteId: String? = nil,
        revision: Int = 3,
        versionParam: String = "ver1",
        orthoMaxZoom: Int = 20
    ) -> CourseFurniture {
        let course = CourseRecord(
            id: courseId,
            siteId: siteId,
            name: "Test Course",
            status: "published",
            revision: revision,
            homeLat: 58.35,
            homeLon: 15.72,
            updatedAt: "2026-07-01T10:00:00Z"
        )
        let holes = [
            HoleRecord(id: "\(courseId)-h1", courseId: courseId, number: 1, par: 4, strokeIndex: 7),
            HoleRecord(id: "\(courseId)-h2", courseId: courseId, number: 2, par: 3),
        ]
        let tees = [
            TeeRecord(
                id: "\(courseId)-t1", holeId: "\(courseId)-h1", name: "yellow", color: "#ffd700",
                lat: 58.351, lon: 15.721, elevation: 42.5, sortOrder: 0
            ),
            TeeRecord(
                id: "\(courseId)-t2", holeId: "\(courseId)-h1", name: "red",
                lat: 58.352, lon: 15.722, sortOrder: 1
            ),
        ]
        let greens = [
            GreenRecord(
                id: "\(courseId)-g1", holeId: "\(courseId)-h1",
                centerLat: 58.353, centerLon: 15.723,
                frontLat: 58.3528, frontLon: 15.7228,
                backLat: 58.3532, backLon: 15.7232,
                elevation: 40.0
            ),
        ]
        let pins = [
            PinRecord(
                id: "\(courseId)-p1", greenId: "\(courseId)-g1", name: "sunday",
                lat: 58.3531, lon: 15.7231, difficulty: "hard", active: true
            ),
        ]
        let aimPoints = [
            AimPointRecord(
                id: "\(courseId)-a1", holeId: "\(courseId)-h1", sortOrder: 0,
                lat: 58.3515, lon: 15.7215, elevation: 41.0, label: "layup"
            ),
        ]
        let manifest = TileManifestRecord(
            courseId: courseId,
            west: 0.0, south: 0.0, east: 10.0, north: 10.0,
            orthoMinZoom: 1, orthoMaxZoom: orthoMaxZoom,
            terrainMinZoom: 1, terrainMaxZoom: 1,
            elevMin: 12.5, elevMax: 87.0,
            generatedAt: "2026-06-30T08:00:00Z",
            versionParam: versionParam
        )
        return CourseFurniture(
            course: course,
            holes: holes,
            tees: tees,
            greens: greens,
            pins: pins,
            aimPoints: aimPoints,
            manifest: manifest
        )
    }
}

// MARK: - Mock URL loading

/// Response stub returned by the mock handler.
struct MockTileResponse: Sendable {
    var statusCode: Int
    var data: Data
    /// Delay before the response is delivered (used by the cancellation test).
    var delay: TimeInterval = 0
    /// When set, the request fails with this transport error instead of
    /// producing a response (used by the retry test).
    var networkError: URLError?
}

/// URLProtocol that answers from a registered handler and records every
/// request URL. State is static (URLProtocol instantiates per request) and
/// lock-protected for Swift 6 strict concurrency.
/// (Named with a Store prefix: the API tests ship their own mock protocol
/// in the same test module.)
final class StoreMockURLProtocol: URLProtocol {
    typealias Handler = @Sendable (URLRequest) -> MockTileResponse

    private static let lock = NSLock()
    nonisolated(unsafe) private static var _handler: Handler?
    nonisolated(unsafe) private static var _requestedURLs: [URL] = []

    static func setHandler(_ handler: Handler?) {
        lock.lock()
        defer { lock.unlock() }
        _handler = handler
        _requestedURLs = []
    }

    static var requestedURLs: [URL] {
        lock.lock()
        defer { lock.unlock() }
        return _requestedURLs
    }

    /// A URLSession routing everything through this protocol.
    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StoreMockURLProtocol.self]
        return URLSession(configuration: config)
    }

    private let stateLock = NSLock()
    private var stopped = false

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let handler: Handler? = {
            Self.lock.lock()
            defer { Self.lock.unlock() }
            if let url = request.url { Self._requestedURLs.append(url) }
            return Self._handler
        }()

        guard let handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let stub = handler(request)

        let box = UncheckedSendableBox(value: self)
        let deliver: @Sendable () -> Void = {
            let mock = box.value
            mock.stateLock.lock()
            let isStopped = mock.stopped
            mock.stateLock.unlock()
            guard !isStopped, let url = mock.request.url, let client = mock.client else { return }

            if let networkError = stub.networkError {
                client.urlProtocol(mock, didFailWithError: networkError)
                return
            }

            let response = HTTPURLResponse(
                url: url,
                statusCode: stub.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Length": String(stub.data.count)]
            )!
            client.urlProtocol(mock, didReceive: response, cacheStoragePolicy: .notAllowed)
            client.urlProtocol(mock, didLoad: stub.data)
            client.urlProtocolDidFinishLoading(mock)
        }

        if stub.delay > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + stub.delay, execute: deliver)
        } else {
            deliver()
        }
    }

    override func stopLoading() {
        stateLock.lock()
        stopped = true
        stateLock.unlock()
    }
}

struct UncheckedSendableBox<T>: @unchecked Sendable {
    let value: T
}

/// Thread-safe counter for per-URL attempt tracking inside @Sendable handlers.
final class AttemptCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]

    /// Records an attempt for the key and returns the attempt number (1-based).
    func record(_ key: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        counts[key, default: 0] += 1
        return counts[key]!
    }
}

// MARK: - Tar fixture builder

/// Builds an uncompressed POSIX ustar archive from `(name, data)` entries —
/// regular files (typeflag '0'), correct octal size + checksum, terminated by
/// two zero blocks. Matches the server contract the downloader parses.
func makeTarArchive(_ entries: [(name: String, data: Data)]) -> Data {
    var out = Data()
    for (name, data) in entries {
        out.append(tarHeader(name: name, size: data.count))
        out.append(data)
        let pad = (512 - (data.count % 512)) % 512
        if pad > 0 { out.append(Data(count: pad)) }
    }
    // Two trailing zero blocks.
    out.append(Data(count: 1024))
    return out
}

private func tarHeader(name: String, size: Int) -> Data {
    var header = [UInt8](repeating: 0, count: 512)

    func write(_ string: String, at offset: Int, length: Int) {
        let bytes = Array(string.utf8).prefix(length)
        for (i, b) in bytes.enumerated() { header[offset + i] = b }
    }

    write(name, at: 0, length: 100)
    // mode, uid, gid — "0000644\0", "0000000\0".
    write("0000644", at: 100, length: 8)
    write("0000000", at: 108, length: 8)
    write("0000000", at: 116, length: 8)
    // size: 11-octal-digit field + trailing space.
    write(String(format: "%011o", size), at: 124, length: 12)
    write("00000000000", at: 136, length: 12) // mtime
    header[156] = UInt8(ascii: "0") // typeflag: regular file
    write("ustar", at: 257, length: 6)
    write("00", at: 263, length: 2)

    // Checksum: sum of all bytes with the checksum field taken as spaces.
    for i in 148..<156 { header[i] = UInt8(ascii: " ") }
    let checksum = header.reduce(0) { $0 + Int($1) }
    write(String(format: "%06o", checksum), at: 148, length: 7)
    header[154] = 0
    header[155] = UInt8(ascii: " ")

    return Data(header)
}

// MARK: - Temp directory helper

func makeTemporaryDirectory(function: StaticString = #function) throws -> URL {
    let url = FileManager.default.temporaryDirectory
        .appending(path: "store-tests-\(function)-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
