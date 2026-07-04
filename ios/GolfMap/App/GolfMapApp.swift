import SwiftUI

@main
struct GolfMapApp: App {
    @State private var appEnvironment = AppEnvironment.live()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appEnvironment)
        }
    }
}
