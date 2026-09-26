// Bisecting the course SVG for the shape the Blender build (OPCD's SVG →
// meshes step) chokes on. The operator picks the suspects (the exclusion
// list's current filter, e.g. every path), and each step leaves half of the
// remaining ones out of an export named `bisect-<step>`. Built OK means the
// culprit is in the half left out; failed means it is in the half still in.
// Down to one suspect, a last step leaves out only that one to confirm it —
// a build that still fails means the break needs it together with others
// (two road pieces that only break once merged, say), not it alone.
//
// Pure state transitions; GsproExportService holds the state and exports each
// step, the export panel is the UI.

import type { CourseFeature } from '../../../shared/api/course-features.gen';

export interface SvgBisect {
    /** Exclusions kept out through the whole bisect (what was excluded besides the suspects). */
    base: string[];
    /** The suspects still in the running, in spatial order. */
    candidates: string[];
    /** 1-based step; each step is one export + one Blender build. */
    step: number;
    /** `candidates` before each answer, for undo. */
    history: string[][];
    /** Whether the current step's export has been written (answers wait for it). */
    exported: boolean;
    /**
     * After the confirming step: `confirmed` (built without only the suspect) or
     * `not-alone` (still failed, so it breaks only together with others).
     */
    result: 'confirmed' | 'not-alone' | null;
}

export function startBisect(suspects: readonly string[], excluded: ReadonlySet<string>): SvgBisect {
    const set = new Set(suspects);
    return {
        base: [...excluded].filter(id => !set.has(id)),
        candidates: [...suspects],
        step: 1,
        history: [],
        exported: false,
        result: null,
    };
}

/** The suspects the current step leaves out: the first half (all of one, the confirming step). */
export function bisectTesting(b: SvgBisect): string[] {
    return b.candidates.slice(0, Math.ceil(b.candidates.length / 2));
}

/** What the current step's export excludes. */
export function bisectExclusions(b: SvgBisect): Set<string> {
    return new Set([...b.base, ...bisectTesting(b)]);
}

export function bisectVariant(b: SvgBisect): string {
    return `bisect-${b.step}`;
}

/** Builds still to run, the current step's included: the halvings plus the confirming step. */
export function bisectBuildsLeft(b: SvgBisect): number {
    if (b.result) return 0;
    return Math.ceil(Math.log2(b.candidates.length)) + 1;
}

/** The next state for the operator's answer about the current step's build. */
export function answerBisect(b: SvgBisect, built: boolean): SvgBisect {
    if (b.candidates.length === 1) {
        return { ...b, exported: false, result: built ? 'confirmed' : 'not-alone' };
    }
    const testing = bisectTesting(b);
    const tested = new Set(testing);
    return {
        ...b,
        candidates: built ? testing : b.candidates.filter(id => !tested.has(id)),
        step: b.step + 1,
        history: [...b.history, b.candidates],
        exported: false,
        result: null,
    };
}

export function undoBisect(b: SvgBisect): SvgBisect {
    if (b.result) return { ...b, result: null, exported: false };
    const previous = b.history.at(-1);
    if (!previous) return b;
    return { ...b, candidates: previous, step: b.step - 1, history: b.history.slice(0, -1), exported: false };
}

/**
 * Suspects in spatial order (Z-order of their centres), so every half is a
 * compact patch of the course: road pieces that the SVG merges into one
 * shape mostly stay on the same side of a split.
 */
export function spatialOrder(features: readonly CourseFeature[]): string[] {
    const centres = features.map(f => {
        const pts = f.geometry.rings.flatMap(r => r.points);
        const n = Math.max(1, pts.length);
        return {
            id: f.id,
            x: pts.reduce((s, p) => s + p.x, 0) / n,
            y: pts.reduce((s, p) => s + p.y, 0) / n,
        };
    });
    if (centres.length === 0) return [];
    const xs = centres.map(c => c.x), ys = centres.map(c => c.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const span = Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0, 1e-9);
    const cell = (v: number) => Math.min(65535, Math.floor((v / span) * 65535));
    return centres
        .map(c => ({ id: c.id, key: morton(cell(c.x - x0), cell(c.y - y0)) }))
        .sort((a, b) => a.key - b.key || (a.id < b.id ? -1 : 1))
        .map(c => c.id);
}

/** Interleave two 16-bit cell indices (a 32-bit Z-order key, as a plain number). */
function morton(x: number, y: number): number {
    let key = 0;
    for (let bit = 15; bit >= 0; bit--) {
        key = key * 4 + ((y >> bit) & 1) * 2 + ((x >> bit) & 1);
    }
    return key;
}

/** A stored bisect, or null when missing or malformed. */
export function parseBisect(raw: unknown): SvgBisect | null {
    if (!raw || typeof raw !== 'object') return null;
    const b = raw as Partial<SvgBisect>;
    const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
    if (!ids(b.base) || !ids(b.candidates) || b.candidates.length === 0 || typeof b.step !== 'number'
        || !Array.isArray(b.history) || !b.history.every(ids)) return null;
    return {
        base: b.base, candidates: b.candidates, step: b.step, history: b.history,
        exported: b.exported === true,
        result: b.result === 'confirmed' || b.result === 'not-alone' ? b.result : null,
    };
}
