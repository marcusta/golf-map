// Test variants of the course SVG: features the operator leaves out of one
// export, to find the shape the Blender build (OPCD's SVG → meshes step)
// chokes on without touching the course. The panel picks them from a
// filtered list or from the map selection; the server passes them to
// `gspro.py svg --exclude-ids` (a road's kerb fillets go with it there) and
// names the file after the variant so the full SVG is kept.
//
// Pure helpers + per-course persistence; the state lives in
// GsproExportService, the UI in the export panel.

import type { CourseFeature } from '../../../shared/api/course-features.gen';
import { parseBisect, type SvgBisect } from './svg-bisect';

/**
 * The feature types `gspro.py svg` writes: its TYPE_SURFACE, plus `trees`
 * through the server's `--map trees=pinestraw`. It skips everything else
 * (rules lines, vegetation zones, outside) whatever is excluded, so the list
 * only offers these. Lives in `shared/gspro-targets.ts` — the GSPro status
 * board's `shapes` target goes stale on an edit to one of them — and is
 * re-exported here for the panel that already imports it from this module.
 */
import { SVG_FEATURE_TYPES } from '../../../shared/gspro-targets';

export { SVG_FEATURE_TYPES };

export type SvgStatusFilter = 'all' | 'excluded' | 'included' | 'suspects';

export interface SvgExclusionFilter {
    /** A feature type, '' = every SVG type. */
    type: string;
    /** A hole id, `COURSE_WIDE` = features on no hole, '' = all. */
    hole: string;
    status: SvgStatusFilter;
    /** Case-insensitive substring of the id, type or source. */
    text: string;
}

/** The hole filter's value for features on no hole (the SVG's `Others` layer). */
export const COURSE_WIDE = '-';

export const NO_FILTER: SvgExclusionFilter = { type: '', hole: '', status: 'all', text: '' };

/** The course's features the SVG would write, in store order. */
export function svgFeatures(items: readonly CourseFeature[]): CourseFeature[] {
    const types = new Set(SVG_FEATURE_TYPES);
    return items.filter(f => types.has(f.type));
}

/**
 * The feature's shape name in the SVG, and so its mesh name after OPCD
 * (`hole_18_1c` → `Spline_hole_18_1c_Bunker_-_Mesh`): its per-course number in
 * hex, as `gspro.py` `_shape_ids` writes it. Paths are merged into the Roads
 * layer's shapes, so for them only the number. A generated feature has no
 * number and is named after 5 characters of its id (the exporter lengthens
 * that in the rare case another shape already has it).
 */
export function shapeName(f: CourseFeature, holeNumber: number | undefined): string {
    const id = f.no !== null && f.no !== undefined ? f.no.toString(16) : f.id.replace(/[^0-9a-z]/gi, '').slice(0, 5).toLowerCase();
    if (f.type === 'path') return id;
    return holeNumber !== undefined ? `hole_${holeNumber}_${id}` : `others_${id}`;
}

/**
 * `shapeName` as the SVG spells it for every type: a road piece as
 * `roads_<number>` (a merged road shape takes its lowest-numbered piece's name).
 */
export function svgShapeName(f: CourseFeature, holeNumber: number | undefined): string {
    const name = shapeName(f, holeNumber);
    return f.type === 'path' ? `roads_${name}` : name;
}

/**
 * The features a typed shape name points at: the SVG name (`hole_5_15c`,
 * `others_178`, `roads_1f`), an OPCD mesh name that carries one
 * (`Spline_hole_5_15c_Tee_-_Mesh`), or only the number part (`15c`).
 * Case and surrounding spaces do not matter.
 */
export function findByShapeName(
    features: readonly CourseFeature[],
    holeNumberOf: (holeId: string | null) => number | undefined,
    query: string,
): CourseFeature[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const full = /(hole_\d+_[0-9a-z]+|others_[0-9a-z]+|roads_[0-9a-z]+)/.exec(q)?.[1];
    return features.filter(f => {
        const name = svgShapeName(f, holeNumberOf(f.holeId));
        return full ? name === full : name.slice(name.lastIndexOf('_') + 1) === q;
    });
}

/** The features matching the filter. */
export function matchSvgFilter(
    features: readonly CourseFeature[],
    filter: SvgExclusionFilter,
    excluded: ReadonlySet<string>,
    /** A running bisect's remaining suspects, for the `suspects` status. */
    suspects: ReadonlySet<string> = new Set(),
): CourseFeature[] {
    const text = filter.text.trim().toLowerCase();
    return features.filter(f => {
        if (filter.type && f.type !== filter.type) return false;
        if (filter.hole === COURSE_WIDE ? f.holeId !== null : filter.hole && f.holeId !== filter.hole) return false;
        if (filter.status === 'excluded' && !excluded.has(f.id)) return false;
        if (filter.status === 'included' && excluded.has(f.id)) return false;
        if (filter.status === 'suspects' && !suspects.has(f.id)) return false;
        if (text && !`${f.id} ${f.type} ${f.source ?? ''}`.toLowerCase().includes(text)) return false;
        return true;
    });
}

/** A hole's green, tee or fairway, as a place to say a feature is near. */
export interface Landmark {
    hole: number;
    type: string;
    x: number;
    y: number;
}

const LANDMARK_TYPES = new Set(['green', 'tee', 'fairway']);

/** Mean of a feature's ring points (EPSG:3006 m): its rough centre. */
export function featureCentre(f: Pick<CourseFeature, 'geometry'>): { x: number; y: number } | null {
    const pts = f.geometry.rings.flatMap(r => r.points);
    if (pts.length === 0) return null;
    return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
}

/** The course's greens, tees and fairways that belong to a hole. */
export function landmarksOf(items: readonly CourseFeature[], holeNumbers: ReadonlyMap<string, number>): Landmark[] {
    return items.flatMap(f => {
        const hole = f.holeId ? holeNumbers.get(f.holeId) : undefined;
        const c = LANDMARK_TYPES.has(f.type) && hole !== undefined ? featureCentre(f) : null;
        return c && hole !== undefined ? [{ hole, type: f.type, ...c }] : [];
    });
}

/** `near hole 13 green`: the landmark whose centre is closest to the feature's, '' with none. */
export function nearLabel(f: Pick<CourseFeature, 'geometry'>, landmarks: readonly Landmark[]): string {
    const c = featureCentre(f);
    if (!c) return '';
    let best: Landmark | null = null;
    let bestD = Infinity;
    for (const l of landmarks) {
        const d = Math.hypot(l.x - c.x, l.y - c.y);
        if (d < bestD) { best = l; bestD = d; }
    }
    return best ? `near hole ${best.hole} ${best.type}` : '';
}

/**
 * The file a variant export writes: `<course>-<variant>.svg`, blank = the
 * full `<course>.svg`. Mirrors the server's `exportFileName` (shown as a
 * hint only; the server names the file).
 */
export function variantFileName(courseName: string, variant: string): string {
    const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const suffix = variant.trim() ? slug(variant) : '';
    return `${slug(courseName) || 'course'}${suffix ? `-${suffix}` : ''}.svg`;
}

// --- Persistence (per course, this browser) ---------------------------------

export interface SvgExclusions {
    ids: string[];
    variant: string;
    /** A bisect in progress (it spans many Blender builds, so it survives a reload). */
    bisect: SvgBisect | null;
}

export type ExclusionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const storageKey = (courseId: string) => `gspro-svg-exclusions:${courseId}`;

/** The browser's localStorage, or null where it is missing or throws (private mode). */
export function browserStorage(): ExclusionStorage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

export function loadExclusions(storage: ExclusionStorage | null, courseId: string): SvgExclusions {
    try {
        const raw = storage?.getItem(storageKey(courseId));
        const parsed = raw ? JSON.parse(raw) as Partial<SvgExclusions> : null;
        return {
            ids: Array.isArray(parsed?.ids) ? parsed.ids.filter((id): id is string => typeof id === 'string') : [],
            variant: typeof parsed?.variant === 'string' ? parsed.variant : '',
            bisect: parseBisect(parsed?.bisect),
        };
    } catch {
        return { ids: [], variant: '', bisect: null };
    }
}

export function saveExclusions(storage: ExclusionStorage | null, courseId: string, value: SvgExclusions): void {
    try {
        if (value.ids.length === 0 && !value.variant && !value.bisect) storage?.removeItem(storageKey(courseId));
        else storage?.setItem(storageKey(courseId), JSON.stringify(value));
    } catch {
        // Storage full or blocked: the exclusions still hold for this session.
    }
}
