import { Hono } from 'hono';
import {
    existsSync,
    statSync,
    readdirSync,
    readFileSync,
    mkdirSync,
    openSync,
    writeSync,
    closeSync,
    renameSync,
} from 'node:fs';
import * as path from 'node:path';
import type { AssetsService, TileLayer } from './assets.service';

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
};

// Long, immutable cache — tiles are content-addressed by course/layer/z/x/y
// and never change in place; a new tile-generation run produces a new asset.
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const VALID_LAYERS = new Set<TileLayer>(['ortho', 'terrain', 'hillshade']);

function parseTileCoordinate(raw: string): number | null {
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
}

/**
 * Maps the id in a tile URL to the key the tiles are stored under on disk.
 * Tiles are keyed by SITE id (the site owns the map; courses share it), but
 * iOS builds tile URLs from the course id — the resolver bridges the two.
 * Returning null means "no mapping" and the id is used as-is (it is already
 * a site id, or a legacy course whose site id equals its own).
 */
export type TileKeyLookup = (id: string) => Promise<string | null>;

/**
 * Wraps a lookup with a TTL cache: tile requests arrive by the thousands per
 * course and the course→site mapping changes rarely. Both hits and misses
 * are cached (a site-keyed request would otherwise hit the database on every
 * tile).
 */
export function cachingTileKeyLookup(lookup: TileKeyLookup, ttlMs = 60_000): TileKeyLookup {
    const cache = new Map<string, { key: string | null; expires: number }>();
    return async (id) => {
        const now = Date.now();
        const cached = cache.get(id);
        if (cached && cached.expires > now) return cached.key;
        const key = await lookup(id);
        cache.set(id, { key, expires: now + ttlMs });
        return key;
    };
}

/**
 * Builds a standalone Hono app exposing GET /tiles/:courseId/:layer/:z/:x/:y
 * (extension resolved server-side by layer — jpg for ortho, png for terrain).
 *
 * Deliberately unauthenticated: map clients (web MapLibre, iOS MapLibre
 * Native) fetch tiles directly from <img>/tile-layer requests that don't
 * carry session cookies/headers, and tile bytes for a course aren't
 * sensitive once that course exists — same posture as static asset hosting.
 * The integration agent should mount this ahead of/alongside authenticated
 * descriptor routes, not behind requireAuth().
 *
 * Usage from main.ts (composition root):
 *   import { createTileRoutes } from './services/tiles';
 *   app.route('/', createTileRoutes(assetsService, cachingTileKeyLookup(...)));
 *
 * The URL id may be a course id or a site id; `tileKeyLookup` resolves course
 * ids to the site id the tiles are stored under (see TileKeyLookup).
 */
export function createTileRoutes(assetsService: AssetsService, tileKeyLookup?: TileKeyLookup): Hono {
    const app = new Hono();

    app.get('/tiles/:courseId/:layer/:z/:x/:y', async (c) => {
        const { courseId, layer, z, x } = c.req.param();
        const yParam = c.req.param('y');

        if (!VALID_LAYERS.has(layer as TileLayer)) {
            return c.json({ error: 'Invalid layer' }, 400);
        }

        const yMatch = /^(\d+)\.(jpg|jpeg|png|webp)$/.exec(yParam);
        if (!yMatch) {
            return c.json({ error: 'Invalid tile coordinate' }, 400);
        }
        const y = Number(yMatch[1]);

        const zNum = parseTileCoordinate(z);
        const xNum = parseTileCoordinate(x);
        if (zNum === null || xNum === null) {
            return c.json({ error: 'Invalid tile coordinate' }, 400);
        }

        const tileKey = (tileKeyLookup && (await tileKeyLookup(courseId))) ?? courseId;

        // `?c=<collection>` selects a non-active ortho vintage tiled under
        // ortho/<collection>/. Absent → the flat (build-time active) ortho tree.
        const collection = c.req.query('c') || undefined;

        let candidates: string[];
        try {
            candidates = assetsService.resolveTilePathCandidates(tileKey, layer as TileLayer, zNum, xNum, y, collection);
        } catch {
            return c.json({ error: 'Invalid tile request' }, 400);
        }

        // Prefer the first candidate that exists (ortho: .webp, else legacy .jpg).
        const filePath = candidates.find((p) => existsSync(p) && statSync(p).isFile());
        if (!filePath) {
            return c.json({ error: 'Not found' }, 404);
        }

        const file = Bun.file(filePath);
        const ext = filePath.slice(filePath.lastIndexOf('.'));
        const contentType = CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';

        return new Response(file, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': CACHE_CONTROL,
            },
        });
    });

    // GET /tiles/:courseId/:layer/archive.tar?v=<version>&maxzoom=<n>
    //
    // Streams every existing tile for a layer as ONE plain, uncompressed POSIX
    // ustar archive so a mobile client downloads a single file instead of
    // thousands of tile requests. Same auth posture (none) and course→site
    // resolution as the per-tile route.
    //
    //  - `v` (required): opaque version string, cache-key component only.
    //  - `maxzoom` (optional): include zooms <= maxzoom (all zooms if absent).
    //
    // Entry names are exactly `<z>/<x>/<y>.<ext>`. The archive is built once and
    // cached on disk (tmp + atomic rename), then served with Content-Length and
    // the same immutable Cache-Control as tiles.
    app.get('/tiles/:courseId/:layer/archive.tar', async (c) => {
        const { courseId, layer } = c.req.param();

        if (!VALID_LAYERS.has(layer as TileLayer)) {
            return c.json({ error: 'Invalid layer' }, 400);
        }

        const v = c.req.query('v');
        if (!v || !/^[A-Za-z0-9._-]+$/.test(v)) {
            return c.json({ error: 'Invalid or missing version (v)' }, 400);
        }

        const maxzoomRaw = c.req.query('maxzoom');
        let maxzoom: number | undefined;
        if (maxzoomRaw !== undefined) {
            if (!/^\d+$/.test(maxzoomRaw)) {
                return c.json({ error: 'Invalid maxzoom' }, 400);
            }
            maxzoom = Number(maxzoomRaw);
        }
        const zoomKey = maxzoom === undefined ? 'all' : String(maxzoom);

        const tileKey = (tileKeyLookup && (await tileKeyLookup(courseId))) ?? courseId;

        let layerDir: string;
        let archivePath: string;
        try {
            layerDir = assetsService.resolveTileLayerDir(tileKey, layer as TileLayer);
            archivePath = assetsService.resolveTileArchivePath(tileKey, layer as TileLayer, v, zoomKey);
        } catch {
            return c.json({ error: 'Invalid archive request' }, 400);
        }

        // Serve a previously built archive directly.
        if (!(existsSync(archivePath) && statSync(archivePath).isFile())) {
            const entries = enumerateTiles(layerDir, maxzoom);
            if (entries.length === 0) {
                // No tiles for this layer — lets a client distinguish "no map".
                return c.json({ error: 'No tiles for layer' }, 404);
            }
            buildTarArchive(archivePath, entries);
        }

        const size = statSync(archivePath).size;
        return new Response(Bun.file(archivePath), {
            headers: {
                'Content-Type': 'application/x-tar',
                'Content-Length': String(size),
                'Cache-Control': CACHE_CONTROL,
            },
        });
    });

    return app;
}

// --- Tile enumeration + minimal ustar tar writer ---------------------------

interface TarEntry {
    /** Archive entry name, exactly `<z>/<x>/<y>.<ext>` (relative, no leading ./). */
    name: string;
    absPath: string;
    size: number;
    /** Modification time in whole seconds since the epoch. */
    mtime: number;
}

const TILE_FILE_RE = /^(\d+)\.(jpg|jpeg|png|webp)$/;

// When one tile coordinate exists in several formats on disk (webp re-encode
// alongside a legacy jpg), the archive must contain exactly one entry per
// coordinate — preferring the smaller/newer webp, mirroring the preference in
// resolveTilePathCandidates.
const TILE_EXT_PREFERENCE = ['webp', 'jpg', 'jpeg', 'png'];

/**
 * Walks `<layerDir>/<z>/<x>/<y>.<ext>` and returns one entry per existing
 * tile coordinate with zoom <= maxzoom (all zooms when undefined),
 * deterministically ordered by z, then x, then y.
 */
function enumerateTiles(layerDir: string, maxzoom: number | undefined): TarEntry[] {
    const entries: TarEntry[] = [];
    if (!existsSync(layerDir)) return entries;

    const numericDirs = (dir: string): number[] =>
        readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
            .map((d) => Number(d.name))
            .sort((a, b) => a - b);

    for (const z of numericDirs(layerDir)) {
        if (maxzoom !== undefined && z > maxzoom) continue;
        const zDir = path.join(layerDir, String(z));
        for (const x of numericDirs(zDir)) {
            const xDir = path.join(zDir, String(x));
            const byTile = new Map<number, string>();
            for (const f of readdirSync(xDir, { withFileTypes: true })) {
                const match = f.isFile() ? TILE_FILE_RE.exec(f.name) : null;
                if (!match) continue;
                const y = Number(match[1]);
                const existing = byTile.get(y);
                if (
                    existing === undefined ||
                    TILE_EXT_PREFERENCE.indexOf(match[2]) <
                        TILE_EXT_PREFERENCE.indexOf(existing.split('.')[1])
                ) {
                    byTile.set(y, f.name);
                }
            }
            const files = [...byTile.entries()].sort((a, b) => a[0] - b[0]).map(([, name]) => name);
            for (const fname of files) {
                const absPath = path.join(xDir, fname);
                const st = statSync(absPath);
                entries.push({
                    name: `${z}/${x}/${fname}`,
                    absPath,
                    size: st.size,
                    mtime: Math.max(0, Math.floor(st.mtimeMs / 1000)),
                });
            }
        }
    }
    return entries;
}

/** Writes an octal field of `len` bytes: `len-1` zero-padded octal digits + NUL. */
function writeOctalField(buf: Buffer, value: number, offset: number, len: number): void {
    const str = value.toString(8).padStart(len - 1, '0') + '\0';
    buf.write(str, offset, len, 'latin1');
}

/** Builds a 512-byte POSIX ustar header for a regular file. */
function tarHeader(entry: TarEntry): Buffer {
    const buf = Buffer.alloc(512);
    buf.write(entry.name, 0, 100, 'utf8'); // name
    writeOctalField(buf, 0o644, 100, 8); // mode
    writeOctalField(buf, 0, 108, 8); // uid
    writeOctalField(buf, 0, 116, 8); // gid
    writeOctalField(buf, entry.size, 124, 12); // size
    writeOctalField(buf, entry.mtime, 136, 12); // mtime
    buf.fill(0x20, 148, 156); // checksum field = spaces while summing
    buf.write('0', 156, 1, 'latin1'); // typeflag: regular file
    buf.write('ustar\0', 257, 6, 'latin1'); // magic
    buf.write('00', 263, 2, 'latin1'); // version

    let sum = 0;
    for (let i = 0; i < 512; i++) sum += buf[i]!;
    // Checksum: 6 octal digits, NUL, space.
    buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
    return buf;
}

/**
 * Builds the tar archive at `archivePath` (creating parent dirs), writing to a
 * unique .tmp file and atomically renaming so concurrent requests never observe
 * a partial file. Data is zero-padded to 512-byte blocks; the archive ends with
 * two 512-byte zero blocks.
 */
function buildTarArchive(archivePath: string, entries: TarEntry[]): void {
    mkdirSync(path.dirname(archivePath), { recursive: true });
    const tmpPath = `${archivePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const fd = openSync(tmpPath, 'w');
    try {
        for (const entry of entries) {
            writeSync(fd, tarHeader(entry));
            const data = readFileSync(entry.absPath);
            writeSync(fd, data);
            const remainder = entry.size % 512;
            if (remainder !== 0) writeSync(fd, Buffer.alloc(512 - remainder));
        }
        writeSync(fd, Buffer.alloc(1024)); // two trailing zero blocks
    } finally {
        closeSync(fd);
    }
    renameSync(tmpPath, archivePath);
}
