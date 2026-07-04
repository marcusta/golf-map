import SwiftUI

/// **Placeholder** on-course screen. The Map/on-course agent (B4) replaces this
/// with the live map + distance UI.
///
/// It receives `courseId` (and a display name for the title). To build the
/// on-course experience, B4 should pull the downloaded bundle from the shared
/// `AppEnvironment`:
///
/// - Furniture (course + holes + tees + greens + pins + aim points + manifest):
///   `try await env.database.courseFurniture(courseId: courseId)` → `CourseFurniture?`
///   (nil if not downloaded).
/// - Tile file paths for MapLibre sources:
///   `env.bundlePaths.tileURLTemplate(courseId:layer:)` (`.ortho` / `.terrain`),
///   and `env.bundlePaths.featuresURL(courseId:)` for the GeoJSON overlay.
/// - Elevation range + zoom ranges + bounds live on `furniture.manifest`.
struct CourseScreen: View {
    @Environment(AppEnvironment.self) private var env
    let courseId: String
    let courseName: String

    @State private var furniture: CourseFurniture?

    var body: some View {
        List {
            Section("On-course UI coming") {
                Text("The map + distances view is built by the Map agent.")
                    .foregroundStyle(.secondary)
            }
            if let furniture {
                Section("Bundle summary") {
                    LabeledContent("Course id", value: courseId)
                    LabeledContent("Holes", value: "\(furniture.holes.count)")
                    LabeledContent("Tees", value: "\(furniture.tees.count)")
                    LabeledContent("Greens", value: "\(furniture.greens.count)")
                    LabeledContent("Pins", value: "\(furniture.pins.count)")
                    LabeledContent("Aim points", value: "\(furniture.aimPoints.count)")
                    LabeledContent("Revision", value: "\(furniture.course.downloadedRevision ?? furniture.course.revision)")
                }
            }
        }
        .navigationTitle(courseName)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            furniture = try? await env.database.courseFurniture(courseId: courseId)
        }
    }
}
