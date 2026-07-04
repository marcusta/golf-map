import SwiftUI

@main
struct GolfMapApp: App {
    @State private var appEnvironment = AppEnvironment()

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                Text("GolfMap")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
                    .navigationTitle("GolfMap")
            }
            .environment(appEnvironment)
        }
    }
}
