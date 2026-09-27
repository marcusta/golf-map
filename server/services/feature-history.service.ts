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

const CONTENT = ['type', 'hole_id', 'layer', 'geometry_json', 'attributes_json', 'generated', 'source', 'source_ref', 'license'];

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

    /** Keep a full SVG export: the SVG and the features it was made from, under <dir>/export-history/<local time>/. */
    async snapshot(courseId: string, dir: string, svgPath: string, when = new Date()): Promise<string> {
        const name = localStamp(when);
        const folder = path.join(dir, SNAPSHOT_DIR, name);
        await mkdir(folder, { recursive: true });
        let svg: string | null = null;
        if (await exists(svgPath)) {
            svg = path.basename(svgPath);
            await copyFile(svgPath, path.join(folder, svg));
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
