// Map rendering geometry for the planner's putt-read tool (feature-putting-
// green-reading.md §5.1): simulated break-path polyline, straight start/aim
// line + aim point, subtle ball→hole reference line, and ball/hole markers.
// The green's Slope/Height field is drawn by the REUSED Green-analysis overlay
// (AnalysisOverlayRenderer), not here — this module owns only the read.
//
// NOTE: imports maplibre-gl transitively via nothing here, but PuttReadService
// (the tested state) still never imports it; only PlannerToolService (untested
// map glue, like the other tools) does.

import type { Feature, FeatureCollection, Position } from 'geojson';
import type { OverlayLayerSpec } from '../map/map.service';
import { bearingToUnitVector, type PuttRead, type Vec2 } from '../../../shared/strategy';
import { sweref99tmToWgs84 } from '../geo/transform';

/** Overlay id for the putt-read rendering (separate from the plan overlay). */
export const PUTT_OVERLAY_ID = 'plan-putt';

function toLngLat(v: Vec2): Position {
    const { lat, lon } = sweref99tmToWgs84(v.x, v.y);
    return [lon, lat];
}

export interface PuttOverlayInput {
    /** LIVE marker positions (follow the cursor mid-drag), EPSG:3006. */
    ball: Vec2 | null;
    hole: Vec2 | null;
    /**
     * The SETTLED read (null mid-drag / before placement) — the break path
     * and aim marker come from it and simply drop out while it's unsettled;
     * the markers + reference line stay live.
     */
    read: PuttRead | null;
    /** Softened presentation (degraded/low-confidence) — restyles the path. */
    soft: boolean;
}

/**
 * Truncate the simulated roll at its closest approach to the hole. The
 * integrator returns the ball's FULL roll to rest; on a near-miss over a
 * coarse DEM that roll-out can run well past the hole (to wherever the ball
 * stops). The read the player wants is "the ball breaks to the hole", so we
 * draw the path only up to the hole, not the run-out beyond it.
 */
function clipPathAtHole(path: readonly Vec2[], hole: Vec2): Vec2[] {
    let bestI = 0;
    let best = Infinity;
    for (let i = 0; i < path.length; i++) {
        const d = (path[i].x - hole.x) ** 2 + (path[i].y - hole.y) ** 2;
        if (d < best) { best = d; bestI = i; }
    }
    return path.slice(0, bestI + 1);
}

/** Build the putt overlay FeatureCollection (EPSG:3006 in → WGS84 out). */
export function buildPuttGeojson(input: PuttOverlayInput): FeatureCollection {
    const features: Feature[] = [];
    const { ball, hole, read } = input;

    if (ball && hole) {
        // Subtle straight reference line — always live, even mid-drag.
        features.push({
            type: 'Feature',
            properties: { role: 'ref' },
            geometry: { type: 'LineString', coordinates: [toLngLat(ball), toLngLat(hole)] },
        });
    }

    if (ball && hole && read && read.availability !== 'unavailable' && read.path.length >= 2) {
        // The break path — clipped so it arrives at the hole rather than
        // showing the run-out past it.
        const clipped = clipPathAtHole(read.path, hole);
        const pathCoords = (clipped.length >= 2 ? clipped : [ball, hole]).map(toLngLat);
        features.push({
            type: 'Feature',
            properties: { role: 'path', soft: input.soft },
            geometry: { type: 'LineString', coordinates: pathCoords },
        });
        // Start/aim line: the initial bearing carried straight out to the
        // hole's range. Its end (the aim point) sits `aimOffsetM` to the side
        // of the hole — the straight line + the gap to the hole is exactly
        // "start the ball here / aim this far to the side".
        const rangeM = Math.hypot(hole.x - ball.x, hole.y - ball.y);
        const dir = bearingToUnitVector(read.aimBearingDeg);
        const aim: Vec2 = { x: ball.x + dir.x * rangeM, y: ball.y + dir.y * rangeM };
        features.push({
            type: 'Feature',
            properties: { role: 'aimline' },
            geometry: { type: 'LineString', coordinates: [toLngLat(ball), toLngLat(aim)] },
        });
        features.push({
            type: 'Feature',
            properties: { role: 'aim' },
            geometry: { type: 'Point', coordinates: toLngLat(aim) },
        });
    }

    if (hole) {
        features.push({
            type: 'Feature',
            properties: { role: 'hole' },
            geometry: { type: 'Point', coordinates: toLngLat(hole) },
        });
    }
    if (ball) {
        features.push({
            type: 'Feature',
            properties: { role: 'ball' },
            geometry: { type: 'Point', coordinates: toLngLat(ball) },
        });
    }
    return { type: 'FeatureCollection', features };
}

/** Layer stack for the putt overlay (bottom → top). */
export function puttLayers(): OverlayLayerSpec[] {
    const role = (r: string) => ['==', ['get', 'role'], r] as never;
    return [
        // Straight ball→hole reference — quiet dashed baseline for the break.
        {
            id: `${PUTT_OVERLAY_ID}-ref`,
            type: 'line',
            filter: role('ref'),
            paint: {
                'line-color': '#ffffff',
                'line-width': 1,
                'line-opacity': 0.55,
                'line-dasharray': [2, 2],
            },
        },
        // Start/aim line — the straight line the player starts the ball on,
        // carried out to the hole's depth. Prominent gold with a dark casing.
        {
            id: `${PUTT_OVERLAY_ID}-aimline-casing`,
            type: 'line',
            filter: role('aimline'),
            layout: { 'line-cap': 'round' },
            paint: { 'line-color': '#14281c', 'line-width': 4, 'line-opacity': 0.5 },
        },
        {
            id: `${PUTT_OVERLAY_ID}-aimline`,
            type: 'line',
            filter: role('aimline'),
            layout: { 'line-cap': 'round' },
            paint: { 'line-color': '#f5b301', 'line-width': 2.5, 'line-opacity': 0.95 },
        },
        // Simulated break path — the read. Softened reads render amber.
        {
            id: `${PUTT_OVERLAY_ID}-path-casing`,
            type: 'line',
            filter: role('path'),
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#ffffff', 'line-width': 4.5, 'line-opacity': 0.9 },
        },
        {
            id: `${PUTT_OVERLAY_ID}-path`,
            type: 'line',
            filter: role('path'),
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': [
                    'case', ['==', ['get', 'soft'], true], '#eab308', '#2f7df4',
                ] as never,
                'line-width': 2.2,
            },
        },
        {
            id: `${PUTT_OVERLAY_ID}-aim`,
            type: 'circle',
            filter: role('aim'),
            paint: {
                'circle-radius': 4,
                'circle-color': '#f5b301',
                'circle-stroke-color': '#14281c',
                'circle-stroke-width': 1.5,
            },
        },
        {
            id: `${PUTT_OVERLAY_ID}-hole`,
            type: 'circle',
            filter: role('hole'),
            paint: {
                'circle-radius': 4.5,
                'circle-color': '#14281c',
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1.5,
            },
        },
        {
            id: `${PUTT_OVERLAY_ID}-ball`,
            type: 'circle',
            filter: role('ball'),
            paint: {
                'circle-radius': 5.5,
                'circle-color': '#ffffff',
                'circle-stroke-color': '#14281c',
                'circle-stroke-width': 1.5,
            },
        },
    ];
}
