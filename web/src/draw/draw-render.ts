import type { Computed, Signal } from '@basics/core/client/core';
import type { FilterSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection, Position } from 'geojson';
import type { OverlayLayerSpec } from '../map/map.service';
import { geometryToWgs84Rings, type FeaturesService } from './features.service';
import { sweref99tmToWgs84 } from '../geo/transform';
import {
    flattenOpenPath,
    flattenRing,
    type AnchorPoint,
    type FeatureGeometry,
    type Point,
} from '../geo/bezier';
import { rectFromCorners, vertexKey, type DrawState } from './draw-state';
import { ACCENT_COLOR, CAT, MARKER_FILL, OVERLAY_TEXT, STATUS_RISK } from '../map/map-palette';
import { DRAW_FILL_OPACITY, SELECTION_COLOR, typeColorExpression } from './feature-palette';
import type { GhostFeature, Marquee } from './draw-pointer';
import type { SnapMarker } from './draw-snap';

// The draw tool's preview overlay: a WGS84 FeatureCollection built from the
// tool's reactive state, plus the layer specs that style it. The overlay is
// owned through `ownedOverlay`, which pushes each rebuild through MapService's
// latest-wins overlay queue.

/** A reactive read: `get()` registers the dependency. */
interface Readable<T> {
    get(): T;
}

/** What the preview reads from the draw tool. Every read is reactive except `features`. */
export interface DrawRenderHost {
    readonly state: Pick<DrawState, 'isDrawing' | 'draft'>;
    readonly features: FeaturesService | null;
    readonly trace: Readable<Point[] | null>;
    readonly cursor: Readable<Point | null>;
    readonly snapMarker: Readable<SnapMarker | null>;
    readonly dragGhost: Readable<GhostFeature[] | null>;
    readonly marquee: Readable<Marquee | null>;
    readonly opPreviewGeometry: Computed<FeatureGeometry | null>;
    readonly vertexSelection: Signal<ReadonlySet<string>>;
}

/**
 * Draft outline + selected-feature vertex/handle markers + marquee
 * rectangle + armed offset/simplify preview, as a WGS84
 * FeatureCollection. Vertex markers render only for a SINGLE selected
 * feature (multi-select shows the outline highlight from the features
 * overlay instead).
 */
export function drawPreviewGeojson(host: DrawRenderHost): FeatureCollection {
    const features: Feature[] = [];
    const toLngLat = (p: Point): Position => {
        const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
        return [lon, lat];
    };
    // Snap marker (draw-snap.ts): drawn last so it sits over the vertices.
    // Each branch draws only its own scope, so a stale draft marker never
    // shows after a disarm and a drag marker never shows while armed.
    const pushSnapMarker = (marker: SnapMarker | null, scope: SnapMarker['scope']): void => {
        if (!marker || marker.scope !== scope) return;
        features.push({
            type: 'Feature',
            properties: { role: marker.kind === 'anchor' ? 'snap-anchor' : 'snap-edge' },
            geometry: { type: 'Point', coordinates: toLngLat(marker.point) },
        });
    };

    if (host.state.isDrawing.get()) {
        // Live freehand-trace stroke (T40): the raw sampled polyline as
        // the familiar dashed draft line (samples are plain points, so
        // no flattening is needed).
        const trace = host.trace.get();
        if (trace) {
            if (trace.length >= 2) {
                features.push({
                    type: 'Feature',
                    properties: { role: 'draft-line' },
                    geometry: { type: 'LineString', coordinates: trace.map(p => toLngLat(p)) },
                });
            }
            return { type: 'FeatureCollection', features };
        }

        const draft = host.state.draft.get();
        const cursor = host.cursor.get();
        // Preview controls: placed points + the cursor as a provisional
        // smooth control (rubber-band). No placed points, no rubber band.
        const controls: AnchorPoint[] = [...draft];
        if (cursor && draft.length > 0) controls.push(cursor);

        // In-progress b-spline drawing shows the open control path only,
        // Inkscape-style: no closed-curve extrapolation and no fill until
        // the user explicitly closes the ring.
        const line = flattenOpenPath(controls, 0.25).map(([x, y]) => toLngLat({ x, y }));
        if (line.length >= 2) {
            features.push({
                type: 'Feature',
                properties: { role: 'draft-line' },
                geometry: { type: 'LineString', coordinates: line },
            });
        }
        draft.forEach((p, i) => {
            features.push({
                type: 'Feature',
                properties: { role: i === 0 ? 'first-vertex' : p.corner ? 'vertex-corner' : 'vertex' },
                geometry: { type: 'Point', coordinates: toLngLat(p) },
            });
        });
        pushSnapMarker(host.snapMarker.get(), 'draft');
        return { type: 'FeatureCollection', features };
    }

    // Drag ghosts: live fill + outline of the feature(s) being dragged
    // (whole-feature move or vertex/handle edit). The originals are
    // hidden via feature-state while these render, so the ACTUAL shape
    // appears to follow the cursor — at the cost of re-flattening only
    // the dragged features, not the whole course.
    const ghosts = host.dragGhost.get();
    if (ghosts) {
        for (const ghost of ghosts) {
            features.push({
                type: 'Feature',
                // Carry the original feature's D24 stackKey so the ghost
                // z-sorts identically to the persistent overlay (the
                // ghost-fill layer sorts on it, not the type heuristic).
                properties: {
                    role: 'ghost',
                    type: ghost.type,
                    stackKey: host.features?.stackKeyForId(ghost.id) ?? 0,
                },
                geometry: {
                    type: 'Polygon',
                    coordinates: geometryToWgs84Rings(ghost.geometry),
                },
            });
        }
    }

    // Marquee rectangle (feature or vertex selection drag).
    const marquee = host.marquee.get();
    if (marquee) {
        const r = rectFromCorners(marquee.start, marquee.current);
        const corners: Position[] = [
            toLngLat({ x: r.minX, y: r.minY }),
            toLngLat({ x: r.maxX, y: r.minY }),
            toLngLat({ x: r.maxX, y: r.maxY }),
            toLngLat({ x: r.minX, y: r.maxY }),
        ];
        corners.push(corners[0]);
        features.push({
            type: 'Feature',
            properties: { role: 'marquee' },
            geometry: { type: 'Polygon', coordinates: [corners] },
        });
    }

    // Armed offset/simplify preview: dashed outline of the result.
    const opPreview = host.opPreviewGeometry.get();
    if (opPreview) {
        for (const ring of opPreview.rings) {
            const flat = flattenRing(ring, 0.25, opPreview.curveType);
            if (flat.length < 2) continue;
            const line = flat.map(([x, y]) => toLngLat({ x, y }));
            line.push(line[0]);
            features.push({
                type: 'Feature',
                properties: { role: 'op-preview' },
                geometry: { type: 'LineString', coordinates: line },
            });
        }
    }

    // Reactive read of the selected feature (null when tool inactive).
    const selected = host.features ? host.features.editableSelected.get() : null;
    if (selected) {
        // While dragging, markers/handles/cage follow the live ghost
        // geometry (the store keeps the pre-drag shape until commit).
        const geometry = ghosts?.find(g => g.id === selected.id)?.geometry ?? selected.geometry;
        const isSpline = geometry.curveType === 'bspline';
        const vertexSel = host.vertexSelection.get();
        geometry.rings.forEach((ring, ringIdx) => {
            if (isSpline && ring.points.length >= 2) {
                // Control cage: the off-curve control polygon, so
                // the pull relationship is visible.
                const cage = ring.points.map((p: AnchorPoint) => toLngLat(p));
                cage.push(cage[0]);
                features.push({
                    type: 'Feature',
                    properties: { role: 'control-cage' },
                    geometry: { type: 'LineString', coordinates: cage },
                });
            }
            ring.points.forEach((p: AnchorPoint, idx: number) => {
                if (!isSpline) {
                    for (const which of ['hIn', 'hOut'] as const) {
                        const handle = p[which];
                        if (!handle) continue;
                        features.push({
                            type: 'Feature',
                            properties: { role: 'handle-line' },
                            geometry: { type: 'LineString', coordinates: [toLngLat(p), toLngLat(handle)] },
                        });
                        features.push({
                            type: 'Feature',
                            properties: { role: 'handle' },
                            geometry: { type: 'Point', coordinates: toLngLat(handle) },
                        });
                    }
                }
                const role = vertexSel.has(vertexKey(ringIdx, idx))
                    ? 'vertex-selected'
                    : isSpline && p.corner ? 'vertex-corner' : 'vertex';
                features.push({
                    type: 'Feature',
                    properties: { role },
                    geometry: { type: 'Point', coordinates: toLngLat(p) },
                });
            });
        });
    }
    pushSnapMarker(host.snapMarker.get(), 'drag');
    return { type: 'FeatureCollection', features };
}

/** Preview overlay layer specs (ids prefixed with the overlay id). */
export function drawPreviewLayers(): OverlayLayerSpec[] {
    const role = (value: string): FilterSpecification =>
        ['==', ['get', 'role'], value] as FilterSpecification;
    return [
        {
            // Drag ghosts: palette-true live copies of dragged features
            // (their hidden originals' stand-in). Same colors/opacity and
            // z-sort as the main features overlay so a drag is visually
            // seamless.
            id: 'draw-ghost-fill',
            type: 'fill',
            filter: role('ghost'),
            layout: { 'fill-sort-key': ['get', 'stackKey'] as never },
            paint: {
                'fill-color': typeColorExpression('draw') as never,
                'fill-opacity': DRAW_FILL_OPACITY,
            },
        },
        {
            id: 'draw-ghost-line',
            type: 'line',
            filter: role('ghost'),
            paint: {
                'line-color': typeColorExpression('outline') as never,
                'line-width': 1.5,
            },
        },
        {
            id: 'draw-draft-fill',
            type: 'fill',
            filter: role('draft-fill'),
            paint: { 'fill-color': SELECTION_COLOR, 'fill-opacity': 0.15 },
        },
        {
            id: 'draw-marquee-fill',
            type: 'fill',
            filter: role('marquee'),
            paint: { 'fill-color': CAT.sky /* '#6FA8C9' — --data-cat-7 */, 'fill-opacity': 0.12 },
        },
        {
            id: 'draw-marquee-line',
            type: 'line',
            filter: role('marquee'),
            paint: { 'line-color': CAT.sky /* '#6FA8C9' — --data-cat-7 */, 'line-width': 1.5, 'line-dasharray': [2, 2] },
        },
        {
            id: 'draw-draft-line',
            type: 'line',
            filter: role('draft-line'),
            paint: { 'line-color': SELECTION_COLOR, 'line-width': 2, 'line-dasharray': [2, 1.5] },
        },
        {
            // Armed offset/simplify result: dashed "what you'll get" line —
            // amber = armed-but-uncommitted state.
            id: 'draw-op-preview',
            type: 'line',
            filter: role('op-preview'),
            paint: { 'line-color': STATUS_RISK /* '#C68A2E' — --data-risk */, 'line-width': 2, 'line-dasharray': [2, 1.5] },
        },
        {
            id: 'draw-handle-lines',
            type: 'line',
            filter: role('handle-line'),
            paint: { 'line-color': OVERLAY_TEXT /* --overlay-text */, 'line-width': 1, 'line-opacity': 0.8 },
        },
        {
            id: 'draw-control-cage',
            type: 'line',
            filter: role('control-cage'),
            paint: {
                'line-color': OVERLAY_TEXT, // --overlay-text
                'line-width': 1,
                'line-opacity': 0.5,
                'line-dasharray': [1, 2],
            },
        },
        {
            id: 'draw-vertices',
            type: 'circle',
            filter: ['in', ['get', 'role'], ['literal', ['vertex', 'first-vertex']]] as FilterSpecification,
            paint: {
                'circle-radius': ['case', ['==', ['get', 'role'], 'first-vertex'], 7, 5] as never,
                'circle-color': OVERLAY_TEXT, // '#FFFFFF' — --overlay-text
                'circle-stroke-color': MARKER_FILL, // '#1E2B22' — --color-surface-brand
                'circle-stroke-width': 2,
            },
        },
        {
            // Corner control points: visually distinct from smooth ones.
            id: 'draw-vertices-corner',
            type: 'circle',
            filter: role('vertex-corner'),
            paint: {
                'circle-radius': 5,
                'circle-color': CAT.wheat, // '#D8A441' — --data-cat-3
                'circle-stroke-color': MARKER_FILL, // --color-surface-brand
                'circle-stroke-width': 2,
            },
        },
        {
            // Multi-vertex selection members (bulk delete / 'I' insert).
            id: 'draw-vertices-selected',
            type: 'circle',
            filter: role('vertex-selected'),
            paint: {
                'circle-radius': 6,
                'circle-color': SELECTION_COLOR,
                'circle-stroke-color': MARKER_FILL, // --color-surface-brand
                'circle-stroke-width': 2,
            },
        },
        {
            id: 'draw-handles',
            type: 'circle',
            filter: role('handle'),
            paint: {
                'circle-radius': 4,
                'circle-color': CAT.sky, // '#6FA8C9' — --data-cat-7 (pairs with the marquee)
                'circle-stroke-color': OVERLAY_TEXT, // --overlay-text
                'circle-stroke-width': 1.5,
            },
        },
        {
            // Snap target (draw-snap.ts): an open ring around the snapped
            // point. Anchor snap: larger clay ring. Edge snap: smaller sky
            // ring. Last in the list, so it draws over the vertex markers.
            id: 'draw-snap',
            type: 'circle',
            filter: ['in', ['get', 'role'], ['literal', ['snap-anchor', 'snap-edge']]] as FilterSpecification,
            paint: {
                'circle-radius': ['case', ['==', ['get', 'role'], 'snap-anchor'], 8, 6] as never,
                'circle-opacity': 0,
                'circle-stroke-color': ['case', ['==', ['get', 'role'], 'snap-anchor'],
                    ACCENT_COLOR, // '#BF6A3E' — --data-cat-1 / --color-accent-primary
                    CAT.sky, // '#6FA8C9' — --data-cat-7
                ] as never,
                'circle-stroke-width': 2.5,
            },
        },
    ];
}
