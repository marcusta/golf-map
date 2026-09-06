import { adjustStand, renderCrownRadius, SPECIES, VARIANTS, type Species } from '../map/tree-geometry';
import { describeStem, type RenderStem } from '../map/tree-renderer';

/**
 * Stem layout of the vegetation test scene (src/vegetation). Pure: no three.js
 * objects, so the layout is unit-testable. Scene metres, x east, y north, ground 0.
 *
 * Groups (y rows, north of the origin):
 *   lineup    y = 0     every species x variant at LINEUP_HEIGHT_M plus one shrub, LINEUP_SPACING_M apart
 *   ladder    y = 40    one broadleaf and one spruce at LADDER_HEIGHTS_M
 *   stand     y = 90..170  STAND_COUNT mixed stems, random positions, heights STAND_HEIGHTS_M, adjustStand applied
 *   shrubs    y = -25   SHRUB_COUNT shrubs scattered along a strip
 * To add an asset type to the lineup: append an entry to `lineupEntries` (a
 * species/variant pair, or a height under SHRUB_MAX_HEIGHT_M for a shrub).
 */
export const GROUND_SIZE_M = 400;
export const LINEUP_HEIGHT_M = 15;
export const LINEUP_SPACING_M = 12;
export const LADDER_Y_M = 40;
export const LADDER_HEIGHTS_M: readonly number[] = [2, 5, 10, 20, 30];
export const STAND_COUNT = 200;
export const STAND_HEIGHTS_M: readonly [number, number] = [8, 25];
export const STAND_ORIGIN_M: readonly [number, number] = [-40, 90];
export const STAND_SIZE_M = 80;
export const SHRUB_COUNT = 30;
export const SHRUB_Y_M = -25;

export interface LineupEntry { label: string; species: Species; variant: number; heightM: number; crownRadiusM: number }

export function lineupEntries(): LineupEntry[] {
    const entries: LineupEntry[] = [];
    for (const species of SPECIES) for (let variant = 0; variant < VARIANTS; variant++) {
        entries.push({ label: `${species} ${variant}`, species, variant, heightM: LINEUP_HEIGHT_M, crownRadiusM: 3 });
    }
    entries.push({ label: 'shrub', species: 'broadleaf', variant: 0, heightM: 2.5, crownRadiusM: 2 });
    return entries;
}

export interface SceneStem extends RenderStem { group: 'lineup' | 'ladder' | 'stand' | 'shrubs'; label: string }

/** Deterministic [0,1) sequence; the scene looks the same on every load. */
function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A stem with the look derived from its position, then species/variant/shrub pinned where the group needs it. */
function placed(group: SceneStem['group'], label: string, x: number, y: number, heightM: number, crownRadiusM: number,
    kind: number, pin: { species?: Species; variant?: number; shrub?: boolean } = {}): SceneStem {
    // Hash coordinates offset into the EPSG:3006 range the hashes were tuned on.
    const stem = describeStem({ x, y, ground: 0, heightM, crownRadiusM, kind, hashX: 500000 + x, hashY: 6480000 + y });
    if (pin.variant !== undefined) stem.variant = pin.variant;
    if (pin.shrub !== undefined) stem.shrub = pin.shrub;
    if (pin.species !== undefined) stem.species = SPECIES.indexOf(pin.species);
    // The hashed look may have picked another species; the render radius follows the pinned one.
    if (!stem.shrub) stem.radius = renderCrownRadius(SPECIES[stem.species], heightM, crownRadiusM);
    return { ...stem, group, label };
}

export function lineupX(index: number, count = lineupEntries().length): number {
    return (index - (count - 1) / 2) * LINEUP_SPACING_M;
}

export function sceneStems(): SceneStem[] {
    const stems: SceneStem[] = [];
    const entries = lineupEntries();
    entries.forEach((entry, i) => {
        const shrub = entry.heightM < 4;
        stems.push(placed('lineup', entry.label, lineupX(i, entries.length), 0, entry.heightM, entry.crownRadiusM, entry.species === 'broadleaf' ? 0 : 1,
            { species: entry.species, variant: entry.variant, shrub }));
    });
    (['broadleaf', 'spruce'] as const).forEach((species, row) => {
        LADDER_HEIGHTS_M.forEach((heightM, i) => {
            const x = -50 + i * 20 + row * 100 - 40;
            stems.push(placed('ladder', `${species} ${heightM} m`, x, LADDER_Y_M, heightM, heightM * 0.2, species === 'broadleaf' ? 0 : 1,
                { species, variant: 1, shrub: false }));
        });
    });
    const random = seeded(7);
    for (let i = 0; i < STAND_COUNT; i++) {
        const x = STAND_ORIGIN_M[0] + random() * STAND_SIZE_M, y = STAND_ORIGIN_M[1] + random() * STAND_SIZE_M;
        const heightM = STAND_HEIGHTS_M[0] + random() * (STAND_HEIGHTS_M[1] - STAND_HEIGHTS_M[0]);
        stems.push(placed('stand', 'stand', x, y, heightM, 2 + random() * 2, random() < 0.5 ? 0 : 1));
    }
    for (let i = 0; i < SHRUB_COUNT; i++) {
        const x = -90 + random() * 180, y = SHRUB_Y_M + (random() - 0.5) * 12;
        stems.push(placed('shrubs', 'shrub', x, y, 1 + random() * 2.5, 0.8 + random() * 1.8, 0));
    }
    // The same load-time neighbour adjustment the map layer runs over the whole asset.
    adjustStand(stems);
    return stems;
}
