import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { AssetsService } from './assets.service';
import { createTileRoutes, cachingTileKeyLookup } from './tiles';

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

function writeFakeVintageTile(courseId: string, collection: string, z: number, x: number, y: number, ext: string, contents = 'vintage-tile-bytes') {
    const dir = path.join(dataDir, 'tiles', courseId, 'ortho', collection, String(z), String(x));
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

test('GET serves the baked hillshade layer as opaque webp', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'hillshade', 14, 100, 200, 'webp');

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/hillshade/14/100/200.webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
});

test('GET ?c=<collection> serves the per-vintage ortho tile from ortho/<collection>/', async () => {
    const { app } = await setup();
    // Same coords in the flat tree and a vintage subdir → ?c must pick the subdir.
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 100, 200, 'jpg', 'active-flat');
    writeFakeVintageTile(TEST_COURSE_ID, 'orto-l2-2023', 14, 100, 200, 'jpg', 'vintage-2023');

    const flat = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/14/100/200.jpg`);
    expect(await flat.text()).toBe('active-flat');

    const vintage = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/14/100/200.jpg?c=orto-l2-2023`);
    expect(vintage.status).toBe(200);
    expect(await vintage.text()).toBe('vintage-2023');
});

test('GET ?c=<collection> returns 404 when that vintage has no such tile', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 100, 200, 'jpg'); // flat exists, subdir does not
    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/14/100/200.jpg?c=orto-l2-2023`);
    expect(res.status).toBe(404);
});

test('GET ?c with an unsafe collection is rejected (400)', async () => {
    const { app } = await setup();
    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/14/100/200.jpg?c=..%2Fterrain`);
    expect(res.status).toBe(400);
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

// --- Course → site tile-key resolution ---

test('GET resolves a course id to its site tile directory via the lookup', async () => {
    const ctx = await createTestDb(seedCourse);
    const assetsService = new AssetsService(ctx.db, dataDir);
    const app = createTileRoutes(assetsService, async (id) =>
        id === TEST_COURSE_ID ? 'site-owning-the-map' : null);
    // Tiles live under the SITE id, not the course id.
    writeFakeTile('site-owning-the-map', 'ortho', 14, 100, 200, 'jpg', 'site-tile');

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/14/100/200.jpg`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('site-tile');
});

test('GET serves site-id URLs unchanged when the lookup has no mapping', async () => {
    const ctx = await createTestDb(seedCourse);
    const assetsService = new AssetsService(ctx.db, dataDir);
    const app = createTileRoutes(assetsService, async () => null);
    writeFakeTile('a-site-id', 'ortho', 14, 100, 200, 'jpg', 'direct-site-tile');

    const res = await app.request(`/tiles/a-site-id/ortho/14/100/200.jpg`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('direct-site-tile');
});

test('cachingTileKeyLookup caches both mappings and misses', async () => {
    let calls = 0;
    const lookup = cachingTileKeyLookup(async (id) => {
        calls += 1;
        return id === 'course-1' ? 'site-1' : null;
    });

    expect(await lookup('course-1')).toBe('site-1');
    expect(await lookup('course-1')).toBe('site-1');
    expect(await lookup('unknown')).toBeNull();
    expect(await lookup('unknown')).toBeNull();
    expect(calls).toBe(2);
});

// --- WebP-aware ortho resolution ------------------------------------------

test('GET ortho prefers .webp over legacy .jpg when both exist', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 100, 200, 'jpg', 'jpeg-bytes');
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 100, 200, 'webp', 'webp-bytes');

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/14/100/200.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(await res.text()).toBe('webp-bytes');
});

test('GET ortho falls back to .jpg when no .webp exists', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 100, 200, 'jpg', 'jpeg-bytes');

    // URL extension is cosmetic — request .webp, still served the .jpg on disk.
    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/14/100/200.webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(await res.text()).toBe('jpeg-bytes');
});

test('GET ortho serves .webp when only .webp exists', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 100, 200, 'webp', 'webp-bytes');

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/14/100/200.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(await res.text()).toBe('webp-bytes');
});

// --- Archive endpoint ------------------------------------------------------

interface ParsedTarEntry {
    name: string;
    size: number;
    typeflag: string;
    data: Buffer;
}

/** Parses a plain ustar archive (512-byte headers, zero-padded data). */
function parseTar(buf: Buffer): ParsedTarEntry[] {
    const entries: ParsedTarEntry[] = [];
    let offset = 0;
    while (offset + 512 <= buf.length) {
        const header = buf.subarray(offset, offset + 512);
        // A zero block marks the end of the archive.
        if (header.every((b) => b === 0)) break;

        const readStr = (start: number, len: number) =>
            header.subarray(start, start + len).toString('latin1').replace(/\0.*$/, '').trim();

        const name = readStr(0, 100);
        const size = parseInt(readStr(124, 12) || '0', 8);
        const typeflag = header.subarray(156, 157).toString('latin1');

        // Verify the header checksum.
        const storedChksum = parseInt(readStr(148, 8) || '0', 8);
        const check = Buffer.from(header);
        check.fill(0x20, 148, 156);
        let sum = 0;
        for (const b of check) sum += b;
        if (sum !== storedChksum) throw new Error(`bad checksum for ${name}`);

        // Verify ustar magic.
        const magic = header.subarray(257, 262).toString('latin1');
        if (magic !== 'ustar') throw new Error(`bad magic for ${name}: ${JSON.stringify(magic)}`);

        offset += 512;
        const data = Buffer.from(buf.subarray(offset, offset + size));
        offset += Math.ceil(size / 512) * 512;
        entries.push({ name, size, typeflag, data });
    }
    return entries;
}

test('archive.tar streams all tiles as a valid, byte-exact ustar archive', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 100, 200, 'webp', 'tile-a');
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 100, 201, 'jpg', 'tile-b-longer');
    writeFakeTile(TEST_COURSE_ID, 'ortho', 15, 50, 60, 'webp', 'tile-c');

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/archive.tar?v=abc123`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/x-tar');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');

    const buf = Buffer.from(await res.arrayBuffer());
    expect(Number(res.headers.get('Content-Length'))).toBe(buf.length);

    const parsed = parseTar(buf);
    const byName = new Map(parsed.map((e) => [e.name, e]));

    expect([...byName.keys()].sort()).toEqual(['14/100/200.webp', '14/100/201.jpg', '15/50/60.webp']);
    for (const e of parsed) {
        expect(e.typeflag).toBe('0');
    }
    expect(byName.get('14/100/200.webp')!.data.toString()).toBe('tile-a');
    expect(byName.get('14/100/201.jpg')!.data.toString()).toBe('tile-b-longer');
    expect(byName.get('14/100/201.jpg')!.size).toBe('tile-b-longer'.length);
    expect(byName.get('15/50/60.webp')!.data.toString()).toBe('tile-c');

    // Terminated by two 512-byte zero blocks.
    const tail = buf.subarray(buf.length - 1024);
    expect(tail.every((b) => b === 0)).toBe(true);
});

test('archive.tar includes one entry per coordinate, preferring .webp over legacy .jpg', async () => {
    const { app } = await setup();
    // Same coordinate in both formats (post-re-encode tree with jpg kept).
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 100, 200, 'jpg', 'legacy-jpg');
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 100, 200, 'webp', 'new-webp');
    // jpg-only coordinate still included.
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 100, 201, 'jpg', 'only-jpg');

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/archive.tar?v=dedup1`);
    expect(res.status).toBe(200);
    const parsed = parseTar(Buffer.from(await res.arrayBuffer()));
    expect(parsed.map((e) => e.name).sort()).toEqual(['14/100/200.webp', '14/100/201.jpg']);
    expect(parsed.find((e) => e.name === '14/100/200.webp')!.data.toString()).toBe('new-webp');
});

test('archive.tar respects maxzoom filtering', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 1, 1, 'webp', 'z14');
    writeFakeTile(TEST_COURSE_ID, 'ortho', 15, 1, 1, 'webp', 'z15');
    writeFakeTile(TEST_COURSE_ID, 'ortho', 16, 1, 1, 'webp', 'z16');

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/archive.tar?v=v1&maxzoom=15`);
    expect(res.status).toBe(200);
    const parsed = parseTar(Buffer.from(await res.arrayBuffer()));
    expect(parsed.map((e) => e.name).sort()).toEqual(['14/1/1.webp', '15/1/1.webp']);
});

test('archive.tar serves the second request from the on-disk cache', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 1, 1, 'webp', 'original');

    const first = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/archive.tar?v=cachekey`);
    expect(first.status).toBe(200);
    const firstBytes = Buffer.from(await first.arrayBuffer());

    // The cache file exists under tile-archives.
    const archiveFile = path.join(dataDir, 'tile-archives', TEST_COURSE_ID, 'ortho-cachekey-zall.tar');
    expect(fs.existsSync(archiveFile)).toBe(true);

    // Mutate the source tile on disk; the cached archive must be served unchanged.
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 1, 1, 'webp', 'MUTATED-different-length');

    const second = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/archive.tar?v=cachekey`);
    expect(second.status).toBe(200);
    const secondBytes = Buffer.from(await second.arrayBuffer());
    expect(secondBytes.equals(firstBytes)).toBe(true);
    expect(parseTar(secondBytes)[0]!.data.toString()).toBe('original');
});

test('archive.tar returns 404 when the layer has zero tiles', async () => {
    const { app } = await setup();
    // Terrain tiles exist but ortho does not — ortho archive must 404.
    writeFakeTile(TEST_COURSE_ID, 'terrain', 14, 1, 1, 'png');

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/archive.tar?v=v1`);
    expect(res.status).toBe(404);
});

test('archive.tar returns 400 for missing version', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 1, 1, 'webp');

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/archive.tar`);
    expect(res.status).toBe(400);
});

test('archive.tar returns 400 for invalid layer', async () => {
    const { app } = await setup();
    const res = await app.request(`/tiles/${TEST_COURSE_ID}/bogus/archive.tar?v=v1`);
    expect(res.status).toBe(400);
});

test('archive.tar returns 400 for non-integer maxzoom', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 1, 1, 'webp');
    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/archive.tar?v=v1&maxzoom=abc`);
    expect(res.status).toBe(400);
});

test('archive.tar rejects path traversal via the version param', async () => {
    const { app } = await setup();
    writeFakeTile(TEST_COURSE_ID, 'ortho', 14, 1, 1, 'webp');

    // A slash in v must be rejected (can't escape the tile-archives dir).
    const res = await app.request(
        `/tiles/${TEST_COURSE_ID}/ortho/archive.tar?v=${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(res.status).toBe(400);
    // Nothing was written outside the archive dir.
    expect(fs.existsSync(path.join(dataDir, 'etc', 'passwd.tar'))).toBe(false);
});

test('archive.tar resolves a course id to its site tile directory via the lookup', async () => {
    const ctx = await createTestDb(seedCourse);
    const assetsService = new AssetsService(ctx.db, dataDir);
    const app = createTileRoutes(assetsService, async (id) =>
        id === TEST_COURSE_ID ? 'site-owning-the-map' : null);
    writeFakeTile('site-owning-the-map', 'ortho', 14, 1, 1, 'webp', 'site-tile');

    const res = await app.request(`/tiles/${TEST_COURSE_ID}/ortho/archive.tar?v=v1`);
    expect(res.status).toBe(200);
    const parsed = parseTar(Buffer.from(await res.arrayBuffer()));
    expect(parsed.map((e) => e.name)).toEqual(['14/1/1.webp']);
    expect(parsed[0]!.data.toString()).toBe('site-tile');
});
