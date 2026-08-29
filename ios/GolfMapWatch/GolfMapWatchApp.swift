import SwiftUI
import WatchKit

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
/// distance ladder and mark-shot tracker below, the green map last. With
/// nothing synced yet the tracker stands alone.
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
                    pins: library.pins,
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
    /// Today's pins, synced from the phone (empty until one is placed).
    @Bindable var pins: PinStore
    let onSwitchCourse: () -> Void
    let courseCount: Int

    @State private var selector = HoleSelector()

    var body: some View {
        TabView {
            OnCourseView(
                tracker: tracker,
                course: course,
                pins: pins,
                selector: $selector,
                onSwitchCourse: onSwitchCourse,
                courseCount: courseCount
            )
            LadderView(tracker: tracker, course: course, pins: pins, selector: selector)
            DistanceView(tracker: tracker)
            GreenMapView(tracker: tracker, course: course, pins: pins, selector: selector)
        }
        .tabViewStyle(.verticalPage)
        // Horizontal axis = holes; vertical stays the page axis. Simultaneous
        // so list scrolling and page swipes keep working — the dominance
        // guard ignores drags that are really vertical.
        .simultaneousGesture(holeSwipe)
        .onAppear { tracker.startUpdates() }
        .onChange(of: tracker.currentFix) { _, fix in
            guard let fix else { return }
            selector.update(
                fix: LatLon(lat: fix.coordinate.latitude, lon: fix.coordinate.longitude),
                holes: course.holes
            )
        }
    }

    /// Swipe left → next hole, right → previous; clamped at the ends.
    private var holeSwipe: some Gesture {
        DragGesture(minimumDistance: 25)
            .onEnded { value in
                let w = value.translation.width
                let h = value.translation.height
                guard abs(w) > 40, abs(w) > abs(h) * 2 else { return }
                let next = selector.currentIndex + (w < 0 ? 1 : -1)
                guard course.holes.indices.contains(next) else { return }
                selector.select(index: next, holeCount: course.holes.count)
                WKInterfaceDevice.current().play(.click)
            }
    }
}
