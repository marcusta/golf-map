// Map rendering for the hole simulator (feature-hole-sim-and-variants §5):
// the landing-scatter dot cloud (Phase B) and the suggest-lines ghost
// branches (Phase C / V7).
//
// Pure builders, exactly like plan-overlay.ts: GeoJSON in projected-meter
// space converted to WGS84, plus the MapLibre layer specs. No MapLibre
// import, no DOM, no signals — so every shape here is unit-testable and the
// tool service only does the add/update/remove lifecycle.
//
// Overlay language (shot-options §2.3 + §5): ghost branches reuse the SAME
// dashed/dimmed treatment as non-primary options, with the sim's own tint
// (--data-cat-2 teal) so a suggestion never reads as something already
// authored. Scatter dots take the map's own feature-fill tokens per lie class
// (map-palette LIE_FILL) and slot BELOW the vector feature fills, like the
// other derived overlays, so the course still reads through the cloud.

import type { Feature, FeatureCollection } from 'geojson';
import type { ChainLeg, ScoredVariant, VariantSignature, Vec2 } from '../../../shared/strategy';
import { dispersionEllipse } from '../../../shared/strategy';
import { sweref99tmToWgs84 } from '../geo/transform';
import type { OverlayLayerSpec } from '../map/map.service';
import { CAT, LIE_FILL, LIE_FILL_DEFAULT, OVERLAY_TEXT, OVERLAY_TEXT_HALO } from '../map/map-palette';

/** Overlay id for the sampled-landing dot cloud. */
export const SIM_SCATTER_OVERLAY_ID = 'plan-sim-scatter';
/** Overlay id for the suggest-lines ghost branches. */
export const VARIANT_OVERLAY_ID = 'plan-variants';

/**
 * The layer the scatter slots UNDER: the plan overlay's bottom layer, so the
 * cloud draws ABOVE the vector feature fills (under them the translucent fills
 * washed it out — the dots were invisible) but still BELOW the plan's own legs,
 * ellipses and labels, which stay the thing you read first.
 * Silently ignored (overlay goes topmost) when that layer is absent.
 */
export const SCATTER_BEFORE_LAYER_ID = 'plan-ellipse-fill';

/** §5 subsample cap: ~200 dots per leg is a readable cloud, not a smear. */
export const SCATTER_MAX_PER_LEG = 200;

/** Ghost tint — distinct from the plan's plum ghost-aim and clay accent. */
export const VARIANT_COLOR = CAT.teal; // '#3E8EA0' — --data-cat-2

/** One sampled landing, ready to draw. */
export interface ScatterPoint {
    /** Leg depth the sample belongs to (0 = tee shot). */
    depth: number;
    /** Lie class at the sampled landing (shared/strategy `Lie`). */
    lie: string;
    point: Vec2;
}

/**
 * Evenly-spaced subsample of `points`, capped at `max`. Deterministic (a
 * stride, not a random draw) so the same simulation always draws the same
 * cloud — the whole feature is reproducible-by-seed and the overlay must not
 * be the one place that isn't.
 */
export function subsample<T>(points: readonly T[], max: number): T[] {
    if (max <= 0 || points.length === 0) return [];
    if (points.length <= max) return [...points];
    const out: T[] = [];
    const stride = points.length / max;
    for (let i = 0; i < max; i++) out.push(points[Math.floor(i * stride)]);
    return out;
}

/** Landing samples as WGS84 points carrying their lie class + leg depth. */
export function buildScatterGeojson(points: readonly ScatterPoint[]): FeatureCollection {
    return {
        type: 'FeatureCollection',
        features: points.map(p => {
            const { lat, lon } = sweref99tmToWgs84(p.point.x, p.point.y);
            return {
                type: 'Feature',
                properties: { lie: p.lie, depth: p.depth },
                geometry: { type: 'Point', coordinates: [lon, lat] },
            } satisfies Feature;
        }),
    };
}

/**
 * Dot colour per LEG DEPTH — the default, and the reason the cloud is legible:
 * lie colours are the same palette as the course polygons the dots sit on
 * (green on green), so the cloud disappeared into the map. Depth colour also
 * answers the question the player actually has ("which cloud is my drive?").
 * Cycles past the end (a 5-leg branch is already pathological).
 */
export const SCATTER_DEPTH_COLORS = [CAT.clay, CAT.sky, CAT.wheat, CAT.plum, CAT.moss];

/** What the dots are coloured by: leg depth (default) or lie class. */
export type ScatterColorBy = 'depth' | 'lie';

/**
 * Dot cloud: coloured by leg depth (or lie), dark-outlined so it reads over
 * fairway, green and sand alike. Drawn ABOVE the vector feature fills — under
 * them the translucent fills washed the cloud out completely.
 */
export function scatterLayers(opts: { colorBy?: ScatterColorBy } = {}): OverlayLayerSpec[] {
    // Built at runtime from the palettes so those stay the single source of
    // truth; MapLibre's expression types can't describe a variadic `match`, so
    // each array is assembled untyped and cast once at the layer boundary.
    const byLie: unknown[] = ['match', ['get', 'lie']];
    for (const [lie, color] of Object.entries(LIE_FILL)) byLie.push(lie, color);
    byLie.push(LIE_FILL_DEFAULT);

    const byDepth: unknown[] = ['match', ['get', 'depth']];
    SCATTER_DEPTH_COLORS.forEach((color, depth) => byDepth.push(depth, color));
    byDepth.push(SCATTER_DEPTH_COLORS[0]);

    const color = (opts.colorBy === 'lie' ? byLie : byDepth) as unknown as string;
    return [
        {
            id: `${SIM_SCATTER_OVERLAY_ID}-dot`,
            type: 'circle',
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.2, 18, 4.6],
                'circle-color': color,
                'circle-opacity': 0.85,
                'circle-stroke-width': 0.9,
                'circle-stroke-color': OVERLAY_TEXT_HALO,
                'circle-stroke-opacity': 0.8,
            },
        } as OverlayLayerSpec,
    ];
}

// ── Suggest lines (V7) ─────────────────────────────────────────────────────

/** A discovered variant in planner state: the engine result plus UI status. */
export interface GhostVariant {
    /** Stable per-hole id — the signature key (unique by construction, V5). */
    id: string;
    /** Human label from the signature, e.g. "left of the bunkers · 2 shots". */
    label: string;
    variant: ScoredVariant;
}

/** Feature types that read wrong with a naive "+s". */
const NO_PLURAL = new Set(['water', 'rough', 'semi_rough', 'deep_rough', 'sand', 'oob', 'trees']);

/** "bunker" → "bunkers"; leaves mass nouns and already-plural kinds alone. */
export function pluralKind(kind: string): string {
    const label = kind.replace(/_/g, ' ');
    if (NO_PLURAL.has(kind) || label.endsWith('s')) return label;
    return `${label}s`;
}

/**
 * The player-facing name of one hazard engagement — "over the water", "left of
 * the bunkers". `hazardKindById` maps the graph's hazard ids back to the
 * course-feature type they came from; an unknown id degrades to "hazard".
 */
export function engagementPhrase(
    engagement: { hazardId: string; relation: string },
    hazardKindById: ReadonlyMap<string, string>,
): string {
    const kind = hazardKindById.get(engagement.hazardId) ?? 'hazard';
    switch (engagement.relation) {
        case 'carried': return `over the ${kind.replace(/_/g, ' ')}`;
        case 'short-of': return `short of the ${kind.replace(/_/g, ' ')}`;
        case 'passed-left': return `left of the ${pluralKind(kind)}`;
        case 'passed-right': return `right of the ${pluralKind(kind)}`;
        default: return `past the ${pluralKind(kind)}`;
    }
}

/** Phrases kept in a variant label before it stops being a label (§5). */
export const MAX_LABEL_PHRASES = 2;

/**
 * Signature → the label V7 prefills onto an accepted branch, e.g.
 * "left of the bunkers · 2 shots". At most two hazard phrases (deduped, in
 * signature order) so it stays a name, not a sentence; a variant that engages
 * nothing is simply "direct line".
 */
export function variantSignatureLabel(
    signature: VariantSignature,
    hazardKindById: ReadonlyMap<string, string>,
): string {
    const phrases: string[] = [];
    for (const engagement of signature.hazards) {
        const phrase = engagementPhrase(engagement, hazardKindById);
        if (!phrases.includes(phrase)) phrases.push(phrase);
        if (phrases.length === MAX_LABEL_PHRASES) break;
    }
    if (phrases.length === 0) phrases.push('direct line');
    const shots = `${signature.shotCount} shot${signature.shotCount === 1 ? '' : 's'}`;
    return `${phrases.join(' · ')} · ${shots}`;
}

/**
 * Duplicate labels, disambiguated by their opening leg. Signature dedupe
 * guarantees the *lines* differ, but `MAX_LABEL_PHRASES` truncates after two
 * hazard phrases, so three lines that all go right of the bunkers and right of
 * the trees in 2 shots read identically in the panel. Where that happens, the
 * tee leg (distance + club) is what a player would name them by, so append it.
 * Labels that are already unique are left exactly as the signature wrote them.
 */
export function disambiguateVariantLabels(ghosts: readonly GhostVariant[]): GhostVariant[] {
    const counts = new Map<string, number>();
    for (const ghost of ghosts) counts.set(ghost.label, (counts.get(ghost.label) ?? 0) + 1);
    return ghosts.map(ghost => {
        if ((counts.get(ghost.label) ?? 0) < 2) return ghost;
        const opener = ghost.variant.legs[0];
        if (!opener) return ghost;
        const distance = Math.round(legDistanceM(opener));
        const club = opener.club?.name ? ` ${opener.club.name}` : '';
        return { ...ghost, label: `${ghost.label} · ${distance} m${club} off the tee` };
    });
}

/** Planar leg length, meters. */
function legDistanceM(leg: ChainLeg): number {
    return Math.hypot(leg.landing.x - leg.origin.x, leg.landing.y - leg.origin.y);
}

/** Compass bearing origin→landing, degrees. */
function legBearingDeg(leg: ChainLeg): number {
    return (Math.atan2(leg.landing.x - leg.origin.x, leg.landing.y - leg.origin.y)
        * 180 / Math.PI + 360) % 360;
}

/**
 * Ghost branches as WGS84 features. Every ghost contributes its line plus one
 * label point at the first landing. The SELECTED ghost additionally gets what
 * the panel row can't show — where the ball would actually finish: a dispersion
 * ellipse per clubbed leg and a `245 m · 3w` label per leg, in the same
 * vocabulary the authored legs use.
 *
 * `hoveredId` is the transient corridor preview (pointer over a row or the
 * line); `selectedId` is the pinned one, which survives the pointer leaving.
 * `wind` must be the same wind the variant was PRICED with, so the ellipse
 * centers land where the chip's number came from.
 */
export function buildVariantGeojson(
    ghosts: readonly GhostVariant[],
    opts: {
        hoveredId?: string | null;
        selectedId?: string | null;
        wind?: { speedMps: number; directionDeg: number } | null;
    } = {},
): FeatureCollection {
    const features: Feature[] = [];
    for (const ghost of ghosts) {
        const points = ghost.variant.nodes.map(n => {
            const { lat, lon } = sweref99tmToWgs84(n.point.x, n.point.y);
            return [lon, lat];
        });
        if (points.length < 2) continue;
        const hovered = opts.hoveredId === ghost.id;
        const selected = opts.selectedId === ghost.id;
        const properties = {
            variantId: ghost.id,
            label: ghost.label,
            hovered,
            selected,
            chip: variantChipText(ghost),
        };
        features.push({
            type: 'Feature',
            properties: { ...properties, role: 'line' },
            geometry: { type: 'LineString', coordinates: points },
        });
        // Label anchor: the first landing (not the tee) so several variants
        // fanning out of one tee don't stack their labels on the same pixel.
        features.push({
            type: 'Feature',
            properties: { ...properties, role: 'label' },
            geometry: { type: 'Point', coordinates: points[1] },
        });
        if (!selected) continue;
        ghost.variant.legs.forEach((leg, legIndex) => {
            const distance = legDistanceM(leg);
            const bearingDeg = legBearingDeg(leg);
            const club = leg.club;
            if (club) {
                const ellipse = dispersionEllipse({
                    origin: leg.origin,
                    bearingDeg,
                    club,
                    groundSlope: leg.groundSlope ?? 0,
                    ...(opts.wind
                        ? { windSpeedMps: opts.wind.speedMps, windDirectionDeg: opts.wind.directionDeg }
                        : {}),
                });
                features.push({
                    type: 'Feature',
                    properties: { ...properties, role: 'ellipse', legIndex },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [ellipse.polygon.map(p => {
                            const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
                            return [lon, lat];
                        })],
                    },
                });
            }
            // Leg label at the midpoint, same shape as the plan's leg labels.
            const mid = sweref99tmToWgs84(
                (leg.origin.x + leg.landing.x) / 2, (leg.origin.y + leg.landing.y) / 2);
            features.push({
                type: 'Feature',
                properties: {
                    ...properties,
                    role: 'leg-label',
                    legIndex,
                    legText: `${Math.round(distance)} m${club?.name ? ` · ${club.name}` : ''}`,
                },
                geometry: { type: 'Point', coordinates: [mid.lon, mid.lat] },
            });
        });
    }
    return { type: 'FeatureCollection', features };
}

/**
 * Sim branch id for a ghost. Namespaced so it can never collide with a plan
 * shot id or the `primary` sentinel when both are simulated in one run.
 */
export function variantBranchId(variantId: string): string {
    return `variant:${variantId}`;
}

/** "prob. 4.2 · 12% pen" for a ghost — the SAME vocabulary as option chips (O4). */
export function variantChipText(ghost: GhostVariant): string {
    const score = ghost.variant.score;
    return `prob. ${score.expectedStrokes.toFixed(1)} · ${Math.round(score.penaltyProb * 100)}% pen`;
}

/**
 * Ghost layers: dashed + dimmed like non-primary options, in the sim tint.
 * Hovered ghosts brighten and thicken (the "hover previews the corridor"
 * affordance) — a paint expression, so hover costs no geometry rebuild.
 */
export function variantLayers(): OverlayLayerSpec[] {
    // Hover and selection get the SAME emphasis paint — the difference between
    // them is lifetime (pointer vs pinned), not appearance, so the map never
    // shows two competing "this one" states.
    // MapLibre's expression types can't describe these composed helpers, so
    // each is built untyped and cast once at the layer boundary — the same
    // treatment the scatter's variadic colour `match` gets.
    const emphasised = ['any', ['get', 'hovered'], ['get', 'selected']] as unknown as boolean;
    const role = (name: string): boolean =>
        ['==', ['get', 'role'], name] as unknown as boolean;
    return [
        {
            // Casing under the selected line only: five near-parallel dashed
            // teal lines over a busy ortho are impossible to follow otherwise.
            id: `${VARIANT_OVERLAY_ID}-line-casing`,
            type: 'line',
            filter: ['all', role('line'), ['get', 'selected']],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': OVERLAY_TEXT_HALO,
                'line-width': 9,
                'line-opacity': 0.55,
            },
        } as OverlayLayerSpec,
        {
            id: `${VARIANT_OVERLAY_ID}-ellipse-fill`,
            type: 'fill',
            filter: role('ellipse'),
            paint: { 'fill-color': VARIANT_COLOR, 'fill-opacity': 0.18 },
        } as OverlayLayerSpec,
        {
            id: `${VARIANT_OVERLAY_ID}-ellipse-outline`,
            type: 'line',
            filter: role('ellipse'),
            paint: { 'line-color': VARIANT_COLOR, 'line-width': 1.2, 'line-opacity': 0.8 },
        } as OverlayLayerSpec,
        {
            id: `${VARIANT_OVERLAY_ID}-line`,
            type: 'line',
            filter: role('line'),
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': VARIANT_COLOR,
                // Idle ghosts stay visibly readable over the ortho (0.45 was
                // near-invisible on grass); the emphasised one still separates
                // by width + casing rather than by the idle ones vanishing.
                'line-width': ['case', emphasised, 5, 3],
                'line-opacity': ['case', emphasised, 0.95, 0.7],
                'line-dasharray': [2, 2],
            },
        } as OverlayLayerSpec,
        {
            id: `${VARIANT_OVERLAY_ID}-node`,
            type: 'circle',
            filter: role('label'),
            paint: {
                'circle-radius': ['case', emphasised, 5, 3.5],
                'circle-color': VARIANT_COLOR,
                'circle-opacity': ['case', emphasised, 0.95, 0.7],
            },
        } as OverlayLayerSpec,
        {
            // Only the emphasised ghost names itself. Five signature labels at
            // once (each two lines long) buried the hole under its own legend.
            id: `${VARIANT_OVERLAY_ID}-label`,
            type: 'symbol',
            filter: ['all', role('label'), emphasised],
            layout: {
                'text-field': ['concat', ['get', 'label'], '\n', ['get', 'chip']],
                'text-size': 11,
                'text-offset': [0, -1.4],
                'text-anchor': 'bottom',
                'text-allow-overlap': false,
            },
            paint: {
                'text-color': OVERLAY_TEXT,
                'text-halo-color': OVERLAY_TEXT_HALO,
                'text-halo-width': 1.2,
            },
        } as OverlayLayerSpec,
        {
            // Per-leg distance + club for the selected ghost — the "where would
            // this shot actually end up" answer the panel row can't give.
            id: `${VARIANT_OVERLAY_ID}-leg-label`,
            type: 'symbol',
            filter: role('leg-label'),
            layout: {
                'text-field': ['get', 'legText'],
                'text-size': 11,
                'symbol-placement': 'point',
                'text-anchor': 'center',
                'text-allow-overlap': false,
            },
            paint: {
                'text-color': OVERLAY_TEXT,
                'text-halo-color': OVERLAY_TEXT_HALO,
                'text-halo-width': 1.2,
            },
        } as OverlayLayerSpec,
    ];
}
