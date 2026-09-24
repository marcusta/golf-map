import SwiftUI

/// Top-level view that switches on `AppEnvironment.authState`. Runs bootstrap
/// on first appearance to resolve the initial state (session cookie → Keychain
/// → offline).
struct RootView: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        Group {
            #if DEBUG
            // Headless live-verify hook: `-photoCaptureSite <siteId>` opens the
            // reference-photo capture screen without a login or a downloaded
            // course. DEBUG-only and inert without the flag.
            if let siteId = UserDefaults.standard.string(forKey: "photoCaptureSite") {
                PhotoCaptureScreen(siteId: siteId, courseId: nil, holeLines: [], onClose: {})
            } else {
                authRoot
            }
            #else
            authRoot
            #endif
        }
        .task { await env.bootstrap() }
    }

    @ViewBuilder
    private var authRoot: some View {
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
