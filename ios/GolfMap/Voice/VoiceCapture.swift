import AVFoundation
import Foundation
import Observation
import Speech

/// Thin `SFSpeechRecognizer` + `AVAudioEngine` wrapper that captures a short
/// spoken pin phrase entirely **on-device** (task L2, doc §4.1). All parsing
/// lives in `PinPhraseParser` (pure, golden-tested); this layer just adapts the
/// microphone + recognizer into an observable live transcript and hands the
/// final text back to the confirm UI.
///
/// **Offline by construction.** `requiresOnDeviceRecognition = true` — the
/// competition reality is no network. If the locale has no downloaded on-device
/// model we land in `.unavailable` and deliberately do **not** fall back to
/// server recognition (that would silently break offline + send audio off the
/// phone). The two usage strings in `project.yml` promise "audio never leaves
/// the phone"; this flag is what keeps that promise.
///
/// **Concurrency.** The type is `@MainActor` (so all observable state is
/// main-actor-confined and safe to read from SwiftUI). Two callbacks arrive off
/// the main actor and are handled the way `Motion/`/`Scan/` handle their sensor
/// callbacks:
///  - The audio tap fires on a realtime audio thread. `SFSpeechAudioBufferRecognitionRequest.append`
///    is thread-safe, so the tap holds a `nonisolated(unsafe)` reference to the
///    request and appends directly — hopping to the main actor per buffer would
///    stall the audio thread and drop samples.
///  - The recognizer result handler runs on an arbitrary queue. It extracts only
///    `Sendable` values (the transcript string + two flags) from the
///    non-`Sendable` result and hops back with `Task { @MainActor in … }`.
///
/// The engine/request/task references are `nonisolated(unsafe)` purely so the
/// nonisolated `deinit` can tear the hardware down; they are otherwise only ever
/// mutated on the main actor inside `start()`/`teardown()`.
@MainActor
@Observable
final class VoiceCapture {

    // MARK: - Status

    enum Status: Equatable {
        /// Not listening (initial, and after a `stop()` / auto-finish).
        case idle
        /// Engine running; `transcript` updates live.
        case listening
        /// Mic or speech-recognition permission was refused.
        case denied
        /// No on-device recognizer/model for the active locale — offline
        /// recognition is impossible, so we refuse rather than go to the server.
        case unavailable
    }

    private(set) var status: Status = .idle

    /// Live partial transcript while listening (drives the UI's echo line).
    /// Cleared at `start()`; left readable after an auto-finish so the confirm
    /// UI can render the final phrase.
    private(set) var transcript: String = ""

    /// The active recognition locale, persisted in `UserDefaults` under
    /// `"voice.locale"` (the `rawValue` of `PinVoiceLocale`). Default: Swedish
    /// when the system's preferred language is Swedish, else English. Setting it
    /// while idle takes effect on the next `start()`; it is ignored mid-capture
    /// (the recognizer is bound to the locale it started with).
    var locale: PinVoiceLocale {
        didSet {
            guard locale != oldValue else { return }
            defaults.set(locale.rawValue, forKey: Self.localeKey)
        }
    }

    // MARK: - Tunables (sensor boundary)

    /// Audio tap buffer size (frames). 1024 at the input node's native rate is
    /// the value Apple's speech sample uses — low latency, no under-runs.
    nonisolated static let tapBufferSize: AVAudioFrameCount = 1024

    /// How many times `start()` retries a not-yet-live microphone input before
    /// giving up. The first-grant race clears within a few hundred ms.
    nonisolated static let engineStartAttempts = 4
    /// Back-off between those attempts.
    nonisolated static let engineRetryDelay: Duration = .milliseconds(150)

    /// Engine-start failures we handle ourselves (as opposed to the errors
    /// `AVAudioSession`/`AVAudioEngine` throw).
    enum EngineError: Error {
        /// The input node reported an unusable (0 Hz / 0-channel) format —
        /// the audio route isn't live yet. Retryable.
        case inputUnavailable
    }

    // MARK: - Private

    private static let localeKey = "voice.locale"

    @ObservationIgnored private let defaults: UserDefaults

    // Hardware references. `nonisolated(unsafe)` so `deinit` can stop them; they
    // are only mutated on the main actor otherwise.
    @ObservationIgnored nonisolated(unsafe) private var engine: AVAudioEngine?
    @ObservationIgnored nonisolated(unsafe) private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored nonisolated(unsafe) private var task: SFSpeechRecognitionTask?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.locale = defaults.string(forKey: Self.localeKey)
            .flatMap(PinVoiceLocale.init(rawValue:)) ?? Self.defaultLocale()
    }

    deinit {
        // Nonisolated cleanup for the rare case the model is dropped mid-capture
        // without a `stop()`. All three calls are safe off the main actor.
        task?.cancel()
        request?.endAudio()
        engine?.stop()
    }

    // MARK: - Control

    /// Requests permissions if needed, then starts the audio engine + on-device
    /// recognition. Idempotent while already listening. Lands in `.denied`,
    /// `.unavailable`, or (on a transient engine failure) back in `.idle`.
    func start() async {
        guard status != .listening else { return }

        // On-device model must exist for this locale before we ask for anything.
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale.rawValue)),
              recognizer.supportsOnDeviceRecognition
        else {
            status = .unavailable
            return
        }

        guard await Self.requestSpeechAuthorization() else {
            status = .denied
            return
        }
        guard await Self.requestMicrophonePermission() else {
            status = .denied
            return
        }
        // A `stop()` may have raced in during the await above.
        guard status != .listening else { return }

        // Immediately after a *first* mic grant the input route is often not live
        // yet, so the input node reports a 0 Hz / 0-channel format. Retry a few
        // times before giving up (see `EngineError.inputUnavailable`).
        for attempt in 0..<Self.engineStartAttempts {
            do {
                try startEngine(recognizer: recognizer)
                transcript = ""
                status = .listening
                return
            } catch EngineError.inputUnavailable where attempt < Self.engineStartAttempts - 1 {
                teardown()
                try? await Task.sleep(for: Self.engineRetryDelay)
                guard status != .listening else { return }
            } catch {
                // Audio session / engine start failed (e.g. a route conflict). Not a
                // permission or locale problem — clean up and return to idle so the
                // user can retry.
                teardown()
                status = .idle
                return
            }
        }
        teardown()
        status = .idle
    }

    /// Stops the engine and returns the final transcript (`nil` if empty / never
    /// started). Also invoked internally when the recognizer finishes on its own
    /// (final result or the on-device silence timeout), in which case `status`
    /// goes to `.idle` while `transcript` stays readable for the confirm UI.
    @discardableResult
    func stop() -> String? {
        teardown()
        if status == .listening { status = .idle }
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: - Engine setup (main actor)

    private func startEngine(recognizer: SFSpeechRecognizer) throws {
        // Fresh request/engine every start — a spent recognition request can't be
        // reused.
        let audioRequest = SFSpeechAudioBufferRecognitionRequest()
        audioRequest.shouldReportPartialResults = true
        audioRequest.requiresOnDeviceRecognition = true
        request = audioRequest

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let audioEngine = AVAudioEngine()
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)

        // `installTap` validates the format inside CoreAudio and raises an
        // **ObjC exception** on a 0 Hz / 0-channel format — an uncatchable
        // SIGABRT, not a Swift error. That is exactly what the input node
        // reports in the runloop turn where the user first grants microphone
        // permission (the route isn't live yet), so check it ourselves and let
        // `start()` back off and retry rather than crash the app.
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw EngineError.inputUnavailable
        }

        // The tap fires on a realtime audio thread; `append` is thread-safe, so we
        // hand it a nonisolated reference and append directly rather than hopping
        // to the main actor (which would drop buffers).
        //
        // `@Sendable` is load-bearing, not decoration: `AVAudioNodeTapBlock` is
        // not itself `@Sendable`, so a plain closure written here would inherit
        // this method's main-actor isolation and trap on entry
        // (`dispatch_assert_queue` → `EXC_BREAKPOINT`) the moment CoreAudio calls
        // it from the audio thread. Same for the recognition handler below.
        nonisolated(unsafe) let sink = audioRequest
        input.installTap(onBus: 0, bufferSize: Self.tapBufferSize, format: format) { @Sendable buffer, _ in
            sink.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
        engine = audioEngine

        task = recognizer.recognitionTask(with: audioRequest) { @Sendable [weak self] result, error in
            // Off the main actor. Pull out only Sendable values (the result is
            // not Sendable) and hop back.
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor in
                self?.handleResult(text: text, isFinal: isFinal, failed: failed)
            }
        }
    }

    /// Main-actor sink for the (off-actor) recognition callback: publishes the
    /// live transcript and auto-finishes on a final result or a recognizer error
    /// (which includes the on-device silence timeout).
    private func handleResult(text: String?, isFinal: Bool, failed: Bool) {
        guard status == .listening else { return }
        if let text { transcript = text }
        if isFinal || failed {
            teardown()
            status = .idle
        }
    }

    /// Tear the recognition + audio stack down. Safe to call repeatedly; leaves
    /// `transcript` untouched so a finished capture stays readable.
    private func teardown() {
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if let engine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Permissions (async wrappers over completion-handler APIs)

    // Both helpers are `nonisolated`. They are `static` members of a
    // `@MainActor` type, so without it they would inherit main-actor isolation —
    // and so would the completion closures below. TCC delivers those replies on
    // a background queue, and the Swift runtime's isolation check then trips
    // `dispatch_assert_queue(main)` → `EXC_BREAKPOINT`, crashing the app the
    // moment the user grants permission. Nothing in them touches actor state.
    private nonisolated static func requestSpeechAuthorization() async -> Bool {
        // Already-decided states resolve without re-prompting.
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .denied, .restricted: return false
        case .notDetermined:
            let status = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
            }
            return status == .authorized
        @unknown default:
            return false
        }
    }

    private nonisolated static func requestMicrophonePermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
            }
        @unknown default:
            return false
        }
    }

    // MARK: - Locale default

    /// Swedish when the system's top preferred language is Swedish, else English.
    private static func defaultLocale() -> PinVoiceLocale {
        let preferred = Locale.preferredLanguages.first ?? "en"
        return preferred.hasPrefix("sv") ? .swedish : .english
    }
}
