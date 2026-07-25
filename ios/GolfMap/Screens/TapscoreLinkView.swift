import SwiftUI

/// One row for the scorecard's list: the round's Tapscore link at a glance,
/// drilling into `TapscoreLinkView` to change it.
struct TapscoreLinkRow: View {
    let model: TapscoreLinkModel

    var body: some View {
        NavigationLink {
            TapscoreLinkView(model: model)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: iconName)
                    .foregroundStyle(iconColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Tapscore")
                        .font(.subheadline.weight(.semibold))
                    Text(TapscoreLinkView.summary(for: model.state))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var iconName: String {
        if case .linked = model.state { return "link.circle.fill" }
        return "link.circle"
    }

    private var iconColor: Color {
        if case .linked = model.state { return Color.statusPositive }
        return .secondary
    }
}

/// Manage the round's link to a Tapscore friendly round.
///
/// The UI does exactly two things — link and unlink. Publishing is the server's
/// job: once the round carries a share token, every shot write pushes that
/// hole's gross score into Tapscore automatically and off the write path
/// (docs/feature-tapscore-bridge.md §3.2). Hence "scores syncing" rather than
/// any sync button — there is nothing here to press.
struct TapscoreLinkView: View {
    let model: TapscoreLinkModel

    @State private var code = ""
    @State private var ballId = ""
    @FocusState private var codeFocused: Bool

    var body: some View {
        List {
            statusSection
            switch model.state {
            case .linked:
                unlinkSection
            case .unlinked:
                linkSection
            case .roundNotSynced:
                notSyncedSection
            case .noActiveRound:
                EmptyView()
            }
            if let failure = model.failure {
                Section {
                    Label(Self.failureText(failure, hasBallPicker: !model.ballChoices.isEmpty),
                          systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(Color.statusNegative)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .navigationTitle("Tapscore")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.refresh() }
    }

    // MARK: - Sections

    private var statusSection: some View {
        Section {
            HStack {
                Text(Self.summary(for: model.state))
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if model.isBusy { ProgressView() }
            }
            if case let .linked(ballId) = model.state, let ballId, !ballId.isEmpty {
                LabeledContent("Ball", value: ballId)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Status")
        } footer: {
            Text(Self.footer(for: model.state))
        }
    }

    private var linkSection: some View {
        Section {
            TextField("Share code or link", text: $code)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .submitLabel(.go)
                .focused($codeFocused)
                .accessibilityLabel("Tapscore share code")
                .onChange(of: code) { _, _ in
                    guard model.needsBallChoice else { return }
                    // The roster — and any ball picked from it — belong to the
                    // code that was on screen a moment ago.
                    model.clearBallChoice()
                    ballId = ""
                }

            // Only asked for when the server said the round has several
            // claimed balls. The roster fetched after that 409 turns the
            // question into a pick; the free-text field survives only as the
            // fallback for a failed roster fetch.
            if model.needsBallChoice {
                if model.ballChoices.isEmpty {
                    TextField("Ball ID (from Tapscore)", text: $ballId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityLabel("Tapscore ball ID")
                } else {
                    Picker("Player", selection: $ballId) {
                        Text("Choose…").tag("")
                        ForEach(model.ballChoices) { ball in
                            Text(ball.label ?? ball.id).tag(ball.id)
                        }
                    }
                    .accessibilityLabel("Tapscore player")
                }
            }

            Button {
                codeFocused = false
                Task { await model.link(rawToken: code, ballId: ballId) }
            } label: {
                Label("Link round", systemImage: "link")
            }
            .disabled(
                model.isBusy
                    || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || (model.needsBallChoice && !model.ballChoices.isEmpty && ballId.isEmpty)
            )
        } header: {
            Text("Link this round")
        } footer: {
            Text("Paste the Tapscore round's share link. Scores publish automatically from then on — this needs a connection once.")
        }
    }

    private var unlinkSection: some View {
        Section {
            Button(role: .destructive) {
                Task { await model.unlink() }
            } label: {
                Label("Unlink", systemImage: "link.badge.plus")
            }
            .disabled(model.isBusy)
        } footer: {
            Text("Unlinking stops further publishing. Scores already in Tapscore stay there.")
        }
    }

    private var notSyncedSection: some View {
        Section {
            Label(
                "This round is still only on your phone.",
                systemImage: "iphone.and.arrow.forward"
            )
            .font(.footnote)
        } footer: {
            Text("Rounds upload by themselves once you're back online — then you can link.")
        }
    }

    // MARK: - Copy

    /// The failure banner. `TapscoreLinkFailure.message` tells the player to
    /// enter a ball ID — right only when the roster fetch failed and the
    /// free-text fallback is showing. With the picker on screen, the remedy is
    /// the picker.
    static func failureText(_ failure: TapscoreLinkFailure, hasBallPicker: Bool) -> String {
        if case .ambiguousBall = failure, hasBallPicker {
            return "That Tapscore round has more than one player. Pick whose scorecard your shots update."
        }
        return failure.message
    }

    static func summary(for state: TapscoreLinkModel.State) -> String {
        switch state {
        case .noActiveRound: return "No active round"
        case .roundNotSynced: return "Waiting to reach the server"
        case .unlinked: return "Not linked"
        case .linked: return "Linked · scores syncing"
        }
    }

    static func footer(for state: TapscoreLinkModel.State) -> String {
        switch state {
        case .noActiveRound:
            return "Start a round to publish scores to Tapscore."
        case .roundNotSynced:
            return "Linking needs the round on the server first."
        case .unlinked:
            return "This round isn't publishing to Tapscore."
        case .linked:
            return "Every stroke you record updates this hole's score in Tapscore."
        }
    }
}
