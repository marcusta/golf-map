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
import type { ScoredVariant, VariantSignature, Vec2 } from '../../../shared/strategy';
import { sweref99tmToWgs84 } from '../geo/transform';
import type { OverlayLayerSpec } from '../map/map.service';
import { CAT, LIE_FILL, LIE_FILL_DEFAULT, OVERLAY_TEXT, OVERLAY_TEXT_HALO } from '../map/map-palette';

/** Overlay id for the sampled-landing dot cloud. */
export const SIM_SCATTER_OVERLAY_ID = 'plan-sim-scatter';
/** Overlay id for the suggest-lines ghost branches. */
export const VARIANT_OVERLAY_ID = 'plan-variants';

/**
 * The layer the scatter slots UNDER so vector feature fills stay legible
 * across the cloud — the same anchor the Clean tool's preview raster uses.
 * Silently ignored (overlay goes topmost) when that layer is absent.
 */
export const SCATTER_BEFORE_LAYER_ID = 'features-fill';

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

/** Dot cloud: small, translucent, coloured by lie class. */
export function scatterLayers(): OverlayLayerSpec[] {
    // Built at runtime from LIE_FILL so the palette stays the single source of
    // truth; MapLibre's expression types can't describe a variadic `match`, so
    // the array is assembled untyped and cast once at the layer boundary.
    const match: unknown[] = ['match', ['get', 'lie']];
    for (const [lie, color] of Object.entries(LIE_FILL)) match.push(lie, color);
    match.push(LIE_FILL_DEFAULT);
    const lieColor = match as unknown as string;
    return [
        {
            id: `${SIM_SCATTER_OVERLAY_ID}-dot`,
            type: 'circle',
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 1.6, 18, 3.4],
                'circle-color': lieColor,
                'circle-opacity': 0.55,
                'circle-stroke-width': 0.4,
                'circle-stroke-color': OVERLAY_TEXT_HALO,
                'circle-stroke-opacity': 0.35,
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
 * Ghost branches as WGS84 line features plus one label point at the first
 * landing. `hoveredId` marks the corridor-preview branch (the layer specs
 * widen and un-dim it); `selectedId` is unused today but kept in the
 * properties so a future selected state needs no geometry change.
 */
export function buildVariantGeojson(
    ghosts: readonly GhostVariant[],
    opts: { hoveredId?: string | null } = {},
): FeatureCollection {
    const features: Feature[] = [];
    for (const ghost of ghosts) {
        const points = ghost.variant.nodes.map(n => {
            const { lat, lon } = sweref99tmToWgs84(n.point.x, n.point.y);
            return [lon, lat];
        });
        if (points.length < 2) continue;
        const hovered = opts.hoveredId === ghost.id;
        const properties = {
            variantId: ghost.id,
            label: ghost.label,
            hovered,
            chip: variantChipText(ghost),
        };
        features.push({
            type: 'Feature',
            properties,
            geometry: { type: 'LineString', coordinates: points },
        });
        // Label anchor: the first landing (not the tee) so several variants
        // fanning out of one tee don't stack their labels on the same pixel.
        features.push({
            type: 'Feature',
            properties: { ...properties, kind: 'label' },
            geometry: { type: 'Point', coordinates: points[1] },
        });
    }
    return { type: 'FeatureCollection', features };
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
    return [
        {
            id: `${VARIANT_OVERLAY_ID}-line`,
            type: 'line',
            filter: ['==', ['geometry-type'], 'LineString'],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color': VARIANT_COLOR,
                'line-width': ['case', ['get', 'hovered'], 5, 2.5],
                'line-opacity': ['case', ['get', 'hovered'], 0.9, 0.45],
                'line-dasharray': [2, 2],
            },
        } as OverlayLayerSpec,
        {
            id: `${VARIANT_OVERLAY_ID}-node`,
            type: 'circle',
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
                'circle-radius': ['case', ['get', 'hovered'], 5, 3.5],
                'circle-color': VARIANT_COLOR,
                'circle-opacity': ['case', ['get', 'hovered'], 0.9, 0.5],
            },
        } as OverlayLayerSpec,
        {
            id: `${VARIANT_OVERLAY_ID}-label`,
            type: 'symbol',
            filter: ['==', ['geometry-type'], 'Point'],
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
                'text-opacity': ['case', ['get', 'hovered'], 1, 0.7],
            },
        } as OverlayLayerSpec,
    ];
}
