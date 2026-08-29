import SwiftUI

/// Bottom card while the PLANNER tool is active (replaces the distance card,
/// like the measure/adjust/capture panels). Edits the course's game plan for
/// the current hole:
///  - **Add at aim**: pan the reticle to the landing spot, then tap to drop
///    a point there (auto-clubbed) — same cursor as distance mode.
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
                Text("Pan the map to aim, then tap “Add at aim” to place a landing point.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                caddySection
                aimingFromTag
                shotList(rows)
                if model.selectedShotHasRecommendedAim {
                    applyAimButton
                }
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

    /// Ranked smart-caddy advice for the plan (top items). Hidden when there is
    /// none (competition mode, or no rule fired). Mirrors the Green view's caddy
    /// hint styling.
    @ViewBuilder private var caddySection: some View {
        let advice = model.planCaddyAdvice
        if !advice.isEmpty {
            VStack(spacing: 6) {
                ForEach(Array(advice.prefix(2).enumerated()), id: \.offset) { pair in
                    caddyAdviceRow(pair.element)
                }
            }
        }
    }

    private func caddyAdviceRow(_ advice: CaddyAdvice) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "figure.golf")
                .font(.footnote)
                .foregroundStyle(.green)
            VStack(alignment: .leading, spacing: 2) {
                Text(advice.headline)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.primary)
                if let detail = advice.detail {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.green.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
    }

    /// Snap the selected shot onto the caddy's recommended aim line.
    private var applyAimButton: some View {
        Button {
            model.applyRecommendedAimForSelectedShot()
        } label: {
            Label("Apply recommended aim", systemImage: "scope")
                .font(.footnote.weight(.medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(Self.violet.opacity(0.2), in: Capsule())
                .foregroundStyle(Self.violet)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Apply the caddy's recommended aim to the selected shot")
    }

    /// Where the reticle measures from — the selected shot (or tee). Makes the
    /// selection-scoped reticle origin visible instead of "why is the cursor
    /// anchored on P3?".
    @ViewBuilder private var aimingFromTag: some View {
        if let origin = model.planPlacementOriginLabel {
            HStack(spacing: 5) {
                Image(systemName: "scope")
                    .font(.system(size: 10))
                Text("Aiming from \(origin)")
                    .font(.caption2.weight(.medium))
            }
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel("The aim reticle measures from \(origin)")
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Label("Plan · H\(model.currentHoleNumber)", systemImage: "signpost.right.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Self.violet)
            Spacer()
            addOptionButton
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
            model.addPlanShotAtReticle()
        } label: {
            Label("Add at aim", systemImage: "plus.circle")
                .font(.footnote.weight(.medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.white.opacity(0.08), in: Capsule())
                .foregroundStyle(Color.primary)
        }
        .buttonStyle(.plain)
        .disabled(model.reticleTarget == nil)
        .accessibilityLabel("Add a plan shot at the aim point")
    }

    /// Places a SIBLING of the selected shot at the aim point — an alternative
    /// option for the same decision (same parent), not a continuation. Only
    /// shown while a shot is selected; the tee default has no sibling group.
    @ViewBuilder private var addOptionButton: some View {
        if model.selectedPlanShotId != nil {
            Button {
                model.addPlanOptionAtReticle()
            } label: {
                Label("Add option", systemImage: "arrow.triangle.branch")
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(.white.opacity(0.08), in: Capsule())
                    .foregroundStyle(Color.primary)
            }
            .buttonStyle(.plain)
            .disabled(model.reticleTarget == nil)
            .accessibilityLabel("Add an alternative option at the aim point")
        }
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
            Text(row.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(row.isBranch ? Self.violet.opacity(0.6) : Self.violet)
                .frame(minWidth: 26, alignment: .leading)
            clubMenu(row)
            advisedClubChip(row)
            Spacer()
            MetricText(DistanceFormat.string(row.meters, unit: unit), unit: unit.abbreviation, size: 14)
            if row.canMakePrimary {
                Button {
                    model.setPrimaryPlanShot(id: row.shotId)
                } label: {
                    Image(systemName: "star")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Make \(row.label) the primary option")
            }
            Button {
                // Branch trash removes the whole option (cascade); a primary-
                // line trash splices the shot out and keeps its continuation.
                if row.isBranch {
                    model.removePlanBranch(id: row.shotId)
                } else {
                    model.removePlanShot(id: row.shotId)
                }
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(row.isBranch
                ? "Remove option \(row.label) and its continuation"
                : "Remove shot \(row.label)")
        }
        .padding(.leading, row.isBranch ? 20 : 8)
        .padding(.trailing, 8)
        .padding(.vertical, 5)
        .background(
            (selected ? Self.violet.opacity(0.16) : .white.opacity(0.05)),
            in: RoundedRectangle(cornerRadius: 10)
        )
        .contentShape(Rectangle())
        .onTapGesture { model.selectPlanShot(handleID: OnCourseModel.planShotHandleID(row.shotId)) }
    }

    /// One-tap "use advised club" chip — shown only when the wind + plays-like
    /// fit for this shot's reaching leg differs from its current club. Applying
    /// it sets the shot's club (and redraws the dispersion ellipse).
    @ViewBuilder private func advisedClubChip(_ row: OnCourseModel.PlanEditRow) -> some View {
        if let advised = model.advisedClub(forShotId: row.shotId), advised.id != row.clubId {
            Button {
                model.setPlanShotClub(shotId: row.shotId, clubId: advised.id)
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "wand.and.stars")
                        .font(.system(size: 9))
                    Text(advised.name)
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 5)
                .background(.green.opacity(0.18), in: Capsule())
                .foregroundStyle(.green)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Use advised club \(advised.name) for shot \(row.label)")
        }
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
        .accessibilityLabel("Club for shot \(row.label): \(row.clubName ?? "none")")
    }
}
