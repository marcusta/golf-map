import SwiftUI

@main
struct GolfMapApp: App {
    @State private var appEnvironment = AppEnvironment.live()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appEnvironment)
                // Retry the offline capture queue whenever the app becomes
                // active (covers cold start AND return from background —
                // connectivity often changed while away). Best-effort; a
                // failed flush just waits for the next trigger.
                .onChange(of: scenePhase, initial: true) { _, phase in
                    guard phase == .active else { return }
                    let sync = appEnvironment.roundSync
                    Task { await sync.flush() }
                }
        }
    }
}
