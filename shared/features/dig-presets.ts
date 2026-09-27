// Dig profiles for the terrain generators' pond, bunker and creek digs, and
// the course-feature attributes that pick or override them. Shared so the
// server's generators and the web terrain editor's per-feature settings read
// the same tables.

/**
 * Pond profiles for `water-digs`, a feature's `digPreset`. Bank slope and
 * depth are Shoreline Studio's lake presets; shelf and perimeter variation
 * are ours (its shelf/edge shape recipe does not map onto a DEM profile).
 */
export const WATER_DIG_PRESETS = {
    parkland_shelf: { label: 'Parkland Shelf', bankSlopeDeg: 10, depthM: 1.2, shelfM: 2.0, shelfDepthM: 0.25, variation: 0.1 },
    natural_pond: { label: 'Natural Pond', bankSlopeDeg: 11, depthM: 1.0, shelfM: 1.5, shelfDepthM: 0.2, variation: 0.5 },
    cove_point: { label: 'Cove & Point', bankSlopeDeg: 14, depthM: 1.4, shelfM: 1.0, shelfDepthM: 0.2, variation: 0.45 },
    deep_water: { label: 'Deep Water', bankSlopeDeg: 34, depthM: 2.0, shelfM: 0.5, shelfDepthM: 0.15, variation: 0.06 },
} as const;
export type WaterDigPreset = keyof typeof WATER_DIG_PRESETS;
export const DEFAULT_WATER_DIG_PRESET: WaterDigPreset = 'natural_pond';

/**
 * Creek bed profiles for `creek-digs`, a creek feature's `digPreset`: bank
 * slope and depth below the water surface from Shoreline Studio's creek
 * presets (its channel shape recipe — meander, pools — is not ours).
 */
export const CREEK_DIG_PRESETS = {
    maintained_drain: { label: 'Maintained Drain', bankSlopeDeg: 18, depthM: 0.35 },
    meadow_brook: { label: 'Meadow Brook', bankSlopeDeg: 10, depthM: 0.28 },
    estate_stream: { label: 'Estate Stream', bankSlopeDeg: 22, depthM: 0.42 },
    pool_riffle: { label: 'Pool & Riffle', bankSlopeDeg: 25, depthM: 0.55 },
    rocky_runnel: { label: 'Rocky Runnel', bankSlopeDeg: 31, depthM: 0.32 },
    eroded_gully: { label: 'Eroded Gully', bankSlopeDeg: 38, depthM: 0.70 },
} as const;
export type CreekDigPreset = keyof typeof CREEK_DIG_PRESETS;
export const DEFAULT_CREEK_DIG_PRESET: CreekDigPreset = 'maintained_drain';

/**
 * Bunker profile for `bunker-digs`: the floor this far below a plane fitted to
 * the ground around it, a steep face towards the hole's green and a gentle
 * entry opposite. A feature's `digDepthM` / `digBankSlopeDeg` /
 * `digFaceSlopeDeg` override these.
 */
export const BUNKER_DIG = { depthM: 0.45, bankSlopeDeg: 18, faceSlopeDeg: 40, rimM: 2.5, variation: 0.25 } as const;

/** The generators that dig one edit per course feature (`originRef: feature:<id>`). */
export type DigGeneratorKind = 'water-digs' | 'bunker-digs' | 'creek-digs';
export const DIG_GENERATOR_KINDS: readonly DigGeneratorKind[] = ['water-digs', 'bunker-digs', 'creek-digs'];

/**
 * The feature attributes a dig generator reads: `dig: false` skips the
 * feature, `digPreset` picks a profile (ponds and creeks), the numbers
 * override it (`digFaceSlopeDeg`: bunkers only).
 */
export const DIG_ATTRIBUTES = ['dig', 'digPreset', 'digDepthM', 'digBankSlopeDeg', 'digFaceSlopeDeg'] as const;
