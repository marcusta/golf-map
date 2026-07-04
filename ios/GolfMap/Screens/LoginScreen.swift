import SwiftUI

/// Username / password login form. On success, `AppEnvironment.login` saves the
/// credentials to the Keychain and flips `authState` to `.loggedIn`, which the
/// root view observes to swap in the course list.
struct LoginScreen: View {
    @Environment(AppEnvironment.self) private var env

    @State private var username = ""
    @State private var password = ""
    @State private var errorMessage: String?
    @State private var isSubmitting = false

    @FocusState private var focusedField: Field?
    private enum Field { case username, password }

    private var canSubmit: Bool {
        !username.isEmpty && !password.isEmpty && !isSubmitting
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Username", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .username)
                        .submitLabel(.next)
                        .onSubmit { focusedField = .password }

                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .focused($focusedField, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { submit() }
                } header: {
                    Text("Server login")
                } footer: {
                    if let errorMessage {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button(action: submit) {
                        HStack {
                            Spacer()
                            if isSubmitting {
                                ProgressView()
                            } else {
                                Text("Log in").bold()
                            }
                            Spacer()
                        }
                    }
                    .disabled(!canSubmit)
                }
            }
            .navigationTitle("GolfMap")
            .onAppear { focusedField = .username }
        }
    }

    private func submit() {
        guard canSubmit else { return }
        isSubmitting = true
        errorMessage = nil
        Task {
            defer { isSubmitting = false }
            do {
                try await env.login(username: username, password: password)
            } catch let APIError.http(_, message) {
                errorMessage = message ?? "Login failed."
            } catch APIError.unauthorized {
                errorMessage = "Incorrect username or password."
            } catch let APIError.transport(detail) {
                errorMessage = "Cannot reach the server. \(detail)"
            } catch {
                errorMessage = "Login failed: \(error.localizedDescription)"
            }
        }
    }
}
