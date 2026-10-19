// Fixture for the hole-by-hole photo cleanup tests: the cleaned-photo
// fixture's course and site, cleanup areas, a hole with a saved view, two
// features, and the service on the same golfpipe stand-in.
import { Hono } from 'hono';
import * as path from 'node:path';
import { mount } from '@basics/core/server/mount';
import { TEST_COURSE_ID, TEST_HOLE_1_ID } from '../db/seeds/course';
import { SITE_ID, fakeRunner, setup as setupPhoto } from './cleaned-photo';
import { PhotoCleanupService } from '../services/photo-cleanup.service';
import { createPhotoCleanupApi } from '../api/photo-cleanup.api';
import { createPhotoCleanupFileRoutes } from '../api/photo-cleanup.routes';

export const REGION = { center: { latitude: 58.4, longitude: 15.56 }, span: { latitudeDelta: 0.004, longitudeDelta: 0.006 } };
export const AREAS = [
    { id: 'a', name: 'Hole 1', kind: 'include', ring: [[15.55, 58.39], [15.58, 58.39], [15.58, 58.41], [15.55, 58.39]] },
    { id: 'k', name: 'Pond', kind: 'exclude', ring: [[15.56, 58.40], [15.57, 58.40], [15.57, 58.401], [15.56, 58.40]] },
];
const SQUARE_GEOJSON = { type: 'Polygon', coordinates: [[[15.56, 58.40], [15.561, 58.40], [15.561, 58.401], [15.56, 58.40]]] };

export async function setup(opts: { areas?: unknown[] | null; failHole?: (hole: number) => boolean; holeChanges?: (hole: number) => number } = {}) {
    const photo = await setupPhoto();
    const db = photo.ctx.db;
    if (opts.areas !== null) {
        await db.insertInto('cleanup_areas').values({ site_id: SITE_ID, version: 1, areas_json: JSON.stringify(opts.areas ?? AREAS) }).execute();
    }
    await db.updateTable('holes').set({ saved_region_json: JSON.stringify(REGION) }).where('id', '=', TEST_HOLE_1_ID).execute();
    await db.insertInto('course_features').values([
        { id: 'f-fairway', course_id: TEST_COURSE_ID, hole_id: TEST_HOLE_1_ID, layer: null, type: 'fairway', geometry_json: '{}', geojson: JSON.stringify(SQUARE_GEOJSON), sort_order: 1, version: 1 },
        { id: 'f-rough', course_id: TEST_COURSE_ID, hole_id: null, layer: 'roughs', type: 'rough', geometry_json: '{}', geojson: JSON.stringify(SQUARE_GEOJSON), sort_order: 0, version: 1 },
    ]).execute();
    const make = () => new PhotoCleanupService({
        db, cleanedPhoto: photo.svc, dataDir: photo.dataDir, pipelineDir: '/nonexistent/pipeline', python: '/nonexistent/python',
        runner: fakeRunner({ calls: photo.calls, failHole: opts.failHole, holeChanges: opts.holeChanges }),
    });
    return { ...photo, removeAll: photo.cleanup, cleanup: make(), make, jobsDir: path.join(photo.sourcesDir, 'photo-cleanup') };
}

/** Real HTTP routes with the user normally supplied by session middleware. */
export function photoCleanupTestApp(service: PhotoCleanupService) {
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id: 'test-user', username: 'tester' }); await next(); });
    mount(app, '/api', createPhotoCleanupApi(service));
    app.route('/api', createPhotoCleanupFileRoutes(service));
    return app;
}
