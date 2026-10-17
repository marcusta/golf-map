// A course's features at any earlier moment, for finding the edit that broke a
// GSPro/OPCD build (the SVG bisect, scripts/gspro-bisect.ts).
//
// Two sources of earlier states:
//   - the edit history the migration-025 triggers keep (course_feature_history):
//     the state at time T is the current rows with every history row after T laid
//     over them, newest first, minus the features created after T;
//   - export snapshots: every full GSPro SVG export copies the SVG and the course's
//     features to <export dir>/export-history/<local time>/ (features.json), so two
//     exports can be compared even when the database has moved on.
// `changes` diffs two states into a numbered list; `mix` builds an in-between state
// (chosen changes applied); `writeVariantDb` puts it into a copy of the database for
// the SVG exporter, so the course itself is never touched.
import * as path from 'node:path';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { Database as SqliteDatabase } from 'bun:sqlite';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/schema';

export const SNAPSHOT_DIR = 'export-history';
export const SNAPSHOT_FORMAT = 'golfmap-feature-snapshot-v1';

/** A course_features row without the derived `geojson`. */
export type FeatureRow = Record<string, unknown> & { id: string; type: string; sort_order: number; hole_id: string | null; layer: string | null };
export type FeatureState = Map<string, FeatureRow>;

export type ChangeKind = 'added' | 'removed' | 'edited' | 'restacked';
export interface FeatureChange {
    /** 1-based, stable for a given pair of states: what `--apply` names. */
    n: number;
    kind: ChangeKind;
    id: string;
    type: string;
    hole: number | null;
    layer: string | null;
    source: string | null;
    /** For `restacked`: the rank among its group's features before -> after. */
    detail?: string;
}

export interface StateAt {
    state: FeatureState;
    /** Features changed after T that the history has no earlier version of (edited before the history existed). */
    unknown: string[];
}

export interface SnapshotInfo {
    name: string;
    dir: string;
    exportedAt: string;
    features: number;
    svg: string | null;
}

/**
 * How much changed since some moment: how many things, and what kinds of
 * thing they were (feature types, terrain-edit ops). What the GSPro status
 * board puts in a row's "changed since".
 */
export interface ChangeCount {
    count: number;
    /** Distinct kinds, sorted; empty when `count` is 0. */
    kinds: string[];
}

/**
 * An ISO timestamp as the history tables spell one: UTC
 * `YYYY-MM-DD HH:MM:SS.SSS`, which compares as a plain string against both
 * `changed_at` (milliseconds) and the `updated_at`/`created_at` SQLite writes
 * (whole seconds).
 */
export function sqlStamp(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) throw new Error(`Not a timestamp: ${iso}`);
    return d.toISOString().replace('T', ' ').slice(0, 23);
}

const CONTENT = ['type', 'hole_id', 'layer', 'geometry_json', 'attributes_json', 'generated', 'source', 'source_ref', 'license'];

/**
 * The migration-025 history `op` of a move in the stack and nothing else
 * (`row_json` holds only `sort_order`, `version`, `updated_at`). Not an edit of
 * the feature: every insert into a group shifts what sits above it.
 */
const RESTACK_OP = 'restack';

export class FeatureHistoryService {
    constructor(private readonly db: Kysely<Database>) {}

    /** The course's features now, keyed by id. */
    async current(courseId: string): Promise<FeatureState> {
        const rows = await this.db.selectFrom('course_features').selectAll().where('course_id', '=', courseId).execute();
        return new Map(rows.map(r => {
            const { geojson: _derived, ...row } = r;
            return [r.id, row as unknown as FeatureRow];
        }));
    }

    /** The course's features at `at` (UTC, 'YYYY-MM-DD HH:MM:SS'). */
    async stateAt(courseId: string, at: string): Promise<StateAt> {
        const state = await this.current(courseId);
        const history = await this.db.selectFrom('course_feature_history').selectAll()
            .where('course_id', '=', courseId).where('changed_at', '>', at)
            .orderBy('history_id', 'desc').execute();
        const touched = new Set<string>();
        for (const h of history) {
            const before = JSON.parse(h.row_json) as Record<string, unknown>;
            const row = state.get(h.feature_id);
            state.set(h.feature_id, { ...(row ?? {}), ...before } as FeatureRow);
            touched.add(h.feature_id);
        }
        const unknown: string[] = [];
        for (const [id, row] of state) {
            if (String(row.created_at) > at) { state.delete(id); continue; }
            if (!touched.has(id) && String(row.updated_at) > at) unknown.push(id);
        }
        return { state, unknown };
    }

    /**
     * How many of the course's features changed since `since` (an ISO
     * timestamp; null = unknown, which counts as nothing), and of which
     * types. `types` narrows it to the types one GSPro target cares about
     * (`shared/gspro-targets.ts`); without it every type counts.
     *
     * Two sources, deduplicated by feature id: a row whose `updated_at` moved
     * (created, edited or restacked since) and the migration-025 history (the
     * only trace a DELETED feature leaves). `generated = 1` rows are left out
     * of both — they are pipeline output that the next run replaces wholesale
     * (vegetation zones are rewritten by the planting itself), not edits a
     * person made, so counting them would leave every row permanently stale.
     *
     * `restack` history rows are left out as well: a sort-order-only move is
     * not a change to what a feature IS (nothing the GSPro files read), and a
     * generator run slides every hand-drawn feature above its zones up. A
     * reorder somebody made moves those rows' own `updated_at`, so the first
     * source still counts it.
     */
    async countChangesSince(courseId: string, since: string | null, types?: readonly string[]): Promise<ChangeCount> {
        if (since === null) return { count: 0, kinds: [] };
        const at = sqlStamp(since);
        const typeOf = new Map<string, string>();

        let touched = this.db.selectFrom('course_features').select(['id', 'type'])
            .where('course_id', '=', courseId).where('generated', '=', 0).where('updated_at', '>', at);
        if (types) touched = touched.where('type', 'in', [...types]);
        for (const row of await touched.execute()) typeOf.set(row.id, row.type);

        const history = await this.db.selectFrom('course_feature_history')
            .select([
                'feature_id',
                sql<string | null>`json_extract(row_json, '$.type')`.as('type'),
                sql<number | null>`json_extract(row_json, '$.generated')`.as('generated'),
            ])
            .where('course_id', '=', courseId).where('changed_at', '>', at)
            .where('op', '!=', RESTACK_OP)
            .execute();
        for (const row of history) {
            if (row.type === null || row.generated) continue;
            if (types && !types.includes(row.type)) continue;
            if (!typeOf.has(row.feature_id)) typeOf.set(row.feature_id, row.type);
        }
        return { count: typeOf.size, kinds: [...new Set(typeOf.values())].sort() };
    }

    /**
     * The high-water mark of the course's feature edits, as one OPAQUE stamp
     * (`<how many>:<newest updated_at>:<newest history row id>`): what an
     * export fingerprint hashes to tell whether the features it reads have
     * moved since the file was written (export-fingerprint.ts). Compare it for
     * equality, not for order.
     *
     * The same two sources as `countChangesSince`: a row's `updated_at`
     * (created, edited, restacked, toggled) and the migration-025 history's
     * rows, the only trace a DELETED row leaves. The count catches a create,
     * and the history's `history_id` an edit or delete inside the same second
     * as the last export (`updated_at` has whole seconds only, so the time
     * alone would miss it). `generated = 1` rows are left out, as there — they
     * are pipeline output the next run replaces wholesale, so counting them
     * would move the stamp on every generator run and nothing could ever be
     * unchanged. So are `restack` rows, for the same reason: the shift a
     * generator run gives the hand-drawn features above its zones is no edit
     * of theirs, and a reorder somebody made moves their own `updated_at`.
     */
    async latestStamp(courseId: string): Promise<string> {
        const touched = await this.db.selectFrom('course_features')
            .select(({ fn }) => [fn.countAll<number>().as('n'), fn.max<string | null>('updated_at').as('at')])
            .where('course_id', '=', courseId).where('generated', '=', 0).executeTakeFirst();
        const history = await this.db.selectFrom('course_feature_history')
            .select(({ fn }) => fn.max<number | null>('history_id').as('id'))
            .where('course_id', '=', courseId)
            .where('op', '!=', RESTACK_OP)
            .where(sql<boolean>`coalesce(json_extract(row_json, '$.generated'), 0) = 0`)
            .executeTakeFirst();
        return `${Number(touched?.n ?? 0)}:${touched?.at ?? 'none'}:${history?.id ?? 0}`;
    }

    /**
     * Keep a full SVG export: the SVG, its road-surface sidecar `<stem>-paths.json` and the features it was made
     * from, under <dir>/export-history/<local time>/. Blender reads the sidecar next to the SVG that built a .blend,
     * so a .blend built from an older export still splits its roads by surface after a newer export.
     */
    async snapshot(courseId: string, dir: string, svgPath: string, when = new Date()): Promise<string> {
        const name = localStamp(when);
        const folder = path.join(dir, SNAPSHOT_DIR, name);
        await mkdir(folder, { recursive: true });
        let svg: string | null = null;
        if (await exists(svgPath)) {
            svg = path.basename(svgPath);
            await copyFile(svgPath, path.join(folder, svg));
            const sidecar = svgPath.replace(/\.svg$/i, '') + '-paths.json';
            if (await exists(sidecar)) await copyFile(sidecar, path.join(folder, path.basename(sidecar)));
        }
        const features = [...(await this.current(courseId)).values()];
        await writeFile(path.join(folder, 'features.json'), JSON.stringify({
            format: SNAPSHOT_FORMAT, courseId, exportedAt: when.toISOString(), svg, features,
        }));
        return folder;
    }

    /** The export snapshots in an export folder, oldest first. */
    static async listSnapshots(dir: string): Promise<SnapshotInfo[]> {
        const root = path.join(dir, SNAPSHOT_DIR);
        if (!(await exists(root))) return [];
        const out: SnapshotInfo[] = [];
        for (const name of (await readdir(root)).sort()) {
            const file = path.join(root, name, 'features.json');
            if (!(await exists(file))) continue;
            const doc = JSON.parse(await readFile(file, 'utf-8'));
            if (doc.format !== SNAPSHOT_FORMAT) continue;
            out.push({ name, dir: path.join(root, name), exportedAt: doc.exportedAt, features: doc.features.length, svg: doc.svg });
        }
        return out;
    }

    /**
     * The newest export snapshot in an export folder, or null without one —
     * when the course's SVG was last exported, without parsing every
     * snapshot's features (the sync board asks on every poll).
     */
    static async latestSnapshot(dir: string): Promise<SnapshotInfo | null> {
        const root = path.join(dir, SNAPSHOT_DIR);
        if (!(await exists(root))) return null;
        // Folder names are local timestamps, so the last one sorted is the newest.
        for (const name of (await readdir(root)).sort().reverse()) {
            const file = path.join(root, name, 'features.json');
            if (!(await exists(file))) continue;
            try {
                const doc = JSON.parse(await readFile(file, 'utf-8'));
                if (doc.format !== SNAPSHOT_FORMAT) continue;
                return { name, dir: path.join(root, name), exportedAt: doc.exportedAt, features: doc.features.length, svg: doc.svg };
            } catch {
                continue;   // half-written or truncated: an older one still counts
            }
        }
        return null;
    }

    static async readSnapshot(snapshotDir: string): Promise<FeatureState> {
        const doc = JSON.parse(await readFile(path.join(snapshotDir, 'features.json'), 'utf-8'));
        if (doc.format !== SNAPSHOT_FORMAT) throw new Error(`${snapshotDir}: not a ${SNAPSHOT_FORMAT} snapshot`);
        return new Map((doc.features as FeatureRow[]).map(r => [r.id, r]));
    }

    /**
     * What differs between two states, numbered. `restacked` is a real change of
     * order inside a group (hole, layer), not the shift every feature above a new
     * one gets: only features whose rank among the group's common features moved.
     */
    async changes(courseId: string, from: FeatureState, to: FeatureState): Promise<FeatureChange[]> {
        const holes = new Map((await this.db.selectFrom('holes').select(['id', 'number']).where('course_id', '=', courseId).execute())
            .map(h => [h.id, h.number]));
        const list: Omit<FeatureChange, 'n'>[] = [];
        const describe = (row: FeatureRow, kind: ChangeKind, detail?: string) => list.push({
            kind, id: row.id, type: row.type, hole: row.hole_id ? holes.get(row.hole_id) ?? null : null,
            layer: row.layer ?? null, source: (row.source as string | null) ?? null, ...(detail ? { detail } : {}),
        });
        for (const [id, row] of to) {
            const old = from.get(id);
            if (!old) describe(row, 'added');
            else if (CONTENT.some(c => (old[c] ?? null) !== (row[c] ?? null))) describe(row, 'edited');
        }
        for (const [id, row] of from) if (!to.has(id)) describe(row, 'removed');
        for (const [id, move] of restacks(from, to)) {
            if (!list.some(c => c.id === id)) describe(to.get(id)!, 'restacked', move);
        }
        const order: Record<ChangeKind, number> = { added: 0, edited: 1, restacked: 2, removed: 3 };
        list.sort((a, b) => order[a.kind] - order[b.kind] || (a.hole ?? 99) - (b.hole ?? 99) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
        return list.map((c, i) => ({ n: i + 1, ...c }));
    }

    /** `from` with the changes to the ids in `apply` taken from `to` (added, removed, edited or restacked). */
    static mix(from: FeatureState, to: FeatureState, apply: Set<string>): FeatureRow[] {
        const rows: FeatureRow[] = [];
        for (const id of new Set([...from.keys(), ...to.keys()])) {
            const row = apply.has(id) ? to.get(id) : from.get(id);
            if (row) rows.push(row);
        }
        return rows;
    }

    /** A copy of the database (VACUUM INTO) whose features of this course are `rows`, for the SVG exporter's --db. */
    async writeVariantDb(courseId: string, rows: FeatureRow[], outPath: string): Promise<void> {
        await mkdir(path.dirname(outPath), { recursive: true });
        await sql`VACUUM INTO ${outPath}`.execute(this.db);
        const copy = new SqliteDatabase(outPath);
        try {
            for (const t of ['course_features_history_update', 'course_features_history_restack', 'course_features_history_delete']) {
                copy.run(`DROP TRIGGER IF EXISTS ${t}`);
            }
            const columns = new Set((copy.query('PRAGMA table_info(course_features)').all() as { name: string }[]).map(c => c.name));
            copy.transaction(() => {
                copy.run('DELETE FROM course_features WHERE course_id = ?', [courseId]);
                for (const row of rows) {
                    const cols = Object.keys(row).filter(c => columns.has(c));
                    copy.run(`INSERT INTO course_features (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
                        cols.map(c => row[c] as never));
                }
            })();
        } finally {
            copy.close();
        }
    }
}

/** Per group (hole, layer): the features common to both states whose rank among them moved, as "rank a -> b". */
function restacks(from: FeatureState, to: FeatureState): Map<string, string> {
    const groupOf = (r: FeatureRow) => `${r.hole_id ?? ''}|${r.layer ?? ''}`;
    const groups = new Map<string, string[]>();
    for (const [id, row] of to) {
        const old = from.get(id);
        if (!old || groupOf(old) !== groupOf(row)) continue;
        const g = groups.get(groupOf(row)) ?? [];
        g.push(id);
        groups.set(groupOf(row), g);
    }
    const moved = new Map<string, string>();
    for (const ids of groups.values()) {
        const before = [...ids].sort((a, b) => Number(from.get(a)!.sort_order) - Number(from.get(b)!.sort_order) || a.localeCompare(b));
        const after = [...ids].sort((a, b) => Number(to.get(a)!.sort_order) - Number(to.get(b)!.sort_order) || a.localeCompare(b));
        // The features that kept their relative order are the longest run of increasing old ranks;
        // the rest moved (one feature dragged to the top moves, not everything it passed).
        const oldRanks = after.map(id => before.indexOf(id));
        const stayed = longestIncreasing(oldRanks);
        after.forEach((id, i) => {
            if (!stayed.has(i)) moved.set(id, `rank ${oldRanks[i] + 1} -> ${i + 1} of ${ids.length}`);
        });
    }
    return moved;
}

/** Indexes of one longest strictly increasing subsequence. */
function longestIncreasing(xs: number[]): Set<number> {
    const tails: number[] = [];   // index into xs of the smallest tail of each length
    const prev: number[] = new Array(xs.length).fill(-1);
    xs.forEach((x, i) => {
        let lo = 0, hi = tails.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[tails[mid]] < x) lo = mid + 1; else hi = mid; }
        if (lo > 0) prev[i] = tails[lo - 1];
        tails[lo] = i;
    });
    const keep = new Set<number>();
    for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
    return keep;
}

function localStamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function exists(p: string): Promise<boolean> {
    try { await stat(p); return true; } catch { return false; }
}
