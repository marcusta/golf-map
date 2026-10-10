import polygonClipping, { type MultiPolygon, type Pair } from 'polygon-clipping';

/** WGS84 boundaries, separate from the course's playable features. */
export interface CleanupArea {
    id: string;
    name: string;
    /** include: clean the blend surfaces mapped here. force: clean all ground here, mapped or not. exclude: never. */
    kind: 'include' | 'force' | 'exclude';
    ring: Pair[];
}

export interface CleanupAreasDocument {
    siteId: string;
    version: number;
    areas: CleanupArea[];
}

/** Reject ambiguous, self-crossing outlines instead of guessing their interior. */
export function validateCleanupAreas(areas: CleanupArea[]): void {
    if (areas.length > 200) throw new Error('Use at most 200 cleanup areas.');
    const ids = new Set<string>();
    for (const a of areas) {
        if (!a.id || a.id.length > 100 || ids.has(a.id)) throw new Error('Area IDs must be unique.');
        ids.add(a.id);
        if (!a.name.trim() || a.name.length > 100) throw new Error('Give each area a name (up to 100 characters).');
        if (a.kind !== 'include' && a.kind !== 'force' && a.kind !== 'exclude') throw new Error('Unknown cleanup area kind.');
        const r = a.ring;
        if (r.length < 4 || r.length > 1000) throw new Error('An area needs 3 to 999 corners.');
        if (r.some(p => p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) {
            throw new Error('Area coordinates must be valid WGS84 longitude/latitude pairs.');
        }
        if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) throw new Error('Close the area outline.');
        const cross = (a: Pair, b: Pair, c: Pair) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        let area = 0;
        for (let i = 0; i < r.length - 1; i++) {
            if (r[i][0] === r[i + 1][0] && r[i][1] === r[i + 1][1]) throw new Error('Remove repeated corners.');
            area += cross(r[0], r[i], r[i + 1]);
            for (let j = i + 2; j < r.length - 1; j++) {
                if (i === 0 && j === r.length - 2) continue;
                const [a, b, c, d] = [r[i], r[i + 1], r[j], r[j + 1]];
                if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
                    Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) continue;
                if (cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0) {
                    throw new Error('Area edges cross or touch. Draw a simple outline.');
                }
            }
        }
        if (Math.abs(area) < 1e-14) throw new Error('The area is too small or has no interior.');
    }
}

function unionLessExclusions(areas: CleanupArea[], kinds: CleanupArea['kind'][]): MultiPolygon {
    const includes = areas.filter(a => kinds.includes(a.kind)).map(a => [a.ring]);
    if (!includes.length) return [];
    const included = polygonClipping.union(includes[0], ...includes.slice(1));
    const excludes = areas.filter(a => a.kind === 'exclude').map(a => [a.ring]);
    return excludes.length ? polygonClipping.difference(included, ...excludes) : included;
}

/** Includes and forced areas are unioned first; every exclusion wins, regardless of drawing order. */
export function effectiveCleanupArea(areas: CleanupArea[]): MultiPolygon {
    return unionLessExclusions(areas, ['include', 'force']);
}

/** The part of the effective area that is cleaned whatever course feature is, or is not, mapped there. */
export function forcedCleanupArea(areas: CleanupArea[]): MultiPolygon {
    return unionLessExclusions(areas, ['force']);
}

/**
 * Direct input to cleanup.py maps --cleanup-aoi … --aoi-crs EPSG:4326. The
 * first feature (`cleanup`) is everywhere cleanup is allowed; a second
 * (`cleanup-force`), present only when a forced area is drawn, is the part of
 * it to clean regardless of course features.
 */
export function cleanupAreaGeoJson(doc: CleanupAreasDocument) {
    const feature = (type: 'cleanup' | 'cleanup-force', coordinates: MultiPolygon) => ({
        type: 'Feature' as const,
        properties: { type, siteId: doc.siteId, version: doc.version },
        geometry: { type: 'MultiPolygon' as const, coordinates },
    });
    const effective = effectiveCleanupArea(doc.areas), forced = forcedCleanupArea(doc.areas);
    return {
        type: 'FeatureCollection' as const,
        features: [...(effective.length ? [feature('cleanup', effective)] : []), ...(forced.length ? [feature('cleanup-force', forced)] : [])],
    };
}
