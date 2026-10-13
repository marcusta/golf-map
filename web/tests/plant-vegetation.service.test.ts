import { describe, expect, test } from 'bun:test';
import { effect } from '@basics/core/client/core';
import { PlantVegetationService, arboristOutcome } from '../src/zones/plant-vegetation.service';
import type { GsproExportApi, GsproExportJob } from '../../shared/api/gspro-export.gen';

// The Vegetation mode's Plant for GSPro job: started once, followed to the
// end; a planting already running is followed instead of refused.

function job(status: GsproExportJob['status'], extra: Partial<GsproExportJob> = {}): GsproExportJob {
    return {
        id: 'job-1', courseId: 'c1', kind: 'vegetation', label: 'inner vegetation, planted for GSPro',
        status, startedAt: '2026-09-27T10:00:00Z', finishedAt: status === 'running' ? null : '2026-09-27T10:01:00Z',
        result: status === 'succeeded' ? { path: 'x-inner-zones.json', report: ['creek banks: replaced 0 zones with 12'] } : null,
        error: null, ...extra,
    };
}

/** start/current/job over a scripted sequence of polls; `started` records the start inputs. */
function client(opts: { polls: GsproExportJob[]; refuse?: GsproExportJob }) {
    const started: unknown[] = [];
    const polls = [...opts.polls];
    const api = {
        async start(input: unknown) {
            started.push(input);
            if (opts.refuse) throw new Error(`An export is already running for this course: ${opts.refuse.label}`);
            return job('running');
        },
        async current() { return opts.refuse ?? null; },
        async job() { return polls.shift()!; },
    } as unknown as GsproExportApi;
    return { api, started };
}

describe('PlantVegetationService', () => {
    test('starts the inner planting and follows it to its outcome', async () => {
        const { api, started } = client({ polls: [job('running'), job('succeeded')] });
        const svc = new PlantVegetationService(api, 1);
        const outcome = await svc.plant('c1');

        expect(started).toEqual([{ courseId: 'c1', kind: 'vegetation', terrain: 'inner' }]);
        expect(outcome.status).toBe('succeeded');
        expect(outcome.result!.report).toEqual(['creek banks: replaced 0 zones with 12']);
        expect(svc.running.get()).toBe(false);
    });

    test('update sends the selected zones as a vegetation-update and follows it; runningKind tells the two jobs apart', async () => {
        const updating = job('running', { kind: 'vegetation-update', label: '2 vegetation zone(s) updated for GSPro' });
        const { api, started } = client({ polls: [updating, job('succeeded', { kind: 'vegetation-update' })] });
        const svc = new PlantVegetationService(api, 1);
        const seen: (string | null)[] = [];
        const stop = effect(() => { seen.push(svc.runningKind.get()); });
        const outcome = await svc.update('c1', ['z1', 'z2']);
        stop();
        expect(seen).toContain('vegetation-update');

        expect(started).toEqual([{ courseId: 'c1', kind: 'vegetation-update', zoneIds: ['z1', 'z2'] }]);
        expect(outcome.status).toBe('succeeded');
        expect(svc.runningKind.get()).toBeNull();
    });

    test('an update does not follow a planting that is running; it reports it as the blocker', async () => {
        const planting = client({ polls: [], refuse: job('running') });
        await expect(new PlantVegetationService(planting.api, 1).update('c1', ['z1']))
            .rejects.toThrow(/already running for this course: inner vegetation, planted for GSPro/);
    });

    test('a planting already running is followed; another export running is the error', async () => {
        const planting = client({ polls: [job('succeeded')], refuse: job('running') });
        expect((await new PlantVegetationService(planting.api, 1).plant('c1')).status).toBe('succeeded');

        const other = client({ polls: [], refuse: job('running', { kind: 'ortho', label: 'inner orthophoto' }) });
        await expect(new PlantVegetationService(other.api, 1).plant('c1')).rejects.toThrow(/already running for this course: inner orthophoto/);
    });

    test('the result dialog says in one sentence what went into the Arborist file', () => {
        const lower = 'Arborist lower vegetation written: 38 items, 13 mask textures (C:/GSPro/Courses/X/arboristdata.dat)';
        expect(arboristOutcome([lower, 'Arborist trees written: 66281 trees of 54 species, from 144475 planted in Unity (x_v4)']))
            .toBe('Arborist file: lower vegetation and trees written.');
        expect(arboristOutcome([lower, "Arborist trees: skipped, Unity is not open (the trees' positions and ground heights come from its scene); the file keeps the trees as last generated"]))
            .toBe('Arborist file: lower vegetation written; the trees need Unity open and are as they were.');
        expect(arboristOutcome([lower])).toBe('Arborist file: lower vegetation written.');
        expect(arboristOutcome(['Arborist: not used by this course (no docs/gspro/x/arborist-species.json)'])).toBe('Arborist: not used by this course.');
    });
});
