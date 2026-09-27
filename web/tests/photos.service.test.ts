import { test, expect, describe, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { ApiError } from '@basics/core/client/api-error';
import { PhotosService } from '../src/photos/photos.service';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import { PhotosPanelComponent } from '../src/photos/photos-panel.component';
import {
    EMPTY_FILTER,
    HOLE_NEAR_M,
    filterPhotos,
    holeLine,
    knownTags,
    normalizeTag,
    formatHeading,
    type HoleLine,
} from '../src/photos/photo-filter';
import { photosGeojson, wedgePolygon } from '../src/photos/photos-overlay';
import { lngLatToSweref99tm, sweref99tmToLngLat } from '../src/geo/transform';
import type { Photo, PhotosApi } from '../../shared/api/photos.gen';

afterEach(() => { _reset(); di.reset(); });

// A spot on a course, SWEREF 99 TM.
const O = { x: 530150, y: 6487600 };

function photo(id: string, dx: number, dy: number, extra: Partial<Photo> = {}): Photo {
    const ll = sweref99tmToLngLat(O.x + dx, O.y + dy);
    return {
        id, siteId: 'site-1', courseId: 'c1', hole: null, capturedAt: '2026-10-02T09:00:00Z',
        lat: ll.lat, lon: ll.lng, hAccM: 4, gpsAltM: null, vAccM: null,
        x3006: O.x + dx, y3006: O.y + dy, attitudeQuat: null,
        yawDeg: 90, pitchDeg: -2, rollDeg: 0, headingAccDeg: 8, magCalibration: null,
        hfovDeg: 66, vfovDeg: 51, width: 2048, height: 1536, eyeHeightM: 1.5,
        deviceModel: 'iPhone', lens: 'wide', tags: [], note: null,
        originalSha256: 'a', originalBytes: 1, originalUploadedAt: null, originalDeletedAt: null,
        previewSha256: 'b', previewBytes: 1, previewUploadedAt: null, pulledAt: null,
        refinedYawDeg: null, refinedPitchDeg: null, refinedRollDeg: null, refineMethod: null,
        refineResidualDeg: null, refinedAt: null, version: 1, createdAt: '', updatedAt: '',
        ...extra,
    };
}

/** Hole 1 runs 300 m due north from O; hole 2 runs east from 200 m east of O. */
function lines(): Map<number, HoleLine> {
    const ll = (dx: number, dy: number) => {
        const p = sweref99tmToLngLat(O.x + dx, O.y + dy);
        return { lat: p.lat, lon: p.lng };
    };
    const h1 = holeLine(1, [{ ...ll(0, 0), sortOrder: 0 }], [{ ...ll(0, 150), sortOrder: 0 }], (() => { const g = ll(0, 300); return { centerLat: g.lat, centerLon: g.lon }; })())!;
    const h2 = holeLine(2, [{ ...ll(200, 0), sortOrder: 0 }], [], (() => { const g = ll(500, 0); return { centerLat: g.lat, centerLon: g.lon }; })())!;
    return new Map([[1, h1], [2, h2]]);
}

describe('photo filter', () => {
    const photos = [
        photo('on-1', 10, 100, { tags: ['creek', 'vegetation'] }),
        photo('tagged-2-far', 1000, 1000, { hole: 2, tags: ['bunker'] }),
        photo('between', 100 + HOLE_NEAR_M / 2, 0, { tags: [] }),
        photo('far', -500, -500, { tags: ['buildings'] }),
    ];

    test('a hole keeps photos near its play line or tagged with it', () => {
        const ids = (hole: number) => filterPhotos(photos, { ...EMPTY_FILTER, hole }, lines()).map(p => p.id);
        expect(ids(1)).toEqual(['on-1']);
        // 'between' is 120 m from hole 1's line but 80 m from hole 2's tee: out.
        expect(ids(2)).toEqual(['tagged-2-far']);
        const closer = [...photos, photo('by-2', 190, 30)];
        expect(filterPhotos(closer, { ...EMPTY_FILTER, hole: 2 }, lines()).map(p => p.id)).toEqual(['tagged-2-far', 'by-2']);
    });

    test('a picked position keeps photos inside the radius, nearest first', () => {
        const near = { ...sweref99tmToLngLat(O.x + 100, O.y), radiusM: 140 };
        const kept = filterPhotos(photos, { ...EMPTY_FILTER, near }, lines());
        expect(kept.map(p => p.id)).toEqual(['between', 'on-1']);
    });

    test('tags match any or all; untagged keeps only photos without tags', () => {
        const ids = (f: Partial<typeof EMPTY_FILTER>) => filterPhotos(photos, { ...EMPTY_FILTER, ...f }, lines()).map(p => p.id);
        expect(ids({ tags: ['creek', 'bunker'] })).toEqual(['on-1', 'tagged-2-far']);
        expect(ids({ tags: ['creek', 'bunker'], tagMode: 'all' })).toEqual([]);
        expect(ids({ tags: ['creek', 'vegetation'], tagMode: 'all' })).toEqual(['on-1']);
        expect(ids({ untagged: true, tags: ['creek'] })).toEqual(['between']);
    });

    test('tags offered: the fixed list, then the others in use; tags normalise', () => {
        const tags = knownTags([photo('x', 0, 0, { tags: ['stone-wall', 'creek', 'bridge'] })]);
        expect(tags.slice(0, 3)).toEqual(['creek', 'bunker', 'vegetation']);
        expect(tags.slice(-2)).toEqual(['bridge', 'stone-wall']);
        expect(normalizeTag('  Stone  Wall ')).toBe('stone-wall');
        expect(formatHeading(212.4)).toBe('212° SSW');
        expect(formatHeading(359.9)).toBe('0° N');
    });

    test('the view wedge opens along the camera azimuth', () => {
        // Looking east (90°), 60° wide: every arc point is east of the photo.
        const p = photo('w', 0, 0, { yawDeg: 90, hfovDeg: 60 });
        const ring = wedgePolygon(p, 100).coordinates[0]!.map(([lng, lat]) => lngLatToSweref99tm({ lng: lng!, lat: lat! }));
        const arc = ring.slice(1, -1);
        for (const q of arc) {
            expect(q.x - O.x).toBeGreaterThan(80);
            expect(Math.abs(Math.hypot(q.x - O.x, q.y - O.y) - 100)).toBeLessThan(0.5);
        }
        // A refined heading wins over the sensor one.
        const refined = photo('r', 0, 0, { yawDeg: 90, refinedYawDeg: 0, refineMethod: 'skyline' });
        const north = wedgePolygon(refined, 100).coordinates[0]!.slice(1, -1).map(([lng, lat]) => lngLatToSweref99tm({ lng: lng!, lat: lat! }));
        expect(north.every(q => q.y - O.y > 80)).toBe(true);

        const fc = photosGeojson([p, refined], 'w', null, lngLatToSweref99tm);
        const markers = fc.features.filter(f => f.properties!.role === 'marker');
        expect(markers.map(f => [f.properties!.id, f.properties!.selected, f.properties!.sensor]))
            .toEqual([['r', false, false], ['w', true, true]]);
    });
});

/** The photos API over an in-memory table, with the server's version check. */
function photosApi(initial: Photo[]) {
    const rows = new Map(initial.map(p => [p.id, structuredClone(p)]));
    const updates: Parameters<PhotosApi['update']>[0][] = [];
    const api: PhotosApi = {
        async list({ siteId }) { return [...rows.values()].filter(p => p.siteId === siteId).map(p => structuredClone(p)); },
        async get({ id }) { return structuredClone(rows.get(id)!); },
        create: () => Promise.reject(new Error('not under test')),
        remove: () => Promise.reject(new Error('not under test')),
        async update(input) {
            updates.push(structuredClone(input));
            await new Promise(r => setTimeout(r, 1));
            const row = rows.get(input.id)!;
            if (row.version !== input.version) throw new ApiError(409, 'Version conflict');
            const { id: _id, version, ...patch } = input;
            Object.assign(row, patch, { version: version + 1 });
            return structuredClone(row);
        },
    };
    return { api, rows, updates };
}

describe('PhotosService', () => {
    test('loads the site, toggles tags quickly without conflicts, saves note and hole', async () => {
        const fake = photosApi([photo('p1', 0, 0, { tags: ['look'] }), photo('p2', 10, 0), photo('other', 0, 0, { siteId: 'site-2' })]);
        const svc = new PhotosService(fake.api);
        await svc.load('site-1');
        expect(svc.photos.get().map(p => p.id)).toEqual(['p1', 'p2']);

        // Three edits fired back to back: each runs on the version the last left.
        await Promise.all([
            svc.toggleTag('p1', 'Creek'),
            svc.toggleTag('p1', 'look'),
            svc.setNote('p1', '  bank erosion '),
        ]);
        expect(fake.rows.get('p1')).toMatchObject({ tags: ['creek'], note: 'bank erosion', version: 4 });
        expect(svc.photos.get()[0]).toMatchObject({ tags: ['creek'], version: 4 });
        expect(svc.saveError.get()).toBeNull();

        // No-op edits send nothing.
        const sent = fake.updates.length;
        await svc.setNote('p1', 'bank erosion');
        await svc.setHole('p2', null);
        expect(fake.updates.length).toBe(sent);
        await svc.setHole('p2', 7);
        expect(fake.rows.get('p2')!.hole).toBe(7);
    });

    test('a photo changed elsewhere reports a conflict and reloads', async () => {
        const fake = photosApi([photo('p1', 0, 0)]);
        const svc = new PhotosService(fake.api);
        await svc.load('site-1');
        fake.rows.get('p1')!.version = 5;
        fake.rows.get('p1')!.tags = ['water'];
        await svc.toggleTag('p1', 'creek');
        expect(svc.saveError.get()?.code).toBe('conflict');
        expect(svc.photos.get()[0]).toMatchObject({ tags: ['water'], version: 5 });
    });

    test('step walks the filtered photos and wraps; filters combine', async () => {
        const fake = photosApi([photo('a', 0, 0, { tags: ['creek'] }), photo('b', 5, 0), photo('c', 9, 0, { tags: ['creek'] })]);
        const svc = new PhotosService(fake.api);
        await svc.load('site-1');
        svc.toggleFilterTag('creek');
        expect(svc.filtered.get().map(p => p.id)).toEqual(['a', 'c']);
        svc.open('a');
        svc.step(1);
        expect(svc.selectedId.get()).toBe('c');
        svc.step(1);
        expect(svc.selectedId.get()).toBe('a');
        svc.step(-1);
        expect(svc.selectedId.get()).toBe('c');

        svc.pickingPosition.set(true);
        svc.pickPosition(sweref99tmToLngLat(O.x + 9, O.y));
        expect(svc.pickingPosition.get()).toBe(false);
        expect(svc.filter.get().near?.radiusM).toBe(50);
        expect(svc.filtered.get().map(p => p.id)).toEqual(['c', 'a']);
        svc.clearFilter();
        expect(svc.filtered.get()).toHaveLength(3);
    });
});

describe('photos panel', () => {
    test('tag chips count photos and filter; the hole select lists the course holes', async () => {
        const fake = photosApi([photo('a', 0, 0, { tags: ['creek'] }), photo('b', 5, 0), photo('c', 9, 0, { tags: ['creek', 'bunker'] })]);
        const svc = new PhotosService(fake.api);
        di.set(PhotosService, svc);
        const course = new CourseDetailService();
        course.holes.set([1, 2].map(n => ({
            id: `h${n}`, courseId: 'c1', number: n, par: 4, strokeIndex: null, notes: null,
            savedRegionJson: null, version: 1, createdAt: '', updatedAt: '',
        })));
        di.set(CourseDetailService, course);
        await svc.load('site-1');

        const host = document.createElement('div');
        new PhotosPanelComponent({}).mount(host);
        const chip = (tag: string) => host.querySelector<HTMLButtonElement>(`[data-testid="photos-filter-tags"] [data-tag="${tag}"]`)!;
        expect(chip('creek').textContent).toBe('creek2');
        expect(chip('untagged').textContent).toBe('untagged1');
        expect(host.querySelector('[data-testid="photos-count"]')!.textContent).toBe('3 photos');

        chip('bunker').click();
        expect(chip('bunker').getAttribute('aria-pressed')).toBe('true');
        expect(host.querySelector('[data-testid="photos-count"]')!.textContent).toBe('1 of 3 photos');

        const holes = [...host.querySelectorAll<HTMLOptionElement>('[data-testid="photos-filter-hole"] option')];
        expect(holes.map(o => o.textContent)).toEqual(['All holes', 'Hole 1', 'Hole 2']);
    });
});
