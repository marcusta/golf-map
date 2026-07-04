import type { Feature, FeatureCollection, Position } from 'geojson';
import type { FilterSpecification } from 'maplibre-gl';
import type { OverlayLayerSpec } from '../map/map.service';
import type { Tee } from '../../../shared/api/tees.gen';
import type { Green } from '../../../shared/api/greens.gen';
import type { Pin } from '../../../shared/api/pins.gen';
import type { AimPoint } from '../../../shared/api/aim-points.gen';
import { FURNITURE_TOOL_ID, type Selection } from './furniture.service';

/** Overlay/source id for the persistent furniture rendering. */
export const FURNITURE_OVERLAY_ID = FURNITURE_TOOL_ID;

export const SELECTION_COLOR = '#ff8c00';

/** Tee colour name → CSS fill. Unknown/null falls back to grey. */
const TEE_FILL: Record<string, string> = {
    black: '#222222',
    white: '#f5f5f5',
    yellow: '#f2c200',
    blue: '#2f6fed',
    red: '#d63a3a',
};

export function teeFill(color: string | null | undefined): string {
    return (color && TEE_FILL[color]) || '#9aa0a6';
}

/** Single uppercase letter label for a tee (first char of colour, else name). */
export function teeLetter(tee: Tee): string {
    const src = tee.color || tee.name || '?';
    return src.charAt(0).toUpperCase();
}

export interface OverlayInput {
    tees: Tee[];
    pins: Pin[];
    greens: Green[];
    aims: AimPoint[];
    /** aim points grouped/ordered per hole, for the ordered polyline + numbering. */
    holeIds: string[];
    /** Selected item, for emphasis. */
    selection: Selection;
    /**
     * Per-hole tee id the aim polyline anchors on (holeId → teeId). Lets the
     * caller pick a "line from" tee other than the first by sortOrder. When a
     * hole is absent or its id doesn't resolve to one of the hole's tees, the
     * builder falls back to the first tee by sortOrder.
     */
    lineOriginByHole?: Map<string, string>;
}

/**
 * Build the persistent furniture FeatureCollection (WGS84). Encodes a
 * `role` per feature for the layer filters below, plus per-role display
 * properties (tee colour/letter, pin active, aim number, selection flag).
 * Aim points are joined per hole into an ordered polyline
 * (tee → aim1 → aim2 → … → green center).
 */
export function buildFurnitureGeojson(input: OverlayInput): FeatureCollection {
    const features: Feature[] = [];
    const sel = input.selection;
    const isSel = (kind: string, id: string) =>
        !!sel && sel.kind === kind && 'id' in sel && sel.id === id;
    const isSelGreen = (holeId: string, point: 'center' | 'front' | 'back') =>
        !!sel && sel.kind === 'green' && sel.holeId === holeId && sel.point === point;

    // Per-hole ordered aim polyline: tee (first, by sortOrder) → aims → green center.
    for (const holeId of input.holeIds) {
        const holeAims = input.aims
            .filter(a => a.holeId === holeId)
            .sort((a, b) => a.sortOrder - b.sortOrder);
        // No early-out on zero aims: par 3s draw the direct tee → green line
        // (the line.length >= 2 guard below handles genuinely empty holes).
        const green = input.greens.find(g => g.holeId === holeId) ?? null;
        const holeTees = input.tees
            .filter(t => t.holeId === holeId)
            .sort((a, b) => a.sortOrder - b.sortOrder);
        // Anchor on the caller-chosen "line from" tee when it resolves to one
        // of this hole's tees; else fall back to the first by sortOrder.
        const originId = input.lineOriginByHole?.get(holeId);
        const originTee = (originId && holeTees.find(t => t.id === originId)) || holeTees[0];
        const line: Position[] = [];
        if (originTee) line.push([originTee.lon, originTee.lat]);
        for (const a of holeAims) line.push([a.lon, a.lat]);
        if (green) line.push([green.centerLon, green.centerLat]);
        if (line.length >= 2) {
            features.push({
                type: 'Feature',
                properties: { role: 'aim-line' },
                geometry: { type: 'LineString', coordinates: line },
            });
        }
    }

    // Greens: center / front / back dots (selectable; a selection ring layer
    // keys on the `selected` flag).
    for (const g of input.greens) {
        features.push(point([g.centerLon, g.centerLat], { role: 'green-center', selected: isSelGreen(g.holeId, 'center') }));
        if (g.frontLat !== null && g.frontLon !== null) {
            features.push(point([g.frontLon, g.frontLat], { role: 'green-front', selected: isSelGreen(g.holeId, 'front') }));
        }
        if (g.backLat !== null && g.backLon !== null) {
            features.push(point([g.backLon, g.backLat], { role: 'green-back', selected: isSelGreen(g.holeId, 'back') }));
        }
    }

    // Tees: coloured circles with a letter label.
    for (const t of input.tees) {
        features.push(point([t.lon, t.lat], {
            role: 'tee',
            id: t.id,
            fill: teeFill(t.color),
            letter: teeLetter(t),
            selected: isSel('tee', t.id),
        }));
    }

    // Pins: dots, active emphasized.
    for (const p of input.pins) {
        features.push(point([p.lon, p.lat], {
            role: 'pin',
            id: p.id,
            active: p.active,
            name: p.name,
            selected: isSel('pin', p.id),
        }));
    }

    // Aim points: numbered diamonds (number = 1-based index within its hole order).
    const aimNumberByHole = new Map<string, Map<string, number>>();
    for (const holeId of input.holeIds) {
        const ordered = input.aims
            .filter(a => a.holeId === holeId)
            .sort((a, b) => a.sortOrder - b.sortOrder);
        const map = new Map<string, number>();
        ordered.forEach((a, i) => map.set(a.id, i + 1));
        aimNumberByHole.set(holeId, map);
    }
    for (const a of input.aims) {
        const number = aimNumberByHole.get(a.holeId)?.get(a.id) ?? 0;
        features.push(point([a.lon, a.lat], {
            role: 'aim',
            id: a.id,
            number,
            selected: isSel('aim', a.id),
        }));
    }

    return { type: 'FeatureCollection', features };
}

function point(coordinates: Position, properties: Record<string, unknown>): Feature {
    return { type: 'Feature', properties, geometry: { type: 'Point', coordinates } };
}

const role = (value: string): FilterSpecification =>
    ['==', ['get', 'role'], value] as FilterSpecification;

/** Layer specs for the furniture overlay (ids prefixed with the overlay id). */
export function furnitureLayers(): OverlayLayerSpec[] {
    return [
        // Ordered aim polyline (below the markers).
        {
            id: `${FURNITURE_OVERLAY_ID}-aim-line`,
            type: 'line',
            filter: role('aim-line'),
            paint: { 'line-color': '#3a7bd5', 'line-width': 1.5, 'line-opacity': 0.8, 'line-dasharray': [2, 1.5] },
        },
        // Green point selection ring (under the dots; same halo as tee/pin/aim).
        {
            id: `${FURNITURE_OVERLAY_ID}-green-sel`,
            type: 'circle',
            filter: ['all',
                ['in', ['get', 'role'], ['literal', ['green-center', 'green-front', 'green-back']]],
                ['==', ['get', 'selected'], true],
            ] as FilterSpecification,
            paint: { 'circle-radius': 10, 'circle-color': 'transparent', 'circle-stroke-color': SELECTION_COLOR, 'circle-stroke-width': 2.5 },
        },
        // Green reference dots.
        {
            id: `${FURNITURE_OVERLAY_ID}-green-back`,
            type: 'circle',
            filter: role('green-back'),
            paint: { 'circle-radius': 4, 'circle-color': '#6ab04c', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 },
        },
        {
            id: `${FURNITURE_OVERLAY_ID}-green-front`,
            type: 'circle',
            filter: role('green-front'),
            paint: { 'circle-radius': 4, 'circle-color': '#badc58', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 },
        },
        {
            id: `${FURNITURE_OVERLAY_ID}-green-center`,
            type: 'circle',
            filter: role('green-center'),
            paint: { 'circle-radius': 5, 'circle-color': '#2f7d4f', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 },
        },
        {
            id: `${FURNITURE_OVERLAY_ID}-green-labels`,
            type: 'symbol',
            filter: ['in', ['get', 'role'], ['literal', ['green-center', 'green-front', 'green-back']]] as FilterSpecification,
            layout: {
                'text-field': [
                    'match', ['get', 'role'],
                    'green-center', 'C', 'green-front', 'F', 'green-back', 'B', '',
                ] as never,
                'text-size': 9,
                'text-offset': [0, -1.1],
                'text-allow-overlap': true,
            },
            paint: { 'text-color': '#1d3b2a', 'text-halo-color': '#ffffff', 'text-halo-width': 1 },
        },
        // Aim diamonds (rotated square) + selection ring.
        {
            id: `${FURNITURE_OVERLAY_ID}-aim-sel`,
            type: 'circle',
            filter: ['all', role('aim'), ['==', ['get', 'selected'], true]] as FilterSpecification,
            paint: { 'circle-radius': 11, 'circle-color': 'transparent', 'circle-stroke-color': SELECTION_COLOR, 'circle-stroke-width': 2.5 },
        },
        {
            id: `${FURNITURE_OVERLAY_ID}-aim`,
            type: 'symbol',
            filter: role('aim'),
            layout: {
                'text-field': ['to-string', ['get', 'number']] as never,
                'text-size': 11,
                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] as never,
                'text-allow-overlap': true,
            },
            paint: { 'text-color': '#ffffff', 'text-halo-color': '#5b3b8c', 'text-halo-width': 3 },
        },
        // Tees: coloured circle + selection ring + letter label.
        {
            id: `${FURNITURE_OVERLAY_ID}-tee-sel`,
            type: 'circle',
            filter: ['all', role('tee'), ['==', ['get', 'selected'], true]] as FilterSpecification,
            paint: { 'circle-radius': 11, 'circle-color': 'transparent', 'circle-stroke-color': SELECTION_COLOR, 'circle-stroke-width': 2.5 },
        },
        {
            id: `${FURNITURE_OVERLAY_ID}-tee`,
            type: 'circle',
            filter: role('tee'),
            paint: {
                'circle-radius': 7,
                'circle-color': ['get', 'fill'] as never,
                'circle-stroke-color': '#1d3b2a',
                'circle-stroke-width': 1.5,
            },
        },
        {
            id: `${FURNITURE_OVERLAY_ID}-tee-label`,
            type: 'symbol',
            filter: role('tee'),
            layout: {
                'text-field': ['get', 'letter'] as never,
                'text-size': 9,
                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] as never,
                'text-allow-overlap': true,
            },
            paint: { 'text-color': '#1d3b2a', 'text-halo-color': '#ffffff', 'text-halo-width': 1 },
        },
        // Pins: selection ring, active ring, dot, name label.
        {
            id: `${FURNITURE_OVERLAY_ID}-pin-sel`,
            type: 'circle',
            filter: ['all', role('pin'), ['==', ['get', 'selected'], true]] as FilterSpecification,
            paint: { 'circle-radius': 11, 'circle-color': 'transparent', 'circle-stroke-color': SELECTION_COLOR, 'circle-stroke-width': 2.5 },
        },
        {
            id: `${FURNITURE_OVERLAY_ID}-pin-active`,
            type: 'circle',
            filter: ['all', role('pin'), ['==', ['get', 'active'], true]] as FilterSpecification,
            paint: { 'circle-radius': 9, 'circle-color': 'transparent', 'circle-stroke-color': '#d63a3a', 'circle-stroke-width': 2 },
        },
        {
            id: `${FURNITURE_OVERLAY_ID}-pin`,
            type: 'circle',
            filter: role('pin'),
            paint: {
                'circle-radius': 5,
                'circle-color': ['case', ['==', ['get', 'active'], true], '#d63a3a', '#ffffff'] as never,
                'circle-stroke-color': '#d63a3a',
                'circle-stroke-width': 2,
            },
        },
    ];
}
