import SwiftUI

@main
struct GolfMapWatchApp: App {
    @State private var tracker = ShotTracker()
    @State private var library = CourseLibrary()

    var body: some Scene {
        WindowGroup {
            RootView(tracker: tracker, library: library)
        }
    }
}

/// Vertical pager: green distances on top (when a course is synced), the
/// green map in the middle, the mark-shot tracker below. With nothing synced
/// yet the tracker stands alone.
struct RootView: View {
    @Bindable var tracker: ShotTracker
    @Bindable var library: CourseLibrary

    @State private var showsCoursePicker = false

    var body: some View {
        Group {
            if let course = library.activeCourse {
                CoursePagesView(
                    tracker: tracker,
                    course: course,
                    onSwitchCourse: { showsCoursePicker = true },
                    courseCount: library.courses.count
                )
                // New course → fresh hole selection state.
                .id(course.courseId)
            } else {
                DistanceView(tracker: tracker)
            }
        }
        .sheet(isPresented: $showsCoursePicker) {
            List(library.courses, id: \.courseId) { course in
                Button {
                    library.choose(courseId: course.courseId)
                    showsCoursePicker = false
                } label: {
                    Text(course.name)
                }
            }
        }
    }
}

/// The synced-course pager. Owns the hole selection so the distance page and
/// the green-map page always agree on the current hole; GPS fixes feed the
/// selector here regardless of which page is frontmost.
struct CoursePagesView: View {
    @Bindable var tracker: ShotTracker
    let course: WatchCourseBundle
    let onSwitchCourse: () -> Void
    let courseCount: Int

    @State private var selector = HoleSelector()

    var body: some View {
        TabView {
            OnCourseView(
                tracker: tracker,
                course: course,
                selector: $selector,
                onSwitchCourse: onSwitchCourse,
                courseCount: courseCount
            )
            GreenMapView(tracker: tracker, course: course, selector: selector)
            DistanceView(tracker: tracker)
        }
        .tabViewStyle(.verticalPage)
        .onAppear { tracker.startUpdates() }
        .onChange(of: tracker.currentFix) { _, fix in
            guard let fix else { return }
            selector.update(
                fix: LatLon(lat: fix.coordinate.latitude, lon: fix.coordinate.longitude),
                holes: course.holes
            )
        }
    }
}
