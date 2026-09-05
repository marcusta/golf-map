import type { CourseFeature } from '../../../shared/api/course-features.gen';
import { FEATURE_STYLES } from './feature-palette';

/**
 * Generated features (server/AGENTS.md "Generated features"): rows written
 * by a pipeline bulk-replace carry a non-null `source` (today
 * `lidar-canopy` tree canopies). Hand-drawn rows have `source = null`.
 * Generated rows are read-only in the editor: no vertex/handle editing,
 * no move, no reshape, no retype/rehole. Plain selection (read-only panel)
 * and delete (false positives such as roofs) stay allowed.
 *
 * Pure predicates and the stack-panel grouping live here so they unit-test
 * without the map-coupled services.
 */

type SourceCarrier = Pick<CourseFeature, 'source'>;

/** True for any feature with a non-empty `source` (pipeline-generated). */
export function isGeneratedFeature(f: SourceCarrier): boolean {
    return typeof f.source === 'string' && f.source.length > 0;
}

/** Editable = hand-drawn (`source` null). */
export function isEditableFeature(f: SourceCarrier): boolean {
    return !isGeneratedFeature(f);
}

/** Short provenance word for a source id (`lidar-canopy` -> `lidar`). */
export function generatedSourceLabel(source: string): string {
    const head = source.split(/[-_/]/)[0] ?? source;
    return head.length > 0 ? head : source;
}

/** Badge text for a generated feature: "Generated from lidar". */
export function generatedBadgeLabel(f: SourceCarrier): string | null {
    if (!isGeneratedFeature(f)) return null;
    return `Generated from ${generatedSourceLabel(f.source!)}`;
}

/**
 * "Height ~13 m" from `attributes.heightP90M` (rounded to whole metres),
 * null when the attribute is absent or not a finite number.
 */
export function generatedHeightLabel(f: Pick<CourseFeature, 'attributes'>): string | null {
    // The codegen'd `FeatureAttributes` is an empty interface (the server's
    // flat record loses its index signature), so read it as a plain record.
    const h = (f.attributes as Record<string, unknown> | null)?.['heightP90M'];
    if (typeof h !== 'number' || !Number.isFinite(h)) return null;
    return `Height ~${Math.round(h)} m`;
}

/** Group row label: "Trees (lidar)". */
export function generatedGroupLabel(type: string, source: string): string {
    const typeLabel = FEATURE_STYLES[type as keyof typeof FEATURE_STYLES]?.label ?? type;
    return `${typeLabel} (${generatedSourceLabel(source)})`;
}

export type StackRow =
    | { kind: 'feature'; key: string; feature: CourseFeature }
    | { kind: 'group'; key: string; source: string; type: string; count: number; ids: string[] };

/** Stable row key for a generated group (source + type). */
export function groupRowKey(source: string, type: string): string {
    return `group:${source}:${type}`;
}

/**
 * Collapse a topmost-first stack into panel rows: hand-drawn features one
 * row each; generated features of one (source, type) collapse into a single
 * group row placed where the group's topmost member sits. A generated
 * feature that is currently selected is additionally listed as its own row
 * directly under its group row (so the selection has somewhere to scroll
 * to) — never more than the selected ones.
 */
export function groupStackRows(topDown: readonly CourseFeature[], selectedIds: ReadonlySet<string>): StackRow[] {
    const rows: StackRow[] = [];
    const groups = new Map<string, { row: Extract<StackRow, { kind: 'group' }>; insertAt: number; selected: CourseFeature[] }>();
    for (const f of topDown) {
        if (!isGeneratedFeature(f)) {
            rows.push({ kind: 'feature', key: f.id, feature: f });
            continue;
        }
        const key = groupRowKey(f.source!, f.type);
        let g = groups.get(key);
        if (!g) {
            const row: Extract<StackRow, { kind: 'group' }> = { kind: 'group', key, source: f.source!, type: f.type, count: 0, ids: [] };
            g = { row, insertAt: rows.length, selected: [] };
            groups.set(key, g);
            rows.push(row);
        }
        g.row.count++;
        g.row.ids.push(f.id);
        if (selectedIds.has(f.id)) g.selected.push(f);
    }
    // Expand selected members under their group row (insert bottom-up so
    // earlier indices stay valid).
    const insertions = [...groups.values()]
        .filter(g => g.selected.length > 0)
        .sort((a, b) => b.insertAt - a.insertAt);
    for (const g of insertions) {
        rows.splice(g.insertAt + 1, 0, ...g.selected.map(f => ({ kind: 'feature', key: f.id, feature: f } as StackRow)));
    }
    return rows;
}
