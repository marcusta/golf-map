import SwiftUI

/// Bottom card while shot-capture is active (replaces the distance card,
/// like the measure/adjust panels). One-hand flow:
///  - crosshair already sits at the GPS fix (drag on the map to adjust);
///  - club is pre-selected, shot type auto — both overridable via compact
///    menus;
///  - the target is pre-filled (pin ?? plan ?? green center); "Aim" reveals
///    the optional secondary drag handle;
///  - **Confirm = one tap**, hole-out = one tap. After confirm the panel
///    shows the saved stroke with a "+1 penalty" stepper, then re-arms.
struct CapturePanel: View {
    let capture: CaptureModel
    let holeNumber: Int
    /// Strokes already recorded on this hole (ordinal of the NEXT stroke).
    let strokesSoFar: Int
    let onConfirm: () -> Void
    let onHoleOut: () -> Void
    let onPenalty: () -> Void
    let onNextStroke: () -> Void
    let onClose: () -> Void

    /// Capture rose — matches the crosshair ring on the map.
    static let rose = Color(red: 0.984, green: 0.443, blue: 0.522)

    var body: some View {
        VStack(spacing: 10) {
            header
            if capture.phase == .confirmed {
                confirmedContent
            } else {
                aimingContent
            }
        }
        .padding(.horizontal, Space.s4)
        .padding(.top, Space.s3)
        .padding(.bottom, Space.s3)
        .glassPanel()
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Label("Stroke \(strokesSoFar + (capture.phase == .confirmed ? 0 : 1)) · H\(holeNumber)",
                  systemImage: "plus.viewfinder")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Self.rose)
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Exit shot capture")
        }
    }

    // MARK: - Aiming

    private var aimingContent: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                clubMenu
                typeMenu
                Spacer()
                if let remaining = capture.remainingMeters {
                    MetricText("\(remaining)", unit: "m", size: 20)
                        .accessibilityLabel("\(remaining) meters to target")
                }
                targetToggle
            }
            HStack(spacing: 10) {
                Button(action: onConfirm) {
                    Label("Confirm", systemImage: "checkmark")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Self.rose.opacity(0.85), in: Capsule())
                        .foregroundStyle(.black)
                }
                .buttonStyle(.plain)
                .disabled(capture.position == nil)
                .accessibilityLabel("Confirm stroke")

                Button(action: onHoleOut) {
                    Label("Hole out", systemImage: "flag.checkered")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        .background(.white.opacity(0.1), in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(capture.position == nil)
                .accessibilityLabel("Hole out with final putt")
            }
            Text("Drag the crosshair to where you play from. Confirm writes the stroke.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Compact club picker: the pre-selected club (auto) or the override.
    private var clubMenu: some View {
        Menu {
            Picker("Club", selection: Binding(
                get: { capture.clubId ?? "" },
                set: { capture.overrideClub(id: $0.isEmpty ? nil : $0) }
            )) {
                Text("No club").tag("")
                ForEach(capture.availableClubs, id: \.id) { club in
                    Text(club.name).tag(club.id)
                }
            }
            if capture.clubIsOverridden {
                Button("Back to auto") { capture.overrideClub(id: nil) }
            }
        } label: {
            chipLabel(
                icon: "bag.fill",
                text: capture.clubName ?? "No club",
                marker: capture.clubIsOverridden ? nil : "~"
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Club: \(capture.clubName ?? "none")")
    }

    /// Compact shot-type picker: auto putt/full, overridable to any type.
    private var typeMenu: some View {
        Menu {
            Picker("Type", selection: Binding(
                get: { capture.shotType },
                set: { capture.overrideShotType($0) }
            )) {
                ForEach(ShotType.allCases, id: \.self) { type in
                    Text(type.label).tag(type)
                }
            }
            if capture.shotTypeIsOverridden {
                Button("Back to auto") { capture.overrideShotType(nil) }
            }
        } label: {
            chipLabel(
                icon: capture.shotType == .putt ? "circle.dotted.circle" : "figure.golf",
                text: capture.shotType.label,
                marker: capture.shotTypeIsOverridden ? nil : "~"
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Shot type: \(capture.shotType.label)")
    }

    /// Reveals the optional target drag handle (zero-tap common case).
    private var targetToggle: some View {
        Button {
            capture.toggleTargetHandle()
        } label: {
            Image(systemName: capture.targetHandleVisible ? "scope" : "scope")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(capture.targetHandleVisible ? Color(red: 1.0, green: 0.83, blue: 0.23) : .secondary)
                .frame(width: 34, height: 34)
                .background(.white.opacity(0.08), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(capture.targetHandleVisible ? "Hide target handle" : "Adjust target")
    }

    private func chipLabel(icon: String, text: String, marker: String?) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text("\(marker ?? "")\(text)")
                .font(.caption.weight(.medium))
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 8))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(.white.opacity(0.08), in: Capsule())
    }

    // MARK: - Confirmed

    private var confirmedContent: some View {
        VStack(spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                Text(confirmedSummary)
                    .font(.footnote.weight(.medium))
                Spacer()
            }
            HStack(spacing: 10) {
                Button(action: onPenalty) {
                    Label(penaltyLabel, systemImage: "exclamationmark.triangle")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(.white.opacity(0.1), in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add one penalty stroke to the last stroke")

                Button(action: onNextStroke) {
                    Label("Next stroke", systemImage: "plus.viewfinder")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Self.rose.opacity(0.85), in: Capsule())
                        .foregroundStyle(.black)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Arm the next stroke")
            }
        }
    }

    private var confirmedSummary: String {
        guard let shot = capture.lastConfirmed else { return "Stroke saved" }
        var parts = ["Stroke \(shot.sortOrder + 1) saved", shot.shotType.label]
        if let club = capture.availableClubs.first(where: { $0.id == shot.clubId })?.name {
            parts.insert(club, at: 1)
        }
        if shot.penaltyStrokes > 0 {
            parts.append("+\(shot.penaltyStrokes) pen")
        }
        return parts.joined(separator: " · ")
    }

    private var penaltyLabel: String {
        let count = capture.lastConfirmed?.penaltyStrokes ?? 0
        return count > 0 ? "+1 penalty (\(count))" : "+1 penalty"
    }
}
