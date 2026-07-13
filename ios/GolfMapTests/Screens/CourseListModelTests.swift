import XCTest
@testable import GolfMap

final class CourseListModelTests: XCTestCase {
    func testSharedMapIsOfferedAsLightweightInstallWithoutClaimingCourseDownloaded() {
        let siteId = "site-landeryd"
        let local = [courseRecord(id: "masters", siteId: siteId, state: .complete)]
        let published = [
            summary(id: "masters", name: "Masters", siteId: siteId),
            summary(id: "classic", name: "Classic", siteId: siteId),
        ]

        let rows = CourseListModel.merge(published: published, local: local)
        let masters = rows.first { $0.id == "masters" }
        let classic = rows.first { $0.id == "classic" }

        XCTAssertEqual(masters?.availability, .downloaded(revision: 3))
        XCTAssertEqual(classic?.availability, .sharedMapAvailable)
        XCTAssertNil(classic?.downloadedRevision)
        XCTAssertEqual(classic?.bundleState, BundleState.none)
        XCTAssertTrue(classic?.hasSharedMap == true)
    }

    func testUnrelatedDownloadedMapDoesNotMakeCourseLightweight() {
        let local = [courseRecord(id: "masters", siteId: "site-a", state: .complete)]
        let rows = CourseListModel.merge(
            published: [summary(id: "classic", name: "Classic", siteId: "site-b")],
            local: local
        )

        XCTAssertEqual(rows.first?.availability, .downloadable)
        XCTAssertFalse(rows.first?.hasSharedMap == true)
    }

    func testCourseWithoutSiteFallsBackToCourseIdMapKey() {
        let rows = CourseListModel.merge(
            published: [summary(id: "solo", name: "Solo", siteId: nil)],
            local: []
        )

        XCTAssertEqual(rows.first?.mapKey, "solo")
    }

    func testSearchMatchesCourseAndSiteNames() {
        let rows = CourseListModel.merge(
            published: [
                summary(id: "masters", name: "Masters", siteId: "site", siteName: "Landeryd"),
                summary(id: "classic", name: "Classic", siteId: "site", siteName: "Landeryd"),
                summary(id: "links", name: "Coastal Links", siteId: "links", siteName: "West Coast"),
            ],
            local: []
        )

        let bySite = CourseListModel.filterSortGroup(
            rows: rows, query: "landeryd", sort: .name, grouping: .none
        )
        XCTAssertEqual(bySite.flatMap(\.rows).map(\.name), ["Classic", "Masters"])

        let byName = CourseListModel.filterSortGroup(
            rows: rows, query: "coastal", sort: .name, grouping: .none
        )
        XCTAssertEqual(byName.flatMap(\.rows).map(\.name), ["Coastal Links"])
    }

    func testProgressSortUsesMappedHoleRatioAndNameAsTieBreak() {
        let rows = CourseListModel.merge(
            published: [
                summary(id: "half-b", name: "Beta", siteId: nil, mapped: 9),
                summary(id: "full", name: "Full", siteId: nil, mapped: 18),
                summary(id: "half-a", name: "Alpha", siteId: nil, mapped: 9),
            ],
            local: []
        )

        let result = CourseListModel.filterSortGroup(
            rows: rows, query: "", sort: .progress, grouping: .none
        )
        XCTAssertEqual(result.flatMap(\.rows).map(\.name), ["Full", "Alpha", "Beta"])
    }

    func testAvailabilityGroupingUsesMobileOfflineStateOrder() {
        let local = [
            courseRecord(id: "downloaded", siteId: "site-a", state: .complete),
            courseRecord(id: "shared-owner", siteId: "site-b", state: .complete),
        ]
        let rows = CourseListModel.merge(
            published: [
                summary(id: "available", name: "Available", siteId: "site-c"),
                summary(id: "shared", name: "Shared", siteId: "site-b"),
                summary(id: "downloaded", name: "Downloaded", siteId: "site-a"),
                summary(id: "shared-owner", name: "Owner", siteId: "site-b"),
            ],
            local: local
        )

        let result = CourseListModel.filterSortGroup(
            rows: rows, query: "", sort: .name, grouping: .availability
        )
        XCTAssertEqual(result.map(\.label), ["Downloaded", "Map on device", "Available to download"])
        XCTAssertEqual(result[0].rows.map(\.name), ["Downloaded", "Owner"])
        XCTAssertEqual(result[1].rows.map(\.name), ["Shared"])
    }

    func testDownloadRemovalChangesSectionScopedRowIdentity() throws {
        let siteId = "landeryd"
        let published = [
            summary(id: "masters", name: "Masters", siteId: siteId),
            summary(id: "classic", name: "Classic", siteId: siteId),
        ]
        let beforeRemoval = CourseListModel.merge(
            published: published,
            local: [
                courseRecord(id: "masters", siteId: siteId, state: .complete),
                courseRecord(id: "classic", siteId: siteId, state: .complete),
            ]
        )
        let afterRemoval = CourseListModel.merge(
            published: published,
            local: [courseRecord(id: "masters", siteId: siteId, state: .complete)]
        )

        let beforeGroups = CourseListModel.filterSortGroup(
            rows: beforeRemoval, query: "", sort: .name, grouping: .availability
        )
        let afterGroups = CourseListModel.filterSortGroup(
            rows: afterRemoval, query: "", sort: .name, grouping: .availability
        )
        let classicBefore = try XCTUnwrap(
            beforeGroups.flatMap(\.renderRows).first { $0.row.id == "classic" }
        )
        let classicAfter = try XCTUnwrap(
            afterGroups.flatMap(\.renderRows).first { $0.row.id == "classic" }
        )

        XCTAssertEqual(classicBefore.groupID, "Downloaded")
        XCTAssertEqual(classicAfter.groupID, "Map on device")
        XCTAssertNotEqual(classicBefore.id, classicAfter.id)
    }

    func testOfflinePresentationDerivesMetricsAndRoutingFromFurniture() {
        let furniture = StoreFixtures.furniture()

        let presentation = CourseListModel.derivePresentation(furniture)

        XCTAssertEqual(presentation.holeCount, 2)
        XCTAssertEqual(presentation.parTotal, 7)
        // Hole 2 has no green, so only hole 1 is routable/mapped offline.
        XCTAssertEqual(presentation.mappedHoleCount, 1)
        XCTAssertEqual(presentation.routing.count, 1)
        XCTAssertEqual(presentation.routing[0].hole, 1)
        // The lowest sort-order tee is used, matching the server thumbnail.
        XCTAssertEqual(presentation.routing[0].tee, [58.351, 15.721])
        XCTAssertEqual(presentation.routing[0].green, [58.353, 15.723])
        XCTAssertGreaterThan(presentation.lengthM, 200)
        XCTAssertLessThan(presentation.lengthM, 300)
    }

    func testOfflineRowsCombineFurnitureWithCachedSiteName() {
        var furniture = StoreFixtures.furniture(courseId: "classic", siteId: "landeryd")
        furniture.course.bundleState = .complete
        furniture.course.downloadedRevision = 3

        let rows = CourseListModel.offlineRows(
            local: [furniture.course],
            furnitureByCourseId: ["classic": furniture],
            siteNamesByCourseId: ["classic": "Landeryd Golf Club"]
        )

        let row = rows.first
        XCTAssertEqual(row?.siteName, "Landeryd Golf Club")
        XCTAssertEqual(row?.holeCount, 2)
        XCTAssertEqual(row?.parTotal, 7)
        XCTAssertEqual(row?.mappedHoleCount, 1)
        XCTAssertEqual(row?.routing.count, 1)
        XCTAssertGreaterThan(row?.lengthM ?? 0, 200)
        XCTAssertTrue(row?.isLocalOnly == true)
        XCTAssertEqual(row?.availability, .downloaded(revision: 3))
    }

    func testOfflineRowGracefullyFallsBackWhenLegacyFurnitureIsMissing() {
        let course = courseRecord(id: "legacy", siteId: nil, state: .complete)

        let row = CourseListModel.offlineRows(
            local: [course], furnitureByCourseId: [:]
        ).first

        XCTAssertEqual(row?.holeCount, 0)
        XCTAssertEqual(row?.parTotal, 0)
        XCTAssertEqual(row?.lengthM, 0)
        XCTAssertEqual(row?.routing, [])
        XCTAssertEqual(row?.availability, .downloaded(revision: 3))
    }

    func testOperationErrorWinsOverRefreshError() {
        XCTAssertEqual(
            CourseListModel.visibleError(
                operationError: "Remove failed: disk error",
                refreshError: "Session expired"
            ),
            "Remove failed: disk error"
        )
        XCTAssertEqual(
            CourseListModel.visibleError(operationError: nil, refreshError: "Session expired"),
            "Session expired"
        )
    }

    private func summary(
        id: String,
        name: String,
        siteId: String?,
        siteName: String? = nil,
        mapped: Int = 0
    ) -> CourseSummary {
        CourseSummary(
            id: id,
            name: name,
            status: "published",
            revision: 3,
            siteId: siteId,
            homeLat: nil,
            homeLon: nil,
            holeCount: 18,
            updatedAt: "2026-07-13T00:00:00Z",
            parTotal: 72,
            lengthM: 5_800,
            mappedHoleCount: mapped,
            siteName: siteName,
            routing: []
        )
    }

    private func courseRecord(id: String, siteId: String?, state: BundleState) -> CourseRecord {
        CourseRecord(
            id: id,
            siteId: siteId,
            name: id,
            status: "published",
            revision: 3,
            downloadedRevision: 3,
            updatedAt: "2026-07-13T00:00:00Z",
            bundleState: state
        )
    }
}
