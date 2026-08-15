import SwiftUI

struct DistanceView: View {
    @Bindable var tracker: ShotTracker

    var body: some View {
        VStack(spacing: 8) {
            if tracker.authorizationDenied {
                deniedView
            } else if let mark = tracker.mark {
                markedView(mark: mark)
            } else {
                unmarkedView
            }
        }
        .padding(.horizontal, 4)
        .onAppear { tracker.startUpdates() }
    }

    private var deniedView: some View {
        VStack(spacing: 6) {
            Image(systemName: "location.slash")
                .font(.title2)
            Text("Location access is off. Allow it in Settings on the watch.")
                .font(.footnote)
                .multilineTextAlignment(.center)
        }
    }

    private var unmarkedView: some View {
        VStack(spacing: 10) {
            accuracyLine
            Button {
                tracker.markShot()
            } label: {
                Label("Mark shot", systemImage: "figure.golf")
                    .font(.headline)
            }
            .buttonStyle(.borderedProminent)
            .disabled(tracker.currentFix == nil)
        }
    }

    private func markedView(mark: ShotTracker.Mark) -> some View {
        VStack(spacing: 4) {
            if let distance = tracker.distanceMeters {
                (Text("\(Int(distance.rounded()))")
                    .font(.system(size: 54, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                 + Text(" m")
                    .font(.title3.weight(.medium))
                    .foregroundStyle(.secondary))
                    .contentTransition(.numericText())
            } else {
                Text("—")
                    .font(.system(size: 54, weight: .semibold, design: .rounded))
            }
            accuracyLine
            HStack(spacing: 8) {
                Button {
                    tracker.markShot()
                } label: {
                    Label("Re-mark", systemImage: "figure.golf")
                }
                .disabled(tracker.currentFix == nil)
                Button(role: .destructive) {
                    tracker.clearMark()
                } label: {
                    Label("Clear", systemImage: "xmark")
                        .labelStyle(.iconOnly)
                }
                .frame(width: 52)
            }
            .font(.footnote)
        }
    }

    @ViewBuilder
    private var accuracyLine: some View {
        if let accuracy = tracker.accuracyMeters {
            Label("±\(Int(accuracy.rounded())) m", systemImage: "location.fill")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else {
            Label("Acquiring GPS", systemImage: "location")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}
