import SwiftUI

/// App preferences sheet, reached from the course-list account menu: the
/// app-level competition-mode toggle, on-course distance unit, default putt
/// stimp, and the server-origin override.
struct SettingsScreen: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss

    /// Local text-field buffer, seeded from the persisted override — edits
    /// only take effect (and validate) on commit, not per keystroke.
    @State private var originText: String = ""
    @State private var originError: String?

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
                            Text("Hides slope-adjusted (plays-like) numbers, club advice and live green reads. Straight distances stay, and so does the wind correction — wind comes off a weather report, not a reading of the course.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Play")
                } footer: {
                    Text("Turn on for tournament rounds where slope information isn't allowed.")
                }

                Section {
                    @Bindable var settings = env.settings
                    Picker("Distance unit", selection: $settings.distanceUnit) {
                        ForEach(DistanceUnit.allCases) { unit in
                            Text(unit.label).tag(unit)
                        }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Units")
                } footer: {
                    Text("On-course distances (front/center/back, plays-like, aim points, plan legs, hazard carries, measure, elevation-profile distance) show in this unit. Elevation and slope stay metric — golf convention, not a distance.")
                }

                Section {
                    @Bindable var settings = env.settings
                    HStack {
                        Text("Default stimp")
                        Spacer()
                        Text(String(format: "%.0f ft", settings.defaultStimpFt))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    Slider(
                        value: Binding(
                            get: { settings.defaultStimpFt },
                            set: { settings.defaultStimpFt = $0.rounded() }
                        ),
                        in: PuttReadModel.stimpMinFt...PuttReadModel.stimpMaxFt,
                        step: 1
                    )
                } header: {
                    Text("Putting")
                } footer: {
                    Text("Seeds the green-read stimp the first time you use a putt read. Once you adjust the stimp on a green, that last-used value takes over — this only sets the starting point.")
                }

                Section {
                    TextField(AppEnvironment.defaultServerOrigin.absoluteString, text: $originText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .onSubmit(commitOrigin)
                    if let originError {
                        Text(originError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Server")
                } footer: {
                    Text("Leave blank to use the built-in default (\(AppEnvironment.defaultServerOrigin.absoluteString)). Force-quit and reopen the app to apply a change — switching apps is not enough.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        commitOrigin()
                        dismiss()
                    }
                }
            }
            .onAppear { originText = env.settings.serverOrigin ?? "" }
        }
    }

    private func commitOrigin() {
        if env.settings.setServerOrigin(originText) {
            originError = nil
            // Reflect the normalized form (trailing slash trimmed, …) back
            // into the field.
            originText = env.settings.serverOrigin ?? ""
        } else {
            originError = "Enter a full URL with scheme and host, e.g. http://192.168.1.20:3000."
        }
    }
}
