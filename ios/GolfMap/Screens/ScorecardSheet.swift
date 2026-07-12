import SwiftUI

/// The scorecard sheet: per-hole strokes / putts / penalties / vs-par with
/// front / back / total summaries, plus the round lifecycle controls
/// (start / finish). Non-modal like the elevation profile — the map stays
/// live underneath so the card can be checked mid-hole.
///
/// Tapping a played hole drills into its stroke list, where each stroke's
/// club / type / penalties can be edited (or the stroke deleted) after the
/// fact — local edits that queue for sync like fresh captures.
struct ScorecardSheet: View {
    let roundModel: RoundModel
    /// The cached bag (club names for the stroke editor).
    let clubs: [ClubRecord]
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if roundModel.hasActiveRound {
                    scorecardList
                } else {
                    noRoundView
                }
            }
            .navigationTitle("Scorecard")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: onClose) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityLabel("Close scorecard")
                }
            }
        }
        .environment(\.colorScheme, .dark)
        .presentationDetents([.medium, .large])
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        .presentationDragIndicator(.visible)
        .presentationBackground(.thinMaterial)
    }

    // MARK: - No active round

    private var noRoundView: some View {
        VStack(spacing: 14) {
            ContentUnavailableView(
                "No active round",
                systemImage: "square.grid.3x3.topleft.filled",
                description: Text("Start a round to record strokes — the capture button also starts one automatically.")
            )
            Button {
                Task { await roundModel.startRound() }
            } label: {
                Label("Start round", systemImage: "play.fill")
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
                    .background(CapturePanel.rose.opacity(0.85), in: Capsule())
                    .foregroundStyle(.black)
            }
            .buttonStyle(.plain)
        }
        .padding(.bottom, 24)
    }

    // MARK: - Scorecard

    private var scorecardList: some View {
        let card = roundModel.scorecard
        return List {
            Section {
                ForEach(card.lines) { line in
                    if line.played {
                        NavigationLink {
                            HoleStrokesView(
                                roundModel: roundModel,
                                clubs: clubs,
                                holeNumber: line.holeNumber
                            )
                        } label: {
                            holeRow(line)
                        }
                    } else {
                        holeRow(line)
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                holeHeader
            }

            Section("Summary") {
                summaryRow("Front 9", card.front)
                summaryRow("Back 9", card.back)
                summaryRow("Total", card.total)
            }

            Section {
                Button(role: .destructive) {
                    Task { await roundModel.finishRound() }
                } label: {
                    Label("Finish round", systemImage: "flag.checkered")
                }
            }
        }
        .scrollContentBackground(.hidden)
    }

    private var holeHeader: some View {
        HStack {
            Text("Hole").frame(width: 44, alignment: .leading)
            Text("Par").frame(width: 34, alignment: .trailing)
            Spacer()
            Text("Str").frame(width: 34, alignment: .trailing)
            Text("Putt").frame(width: 38, alignment: .trailing)
            Text("Pen").frame(width: 34, alignment: .trailing)
            Text("±").frame(width: 34, alignment: .trailing)
        }
        .font(.caption2)
    }

    private func holeRow(_ line: Scorecard.HoleLine) -> some View {
        HStack {
            Text("\(line.holeNumber)")
                .font(.subheadline.weight(.semibold))
                .frame(width: 44, alignment: .leading)
            Text("\(line.par)")
                .frame(width: 34, alignment: .trailing)
            Spacer()
            Text(line.played ? "\(line.score)" : "–")
                .fontWeight(.semibold)
                .frame(width: 34, alignment: .trailing)
            Text(line.played ? "\(line.putts)" : "–")
                .frame(width: 38, alignment: .trailing)
            Text(line.played ? "\(line.penalties)" : "–")
                .frame(width: 34, alignment: .trailing)
            Text(Scorecard.formatVsPar(line.vsPar))
                .foregroundStyle(vsParColor(line.vsPar))
                .fontWeight(.semibold)
                .frame(width: 34, alignment: .trailing)
        }
        .font(.subheadline)
        .monospacedDigit()
    }

    private func summaryRow(_ label: String, _ summary: Scorecard.Summary) -> some View {
        HStack {
            Text(label)
                .font(.subheadline.weight(.semibold))
            Spacer()
            Text("\(summary.score)")
                .fontWeight(.semibold)
                .frame(width: 34, alignment: .trailing)
            Text("\(summary.putts)")
                .frame(width: 38, alignment: .trailing)
            Text("\(summary.penalties)")
                .frame(width: 34, alignment: .trailing)
            Text(Scorecard.formatVsPar(summary.vsPar))
                .foregroundStyle(vsParColor(summary.vsPar))
                .fontWeight(.semibold)
                .frame(width: 34, alignment: .trailing)
        }
        .font(.subheadline)
        .monospacedDigit()
    }

    private func vsParColor(_ vsPar: Int?) -> Color {
        guard let vsPar else { return .secondary }
        if vsPar < 0 { return .green }
        if vsPar == 0 { return .primary }
        return .orange
    }
}

// MARK: - Per-hole stroke editor

/// One hole's strokes: edit club / type / penalties, or delete a stroke.
/// Every change is a local write that queues for sync.
private struct HoleStrokesView: View {
    let roundModel: RoundModel
    let clubs: [ClubRecord]
    let holeNumber: Int

    var body: some View {
        List {
            ForEach(roundModel.strokes(holeNumber: holeNumber)) { shot in
                strokeRow(shot)
            }
        }
        .scrollContentBackground(.hidden)
        .navigationTitle("Hole \(holeNumber)")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func strokeRow(_ shot: ShotRecord) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Stroke \(shot.sortOrder + 1)")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if shot.penaltyStrokes > 0 {
                    Text("+\(shot.penaltyStrokes) pen")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                }
            }
            HStack(spacing: 8) {
                clubMenu(shot)
                typeMenu(shot)
                Spacer()
                penaltyStepper(shot)
            }
        }
        .swipeActions {
            Button(role: .destructive) {
                Task { await roundModel.deleteStroke(id: shot.id) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private func clubMenu(_ shot: ShotRecord) -> some View {
        Menu {
            Picker("Club", selection: Binding(
                get: { shot.clubId ?? "" },
                set: { newValue in
                    Task {
                        await roundModel.updateStroke(
                            id: shot.id,
                            clubId: .some(newValue.isEmpty ? nil : newValue)
                        )
                    }
                }
            )) {
                Text("No club").tag("")
                ForEach(clubs, id: \.id) { club in
                    Text(club.name).tag(club.id)
                }
            }
        } label: {
            chip(clubs.first(where: { $0.id == shot.clubId })?.name ?? "No club")
        }
        .buttonStyle(.plain)
    }

    private func typeMenu(_ shot: ShotRecord) -> some View {
        Menu {
            Picker("Type", selection: Binding(
                get: { shot.shotType },
                set: { newValue in
                    Task { await roundModel.updateStroke(id: shot.id, shotType: newValue) }
                }
            )) {
                ForEach(ShotType.allCases, id: \.self) { type in
                    Text(type.label).tag(type)
                }
            }
        } label: {
            chip(shot.shotType.label)
        }
        .buttonStyle(.plain)
    }

    private func penaltyStepper(_ shot: ShotRecord) -> some View {
        HStack(spacing: 6) {
            Button {
                Task {
                    await roundModel.updateStroke(
                        id: shot.id, penaltyStrokes: shot.penaltyStrokes - 1
                    )
                }
            } label: {
                Image(systemName: "minus.circle")
            }
            .buttonStyle(.plain)
            .disabled(shot.penaltyStrokes == 0)
            .accessibilityLabel("Remove a penalty stroke")
            Text("Pen \(shot.penaltyStrokes)")
                .font(.caption)
                .monospacedDigit()
            Button {
                Task {
                    await roundModel.updateStroke(
                        id: shot.id, penaltyStrokes: shot.penaltyStrokes + 1
                    )
                }
            } label: {
                Image(systemName: "plus.circle")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add a penalty stroke")
        }
        .foregroundStyle(.secondary)
    }

    private func chip(_ text: String) -> some View {
        HStack(spacing: 4) {
            Text(text)
                .font(.caption.weight(.medium))
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 8))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(.white.opacity(0.08), in: Capsule())
    }
}
