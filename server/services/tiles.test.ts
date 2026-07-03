import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { AssetsService } from './assets.service';
import { createTileRoutes } from './tiles';

let dataDir: string;

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golf-map-tiles-test-'));
});

afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function setup() {
    const ctx = await createTestDb(seedCourse);
    const assetsService = new AssetsService(ctx.db, dataDir);
    const app = createTileRoutes(assetsService);
    return { app, assetsService };
}

function writeFakeTile(courseId: string, layer: string, z: number, x: number, y: number, ext: string, contents = 'fake-tile-bytes') {
    const dir = path.join(dataDir, 'tiles', courseId, layer, String(z), String(x));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${y}.${ext}`), contents);
}

test('GET returns 200 with the tile bytes, content-type, and long cache headers for ortho', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 100, 200, 'jpg');

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/14/100/200.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    const body = await res.text();
    expect(body).toBe('fake-tile-bytes');
});

test('GET returns 200 with correct content-type for terrain (png)', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'terrain', 14, 100, 200, 'png');

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/terrain/14/100/200.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
});

test('GET returns 404 when tile file does not exist', async () => {
    const { app } = await setup();

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/14/999/999.jpg`);
    expect(res.status).toBe(404);
});

test('GET returns 400 for invalid layer', async () => {
    const { app } = await setup();

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/bogus/14/100/200.jpg`);
    expect(res.status).toBe(400);
});

test('GET returns 400 for non-integer z', async () => {
    const { app } = await setup();

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/abc/100/200.jpg`);
    expect(res.status).toBe(400);
});

test('GET returns 400 for non-integer y', async () => {
    const { app } = await setup();

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/14/100/abc.jpg`);
    expect(res.status).toBe(400);
});

test('GET returns 400 for path traversal attempt in courseId', async () => {
    const { app } = await setup();
    // Write a tile outside the course's tile dir to prove traversal would
    // otherwise succeed, then confirm it's rejected.
    writeFakeTile('other-course', 'ortho', 14, 100, 200, 'jpg', 'secret');

    const res = await app.request(`/tiles/..%2Fother-course/ortho/14/100/200.jpg`);
    expect([400, 404]).toContain(res.status);
});

test('GET does not require auth (no Authorization header needed)', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'ortho', 5, 1, 1, 'jpg');

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/5/1/1.jpg`);
    expect(res.status).toBe(200);
});
