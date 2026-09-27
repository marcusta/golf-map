import { describe, expect, test } from 'bun:test';
import { formatZonePalettes, parseZonePalettes, zoneBlendOf, zoneExtraPalettesOf } from './zone-layers';

describe('zone layers', () => {
    test('extra palettes read type, optional variant and optional weight, and format back', () => {
        const parsed = parseZonePalettes(' shrub/rocks=0.4, fern ,,rough_tall/dry=1, meadow=0 ');
        expect(parsed).toEqual({
            palettes: [
                { zoneType: 'shrub', zoneVariant: 'rocks', weight: 0.4 },
                { zoneType: 'fern', zoneVariant: '', weight: 1 },
                { zoneType: 'rough_tall', zoneVariant: 'dry', weight: 1 },
                { zoneType: 'meadow', zoneVariant: '', weight: 0 },
            ],
        });
        expect(formatZonePalettes('palettes' in parsed ? parsed.palettes : [])).toBe('shrub/rocks=0.4, fern, rough_tall/dry, meadow=0');
        expect(parseZonePalettes('')).toEqual({ palettes: [] });
    });

    test('malformed entries name themselves', () => {
        for (const raw of ['Shrub', 'shrub/', 'shrub=1.5', 'shrub=x', 'a/b/c', 'shrub rocks']) {
            expect(parseZonePalettes(raw)).toHaveProperty('error');
        }
        expect(parseZonePalettes('fern, shrub=2')).toEqual({ error: '"shrub=2" is not <zoneType>[/<variant>][=<weight 0..1>]' });
    });

    test('attribute readers default to replace and no palettes', () => {
        expect(zoneBlendOf({ blend: 'mix' })).toBe('mix');
        expect(zoneBlendOf({ blend: 'other' })).toBe('replace');
        expect(zoneBlendOf(null)).toBe('replace');
        expect(zoneExtraPalettesOf({ extraPalettes: 'fern' })).toEqual([{ zoneType: 'fern', zoneVariant: '', weight: 1 }]);
        expect(zoneExtraPalettesOf({ extraPalettes: 'Fern!' })).toEqual([]);
        expect(zoneExtraPalettesOf({})).toEqual([]);
    });
});
