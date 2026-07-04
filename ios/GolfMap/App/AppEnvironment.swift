import Observation

/// App-wide dependency container, injected via `.environment(_:)` from `GolfMapApp`.
/// Later phases hang the API client, course store, and location service off this.
@MainActor
@Observable
final class AppEnvironment {
    // Placeholder — no dependencies yet.
}
