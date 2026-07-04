import Foundation
import XCTest
@testable import GolfMap

// MARK: - Fixtures

enum StoreFixtures {
    /// A small two-hole course. Manifest bounds (0,0)-(10,10) with ortho z1-2
    /// and terrain z1 yield exactly 6 tiles:
    ///   ortho  z1: (1,0) (1,1)   z2: (2,1) (2,2)
    ///   terrain z1: (1,0) (1,1)
    static func furniture(
        courseId: String = "course-1",
        revision: Int = 3,
        versionParam: String = "ver1"
    ) -> CourseFurniture {
        let course = CourseRecord(
            id: courseId,
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
            orthoMinZoom: 1, orthoMaxZoom: 2,
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

            let response = HTTPURLResponse(
                url: url,
                statusCode: stub.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: nil
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

// MARK: - Temp directory helper

func makeTemporaryDirectory(function: StaticString = #function) throws -> URL {
    let url = FileManager.default.temporaryDirectory
        .appending(path: "store-tests-\(function)-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
