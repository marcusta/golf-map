import Foundation
import Observation
import WatchConnectivity

/// The watch's store of synced courses: receives `WatchCourseBundle` files
/// from the iPhone over WatchConnectivity and persists them in Application
/// Support, so every synced course works with the phone left in the bag.
@MainActor
@Observable
final class CourseLibrary: NSObject {

    /// Synced courses, most recently built first.
    private(set) var courses: [WatchCourseBundle] = []
    /// The user's explicit course choice (persisted); nil = newest synced.
    private var chosenCourseId: String?
    /// Today's pins, received on the application-context channel. Owned here
    /// because WCSession allows exactly one delegate — this class is it, and it
    /// forwards pin contexts through.
    let pins: PinStore

    private let defaults: UserDefaults
    private static let chosenKey = "courseLibrary.chosenCourseId"

    var activeCourse: WatchCourseBundle? {
        if let chosenCourseId, let chosen = courses.first(where: { $0.courseId == chosenCourseId }) {
            return chosen
        }
        return courses.first
    }

    init(defaults: UserDefaults = .standard, pins: PinStore = PinStore()) {
        self.defaults = defaults
        self.pins = pins
        super.init()
        chosenCourseId = defaults.string(forKey: Self.chosenKey)
        loadFromDisk()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func choose(courseId: String) {
        chosenCourseId = courseId
        defaults.set(courseId, forKey: Self.chosenKey)
    }

    // MARK: - Storage

    /// Application Support/Courses; created on demand. NOTE: keep every
    /// filesystem call on `path(percentEncoded: false)`-safe APIs — spaced
    /// paths broke `fileExists(atPath:)` once already (see memory).
    private nonisolated static func storeDirectory() -> URL {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        )[0]
        return base.appendingPathComponent("Courses", isDirectory: true)
    }

    private func loadFromDisk() {
        let directory = Self.storeDirectory()
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        )) ?? []
        courses = files
            .filter { $0.pathExtension == "json" }
            .compactMap { url -> WatchCourseBundle? in
                guard
                    let data = try? Data(contentsOf: url),
                    let bundle = try? decoder.decode(WatchCourseBundle.self, from: data),
                    bundle.formatVersion <= WatchCourseBundle.currentFormatVersion
                else { return nil }
                return bundle
            }
            .sorted { $0.builtAt > $1.builtAt }
    }

    /// Moves a received file into the store (overwriting any previous sync of
    /// the same course). Runs off the main actor — the system deletes the
    /// source file as soon as the delegate callback returns.
    private nonisolated static func persist(receivedFile url: URL) {
        let directory = storeDirectory()
        let destination = directory.appendingPathComponent(url.lastPathComponent)
        do {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true
            )
            if FileManager.default.fileExists(atPath: destination.path(percentEncoded: false)) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: url, to: destination)
        } catch {
            print("Course receive failed: \(error)")
        }
    }
}

extension CourseLibrary: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: (any Error)?
    ) {
        guard activationState == .activated else { return }
        // The context delivered while the app was not running is waiting here
        // at activation — the delegate callback does not replay it.
        guard let decoded = WatchPinPayload.decode(session.receivedApplicationContext)
        else { return }
        Task { @MainActor in self.pins.apply(decoded) }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveApplicationContext applicationContext: [String: Any]
    ) {
        guard let decoded = WatchPinPayload.decode(applicationContext) else { return }
        Task { @MainActor in self.pins.apply(decoded) }
    }

    nonisolated func session(_ session: WCSession, didReceive file: WCSessionFile) {
        // Must complete before returning — the temp file dies with the call.
        Self.persist(receivedFile: file.fileURL)
        Task { @MainActor in self.loadFromDisk() }
    }
}
