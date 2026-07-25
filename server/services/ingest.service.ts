import type { Kysely, Transaction } from 'kysely';
import * as path from 'node:path';
import { existsSync, statSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { Database } from '../db/schema';
import {
    BUNDLE_FORMAT_VERSION,
    CONTENT_TABLES,
    CONTENT_HASH_FILES,
    CONTENT_BLOCKER_REFERENCES,
    SEED_PINS_PATH,
    contentFilePath,
    contentHash,
    type BundleMeta,
    type ContentTable,
    type IngestBlocker,
    type IngestReport,
} from './bundle';
import { extractTarZst } from './bundle-archive';

/** 409 raised when deleting a bundle-absent content row would cascade user data. */
export class IngestBlockedError extends ConflictError {
    detail: { blockers: IngestBlocker[] };
    constructor(blockers: IngestBlocker[]) {
        super('Ingest blocked: deleting content would remove referencing user data');
        this.name = 'IngestBlockedError';
        this.detail = { blockers };
    }
}

interface IngestDeps {
    db: Kysely<Database>;
    dataDir: string;
}

type Row = Record<string, unknown>;

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Serve-mode ingest (§8): consumes a publish bundle (tar.zst) and applies it —
 * atomic tile swap + courseId symlinks, a single transactional content
 * upsert/delete-missing guarded against cascading user-data loss, a
 * `course_assets` rewrite pointing at the published artifacts, and
 * archive-cache invalidation. Content lands first and atomically, so a blocker
 * aborts with a 409 before any filesystem mutation.
 */
export class IngestService {
    private db: Kysely<Database>;
    private dataDir: string;

    constructor(deps: IngestDeps) {
        this.db = deps.db;
        this.dataDir = deps.dataDir;
    }

    /**
     * Extracts a tar.zst archive to `data/incoming/…`, ingests it, and removes
     * the staging dir. Used by the HTTP endpoint after streaming the body to disk.
     */
    async ingestArchive(archivePath: string): Promise<IngestReport> {
        const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const stageDir = path.join(this.dataDir, 'incoming', stamp);
        mkdirSync(stageDir, { recursive: true });
        try {
            await extractTarZst(archivePath, stageDir);
            return await this.ingest(stageDir);
        } finally {
            rmSync(stageDir, { recursive: true, force: true });
        }
    }

    /** Ingests an already-extracted bundle directory. */
    async ingest(bundleDir: string): Promise<IngestReport> {
        const meta = await this.readMeta(bundleDir);
        await this.verifyContentHash(bundleDir, meta);

        const siteId = meta.siteId;
        if (!SAFE_ID_RE.test(siteId)) throw new Error(`Unsafe siteId in bundle: ${siteId}`);
        for (const cid of meta.courseIds) {
            if (!SAFE_ID_RE.test(cid)) throw new Error(`Unsafe courseId in bundle: ${cid}`);
        }

        const content = await this.readContent(bundleDir);
        const seedPins = await this.readJsonl(path.join(bundleDir, SEED_PINS_PATH));

        // 1. Content first: atomic, and a blocker aborts here before any FS change.
        const { upserted, deleted } = await this.applyContent(siteId, meta.courseIds, content, seedPins);

        // 2. Atomic tile swap + courseId symlinks.
        const swap = this.swapTiles(bundleDir, siteId, meta.courseIds);

        // 3. Analysis DEM.
        const demInstalled = await this.installDem(bundleDir, siteId);

        // 4. course_assets rewrite → published artifacts.
        const assetsRewritten = await this.rewriteAssets(siteId, meta.courseIds, demInstalled, bundleDir);

        // 5. Archive-cache invalidation (D4: drop stale versions entirely).
        const archivesCleared = this.clearArchives(siteId, meta.courseIds);

        return {
            siteId,
            upserted,
            deleted,
            tilesInstalled: swap.count,
            tilesBytes: swap.bytes,
            symlinks: swap.symlinks,
            demInstalled,
            assetsRewritten,
            archivesCleared,
            swapOk: true,
        };
    }

    // --- Bundle reading ------------------------------------------------------

    private async readMeta(bundleDir: string): Promise<BundleMeta> {
        const file = Bun.file(path.join(bundleDir, 'meta.json'));
        if (!(await file.exists())) throw new NotFoundError('Bundle meta.json missing');
        const meta = (await file.json()) as BundleMeta;
        if (meta.formatVersion !== BUNDLE_FORMAT_VERSION) {
            throw new ConflictError(
                `Unsupported bundle format ${meta.formatVersion} (expected ${BUNDLE_FORMAT_VERSION})`,
            );
        }
        if (!meta.siteId) throw new ConflictError('Bundle meta.json missing siteId');
        return meta;
    }

    private async verifyContentHash(bundleDir: string, meta: BundleMeta): Promise<void> {
        const parts: Buffer[] = [];
        for (const rel of CONTENT_HASH_FILES) {
            const file = Bun.file(path.join(bundleDir, rel));
            parts.push((await file.exists()) ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0));
        }
        const actual = contentHash(parts);
        if (actual !== meta.contentHash) {
            throw new ConflictError('Bundle content hash mismatch (corrupt or tampered upload)');
        }
    }

    private async readContent(bundleDir: string): Promise<Record<ContentTable, Row[]>> {
        const out = {} as Record<ContentTable, Row[]>;
        for (const table of CONTENT_TABLES) {
            out[table] = await this.readJsonl(path.join(bundleDir, contentFilePath(table)));
        }
        return out;
    }

    private async readJsonl(filePath: string): Promise<Row[]> {
        const file = Bun.file(filePath);
        if (!(await file.exists())) return [];
        const text = await file.text();
        return text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as Row);
    }

    // --- Content transaction -------------------------------------------------

    private async applyContent(
        siteId: string,
        metaCourseIds: string[],
        content: Record<ContentTable, Row[]>,
        seedPins: Row[],
    ): Promise<{ upserted: Record<string, number>; deleted: Record<string, number> }> {
        const upserted: Record<string, number> = {};
        const deleted: Record<string, number> = {};

        await this.db.transaction().execute(async (trx) => {
            // Existing site scope, derived top-down from the CURRENT DB so the
            // delete-missing set is computed before any upsert widens it.
            const courseIds = await this.scopeCourseIds(trx, siteId, metaCourseIds);
            const holeIds = await this.idsIn(trx, 'holes', 'course_id', courseIds);
            const greenIds = await this.idsIn(trx, 'greens', 'hole_id', holeIds);

            const existing: Record<ContentTable, string[]> = {
                sites: (await this.idsIn(trx, 'sites', 'id', [siteId])),
                courses: courseIds,
                holes: holeIds,
                greens: greenIds,
                tees: await this.idsIn(trx, 'tees', 'hole_id', holeIds),
                course_features: await this.idsIn(trx, 'course_features', 'course_id', courseIds),
                hazards: await this.idsIn(trx, 'hazards', 'hole_id', holeIds),
            };

            const toDelete: Record<ContentTable, string[]> = {} as Record<ContentTable, string[]>;
            for (const table of CONTENT_TABLES) {
                const incomingIds = new Set(content[table].map((r) => String(r.id)));
                toDelete[table] = existing[table].filter((id) => !incomingIds.has(id));
            }

            // Guard: block if a doomed content row is referenced by user data
            // (would cascade-delete rounds / plans / pins / scans, §5/§8.3).
            const blockers = await this.findBlockers(trx, toDelete);
            if (blockers.length > 0) throw new IngestBlockedError(blockers);

            // Upsert incoming (parent→child). Dynamic table/column access is
            // outside Kysely's static typing, so cast at the boundary.
            const dyn = trx as unknown as Kysely<Database>;
            for (const table of CONTENT_TABLES) {
                let n = 0;
                for (const row of content[table]) {
                    await (dyn.insertInto(table as never) as any)
                        .values(row)
                        .onConflict((oc: any) => oc.column('id').doUpdateSet(row))
                        .execute();
                    n++;
                }
                upserted[table] = n;
            }

            // Delete bundle-absent (child→parent).
            for (const table of [...CONTENT_TABLES].reverse()) {
                const ids = toDelete[table];
                if (ids.length === 0) {
                    deleted[table] = 0;
                    continue;
                }
                await (dyn.deleteFrom(table as never) as any).where('id', 'in', ids).execute();
                deleted[table] = ids.length;
            }

            // Pin seeding (D3): only when the site has zero pins on the VPS.
            if (seedPins.length > 0) {
                await this.seedPinsIfEmpty(trx, siteId, metaCourseIds, seedPins);
            }
        });

        return { upserted, deleted };
    }

    /** Current course ids for the site (by site_id), unioned with the bundle's list. */
    private async scopeCourseIds(trx: Transaction<Database>, siteId: string, metaCourseIds: string[]): Promise<string[]> {
        const rows = await trx.selectFrom('courses').select('id').where('site_id', '=', siteId).execute();
        const ids = new Set(rows.map((r) => r.id));
        for (const cid of metaCourseIds) ids.add(cid);
        // Keep only ids that actually exist as course rows (metaCourseIds may
        // include a not-yet-inserted course — those have no existing children).
        const existing = await this.idsIn(trx, 'courses', 'id', [...ids]);
        return existing;
    }

    private async idsIn(
        trx: Transaction<Database>,
        table: string,
        column: string,
        values: string[],
    ): Promise<string[]> {
        if (values.length === 0) return [];
        const rows = await (trx as any)
            .selectFrom(table)
            .select('id')
            .where(column, 'in', values)
            .execute();
        return (rows as Array<{ id: string }>).map((r) => r.id);
    }

    private async findBlockers(
        trx: Transaction<Database>,
        toDelete: Record<ContentTable, string[]>,
    ): Promise<IngestBlocker[]> {
        const blockers: IngestBlocker[] = [];
        for (const table of CONTENT_TABLES) {
            const doomed = toDelete[table];
            if (doomed.length === 0) continue;
            for (const ref of CONTENT_BLOCKER_REFERENCES[table]) {
                const rows = await (trx as any)
                    .selectFrom(ref.table)
                    .select(ref.column)
                    .where(ref.column, 'in', doomed)
                    .execute();
                const counts = new Map<string, number>();
                for (const r of rows as Array<Record<string, string>>) {
                    const id = r[ref.column];
                    counts.set(id, (counts.get(id) ?? 0) + 1);
                }
                for (const [id, count] of counts) {
                    blockers.push({ table, id, referencedBy: `${ref.table}.${ref.column}`, count });
                }
            }
        }
        return blockers;
    }

    private async seedPinsIfEmpty(
        trx: Transaction<Database>,
        siteId: string,
        metaCourseIds: string[],
        seedPins: Row[],
    ): Promise<void> {
        // Recompute green scope AFTER upsert so seed pins reference live greens.
        const courseIds = await this.scopeCourseIds(trx, siteId, metaCourseIds);
        const holeIds = await this.idsIn(trx, 'holes', 'course_id', courseIds);
        const greenIds = await this.idsIn(trx, 'greens', 'hole_id', holeIds);
        if (greenIds.length === 0) return;

        const existing = await trx
            .selectFrom('pins')
            .select('id')
            .where('green_id', 'in', greenIds)
            .executeTakeFirst();
        if (existing) return; // site already has pins — never overwrite user data

        const greenSet = new Set(greenIds);
        for (const pin of seedPins) {
            if (!greenSet.has(String(pin.green_id))) continue;
            await (trx as any).insertInto('pins').values(pin).execute();
        }
    }

    // --- Tiles ---------------------------------------------------------------

    private swapTiles(
        bundleDir: string,
        siteId: string,
        courseIds: string[],
    ): { count: number; bytes: number; symlinks: string[] } {
        const bundleTiles = path.join(bundleDir, 'tiles');
        if (!existsSync(bundleTiles)) {
            throw new ConflictError('Bundle has no tiles/ directory');
        }
        const tilesRoot = path.join(this.dataDir, 'tiles');
        mkdirSync(tilesRoot, { recursive: true });

        // Sweep leftovers from a crashed prior swap for this site before starting
        // a new one, so they never leak disk or collide with the fresh stamp.
        this.cleanupTileLeftovers(tilesRoot, siteId);

        const live = path.join(tilesRoot, siteId);
        const stamp = `${Date.now()}-${process.pid}`;
        const staging = path.join(tilesRoot, `.staging-${siteId}-${stamp}`);
        const trash = `${live}.trash-${stamp}`;

        // Move the extracted tree onto the tiles filesystem, then swap into place.
        // The swap tolerates a missing `live` dir (a crash mid-swap can leave it
        // absent) — it simply skips the trash step and installs the fresh tree.
        renameSync(bundleTiles, staging);
        let hadTrash = false;
        if (existsSync(live) || this.isSymlink(live)) {
            renameSync(live, trash);
            hadTrash = true;
        }
        renameSync(staging, live);
        if (hadTrash) rmSync(trash, { recursive: true, force: true });

        // Recreate courseId → siteId symlinks (relative, sibling target).
        const symlinks: string[] = [];
        for (const cid of courseIds) {
            if (cid === siteId) continue;
            const linkPath = path.join(tilesRoot, cid);
            if (existsSync(linkPath) || this.isSymlink(linkPath)) {
                rmSync(linkPath, { recursive: true, force: true });
            }
            symlinkSync(siteId, linkPath);
            symlinks.push(cid);
        }

        const { count, bytes } = this.measureTiles(live);
        return { count, bytes, symlinks };
    }

    /**
     * Removes this site's orphaned swap scratch dirs — `.staging-<site>-*` and
     * `<site>.trash-*` — left behind by an ingest that crashed mid-swap. Runs
     * before each swap so a crashed publish can't leak disk or leave a stale
     * copy lying around; a live dir absent (crash after moving it to trash) is
     * fine, the swap recreates it from the fresh bundle.
     */
    private cleanupTileLeftovers(tilesRoot: string, siteId: string): void {
        if (!existsSync(tilesRoot)) return;
        const stagingPrefix = `.staging-${siteId}-`;
        const trashPrefix = `${siteId}.trash-`;
        for (const name of readdirSync(tilesRoot)) {
            if (name.startsWith(stagingPrefix) || name.startsWith(trashPrefix)) {
                rmSync(path.join(tilesRoot, name), { recursive: true, force: true });
            }
        }
    }

    /** True if `p` exists as a path entry (including a dangling symlink, which
     *  `existsSync` reports as absent). */
    private isSymlink(p: string): boolean {
        const st = lstatSync(p, { throwIfNoEntry: false });
        return st !== undefined && st.isSymbolicLink();
    }

    private measureTiles(root: string): { count: number; bytes: number } {
        let count = 0;
        let bytes = 0;
        const walk = (dir: string): void => {
            for (const ent of readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) walk(full);
                else if (ent.isFile() && /\.(jpg|jpeg|png|webp)$/.test(ent.name)) {
                    count++;
                    bytes += statSync(full).size;
                }
            }
        };
        if (existsSync(root)) walk(root);
        return { count, bytes };
    }

    // --- DEM -----------------------------------------------------------------

    private async installDem(bundleDir: string, siteId: string): Promise<boolean> {
        const src = path.join(bundleDir, 'dem', 'dem-analysis.tif');
        if (!existsSync(src)) return false;
        const destDir = path.join(this.dataDir, 'dem', siteId);
        mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, 'dem-analysis.tif');
        const tmp = `${dest}.tmp-${process.pid}`;
        // Copy then atomic rename so a concurrent analysis read never sees a
        // half-written DEM.
        await Bun.write(tmp, Bun.file(src));
        renameSync(tmp, dest);
        return true;
    }

    // --- course_assets -------------------------------------------------------

    private async rewriteAssets(
        siteId: string,
        courseIds: string[],
        demInstalled: boolean,
        bundleDir: string,
    ): Promise<number> {
        // The capped manifest is already in place after the tile swap.
        const manifestPath = path.join(this.dataDir, 'tiles', siteId, 'manifest.json');
        const manifestJson = existsSync(manifestPath)
            ? await Bun.file(manifestPath).text()
            : null;
        // course_id satisfies the legacy (cascade) FK — use a real course of the
        // site; assets resolve by site_id.
        const ownerCourseId = courseIds[0] ?? siteId;

        let count = 0;
        await this.db.transaction().execute(async (trx) => {
            await trx.deleteFrom('course_assets').where('site_id', '=', siteId).execute();

            await trx.insertInto('course_assets').values({
                id: crypto.randomUUID(),
                course_id: ownerCourseId,
                site_id: siteId,
                kind: 'tile_manifest',
                filename: `tiles/${siteId}/manifest.json`,
                meta_json: manifestJson,
                version: 1,
            }).execute();
            count++;

            if (demInstalled) {
                await trx.insertInto('course_assets').values({
                    id: crypto.randomUUID(),
                    course_id: ownerCourseId,
                    site_id: siteId,
                    kind: 'dem_cog',
                    filename: `dem/${siteId}/dem-analysis.tif`,
                    meta_json: null,
                    version: 1,
                }).execute();
                count++;
            }
        });
        return count;
    }

    // --- Archive cache -------------------------------------------------------

    private clearArchives(siteId: string, courseIds: string[]): string[] {
        const cleared: string[] = [];
        const ids = new Set<string>([siteId, ...courseIds]);
        for (const id of ids) {
            if (!SAFE_ID_RE.test(id)) continue;
            const dir = path.join(this.dataDir, 'tile-archives', id);
            if (existsSync(dir)) {
                rmSync(dir, { recursive: true, force: true });
                cleared.push(id);
            }
        }
        return cleared;
    }
}
