import Foundation
import Observation

/// The app's authentication / connectivity state, driven by `AppEnvironment`.
enum AuthState: Equatable {
    /// No session and no stored credentials — show the login screen.
    case loggedOut
    /// Authenticated with the server.
    case loggedIn(AuthUser)
    /// The server is unreachable but local bundles remain usable. Reached when
    /// bootstrap can't contact the server; the UI shows a local-only list.
    case offline
}

/// App-wide dependency container + auth state machine, injected via
/// `.environment(_:)` from `GolfMapApp`.
///
/// Owns the singletons the whole app shares — `GolfAPIClient`, `AppDatabase`,
/// `BundleDownloader`, `SyncService`, `Keychain` — and the observable auth
/// state the root view switches on.
///
/// **Server origin** is read once from `UserDefaults` key `serverOrigin` (so it
/// can be pointed at a different host without a rebuild — used by the offline
/// live-verify), falling back to `defaultServerOrigin` (the deployed VPS on a
/// device, the local dev server on the simulator).
@MainActor
@Observable
final class AppEnvironment {
    // MARK: Dependencies

    let serverOrigin: URL
    let client: GolfAPIClient
    let database: AppDatabase
    let bundlePaths: BundlePaths
    let downloader: BundleDownloader
    let syncService: SyncService
    /// Pushes locally captured rounds/shots (dirty-flag queue). Flushed on
    /// app-start/foreground (`GolfMapApp`) and after every capture write.
    let roundSync: RoundSyncService
    /// Pushes locally edited game-plan rows (dirty-flag queue). Flushed on
    /// app-start/foreground and after every planner edit.
    let planSync: PlanSyncService
    /// Pushes locally edited club-bag rows (dirty-flag queue + order-dirty
    /// flag). Flushed on app-start/foreground and after every bag edit.
    let clubSync: ClubSyncService
    let keychain: Keychain
    /// App-wide user preferences (competition mode, …).
    let settings: AppSettings
    /// Build-time feature gates, resolved once at launch.
    let gates: FeatureGates

    // MARK: Observable state

    /// Current auth/connectivity state; the root view switches on this.
    private(set) var authState: AuthState = .loggedOut
    /// True while `bootstrap()` is resolving the initial state (splash).
    private(set) var isBootstrapping = true

    // MARK: Init

    /// Designated initializer. `database`/`bundlePaths` are injected so tests
    /// can pass in-memory / temp-dir variants; production uses `.live()`.
    init(
        serverOrigin: URL,
        database: AppDatabase,
        bundlePaths: BundlePaths,
        keychain: Keychain = Keychain(),
        settings: AppSettings = AppSettings(),
        gates: FeatureGates = .current
    ) {
        self.serverOrigin = serverOrigin
        self.database = database
        self.bundlePaths = bundlePaths
        self.keychain = keychain
        self.settings = settings
        self.gates = gates

        let client = GolfAPIClient(baseURL: serverOrigin)
        self.client = client
        let downloader = BundleDownloader(database: database, paths: bundlePaths)
        self.downloader = downloader
        self.syncService = SyncService(client: client, downloader: downloader, serverOrigin: serverOrigin)
        self.roundSync = RoundSyncService(client: client, database: database)
        self.planSync = PlanSyncService(client: client, database: database)
        self.clubSync = ClubSyncService(client: client, database: database)

        // Wire the Keychain into the client's silent re-login hook.
        let kc = keychain
        Task {
            await client.setCredentialsProvider {
                kc.load().map { (username: $0.username, password: $0.password) }
            }
        }
    }

    /// Builds the production environment: on-disk DB, default bundle paths, and
    /// the configured server origin.
    static func live() -> AppEnvironment {
        // A misconfigured on-disk store should not crash launch outright, but in
        // practice these only fail if the filesystem is unwritable — fatalError
        // gives a clear crash rather than a silently broken app.
        do {
            let database = try AppDatabase.onDisk()
            let paths = try BundlePaths.default()
            return AppEnvironment(
                serverOrigin: Self.resolvedServerOrigin(),
                database: database,
                bundlePaths: paths
            )
        } catch {
            fatalError("Failed to initialize on-disk store: \(error)")
        }
    }

    /// Built-in server origin when no `serverOrigin` override is stored.
    ///
    /// A device can never reach the builder Mac's `localhost`, so a phone with
    /// no override has to point somewhere real or the app is dead on first
    /// launch — that's the deployed VPS (path-prefixed; `GolfAPIClient` and
    /// `TileURLBuilder` both join onto the prefix, see `DeployPrefixTests`).
    /// The simulator shares the Mac's loopback, so it keeps the local dev
    /// server: that's where day-to-day development and the headless
    /// live-verify hooks run.
    static let defaultServerOrigin: URL = {
        #if targetEnvironment(simulator)
        return URL(string: "http://localhost:3000")!
        #else
        return URL(string: "https://app.swedenindoorgolf.se/golf-map")!
        #endif
    }()

    /// Resolves the server origin: `UserDefaults["serverOrigin"]` override wins,
    /// else `defaultServerOrigin`.
    static func resolvedServerOrigin() -> URL {
        if let override = UserDefaults.standard.string(forKey: "serverOrigin"),
           let url = URL(string: override) {
            return url
        }
        return defaultServerOrigin
    }

    // MARK: - Bootstrap

    /// Determines the initial auth state on launch:
    /// 1. `GET /api/auth/me` — a persisted session cookie may already work.
    /// 2. On 401, if Keychain credentials exist, try one silent login.
    /// 3. On any transport/network failure, drop to `.offline` (local bundles
    ///    stay usable).
    func bootstrap() async {
        isBootstrapping = true
        defer { isBootstrapping = false }

        #if DEBUG
        // Headless live-verify hook: `-seedKeychain user:pass` seeds the
        // Keychain so bootstrap exercises the real server login path without UI
        // typing (which needs macOS accessibility automation, unavailable in
        // headless CI). DEBUG-only and inert without the flag.
        if let seed = UserDefaults.standard.string(forKey: "seedKeychain"),
           let sep = seed.firstIndex(of: ":") {
            keychain.save(.init(
                username: String(seed[..<sep]),
                password: String(seed[seed.index(after: sep)...])
            ))
        }
        #endif

        do {
            let user = try await client.me()
            authState = .loggedIn(user)
        } catch APIError.unauthorized {
            // Session cookie missing/expired. Try stored credentials.
            if let creds = keychain.load() {
                do {
                    let user = try await client.login(username: creds.username, password: creds.password)
                    authState = .loggedIn(user)
                } catch APIError.unauthorized {
                    // Stored creds are stale — force a fresh login.
                    keychain.clear()
                    authState = .loggedOut
                } catch {
                    // Login failed for a non-auth reason (network) → offline.
                    authState = .offline
                }
            } else {
                authState = .loggedOut
            }
        } catch {
            // Transport / non-HTTP error → server unreachable → offline mode.
            authState = .offline
        }
    }

    // MARK: - Auth actions

    /// Logs in with the given credentials, saving them to the Keychain on
    /// success. Rethrows the API error on failure (the login screen displays it).
    func login(username: String, password: String) async throws {
        let user = try await client.login(username: username, password: password)
        keychain.save(.init(username: username, password: password))
        authState = .loggedIn(user)
    }

    /// Logs out: clears the server session (best-effort), wipes stored
    /// credentials, and returns to the login screen.
    func logout() async {
        try? await client.logout()
        keychain.clear()
        authState = .loggedOut
    }

    /// Retries bootstrap — used by the offline screen's "Retry" affordance.
    func retryConnection() async {
        await bootstrap()
    }
}
