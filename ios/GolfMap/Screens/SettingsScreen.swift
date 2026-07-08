import SwiftUI

/// App preferences sheet, reached from the course-list account menu. Currently
/// hosts the app-level competition-mode toggle; the natural home for future
/// preferences (units, stimp default, …).
struct SettingsScreen: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    // `@Bindable` on the observable settings gives a two-way
                    // binding straight to the persisted property.
                    @Bindable var settings = env.settings
                    Toggle(isOn: $settings.competitionMode) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Competition mode — distances only")
                            Text("Hides slope-adjusted (plays-like) numbers and live green reads. Straight distances stay, keeping the app legal under the distance-measuring-device local rule.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Play")
                } footer: {
                    Text("Turn on for tournament rounds where slope information isn't allowed.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
