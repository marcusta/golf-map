import { flattenCenterline, type CenterlinePoint, type FeatureCenterline } from './centerline';

export type PathTransitionPattern = 'soft-fade' | 'overgrown-gravel' | 'wheel-tracks';
export interface PathTransition {
    id: string;
    pattern: PathTransitionPattern;
    placement: 'start' | 'end' | 'section';
    startM: number;
    direction: 1 | -1;
    transitionLengthM: number;
    holdLengthM: number;
    fadeLengthM: number;
    ending: 'grass' | 'continue';
    edgeIrregularity: number;
    dirtAmount: number;
    centerGrassReachM: number;
    trackWidthM: number;
    trackSpacingM: number;
    variation: number;
    seed: number;
}
export const PATH_TRANSITION_PRESETS = ['soft-fade', 'overgrown-gravel', 'wheel-tracks'] as const;
export function pathTransitionDefaults(pattern: PathTransitionPattern): PathTransition {
    return { id: '', pattern, placement: 'end', startM: 0, direction: 1, transitionLengthM: 8,
        holdLengthM: pattern === 'soft-fade' ? 0 : 6, fadeLengthM: 4, ending: 'grass',
        edgeIrregularity: .4, dirtAmount: pattern === 'wheel-tracks' ? .7 : .3,
        centerGrassReachM: 0, trackWidthM: .45, trackSpacingM: 1.5, variation: .4, seed: 1 };
}
export function centerlineStations(points: readonly CenterlinePoint[]) {
    const line = flattenCenterline(points), stationsM = [0];
    for (let i = 1; i < line.length; i++) stationsM.push(stationsM[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y));
    return { points: line, stationsM, lengthM: stationsM[stationsM.length - 1] ?? 0 };
}
export function centerlinePointAtStation(points: readonly CenterlinePoint[], stationM: number) {
    const s = centerlineStations(points);
    if (!s.points.length) return { x: 0, y: 0 };
    const d = Math.max(0, Math.min(s.lengthM, stationM));
    for (let i = 1; i < s.points.length; i++) if (s.stationsM[i] >= d) {
        const t = (d - s.stationsM[i - 1]) / (s.stationsM[i] - s.stationsM[i - 1] || 1), a = s.points[i - 1], b = s.points[i];
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    return s.points[s.points.length - 1];
}
export function projectCenterlineStation(points: readonly CenterlinePoint[], q: { x: number; y: number }) {
    const s = centerlineStations(points);
    let best = { stationM: 0, point: s.points[0] ?? q, distanceM: Infinity };
    for (let i = 1; i < s.points.length; i++) {
        const a = s.points[i - 1], b = s.points[i], dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        const point = { x: a.x + dx * t, y: a.y + dy * t }, distanceM = Math.hypot(q.x - point.x, q.y - point.y);
        if (distanceM < best.distanceM) best = { stationM: s.stationsM[i - 1] + t * (s.stationsM[i] - s.stationsM[i - 1]), point, distanceM };
    }
    return best;
}
export function transitionRange(t: PathTransition, lengthM: number) {
    const total = t.transitionLengthM + t.holdLengthM + t.fadeLengthM;
    const direction = t.placement === 'start' ? -1 : t.placement === 'end' ? 1 : t.direction;
    const startM = t.placement === 'start' ? total : t.placement === 'end' ? lengthM - total : t.startM;
    return { startM, endM: startM + direction * total, direction };
}
/** Painting persists to the directional endpoint after the nominal marker span. */
export function transitionFootprint(t: PathTransition, lengthM: number) {
    const range = transitionRange(t, lengthM);
    const tongueStartM = range.startM - range.direction * t.centerGrassReachM;
    const finalM = range.direction === 1 ? lengthM : 0;
    return { minM: Math.min(tongueStartM, finalM), maxM: Math.max(tongueStartM, finalM) };
}
/** Unknown attributes stay scalar; this is the sole structured attribute. */
export function pathTransitionsError(value: unknown, centerline?: FeatureCenterline, type = 'path', surface?: unknown): string | null {
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.length > 32) return 'pathTransitions must be an array of at most 32 entries';
    if (!value.length) return null;
    if (type !== 'path' || !centerline || !['gravel', 'dirt'].includes(String(surface))) return 'pathTransitions requires a gravel or dirt centerline path';
    const length = centerlineStations(centerline.points).lengthM, ids = new Set<string>();
    const occupied: Array<[number, number]> = [];
    for (const t of value) {
        if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id.trim() || ids.has(t.id)) return 'pathTransitions needs unique non-empty ids';
        ids.add(t.id);
        if (!PATH_TRANSITION_PRESETS.includes(t.pattern) || !['start', 'end', 'section'].includes(t.placement) || !['grass', 'continue'].includes(t.ending) || ![1, -1].includes(t.direction)) return 'pathTransitions has an invalid pattern, placement, ending or direction';
        for (const key of ['startM', 'transitionLengthM', 'holdLengthM', 'fadeLengthM', 'centerGrassReachM', 'trackWidthM', 'trackSpacingM', 'edgeIrregularity', 'dirtAmount', 'variation', 'seed']) {
            if (typeof t[key] !== 'number' || !Number.isFinite(t[key]) || t[key] < 0) return `pathTransitions.${key} must be finite and nonnegative`;
        }
        if (!Number.isSafeInteger(t.seed)) return 'pathTransitions.seed must be a nonnegative safe integer';
        if (t.transitionLengthM <= 0 || t.trackWidthM <= 0 || t.trackSpacingM <= 0) return 'pathTransitions transition length and track dimensions must be positive';
        if (['edgeIrregularity', 'dirtAmount', 'variation'].some(k => t[k] > 1)) return 'pathTransitions fractions must be 0..1';
        if (t.trackSpacingM + t.trackWidthM > centerline.widthM) return 'pathTransitions track dimensions must fit the path width';
        const r = transitionRange(t, length);
        const tongueStart = r.startM - r.direction * t.centerGrassReachM;
        if (Math.min(tongueStart, r.endM) < -1e-6 || Math.max(tongueStart, r.endM) > length + 1e-6) return 'pathTransitions extent exceeds the centerline';
        const { minM: lo, maxM: hi } = transitionFootprint(t, length);
        if (occupied.some(([a, b]) => Math.min(hi, b) - Math.max(lo, a) > 1e-6)) return 'pathTransitions extents must not overlap';
        occupied.push([lo, hi]);
    }
    return null;
}
