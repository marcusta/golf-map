import SwiftUI

/// Top-level view that switches on `AppEnvironment.authState`. Runs bootstrap
/// on first appearance to resolve the initial state (session cookie → Keychain
/// → offline).
struct RootView: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        Group {
            if env.isBootstrapping {
                bootstrapping
            } else {
                switch env.authState {
                case .loggedOut:
                    LoginScreen()
                case .loggedIn:
                    CourseListScreen()
                case .offline:
                    // Offline: local bundles remain usable, so go straight to the
                    // course list (it falls back to a local-only list).
                    CourseListScreen()
                }
            }
        }
        .task { await env.bootstrap() }
    }

    private var bootstrapping: some View {
        VStack(spacing: 16) {
            Image(systemName: "flag.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(.green)
            ProgressView()
        }
    }
}
