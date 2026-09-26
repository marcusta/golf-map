import SwiftUI
import UIKit

/// A site's reference photos, newest first, with thumbnail and upload state.
/// Failed rows show the server's reason and a retry; the toolbar button
/// flushes the queue now, ignoring backoff.
struct PhotoListScreen: View {
    let siteId: String
    let onClose: () -> Void

    @Environment(AppEnvironment.self) private var env
    @State private var photos: [ReferencePhotoRecord] = []

    var body: some View {
        NavigationStack {
            List(photos, id: \.id) { photo in
                row(photo)
            }
            .overlay {
                if photos.isEmpty {
                    ContentUnavailableView("No photos", systemImage: "photo.stack")
                }
            }
            .navigationTitle("Photos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onClose)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        PhotoUploadTrigger.flush(env.photoSync, ignoringBackoff: true)
                    } label: {
                        Image(systemName: "arrow.clockwise.icloud")
                    }
                    .accessibilityLabel("Upload now")
                }
            }
            .task {
                // The sync actor writes rows in the background; poll while
                // the list is open.
                while !Task.isCancelled {
                    await reload()
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        }
    }

    private func reload() async {
        photos = (try? await env.database.referencePhotos(siteId: siteId)) ?? []
    }

    private func row(_ photo: ReferencePhotoRecord) -> some View {
        HStack(spacing: 12) {
            thumbnail(photo)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if let hole = photo.hole {
                        Label("\(hole)", systemImage: "flag.fill")
                            .labelStyle(.titleAndIcon)
                    }
                    Text(String(format: "%03.0f°", photo.yawDeg)).monospacedDigit()
                    Text(Self.time(photo.capturedAt)).foregroundStyle(.secondary)
                }
                .font(.subheadline.weight(.semibold))
                if !photo.tags.isEmpty {
                    Text(photo.tags.joined(separator: " · "))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let error = photo.lastError, photo.syncState != .synced {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(photo.syncState == .failed ? Color.statusNegative : Color.statusCaution)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            syncBadge(photo)
        }
        .accessibilityElement(children: .combine)
    }

    private func thumbnail(_ photo: ReferencePhotoRecord) -> some View {
        let image = UIImage(contentsOfFile: env.photoFiles.url(photo.thumbnailFile).path(percentEncoded: false))
        return Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Color.secondary.opacity(0.2)
            }
        }
        .frame(width: 56, height: 56)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    @ViewBuilder
    private func syncBadge(_ photo: ReferencePhotoRecord) -> some View {
        switch photo.syncState {
        case .synced:
            Image(systemName: "checkmark.icloud")
                .foregroundStyle(Color.statusPositive)
                .frame(width: 44, height: 44)
                .accessibilityLabel("Uploaded")
        case .pending:
            Image(systemName: "icloud.and.arrow.up")
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 44)
                .accessibilityLabel("Waiting to upload")
        case .failed:
            Button {
                Task {
                    await env.photoSync.retry(id: photo.id)
                    PhotoUploadTrigger.flush(env.photoSync, ignoringBackoff: true)
                    await reload()
                }
            } label: {
                Image(systemName: "exclamationmark.icloud")
                    .foregroundStyle(Color.statusNegative)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Upload failed, retry")
        }
    }

    private static func time(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
