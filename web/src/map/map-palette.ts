// Links & Loam palette literals for MapLibre PAINT properties.
//
// MapLibre paint can't read CSS custom properties, so over-map layers
// (plan, furniture, area picker, draw previews) take LITERAL hexes.
// Every value is copied from a named token — design-tokens.css for the
// cartography/data-viz layers, theme.ts for the overlay/semantic layer —
// change them together, by token name. Same one-place-to-sync pattern as
// draw/feature-palette.ts (which is frozen by an iOS golden test and must
// NOT absorb these).
//
// DOM-based map chrome (MapLibre Markers with HTML elements, IControls)
// should keep using CSS vars / the css.ts `mapLabel()` recipe instead.

import type { Lie } from '../../../shared/strategy';

/** Shot/aim/leg lines (guide §03): 3px, round ("pill") line ends. */
export const SHOT_LINE_COLOR = '#E4A15A'; // --map-shot-line
export const SHOT_LINE_WIDTH = 3;

/** Selection / primary accent (clay). */
export const ACCENT_COLOR = '#BF6A3E'; // --data-cat-1 == --color-accent-primary (light)

/**
 * Over-map marker treatment (guide §03): pine circle, 2px bone ring,
 * bone glyph. Green/tee markers may take the feature colour with a dark
 * glyph instead (MAP_GREEN_FILL below + MARKER_FILL as the glyph).
 */
export const MARKER_FILL = '#1E2B22'; // --color-surface-brand (pine)
export const MARKER_RING = '#FFFFFF'; // --overlay-text (bone ring)
export const MARKER_RING_WIDTH = 2; // guide §03

/**
 * Over-map SYMBOL-LAYER text (canvas, no DOM): always overlay-text with a
 * dark halo as the scrim-equivalent — symbol layers can't draw the
 * `mapLabel()` pill, the halo is the closest paint-level protection.
 */
export const OVERLAY_TEXT = '#FFFFFF'; // --overlay-text
export const OVERLAY_TEXT_HALO = '#1E2B22'; // --color-surface-brand (scrim stand-in)

/** Status / traffic-light ramp. */
export const STATUS_GOOD = '#4E7A46'; // --data-good
export const STATUS_RISK = '#C68A2E'; // --data-risk
export const STATUS_BAD = '#B24A32'; // --data-bad
export const STATUS_NEUTRAL = '#9C917A'; // --data-neutral

/** Categorical ramp for map annotations (gates, ghosts, handles, …). */
export const CAT = {
    clay: '#BF6A3E', // --data-cat-1
    teal: '#3E8EA0', // --data-cat-2
    wheat: '#D8A441', // --data-cat-3
    moss: '#5C6B4A', // --data-cat-4
    slate: '#5E6D94', // --data-cat-5
    plum: '#8A5A6E', // --data-cat-6
    sky: '#6FA8C9', // --data-cat-7
    loam: '#7A6A50', // --data-cat-8
} as const;

/** Feature fills markers may take (guide §03 "green/tee markers"). */
export const MAP_GREEN_FILL = '#7FC489'; // --map-green-fill
export const MAP_TEE_FILL = '#5FA76E'; // --map-tee-fill

/**
 * Strategy LIE classes (shared/strategy `Lie`) → the cartography token for the
 * feature type that lie comes from, so a sampled-landing dot reads as "this
 * landed in that thing on the map". Theme-invariant by construction: every
 * value is one of the `--map-*-fill` tokens above, which are the same in light
 * and dark (design-tokens.css §map). No new token needed — this is a mapping,
 * not a palette.
 */
export const LIE_FILL: Record<Lie, string> = {
    tee: MAP_TEE_FILL, // --map-tee-fill
    fairway: '#4C9256', // --map-fairway-fill
    rough: '#566E3A', // --map-rough-fill
    sand: '#E1CC93', // --map-bunker-fill
    recovery: '#24402B', // --map-trees-fill
    green: MAP_GREEN_FILL, // --map-green-fill
    penalty: '#4C8FBE', // --map-water-fill
};

/** Fallback dot colour for an unclassified lie. */
export const LIE_FILL_DEFAULT = STATUS_NEUTRAL;
