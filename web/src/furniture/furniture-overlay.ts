import type { Feature, FeatureCollection, Position } from 'geojson';
import type { FilterSpecification } from 'maplibre-gl';
import type { OverlayLayerSpec } from '../map/map.service';
import type { Tee } from '../../../shared/api/tees.gen';
import type { Green } from '../../../shared/api/greens.gen';
import type { Pin } from '../../../shared/api/pins.gen';
import type { AimPoint } from '../../../shared/api/aim-points.gen';
import { FURNITURE_TOOL_ID, finiteWgs84Point, type Selection } from './furniture.service';
import {
    ACCENT_COLOR,
    CAT,
    MARKER_FILL,
    OVERLAY_TEXT,
    SHOT_LINE_COLOR,
    SHOT_LINE_WIDTH,
    STATUS_BAD,
    STATUS_NEUTRAL,
} from '../map/map-palette';

/** Overlay/source id for the persistent furniture rendering. */
export const FURNITURE_OVERLAY_ID = FURNITURE_TOOL_ID;

export const SELECTION_COLOR = ACCENT_COLOR; // '#BF6A3E' — --data-cat-1 / accent

/**
 * Tee colour name → CSS fill. Real-world tee-marker identity colours, so
 * hue-true, but drawn from the L&L cartography ramp (guide §03: tee markers
 * take the feature colour with a dark glyph). Unknown/null falls back to
 * the neutral data token.
 */
const TEE_FILL: Record<string, string> = {
    black: '#211D14', // --color-text-primary (light) — ink, not pure black
    white: '#EFEAE0', // --map-oob-fill — bone white
    yellow: '#E8CB56', // --map-penalty-yellow-fill
    blue: '#4C8FBE', // --map-water-fill
    red: '#DE6152', // --map-penalty-red-fill
};

export function teeFill(color: string | null | undefined): string {
    return (color && TEE_FILL[color]) || STATUS_NEUTRAL; // '#9C917A' — --data-neutral
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
     * Hole whose furniture is softly highlighted (the selected hole in the
     * sidebar). Every feature carries a `holeId`; features on this hole also
     * carry `highlighted: true`, which a halo layer + the aim-line paint key
     * on. Null/absent → nothing highlighted.
     */
    highlightHoleId?: string | null;
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
    const hl = (holeId: string) => holeId === input.highlightHoleId;
    // Pins hang off a green row (greenId), not a hole — resolve pin → hole
    // via the greens so pins highlight with the rest of their hole.
    const holeIdByGreen = new Map(input.greens.map(g => [g.id, g.holeId]));

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
        const originPos = originTee ? finiteWgs84Point(originTee.lat, originTee.lon) : null;
        if (originPos) line.push([originPos.lon, originPos.lat]);
        for (const a of holeAims) {
            const pos = finiteWgs84Point(a.lat, a.lon);
            if (pos) line.push([pos.lon, pos.lat]);
        }
        const greenCenter = green ? finiteWgs84Point(green.centerLat, green.centerLon) : null;
        if (greenCenter) line.push([greenCenter.lon, greenCenter.lat]);
        if (line.length >= 2) {
            features.push({
                type: 'Feature',
                properties: { role: 'aim-line', holeId, highlighted: hl(holeId) },
                geometry: { type: 'LineString', coordinates: line },
            });
        }
    }

    // Greens: center / front / back dots (selectable; a selection ring layer
    // keys on the `selected` flag).
    for (const g of input.greens) {
        const hlG = hl(g.holeId);
        const center = finiteWgs84Point(g.centerLat, g.centerLon);
        const front = finiteWgs84Point(g.frontLat, g.frontLon);
        const back = finiteWgs84Point(g.backLat, g.backLon);
        if (center) features.push(point([center.lon, center.lat], { role: 'green-center', holeId: g.holeId, highlighted: hlG, selected: isSelGreen(g.holeId, 'center') }));
        if (front) features.push(point([front.lon, front.lat], { role: 'green-front', holeId: g.holeId, highlighted: hlG, selected: isSelGreen(g.holeId, 'front') }));
        if (back) features.push(point([back.lon, back.lat], { role: 'green-back', holeId: g.holeId, highlighted: hlG, selected: isSelGreen(g.holeId, 'back') }));
    }

    // Tees: coloured circles with a letter label.
    for (const t of input.tees) {
        const pos = finiteWgs84Point(t.lat, t.lon);
        if (!pos) continue;
        features.push(point([pos.lon, pos.lat], {
            role: 'tee',
            id: t.id,
            holeId: t.holeId,
            highlighted: hl(t.holeId),
            fill: teeFill(t.color),
            letter: teeLetter(t),
            selected: isSel('tee', t.id),
        }));
    }

    // Pins: dots, active emphasized.
    for (const p of input.pins) {
        const holeId = holeIdByGreen.get(p.greenId);
        const pos = finiteWgs84Point(p.lat, p.lon);
        if (!pos) continue;
        features.push(point([pos.lon, pos.lat], {
            role: 'pin',
            id: p.id,
            holeId: holeId ?? null,
            highlighted: holeId !== undefined && hl(holeId),
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
        const pos = finiteWgs84Point(a.lat, a.lon);
        if (!pos) continue;
        features.push(point([pos.lon, pos.lat], {
            role: 'aim',
            id: a.id,
            holeId: a.holeId,
            highlighted: hl(a.holeId),
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
        // Ordered aim polyline (below the markers). The selected hole's line
        // reads brighter + thicker.
        {
            id: `${FURNITURE_OVERLAY_ID}-aim-line`,
            type: 'line',
            filter: role('aim-line'),
            // Guide §03 shot/aim lines: --map-shot-line, 3px, rounded ends.
            // The selected hole's line gets the full treatment; the rest of
            // the course reads quieter (thinner + dimmer, same hue). Dashed
            // keeps aim guides distinct from played plan legs.
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': SHOT_LINE_COLOR, // '#E4A15A' — --map-shot-line
                'line-width': ['case', ['==', ['get', 'highlighted'], true], SHOT_LINE_WIDTH, 2] as never,
                'line-opacity': ['case', ['==', ['get', 'highlighted'], true], 1, 0.75] as never,
                'line-dasharray': [2, 1.5],
            },
        },
        // Soft halo behind every marker on the selected hole (slight highlight).
        // First real marker layer → sits under the dots/labels/rings.
        {
            id: `${FURNITURE_OVERLAY_ID}-hole-highlight`,
            type: 'circle',
            filter: ['all',
                ['in', ['get', 'role'], ['literal', ['tee', 'pin', 'aim', 'green-center', 'green-front', 'green-back']]],
                ['==', ['get', 'highlighted'], true],
            ] as FilterSpecification,
            paint: {
                'circle-radius': 13,
                'circle-color': SELECTION_COLOR,
                'circle-opacity': 0.16,
                'circle-stroke-color': SELECTION_COLOR,
                'circle-stroke-width': 1,
                'circle-stroke-opacity': 0.35,
            },
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
        // Green reference dots — the L&L green ramp (they sit ON the green
        // fill): back = dark outline green, front = light draw green,
        // center = moss, all ringed in overlay-text bone.
        {
            id: `${FURNITURE_OVERLAY_ID}-green-back`,
            type: 'circle',
            filter: role('green-back'),
            paint: { 'circle-radius': 4, 'circle-color': '#3F7A55' /* --map-green-outline */, 'circle-stroke-color': OVERLAY_TEXT, 'circle-stroke-width': 1 },
        },
        {
            id: `${FURNITURE_OVERLAY_ID}-green-front`,
            type: 'circle',
            filter: role('green-front'),
            paint: { 'circle-radius': 4, 'circle-color': '#97D79B' /* --map-green-draw */, 'circle-stroke-color': OVERLAY_TEXT, 'circle-stroke-width': 1 },
        },
        {
            id: `${FURNITURE_OVERLAY_ID}-green-center`,
            type: 'circle',
            filter: role('green-center'),
            paint: { 'circle-radius': 5, 'circle-color': CAT.moss /* '#5C6B4A' — --data-cat-4 */, 'circle-stroke-color': OVERLAY_TEXT, 'circle-stroke-width': 1.5 },
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
            // Dark glyph on the light dots (guide §03: feature-coloured
            // markers take a dark glyph): pine on a bone halo.
            paint: { 'text-color': MARKER_FILL, 'text-halo-color': OVERLAY_TEXT, 'text-halo-width': 1 },
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
            // The wide halo is the aim marker's body: slate from the
            // categorical ramp (aims are their own annotation category),
            // overlay-text glyph.
            paint: { 'text-color': OVERLAY_TEXT, 'text-halo-color': CAT.slate /* '#5E6D94' — --data-cat-5 */, 'text-halo-width': 3 },
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
                // Pine ring, not bone: tee fills include bone-white, which
                // would vanish inside an overlay-text ring.
                'circle-stroke-color': MARKER_FILL, // '#1E2B22' — --color-surface-brand
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
                'text-allow-overlap': true, // marker glyphs, must never disappear
            },
            // Feature-coloured marker → dark glyph (guide §03).
            paint: { 'text-color': MARKER_FILL, 'text-halo-color': OVERLAY_TEXT, 'text-halo-width': 1 },
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
            paint: { 'circle-radius': 9, 'circle-color': 'transparent', 'circle-stroke-color': STATUS_BAD /* '#B24A32' — --data-bad, flag red */, 'circle-stroke-width': 2 },
        },
        {
            id: `${FURNITURE_OVERLAY_ID}-pin`,
            type: 'circle',
            filter: role('pin'),
            paint: {
                'circle-radius': 5,
                'circle-color': ['case', ['==', ['get', 'active'], true], STATUS_BAD, OVERLAY_TEXT] as never,
                'circle-stroke-color': STATUS_BAD, // '#B24A32' — --data-bad (flag red)
                'circle-stroke-width': 2,
            },
        },
    ];
}
