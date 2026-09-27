// How vegetation zones add up (docs/feature-vegetation-zones.md D-VZ12,
// D-VZ14): a zone's `blend` says what it does to the generated zones under it, and its
// `extraPalettes` are more palettes (a zone type's Default mix or one of its
// variants) it plants on its own footprint next to its `zoneType` /
// `zoneVariant`. Shared by the server (validation), the web selection panel
// and the zones CLI; pipeline/gspro.py mirrors the names and the format.

/**
 * What a zone does to the zones it overlaps (D-VZ14). Drawn zones always add
 * up with each other; this is about the generated zones (tall rough, creek
 * banks, lidar) under a drawn one: `replace` (absent) takes its weight of
 * that ground, `mix` grows on top of it. Among generated zones `replace` is
 * the stack rule: the later one takes its share from those below.
 */
export const ZONE_BLENDS = ['replace', 'mix'] as const;
export type ZoneBlend = (typeof ZONE_BLENDS)[number];
export const ZONE_BLEND_ATTRIBUTE = 'blend';

export function zoneBlendOf(attributes: object | null | undefined): ZoneBlend {
    return (attributes as Record<string, unknown> | null | undefined)?.[ZONE_BLEND_ATTRIBUTE] === 'mix' ? 'mix' : 'replace';
}

/**
 * Feature attributes are flat scalars, so the extra palettes are one string:
 * comma-separated `<zoneType>[/<variant>][=<weight>]`, e.g.
 * `"shrub/rocks=0.4, fern"`. The weight (0..1, default 1) scales the zone's
 * own weight for that palette. Absent or '' = none.
 */
export const ZONE_EXTRA_PALETTES_ATTRIBUTE = 'extraPalettes';

export interface ZonePalette {
    zoneType: string;
    /** '' = the type's Default mix. */
    zoneVariant: string;
    /** 0..1, times the zone's weight. */
    weight: number;
}

const KEY = '[a-z0-9_]+';
const ENTRY = new RegExp(`^(${KEY})(?:/(${KEY}))?(?:=([0-9]*\\.?[0-9]+))?$`);

/** The palettes a string names, or an error message for the first entry that is not `<type>[/<variant>][=<weight 0..1>]`. */
export function parseZonePalettes(raw: string): { palettes: ZonePalette[] } | { error: string } {
    const palettes: ZonePalette[] = [];
    for (const part of raw.split(',')) {
        const entry = part.trim();
        if (!entry) continue;
        const m = ENTRY.exec(entry);
        const weight = m?.[3] === undefined ? 1 : Number(m[3]);
        if (!m || !(weight >= 0 && weight <= 1)) {
            return { error: `"${entry}" is not <zoneType>[/<variant>][=<weight 0..1>]` };
        }
        palettes.push({ zoneType: m[1]!, zoneVariant: m[2] ?? '', weight });
    }
    return { palettes };
}

/** A zone's extra palettes from its attributes ([] when absent or malformed). */
export function zoneExtraPalettesOf(attributes: object | null | undefined): ZonePalette[] {
    const raw = (attributes as Record<string, unknown> | null | undefined)?.[ZONE_EXTRA_PALETTES_ATTRIBUTE];
    if (typeof raw !== 'string') return [];
    const parsed = parseZonePalettes(raw);
    return 'palettes' in parsed ? parsed.palettes : [];
}

/** The attribute string for a list of palettes (weight 1 is left out). */
export function formatZonePalettes(palettes: readonly ZonePalette[]): string {
    return palettes
        .map(p => `${p.zoneType}${p.zoneVariant ? `/${p.zoneVariant}` : ''}${p.weight === 1 ? '' : `=${roundWeight(p.weight)}`}`)
        .join(', ');
}

function roundWeight(weight: number): number {
    return Math.round(weight * 1000) / 1000;
}
