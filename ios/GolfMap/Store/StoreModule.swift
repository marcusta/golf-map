import GRDB

/// Placeholder for the on-device course bundle store (GRDB/SQLite).
enum StoreModule {
    /// Referencing a GRDB type proves the package links, not just resolves.
    static func linkedDatabaseQueueType() -> DatabaseQueue.Type {
        DatabaseQueue.self
    }
}
