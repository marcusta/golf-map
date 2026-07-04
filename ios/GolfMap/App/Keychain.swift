import Foundation
import Security

/// Minimal Keychain wrapper for storing the single set of server credentials
/// used to silently re-login (feeds `GolfAPIClient.credentialsProvider`).
///
/// Stores a `kSecClassGenericPassword` item keyed by `service` + `account`
/// ("username"), with the password bytes as the secret. The username is kept in
/// the `account` attribute so a single query round-trips both fields.
///
/// This is a personal tool with one login, so the design is deliberately small:
/// one credential slot, overwrite-on-save, wipe-on-clear.
struct Keychain: Sendable {
    /// Username + password pair persisted for auto re-login.
    struct Credentials: Sendable, Equatable {
        let username: String
        let password: String
    }

    /// Keychain service string namespacing all items for this app.
    let service: String

    init(service: String = "com.marcusandersson.golfmap.credentials") {
        self.service = service
    }

    /// Stores (or replaces) the single credential slot. Any previously stored
    /// credential is removed first so at most one item ever exists.
    func save(_ credentials: Credentials) {
        clear()
        guard let passwordData = credentials.password.data(using: .utf8) else { return }
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: credentials.username,
            kSecValueData as String: passwordData,
            // Available after first unlock; survives reboots, never syncs.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        SecItemAdd(attributes as CFDictionary, nil)
    }

    /// Loads the stored credential, or nil if none is present.
    func load() -> Credentials? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let result = item as? [String: Any],
              let username = result[kSecAttrAccount as String] as? String,
              let passwordData = result[kSecValueData as String] as? Data,
              let password = String(data: passwordData, encoding: .utf8)
        else { return nil }
        return Credentials(username: username, password: password)
    }

    /// Removes every credential item for this service.
    func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
