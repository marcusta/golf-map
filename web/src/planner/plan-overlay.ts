// Pure planning-model + overlay-geojson builders for the game-plan editor.
// No MapLibre, no DOM, no services — unit-testable under happy-dom (same
// split as analysis-tool.service vs analysis-overlay). All strategy math
// comes from shared/strategy (single reference implementation); this module
// only assembles nodes/legs and converts geometry for rendering.
//
// Planning model (Phase 5 contract):
//  - Node sequence: origin = selected tee, then plan shots in sort order
//    (each shot's lat/lon = its landing point), terminal = green center.
//  - Leg N = node N → node N+1; leg bearing = planar initial bearing in
//    EPSG:3006 (atan2(Δx, Δy), fine at course scale — consistent everywhere).
//  - The ellipse for a leg anchors at its ORIGIN node and projects forward
//    along the leg bearing; club = the landing shot's clubId, with the TEE
//    leg falling back to the hole's preferredClubId. Legs without a club
//    (e.g. later legs into the green) get no ellipse.
//  - Plays-like per leg via shared/strategy segmentStats on the node
//    elevations (tee/shot/green rows carry sampled elevations).
//
// Coordinates: math in EPSG:3006 planar meters; WGS84 conversion happens
// only when building the GeoJSON FeatureCollection for the map overlay.

import type { Feature, FeatureCollection, Position } from 'geojson';
import type { FilterSpecification } from 'maplibre-gl';
import type { OverlayLayerSpec } from '../map/map.service';
import type { Club } from '../../../shared/api/clubs.gen';
import type { PlanShot, PlanGate } from '../../../shared/api/game-plans.gen';
import {
    adjustedCarryM,
    bearingToUnitVector,
    dispersionEllipse,
    pathSegmentStats,
    windEffect,
    type DispersionEllipse,
    type StrategyPoint,
    type Vec2,
} from '../../../shared/strategy';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from '../geo/transform';

/** Overlay/source id for the plan rendering. */
export const PLAN_OVERLAY_ID = 'plan';

/** Default half-widths for a freshly placed corridor gate, meters. */
export const GATE_DEFAULT_HALF_WIDTH_M = 30;

/** Selection highlight colour (matches the builder tools). */
export const PLAN_SELECTION_COLOR = '#ff8c00';

// ── Planning model ─────────────────────────────────────────────────────────

/** A WGS84 anchor point with its sampled elevation (tee/shot/green rows). */
export interface PlanNodePoint {
    lat: number;
    lon: number;
    elevation: number | null;
}

/** One node of the hole's planning sequence, with projected coordinates. */
export interface PlanNode extends PlanNodePoint {
    kind: 'tee' | 'shot' | 'green';
    /** The backing shot row when kind === 'shot'. */
    shot?: PlanShot;
    /** EPSG:3006 easting/northing, meters. */
    x: number;
    y: number;
}

/** Effective wind for a hole (hole override ?? plan wind; null = calm). */
export interface EffectiveWind {
    speedMps: number;
    directionDeg: number;
}

export interface HolePlanInput {
    /** Resolved origin tee (GamePlanHole.teeId, fallback first by sortOrder). */
    tee: PlanNodePoint | null;
    /** The hole's plan shots, sorted by sortOrder. */
    shots: readonly PlanShot[];
    /** Green center (terminal target). */
    green: PlanNodePoint | null;
    /** All clubs (for clubId lookups). */
    clubs: readonly Club[];
    /** Hole preferredClubId — the tee leg's club fallback. */
    preferredClubId: string | null;
    wind: EffectiveWind | null;
}

/** One leg of the plan with its full readout. */
export interface PlanLeg {
    index: number;
    from: PlanNode;
    to: PlanNode;
    /** Planar initial bearing from → to, compass degrees. */
    bearingDeg: number;
    /** Assigned club (landing shot's club; tee-leg fallback preferredClubId). */
    club: Club | null;
    /** Planar ground distance, meters. */
    horizontalM: number;
    /** horizontal + elevationΔ; undefined when an endpoint lacks elevation. */
    playsLikeM: number | undefined;
    /** Fractional wind carry multiplier for this leg's bearing (0 when calm). */
    windEffect: number;
    /** The assigned club's wind-adjusted carry, meters (undefined: no club). */
    adjustedCarryM: number | undefined;
    /** Dispersion ellipse anchored at `from` (undefined: no club). */
    ellipse: DispersionEllipse | undefined;
    /** Straight-line distance from `to` to the green center, meters. */
    remainingToGreenM: number | undefined;
}

export interface HolePlan {
    nodes: PlanNode[];
    legs: PlanLeg[];
    /** Sum of leg horizontals, meters. */
    totalHorizontalM: number;
    /** Sum of plays-like over legs that have it; undefined when none do. */
    totalPlaysLikeM: number | undefined;
}

/** Planar initial bearing a → b in EPSG:3006, compass degrees [0, 360). */
export function planarBearingDeg(a: Vec2, b: Vec2): number {
    const deg = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
    return (deg + 360) % 360;
}

/** Build the hole's node sequence + legs with all per-leg readouts. */
export function buildHolePlan(input: HolePlanInput): HolePlan {
    const clubById = new Map(input.clubs.map(c => [c.id, c]));

    const nodes: PlanNode[] = [];
    const push = (kind: PlanNode['kind'], p: PlanNodePoint, shot?: PlanShot) => {
        const { x, y } = wgs84ToSweref99tm(p.lat, p.lon);
        nodes.push({ kind, lat: p.lat, lon: p.lon, elevation: p.elevation, x, y, shot });
    };
    if (input.tee) push('tee', input.tee);
    for (const shot of input.shots) {
        push('shot', { lat: shot.lat, lon: shot.lon, elevation: shot.elevation }, shot);
    }
    if (input.green) push('green', input.green);

    const green = nodes.find(n => n.kind === 'green') ?? null;
    const stats = pathSegmentStats(nodes satisfies StrategyPoint[]);

    const legs: PlanLeg[] = [];
    for (let i = 1; i < nodes.length; i++) {
        const from = nodes[i - 1];
        const to = nodes[i];
        const index = i - 1;
        const bearingDeg = planarBearingDeg(from, to);

        // Club: the landing shot's club; the tee leg (index 0) falls back to
        // the hole's preferred club (also covers the par-3 zero-shot leg).
        const clubId = (to.kind === 'shot' ? to.shot?.clubId : null)
            ?? (index === 0 ? input.preferredClubId : null);
        const club = (clubId && clubById.get(clubId)) || null;

        const effect = input.wind
            ? windEffect(input.wind.speedMps, input.wind.directionDeg, bearingDeg)
            : 0;
        // Leg slope (signed elevationΔ / horizontal) so the ellipse projects
        // the club's air carry onto the ground — keeps the dispersion circle
        // consistent with plays-like club selection (downhill reaches further).
        const seg = stats[index];
        const groundSlope = seg.elevationDeltaM !== undefined && seg.horizontalM > 0
            ? seg.elevationDeltaM / seg.horizontalM
            : 0;
        const ellipse = club
            ? dispersionEllipse({
                origin: { x: from.x, y: from.y },
                bearingDeg,
                club,
                groundSlope,
                ...(input.wind !== null
                    ? { windSpeedMps: input.wind.speedMps, windDirectionDeg: input.wind.directionDeg }
                    : {}),
            })
            : undefined;

        legs.push({
            index,
            from,
            to,
            bearingDeg,
            club,
            horizontalM: stats[index].horizontalM,
            playsLikeM: stats[index].playsLikeSimpleM,
            windEffect: effect,
            adjustedCarryM: club ? adjustedCarryM(club.carryM, effect) : undefined,
            ellipse,
            remainingToGreenM: green ? Math.hypot(green.x - to.x, green.y - to.y) : undefined,
        });
    }

    let totalHorizontalM = 0;
    let totalPlaysLikeM = 0;
    let measured = 0;
    for (const leg of legs) {
        totalHorizontalM += leg.horizontalM;
        if (leg.playsLikeM !== undefined) {
            totalPlaysLikeM += leg.playsLikeM;
            measured++;
        }
    }

    return {
        nodes,
        legs,
        totalHorizontalM,
        totalPlaysLikeM: measured > 0 ? totalPlaysLikeM : undefined,
    };
}

// ── Corridor-gate geometry ─────────────────────────────────────────────────

/**
 * Perpendicular foot of `p` on segment a → b, clamped to the segment.
 * `t` is the normalized position along a → b in [0, 1].
 */
export function perpendicularFoot(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number } {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const raw = len2 === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    const t = Math.min(1, Math.max(0, raw));
    return { point: { x: a.x + abx * t, y: a.y + aby * t }, t };
}

export interface LegFoot {
    legIndex: number;
    /** Foot point on the leg, EPSG:3006 meters. */
    point: Vec2;
    /** Planar distance from `p` to the foot, meters. */
    distM: number;
    t: number;
}

/** The nearest leg's perpendicular foot for `p`, or null with no legs. */
export function nearestLegFoot(p: Vec2, legs: readonly PlanLeg[]): LegFoot | null {
    let best: LegFoot | null = null;
    for (const leg of legs) {
        const { point, t } = perpendicularFoot(p, leg.from, leg.to);
        const distM = Math.hypot(p.x - point.x, p.y - point.y);
        if (!best || distM < best.distM) best = { legIndex: leg.index, point, distM, t };
    }
    return best;
}

/**
 * The gate ruler's endpoints: the ruler runs PERPENDICULAR to the stored
 * corridor-axis bearing (directionDeg). "Left"/"right" are relative to the
 * play direction — left = bearing − 90°, right = bearing + 90°.
 */
export function gateEndpoints(
    station: Vec2,
    directionDeg: number,
    halfWidthLeftM: number,
    halfWidthRightM: number,
): { left: Vec2; right: Vec2 } {
    const leftUnit = bearingToUnitVector(directionDeg - 90);
    const rightUnit = bearingToUnitVector(directionDeg + 90);
    return {
        left: { x: station.x + leftUnit.x * halfWidthLeftM, y: station.y + leftUnit.y * halfWidthLeftM },
        right: { x: station.x + rightUnit.x * halfWidthRightM, y: station.y + rightUnit.y * halfWidthRightM },
    };
}

// ── Overlay GeoJSON ────────────────────────────────────────────────────────

export interface PlanOverlayInput {
    plan: HolePlan | null;
    gates: readonly PlanGate[];
    selectedShotId: string | null;
    selectedGateId: string | null;
}

function toPosition(p: Vec2): Position {
    const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
    return [lon, lat];
}

/**
 * Leg label: ground distance, then the "plays-as" (elevation plays-like)
 * distance, then the assigned club and its ABSOLUTE (nominal) carry — so the
 * map shows both how far the shot plays and what the club actually carries.
 * e.g. "184 m · plays 176 m · 7 Iron 150 m" (club/plays parts omitted when
 * absent).
 */
export function legLabel(leg: PlanLeg): string {
    const parts = [`${Math.round(leg.horizontalM)} m`];
    if (leg.playsLikeM !== undefined) parts.push(`plays ${Math.round(leg.playsLikeM)} m`);
    if (leg.club) parts.push(`${leg.club.name} ${Math.round(leg.club.carryM)} m`);
    return parts.join(' · ');
}

/** "L 24 m | R 31 m" gate width label. */
export function gateLabel(gate: PlanGate): string {
    return `L ${Math.round(gate.halfWidthLeftM)} m | R ${Math.round(gate.halfWidthRightM)} m`;
}

/**
 * The plan overlay FeatureCollection (WGS84). Roles: `leg` (LineString with
 * a distance label), `ellipse` (Polygon per clubbed leg, selected = the
 * selected shot's landing ellipse), `node` (tee/shot/green markers), and
 * `gate-line` / `gate-handle` / `gate-label` for corridor rulers.
 */
export function buildPlanGeojson(input: PlanOverlayInput): FeatureCollection {
    const features: Feature[] = [];
    const plan = input.plan;

    if (plan) {
        for (const leg of plan.legs) {
            features.push({
                type: 'Feature',
                properties: { role: 'leg', index: leg.index, label: legLabel(leg) },
                geometry: {
                    type: 'LineString',
                    coordinates: [[leg.from.lon, leg.from.lat], [leg.to.lon, leg.to.lat]],
                },
            });
            if (leg.ellipse) {
                const selected = leg.to.kind === 'shot'
                    && leg.to.shot !== undefined
                    && leg.to.shot.id === input.selectedShotId;
                features.push({
                    type: 'Feature',
                    properties: { role: 'ellipse', legIndex: leg.index, selected },
                    geometry: { type: 'Polygon', coordinates: [leg.ellipse.polygon.map(toPosition)] },
                });
            }
        }

        let shotNumber = 0;
        for (const node of plan.nodes) {
            if (node.kind === 'shot') shotNumber++;
            features.push({
                type: 'Feature',
                properties: {
                    role: 'node',
                    kind: node.kind,
                    id: node.shot?.id ?? null,
                    label: node.kind === 'tee' ? 'T' : node.kind === 'green' ? 'G' : String(shotNumber),
                    selected: node.kind === 'shot' && node.shot?.id === input.selectedShotId,
                },
                geometry: { type: 'Point', coordinates: [node.lon, node.lat] },
            });
        }
    }

    for (const gate of input.gates) {
        const station = wgs84ToSweref99tm(gate.lat, gate.lon);
        const { left, right } = gateEndpoints(
            station, gate.directionDeg, gate.halfWidthLeftM, gate.halfWidthRightM);
        const selected = gate.id === input.selectedGateId;
        features.push({
            type: 'Feature',
            properties: { role: 'gate-line', id: gate.id, selected, label: gateLabel(gate) },
            geometry: { type: 'LineString', coordinates: [toPosition(left), toPosition(right)] },
        });
        for (const [side, p] of [['left', left], ['right', right]] as const) {
            features.push({
                type: 'Feature',
                properties: { role: 'gate-handle', id: gate.id, side, selected },
                geometry: { type: 'Point', coordinates: toPosition(p) },
            });
        }
        features.push({
            type: 'Feature',
            properties: { role: 'gate-label', id: gate.id, label: gateLabel(gate) },
            geometry: { type: 'Point', coordinates: [gate.lon, gate.lat] },
        });
    }

    return { type: 'FeatureCollection', features };
}

const role = (value: string): FilterSpecification =>
    ['==', ['get', 'role'], value] as FilterSpecification;

const LEG_COLOR = '#fbbf24'; // amber, like the measure path
const ELLIPSE_COLOR = '#2f7d4f';
const GATE_COLOR = '#06b6d4';

/** Layer specs for the plan overlay (ids prefixed with the overlay id). */
export function planLayers(): OverlayLayerSpec[] {
    return [
        {
            id: `${PLAN_OVERLAY_ID}-ellipse-fill`,
            type: 'fill',
            filter: role('ellipse'),
            paint: {
                'fill-color': ELLIPSE_COLOR,
                'fill-opacity': ['case', ['==', ['get', 'selected'], true], 0.3, 0.15] as never,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-ellipse-outline`,
            type: 'line',
            filter: role('ellipse'),
            paint: {
                'line-color': ['case', ['==', ['get', 'selected'], true], PLAN_SELECTION_COLOR, ELLIPSE_COLOR] as never,
                'line-width': ['case', ['==', ['get', 'selected'], true], 2.5, 1.2] as never,
                'line-opacity': 0.9,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-leg`,
            type: 'line',
            filter: role('leg'),
            paint: { 'line-color': LEG_COLOR, 'line-width': 2.5 },
        },
        {
            id: `${PLAN_OVERLAY_ID}-leg-label`,
            type: 'symbol',
            filter: role('leg'),
            layout: {
                'symbol-placement': 'line-center',
                'text-field': ['get', 'label'] as never,
                'text-size': 12,
                'text-offset': [0, -1],
                'text-allow-overlap': true,
            },
            paint: { 'text-color': '#ffffff', 'text-halo-color': '#14281c', 'text-halo-width': 1.5 },
        },
        {
            id: `${PLAN_OVERLAY_ID}-gate-line`,
            type: 'line',
            filter: role('gate-line'),
            paint: {
                'line-color': ['case', ['==', ['get', 'selected'], true], PLAN_SELECTION_COLOR, GATE_COLOR] as never,
                'line-width': 3,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-gate-handle`,
            type: 'circle',
            filter: role('gate-handle'),
            paint: {
                'circle-radius': 6,
                'circle-color': '#ffffff',
                'circle-stroke-color': ['case', ['==', ['get', 'selected'], true], PLAN_SELECTION_COLOR, GATE_COLOR] as never,
                'circle-stroke-width': 2,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-gate-label`,
            type: 'symbol',
            filter: role('gate-label'),
            layout: {
                'text-field': ['get', 'label'] as never,
                'text-size': 11,
                'text-offset': [0, 1.6],
                'text-anchor': 'top',
                'text-allow-overlap': true,
            },
            paint: { 'text-color': '#ffffff', 'text-halo-color': '#0c3a42', 'text-halo-width': 1.5 },
        },
        {
            id: `${PLAN_OVERLAY_ID}-node-sel`,
            type: 'circle',
            filter: ['all', role('node'), ['==', ['get', 'selected'], true]] as FilterSpecification,
            paint: {
                'circle-radius': 11,
                'circle-color': 'transparent',
                'circle-stroke-color': PLAN_SELECTION_COLOR,
                'circle-stroke-width': 2.5,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-node`,
            type: 'circle',
            filter: role('node'),
            paint: {
                'circle-radius': ['match', ['get', 'kind'], 'shot', 7, 6] as never,
                'circle-color': [
                    'match', ['get', 'kind'],
                    'tee', '#3a7bd5',
                    'green', ELLIPSE_COLOR,
                    '#ffffff',
                ] as never,
                'circle-stroke-color': '#1d3b2a',
                'circle-stroke-width': 1.5,
            },
        },
        {
            id: `${PLAN_OVERLAY_ID}-node-label`,
            type: 'symbol',
            filter: role('node'),
            layout: {
                'text-field': ['get', 'label'] as never,
                'text-size': 10,
                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] as never,
                'text-allow-overlap': true,
            },
            paint: {
                'text-color': ['match', ['get', 'kind'], 'shot', '#1d3b2a', '#ffffff'] as never,
                'text-halo-color': ['match', ['get', 'kind'], 'shot', '#ffffff', '#1d3b2a'] as never,
                'text-halo-width': 1,
            },
        },
    ];
}
