import XCTest
import Network
@testable import GolfMap

/// Exercises the real URLSession and bundle installer over loopback HTTP.
final class TreeStemsBundleTests: XCTestCase {
    func testDownloadAndInstallStemsOrFallbackOn404() async throws {
        for status in [200, 404] {
            let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let asset = Data(#"{"version":1,"crs":"EPSG:3006","fields":["x","y","heightM","crownRadiusM","groundM"],"trees":[[540000,6460000,10,3,80]]}"#.utf8)
            let archive = makeTarArchive([("14/1/1.png", Data("tile".utf8))])
            let server = try StemBundleHTTPServer { path in
                path.contains("tree-stems.json") ? (status, asset) : (200, archive)
            }
            let port = try await server.start()
            defer { server.stop() }
            let paths = BundlePaths(rootDirectory: root)
            let downloader = BundleDownloader(database: try AppDatabase.inMemory(), paths: paths)
            let request = BundleDownloadRequest(
                tileBaseURL: URL(string: "http://127.0.0.1:\(port)/tiles")!,
                furniture: StoreFixtures.furniture(), treeStemsPath: "tree-stems.json",
                featuresGeoJSON: { Data(#"{"type":"FeatureCollection","features":[]}"#.utf8) }
            )
            _ = try await downloader.download(request)
            let url = paths.courseDataDirectory(courseId: "course-1").appending(path: "tree-stems.json")
            if status == 200 {
                XCTAssertEqual(try TreeStemsAsset.parse(Data(contentsOf: url)).first?.groundM, 80)
            } else {
                XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
            }
        }
    }
}

private final class StemBundleHTTPServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "TreeStemsBundleTests.http")
    private let response: @Sendable (String) -> (Int, Data)

    init(response: @escaping @Sendable (String) -> (Int, Data)) throws {
        self.listener = try NWListener(using: .tcp, on: .any)
        self.response = response
    }

    func start() async throws -> UInt16 {
        listener.newConnectionHandler = { [response, queue] connection in
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
                let request = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                let (status, body) = response(request)
                var bytes = Data("HTTP/1.1 \(status) OK\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
                bytes.append(body)
                connection.send(content: bytes, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        return try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { [listener] state in
                switch state {
                case .ready:
                    listener.stateUpdateHandler = nil
                    continuation.resume(returning: listener.port!.rawValue)
                case .failed(let error):
                    listener.stateUpdateHandler = nil
                    continuation.resume(throwing: error)
                default: break
                }
            }
            listener.start(queue: queue)
        }
    }

    func stop() { listener.cancel() }
}
