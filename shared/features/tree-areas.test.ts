import { describe, expect, test } from 'bun:test';
import { formatSpeciesMix, parseSpeciesMix, speciesMixLabel, speciesMixOf, treeAreaProblem } from './tree-areas';

describe('tree species areas', () => {
    test('a mix reads species with optional relative weights and formats back', () => {
        const parsed = parseSpeciesMix(' Oak=9, birch=1 ,,elm, pine=0 ');
        expect(parsed).toEqual({
            mix: [
                { species: 'oak', weight: 9 },
                { species: 'birch', weight: 1 },
                { species: 'elm', weight: 1 },
                { species: 'pine', weight: 0 },
            ],
        });
        expect(formatSpeciesMix('mix' in parsed ? parsed.mix : [])).toBe('oak=9, birch, elm, pine=0');
        expect(parseSpeciesMix('')).toEqual({ mix: [] });
    });

    test('malformed entries and doubles name themselves', () => {
        for (const raw of ['9oak', 'oak=', 'oak=x', 'oak=-1', 'red oak', 'oak/x']) expect(parseSpeciesMix(raw)).toHaveProperty('error');
        expect(parseSpeciesMix('oak, birch, oak=2')).toEqual({ error: '"oak" is named twice' });
    });

    test('the label shows each species share of the total, leaving out weight 0', () => {
        expect(speciesMixLabel([{ species: 'oak', weight: 9 }, { species: 'birch', weight: 1 }, { species: 'pine', weight: 0 }])).toBe('oak 90% · birch 10%');
        expect(speciesMixLabel([])).toBe('no species');
    });

    test('an area needs a mix with some weight; ignoreKind and name are optional', () => {
        expect(treeAreaProblem({ species: 'oak=9, birch=1' })).toBeNull();
        expect(treeAreaProblem({ species: 'oak', ignoreKind: true, name: 'Oak grove' })).toBeNull();
        expect(treeAreaProblem({})).toContain('needs attributes.species');
        expect(treeAreaProblem({ species: 'oak=0' })).toContain('above 0');
        expect(treeAreaProblem({ species: 'oak=x' })).toContain('<species>[=<weight>]');
        expect(treeAreaProblem({ species: 'oak', ignoreKind: 'yes' })).toContain('boolean');
        expect(treeAreaProblem({ species: 'oak', name: 3 })).toContain('string');
        expect(speciesMixOf({ species: 'oak=2' })).toEqual([{ species: 'oak', weight: 2 }]);
        expect(speciesMixOf({ species: 'bad entry' })).toEqual([]);
    });
});
