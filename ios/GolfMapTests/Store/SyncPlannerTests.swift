import XCTest
@testable import GolfMap

final class SyncPlannerTests: XCTestCase {
    private func local(
        _ id: String,
        downloadedRevision: Int? = nil,
        state: BundleState
    ) -> LocalCourseSummary {
        LocalCourseSummary(id: id, downloadedRevision: downloadedRevision, bundleState: state)
    }

    private func remote(_ id: String, revision: Int, status: String = "published") -> RemoteCourseSummary {
        RemoteCourseSummary(id: id, revision: revision, status: status)
    }

    // MARK: - Single-course matrix

    func testNewPublishedRemoteCourseIsDownloaded() {
        XCTAssertEqual(
            SyncPlanner.plan(local: [], remote: [remote("a", revision: 1)]),
            [.download(courseId: "a")]
        )
    }

    func testUpToDateCompleteBundleIsKept() {
        XCTAssertEqual(
            SyncPlanner.plan(
                local: [local("a", downloadedRevision: 5, state: .complete)],
                remote: [remote("a", revision: 5)]
            ),
            [.keep(courseId: "a")]
        )
    }

    func testStaleRevisionIsRedownloaded() {
        XCTAssertEqual(
            SyncPlanner.plan(
                local: [local("a", downloadedRevision: 4, state: .complete)],
                remote: [remote("a", revision: 5)]
            ),
            [.redownload(courseId: "a")]
        )
    }

    func testStaleStateIsRedownloadedEvenIfRevisionMatches() {
        // bundleState .stale with a matching revision shouldn't happen, but a
        // non-complete state must never be reported as keep.
        XCTAssertEqual(
            SyncPlanner.plan(
                local: [local("a", downloadedRevision: 5, state: .stale)],
                remote: [remote("a", revision: 5)]
            ),
            [.redownload(courseId: "a")]
        )
    }

    func testInterruptedFirstDownloadIsDownloadedAgain() {
        // Row exists (state downloading/none) but nothing usable on disk.
        for state in [BundleState.downloading, .none] {
            XCTAssertEqual(
                SyncPlanner.plan(
                    local: [local("a", downloadedRevision: nil, state: state)],
                    remote: [remote("a", revision: 2)]
                ),
                [.download(courseId: "a")],
                "state \(state)"
            )
        }
    }

    func testInterruptedRedownloadWithOldBundleIsRedownloaded() {
        XCTAssertEqual(
            SyncPlanner.plan(
                local: [local("a", downloadedRevision: 3, state: .downloading)],
                remote: [remote("a", revision: 5)]
            ),
            [.redownload(courseId: "a")]
        )
    }

    func testUnpublishedRemoteWithLocalCopyIsDeleted() {
        XCTAssertEqual(
            SyncPlanner.plan(
                local: [local("a", downloadedRevision: 5, state: .complete)],
                remote: [remote("a", revision: 6, status: "draft")]
            ),
            [.delete(courseId: "a")]
        )
    }

    func testUnpublishedRemoteWithoutLocalCopyIsIgnored() {
        XCTAssertEqual(
            SyncPlanner.plan(local: [], remote: [remote("a", revision: 1, status: "draft")]),
            []
        )
    }

    func testLocalCourseMissingFromRemoteIsDeleted() {
        XCTAssertEqual(
            SyncPlanner.plan(
                local: [local("gone", downloadedRevision: 2, state: .complete)],
                remote: []
            ),
            [.delete(courseId: "gone")]
        )
    }

    // MARK: - Combined

    func testMixedFleetProducesSortedActions() {
        let localCourses = [
            local("b-stale", downloadedRevision: 1, state: .complete),
            local("c-current", downloadedRevision: 7, state: .complete),
            local("d-removed", downloadedRevision: 2, state: .complete),
            local("e-unpublished", downloadedRevision: 3, state: .complete),
        ]
        let remoteCourses = [
            remote("e-unpublished", revision: 4, status: "draft"),
            remote("c-current", revision: 7),
            remote("a-new", revision: 1),
            remote("b-stale", revision: 2),
            remote("f-draft-unknown", revision: 1, status: "draft"),
        ]
        XCTAssertEqual(
            SyncPlanner.plan(local: localCourses, remote: remoteCourses),
            [
                .download(courseId: "a-new"),
                .redownload(courseId: "b-stale"),
                .keep(courseId: "c-current"),
                .delete(courseId: "d-removed"),
                .delete(courseId: "e-unpublished"),
            ]
        )
    }
}
