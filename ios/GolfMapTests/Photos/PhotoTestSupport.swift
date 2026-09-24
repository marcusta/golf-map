import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import GolfMap

/// URLProtocol stub for the photo upload tests. Unlike `MockURLProtocol` it
/// records method, headers, query and body of every request, and its script is
/// keyed by `"<METHOD> <path>[?kind=<kind>]"`. State is reset per test.
final class PhotoStubProtocol: URLProtocol {
    struct Recorded: Sendable {
        var method: String
        var path: String
        var kind: String?
        var headers: [String: String]
        var body: Data

        var key: String { kind.map { "\(method) \(path)?kind=\($0)" } ?? "\(method) \(path)" }
    }

    enum Reply: Sendable {
        case status(Int, String)
        case networkDown
    }

    final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var scripts: [String: [Reply]] = [:]
        private var log: [Recorded] = []

        func reset() {
            lock.lock(); defer { lock.unlock() }
            scripts = [:]
            log = []
        }

        /// Replies in order; the last one repeats once the script is drained.
        func script(_ key: String, _ replies: Reply...) {
            lock.lock(); defer { lock.unlock() }
            scripts[key] = replies
        }

        func next(_ request: Recorded) -> Reply {
            lock.lock(); defer { lock.unlock() }
            log.append(request)
            guard var replies = scripts[request.key], !replies.isEmpty else {
                return .status(500, #"{"error":"no stub"}"#)
            }
            let head = replies.removeFirst()
            scripts[request.key] = replies.isEmpty ? [head] : replies
            return head
        }

        var requests: [Recorded] {
            lock.lock(); defer { lock.unlock() }
            return log
        }

        var keys: [String] { requests.map(\.key) }
    }

    nonisolated(unsafe) static let state = State()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let kind = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "kind" })?.value
        var headers: [String: String] = [:]
        for (k, v) in request.allHTTPHeaderFields ?? [:] { headers[k] = v }
        let recorded = Recorded(
            method: request.httpMethod ?? "GET",
            path: url.path,
            kind: kind,
            headers: headers,
            body: Self.body(of: request)
        )
        switch Self.state.next(recorded) {
        case .networkDown:
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        case .status(let code, let body):
            let response = HTTPURLResponse(
                url: url, statusCode: code, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65536)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            guard n > 0 else { break }
            data.append(buffer, count: n)
        }
        return data
    }

    static func makeClient() -> GolfAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PhotoStubProtocol.self]
        return GolfAPIClient(baseURL: URL(string: "http://mock.local")!, session: URLSession(configuration: config))
    }
}

/// Settable clock for backoff and retention tests.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date

    init(_ start: Date) { value = start }

    var now: Date {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    func advance(_ seconds: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        value = value.addingTimeInterval(seconds)
    }
}

enum PhotoFixtures {
    static func temporaryFiles() throws -> PhotoFiles {
        let dir = FileManager.default.temporaryDirectory
            .appending(path: "photo tests \(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(atPath: dir.path(percentEncoded: false), withIntermediateDirectories: true)
        return PhotoFiles(rootDirectory: dir)
    }

    static func record(id: String = "p1", capturedAt: String = "2026-10-02T09:14:31Z") -> ReferencePhotoRecord {
        ReferencePhotoRecord(
            id: id,
            siteId: "site-1",
            courseId: "course-1",
            hole: 7,
            capturedAt: capturedAt,
            lat: 59.25,
            lon: 18.5,
            hAccM: 3.5,
            gpsAltM: 42.5,
            vAccM: 4,
            quatW: 0.5, quatX: 0.5, quatY: -0.5, quatZ: -0.5,
            yawDeg: 0,
            pitchDeg: 0,
            rollDeg: 0,
            headingAccDeg: 8,
            magCalibration: 2,
            hfovDeg: 50,
            vfovDeg: 65.5,
            width: 3024,
            height: 4032,
            eyeHeightM: 1.5,
            deviceModel: "iPhone17,1",
            lens: "wide",
            tags: ["look", "trees"],
            note: "left of the oak",
            northReference: .trueNorth,
            declinationDeg: nil,
            imageUp: "plusY",
            isStationary: true,
            maxRotationRateRadS: 0.02,
            originalFile: "\(id).heic",
            previewFile: "\(id).jpg",
            thumbnailFile: "\(id)-thumb.jpg",
            originalSha256: PhotoFiles.sha256Hex(originalBytes(id)),
            originalBytes: originalBytes(id).count,
            previewSha256: PhotoFiles.sha256Hex(previewBytes(id)),
            previewBytes: previewBytes(id).count,
            syncState: .pending,
            attemptCount: 0
        )
    }

    static func originalBytes(_ id: String) -> Data { Data("heic-\(id)".utf8) }
    static func previewBytes(_ id: String) -> Data { Data("jpeg-\(id)".utf8) }

    /// Saves the row and writes stand-in bytes for its three files.
    static func store(_ record: ReferencePhotoRecord, database: AppDatabase, files: PhotoFiles) async throws {
        try originalBytes(record.id).write(to: files.url(record.originalFile))
        try previewBytes(record.id).write(to: files.url(record.previewFile))
        try Data("thumb".utf8).write(to: files.url(record.thumbnailFile))
        try await database.saveReferencePhoto(record)
    }

    /// A solid JPEG with the given pixel size and EXIF orientation.
    static func jpeg(width: Int, height: Int, orientation: UInt32) -> Data {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        )!
        ctx.setFillColor(red: 0.3, green: 0.5, blue: 0.2, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = ctx.makeImage()!
        let out = NSMutableData()
        let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, image, [kCGImagePropertyOrientation: orientation] as CFDictionary)
        CGImageDestinationFinalize(dest)
        return out as Data
    }
}
