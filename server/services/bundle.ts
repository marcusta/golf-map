/**
 * Publish/ingest bundle contract (T59). Shared, side-effect-free constants and
 * types so the builder-side publish CLI (`scripts/publish.ts`) and the
 * serve-side `IngestService` agree on the on-the-wire layout without importing
 * each other.
 *
 * Bundle layout (inside the tar.zst):
 *   meta.json                       — BundleMeta
 *   content/<table>.jsonl           — one JSON row per line, per content table
 *   tiles/<layer>/<z>/<x>/<y>.<ext> — ortho capped at meta.orthoMaxzoom
 *   tiles/manifest.json             — manifest with ortho maxzoom rewritten to the cap
 *   dem/dem-analysis.tif            — the analysis DEM (v1: the full edited DEM, D2)
 */

import { createHash } from 'node:crypto';

/** Bump when the bundle layout or serialization changes incompatibly. */
export const BUNDLE_FORMAT_VERSION = 1;

/**
 * Optional seed file for initial pins (D3). Pins are user data (iOS laser-pin
 * placement), so they are never in the delete-missing content set. The builder
 * may ship a seed here; ingest inserts it only when the site has zero pins on
 * the VPS (first publish), then never touches pins again.
 */
export const SEED_PINS_PATH = 'seed/pins.jsonl';

/** Default ortho zoom cap for published tiles (D1). */
export const DEFAULT_ORTHO_MAXZOOM = 19;

/**
 * Content tables published as `content/<table>.jsonl`, in parent→child order
 * (safe insert order under FKs; delete in reverse). These are the site-scoped
 * "content" tables from §5 — user data is never in the bundle.
 *
 * `course_assets` is intentionally absent: ingest rewrites the site's asset
 * rows from scratch to point at the freshly published artifacts (§8.4), rather
 * than replaying builder-local filenames (`sources/…`, per-vintage ortho).
 *
 * `aim_points` is course definition, not player strategy — furniture in the
 * same sense as tees and green front/center/back. Their count is what makes a
 * hole a par 3/4/5/6 (0/1/2/3 aim points) and their position is what makes it
 * a dogleg, so a course published without them is not the same course.
 */
export const CONTENT_TABLES = [
    'sites',
    'courses',
    'holes',
    'tees',
    'greens',
    'aim_points',
    'course_features',
    'hazards',
] as const;

export type ContentTable = (typeof CONTENT_TABLES)[number];

/** Content jsonl file for a table, relative to the bundle root. */
export function contentFilePath(table: ContentTable): string {
    return `content/${table}.jsonl`;
}

/**
 * Fixed, ordered list of bundle-relative files whose bytes make up the content
 * hash — every content table (even when empty) plus the pins seed. Both
 * publish and ingest hash exactly this list so the integrity check is
 * deterministic and order-stable.
 */
export const CONTENT_HASH_FILES: readonly string[] = [
    ...CONTENT_TABLES.map(contentFilePath),
    SEED_PINS_PATH,
];

/** SHA-256 over the concatenated parts (used for `BundleMeta.contentHash`). */
export function contentHash(parts: Array<Buffer | string>): string {
    const h = createHash('sha256');
    for (const p of parts) h.update(p);
    return h.digest('hex');
}

/** Tile layers packaged in a bundle. Only `ortho` is zoom-capped. */
export const BUNDLE_TILE_LAYERS = ['ortho', 'terrain', 'hillshade'] as const;

export type BundleTileLayer = (typeof BUNDLE_TILE_LAYERS)[number];

export interface LayerZoomRange {
    minzoom: number | null;
    maxzoom: number | null;
}

export interface BundleMeta {
    formatVersion: number;
    siteId: string;
    /** Course ids belonging to the site — used to recreate courseId tile symlinks. */
    courseIds: string[];
    /** SHA-256 over the concatenated `content/*.jsonl` payloads, for integrity. */
    contentHash: string;
    /** Applied ortho zoom cap. */
    orthoMaxzoom: number;
    /** Per-layer zoom ranges present in the bundle (post-cap). */
    layerZoomRanges: Partial<Record<BundleTileLayer, LayerZoomRange>>;
    createdAt: string;
}

/**
 * For each content table, the USER tables whose rows would be destroyed by a
 * cascading FK if that content row were deleted during ingest. Ingest checks
 * these before deleting bundle-absent content rows and aborts (409) with a
 * blocker list rather than silently cascade-deleting user data (§5, §8.3).
 *
 * Only cascade-on-delete FKs are blockers — `set null` references (e.g.
 * `game_plan_holes.tee_id`) degrade gracefully and are not listed.
 */
export const CONTENT_BLOCKER_REFERENCES: Record<ContentTable, ReadonlyArray<{ table: string; column: string }>> = {
    sites: [],
    courses: [
        { table: 'game_plans', column: 'course_id' },
        { table: 'rounds', column: 'course_id' },
    ],
    holes: [],
    tees: [],
    // Nothing user-owned references an aim point; plan shots carry their own
    // coordinates rather than pointing at one.
    aim_points: [],
    greens: [
        { table: 'pins', column: 'green_id' },
        { table: 'green_scans', column: 'green_id' },
        { table: 'green_calibration', column: 'green_id' },
        { table: 'putt_estimate_samples', column: 'green_id' },
    ],
    course_features: [],
    hazards: [],
};

export interface IngestBlocker {
    table: ContentTable;
    id: string;
    /** User table + column that references the doomed content row. */
    referencedBy: string;
    count: number;
}

export interface IngestReport {
    siteId: string;
    /** Rows upserted per content table. */
    upserted: Record<string, number>;
    /** Rows deleted per content table (bundle-absent). */
    deleted: Record<string, number>;
    tilesInstalled: number;
    tilesBytes: number;
    symlinks: string[];
    demInstalled: boolean;
    assetsRewritten: number;
    archivesCleared: string[];
    swapOk: boolean;
}
