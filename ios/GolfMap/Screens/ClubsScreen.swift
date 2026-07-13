import SwiftUI

/// Editable club-bag screen — view + edit the player's clubs, synced to the
/// server. Reached from the same account menu as Settings. Mirrors the web
/// club matrix (`web/src/player/player-settings.component.ts`): name / carry /
/// lateral dispersion editable, length dispersion derived + read-only,
/// reorder + delete, and an add-club row. Autosaves on submit/blur with the
/// same client-side validation ranges as web (carry 10-400 m, dispersion
/// 1-100 m); invalid input reverts the field and shows an inline error.
struct ClubsScreen: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var model: ClubsModel?

    @State private var newName = ""
    @State private var newCarryText = ""
    @State private var newDispersionText = ""
    @State private var addError: String?

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    content(model)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Clubs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { EditButton() }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            guard model == nil else { return }
            let writer = ClubEditStore(database: env.database, clubSync: env.clubSync).writer()
            let newModel = ClubsModel(writer: writer)
            if let cached = try? await env.database.allClubs() {
                newModel.setClubs(cached)
            }
            model = newModel
        }
    }

    @ViewBuilder
    private func content(_ model: ClubsModel) -> some View {
        List {
            Section {
                if model.rows.isEmpty {
                    ContentUnavailableView(
                        "No clubs yet",
                        systemImage: "bag",
                        description: Text("Add a club below to start building your bag.")
                    )
                }
                ForEach(model.rows) { row in
                    ClubRowView(model: model, row: row)
                }
                .onDelete { offsets in
                    Task { await model.delete(atOffsets: offsets) }
                }
                .onMove { offsets, destination in
                    Task { await model.move(fromOffsets: offsets, toOffset: destination) }
                }
            } header: {
                Text("Bag")
            } footer: {
                Text("Carry and lateral dispersion are full widths, matching the web planner. Length dispersion is derived from carry and can't be edited directly.")
            }

            Section {
                TextField("Name", text: $newName)
                HStack {
                    TextField("Carry", text: $newCarryText)
                        .keyboardType(.decimalPad)
                    Text("m").font(.caption).foregroundStyle(.secondary)
                }
                HStack {
                    TextField("Lateral dispersion", text: $newDispersionText)
                        .keyboardType(.decimalPad)
                    Text("m").font(.caption).foregroundStyle(.secondary)
                }
                Button("Add club") {
                    Task { await addClub(model) }
                }
                if let addError {
                    Text(addError).font(.footnote).foregroundStyle(.red)
                }
            } header: {
                Text("Add club")
            }
        }
        .listStyle(.insetGrouped)
    }

    private func addClub(_ model: ClubsModel) async {
        let error = await model.addClub(
            name: newName, carryText: newCarryText, dispersionText: newDispersionText
        )
        addError = error
        if error == nil {
            newName = ""
            newCarryText = ""
            newDispersionText = ""
        }
    }
}

/// One bag row: name/carry/dispersion `TextField`s with commit-on-submit-or-
/// blur semantics. Each field has its own local text buffer (seeded from the
/// model, resynced whenever the model's stored value changes — e.g. a
/// validation revert, or a server-driven refresh) so a keystroke never
/// round-trips through the model before the user finishes typing.
private struct ClubRowView: View {
    let model: ClubsModel
    let row: ClubsModel.Row

    @State private var nameText = ""
    @State private var carryText = ""
    @State private var dispersionText = ""
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case name, carry, dispersion }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Name", text: $nameText)
                .font(.headline)
                .focused($focusedField, equals: .name)
                .submitLabel(.done)
                .onSubmit { Task { await model.commitName(id: row.id, text: nameText) } }
            if let error = row.nameError {
                Text(error).font(.caption).foregroundStyle(.red)
            }

            HStack(alignment: .firstTextBaseline) {
                labeledField("Carry", text: $carryText, focus: .carry)
                    .onSubmit { Task { await model.commitCarry(id: row.id, text: carryText) } }
                labeledField("Lateral", text: $dispersionText, focus: .dispersion)
                    .onSubmit { Task { await model.commitDispersion(id: row.id, text: dispersionText) } }
                Spacer()
                VStack(alignment: .trailing, spacing: 0) {
                    Text("Length disp.").font(.caption2).foregroundStyle(.secondary)
                    Text("\(ClubsModel.lengthDispersionText(carryM: row.club.carryM)) m")
                        .font(.footnote)
                        .monospacedDigit()
                }
            }
            if let error = row.carryError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            if let error = row.dispersionError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(.vertical, 4)
        .onAppear { syncBuffers() }
        .onChange(of: row.club) { _, _ in syncBuffers() }
        .onChange(of: focusedField) { old, new in
            guard old != new else { return }
            switch old {
            case .name: Task { await model.commitName(id: row.id, text: nameText) }
            case .carry: Task { await model.commitCarry(id: row.id, text: carryText) }
            case .dispersion: Task { await model.commitDispersion(id: row.id, text: dispersionText) }
            case nil: break
            }
        }
    }

    private func labeledField(_ label: String, text: Binding<String>, focus: Field) -> some View {
        HStack(spacing: 2) {
            TextField(label, text: text)
                .keyboardType(.decimalPad)
                .focused($focusedField, equals: focus)
                .frame(minWidth: 44)
            Text("m").font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func syncBuffers() {
        nameText = row.club.name
        carryText = formatted(row.club.carryM)
        dispersionText = formatted(row.club.dispersionM)
    }

    /// Trims a trailing ".0" so a stored whole number doesn't show a decimal
    /// point the user never typed.
    private func formatted(_ value: Double) -> String {
        value.truncatingRemainder(dividingBy: 1) == 0
            ? String(format: "%.0f", value)
            : String(value)
    }
}
