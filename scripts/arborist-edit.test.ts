/**
 * `bun run arborist -- edit` names one tree and one change; what it does with them is
 * ArboristEditService's (server/services/arborist-edit.service.test.ts). This pins the command line.
 */
import { describe, expect, test } from 'bun:test';
import { parseEditArgs } from './arborist-edit';

const parse = (line: string) => parseEditArgs(line.split(' ').filter(Boolean));

describe('the edit command line', () => {
    test('each op with its tree', () => {
        expect(parse('omberg move --by 2,-1 --id epsg3006:1.50:2.50')).toEqual({
            course: 'omberg', target: { id: 'epsg3006:1.50:2.50' }, change: { op: 'move', by: [2, -1] }, dryRun: false, json: false,
        });
        expect(parse('omberg move --to 270.5,472.5 --near 268,472 --dry-run')).toMatchObject({ target: { near: [268, 472] }, change: { op: 'move', to: [270.5, 472.5] }, dryRun: true });
        expect(parse('omberg resize 1.2 --picked')).toMatchObject({ target: { pick: 'marked' }, change: { op: 'resize', factor: 1.2 } });
        expect(parse('omberg resize 80% --pick')).toMatchObject({ target: { pick: 'mouse' }, change: { op: 'resize', factor: 0.8 } });
        expect(parse('omberg resize --height 3 --width 2.5 --pick 0.5,0.5')).toMatchObject({ target: { pick: { u: 0.5, v: 0.5 } }, change: { op: 'resize', heightM: 3, crownWidthM: 2.5 } });
        expect(parse('omberg rotate -30 --picked')).toMatchObject({ change: { op: 'rotate', by: -30 } });
        expect(parse('omberg rotate --yaw 90 --picked --json')).toMatchObject({ change: { op: 'rotate', yaw: 90 }, json: true });
        expect(parse('omberg delete --picked')).toMatchObject({ change: { op: 'delete' } });
        expect(parse('omberg swap S7_American_Elm --picked')).toMatchObject({ change: { op: 'swap', model: 'arborist:S7_American_Elm' } });
        expect(parse('omberg add arborist:CE_Plants_buckthorn-bush --at 100,200 --height 2.4')).toMatchObject({
            target: null, change: { op: 'add', model: 'arborist:CE_Plants_buckthorn-bush', at: [100, 200], heightM: 2.4 },
        });
        expect(parse('omberg add LakePlants_Water_Lily_03 --at 731.5,1081 --width 5.2 --y 20.388')).toMatchObject({
            target: null, change: { op: 'add', model: 'arborist:LakePlants_Water_Lily_03', at: [731.5, 1081], crownWidthM: 5.2, yM: 20.388 },
        });
        expect(parse('omberg move --to 1,2 --y 20.4 --near 1,1')).toMatchObject({ change: { op: 'move', to: [1, 2], yM: 20.4 } });
    });

    test('what is wrong is said', () => {
        expect(parse('omberg')).toEqual({ error: expect.stringContaining('name an op') });
        expect(parse('omberg move --by 2,0')).toEqual({ error: expect.stringContaining('move needs the tree') });
        expect(parse('omberg move --picked')).toEqual({ error: 'move needs --to <x,z> or --by <dx,dz>' });
        expect(parse('omberg move --by 2 --picked')).toEqual({ error: expect.stringContaining('--by needs <a,b>') });
        expect(parse('omberg delete --picked --id x')).toEqual({ error: expect.stringContaining('one way') });
        expect(parse('omberg add bush --at 1,2 --picked')).toEqual({ error: expect.stringContaining('add makes a new tree') });
        expect(parse('omberg add bush --at 1,2 --y high')).toEqual({ error: '--y needs a number' });
        expect(parse('omberg resize 0 --picked')).toEqual({ error: expect.stringContaining('above 0') });
        expect(parse('omberg rotate --picked')).toEqual({ error: expect.stringContaining('rotate needs') });
        expect(parse('omberg delete --picked --fast')).toEqual({ error: 'unknown option --fast' });
    });
});
