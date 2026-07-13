import SwiftUI

/// Bottom card while the PLANNER tool is active (replaces the distance card,
/// like the measure/adjust/capture panels). Edits the course's game plan for
/// the current hole:
///  - **Add shot**: arm, then tap the map to drop a landing point (auto-clubbed).
///  - **Drag**: move the `P1`, `P2`… handles on the map (persists on release).
///  - **Per-shot club**: a compact picker over the cached bag.
///  - **Remove**: a trash button per row.
///
/// Gates and hole-level fields stay view-only in this task. Edits write through
/// the model's `planWriter` (GRDB dirty row + `PlanSyncService`), offline-first.
struct PlanPanel: View {
    let model: OnCourseModel
    let onClose: () -> Void
    @Environment(AppEnvironment.self) private var env

    /// Plan violet — matches the map overlay + plan-shot handles (#a78bfa).
    static let violet = Color(red: 0.655, green: 0.545, blue: 0.98)

    private var unit: DistanceUnit { env.settings.distanceUnit }

    var body: some View {
        VStack(spacing: 10) {
            header
            let rows = model.planEditRows
            if rows.isEmpty {
                Text(model.isAddingPlanShot
                     ? "Tap the map to place a landing point."
                     : "Tap “Add shot”, then tap the map to place a landing point.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                shotList(rows)
                Text("Drag a P-handle on the map to move a shot. Edits save on this device and sync when online.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, Space.s4)
        .padding(.top, Space.s3)
        .padding(.bottom, Space.s3)
        .glassPanel()
    }

    private var header: some View {
        HStack(spacing: 10) {
            Label("Plan · H\(model.currentHoleNumber)", systemImage: "signpost.right.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Self.violet)
            Spacer()
            addShotButton
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Exit plan editing")
        }
    }

    private var addShotButton: some View {
        Button {
            model.setAddingPlanShot(!model.isAddingPlanShot)
        } label: {
            Label(model.isAddingPlanShot ? "Tap map…" : "Add shot",
                  systemImage: model.isAddingPlanShot ? "hand.tap" : "plus.circle")
                .font(.footnote.weight(.medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    (model.isAddingPlanShot ? Self.violet.opacity(0.28) : .white.opacity(0.08)),
                    in: Capsule()
                )
                .foregroundStyle(model.isAddingPlanShot ? Self.violet : Color.primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(model.isAddingPlanShot ? "Cancel adding a shot" : "Add a plan shot")
    }

    private func shotList(_ rows: [OnCourseModel.PlanEditRow]) -> some View {
        VStack(spacing: 6) {
            ForEach(rows) { row in
                shotRow(row)
            }
        }
    }

    private func shotRow(_ row: OnCourseModel.PlanEditRow) -> some View {
        let selected = model.selectedPlanShotId == row.shotId
        return HStack(spacing: 8) {
            Text("P\(row.index)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Self.violet)
                .frame(width: 26)
            clubMenu(row)
            Spacer()
            MetricText(DistanceFormat.string(row.meters, unit: unit), unit: unit.abbreviation, size: 14)
            Button {
                model.removePlanShot(id: row.shotId)
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove shot P\(row.index)")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            (selected ? Self.violet.opacity(0.16) : .white.opacity(0.05)),
            in: RoundedRectangle(cornerRadius: 10)
        )
        .contentShape(Rectangle())
        .onTapGesture { model.selectPlanShot(handleID: OnCourseModel.planShotHandleID(row.shotId)) }
    }

    private func clubMenu(_ row: OnCourseModel.PlanEditRow) -> some View {
        Menu {
            Picker("Club", selection: Binding(
                get: { row.clubId ?? "" },
                set: { model.setPlanShotClub(shotId: row.shotId, clubId: $0.isEmpty ? nil : $0) }
            )) {
                Text("No club").tag("")
                ForEach(model.clubs, id: \.id) { club in
                    Text(club.name).tag(club.id)
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "bag.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(row.clubName ?? "No club")
                    .font(.caption.weight(.medium))
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(.white.opacity(0.08), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Club for shot P\(row.index): \(row.clubName ?? "none")")
    }
}
