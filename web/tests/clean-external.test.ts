import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import { CleanToolService, type UnityOrthoApi } from '../src/clean/clean-tool.service';
import type { GsproExportJob, GsproOrthoSource } from '../../shared/api/gspro-export.gen';
import { CleanPanelComponent } from '../src/clean/clean-panel.component';
import {
    OrthoImportClient,
    countTiles,
    summarizeImport,
    type UploadLike,
    type UploadRequest,
} from '../src/clean/clean-external';
import { API_BASE } from '../src/api';
import { ORTHO_IMPORT_MAX_BYTES, type OrthoImportResult } from '../../shared/ortho-import';
import type {
    OrthoExportResult,
    OrthoExportSummary,
    OrthoPatchesApi,
    OrthoPatchesInfo,
    SimFrame,
} from '../../shared/api/ortho-patches.gen';

// Clean tool, "External edit" section: export the cleaned photo, import the
// edited one. Server calls sit behind the generated-client fake and the upload
// seam, so no network is involved; the panel is rendered through happy-dom.

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const FRAME: SimFrame = { extent3006: [500_000, 6_400_000, 501_700, 6_401_700], size: 8192 };

function exportSummary(seq: number, logSeq = 3): OrthoExportSummary {
    return {
        seq, createdAt: '2026-10-07T10:00:00.000Z', logSeq, size: 8192, format: 'png',
        bytes: 150 * 1024 * 1024, downloadPath: `/ortho-patches/export/site-1/${seq}/file`,
    };
}

function exportResult(seq: number, over: Partial<OrthoExportResult> = {}): OrthoExportResult {
    return {
        siteId: 'site-1', exportSeq: seq, extent3006: FRAME.extent3006, size: 8192, logSeq: 3,
        sha256: 'abc', createdAt: '2026-10-07T10:00:00.000Z', file: `ortho-sim-${seq}.png`,
        format: 'png', bytes: 150 * 1024 * 1024, downloadPath: `/ortho-patches/export/site-1/${seq}/file`,
        replayed: false, patchesGeneratedAt: null, ...over,
    };
}

/** A changed import whose box is `fraction` of the frame (square, centred). */
function changedImport(over: Partial<OrthoImportResult> = {}): OrthoImportResult {
    return {
        changed: true, count: 5, patchesGeneratedAt: '2026-10-07T11:00:00.000Z', seq: 5, exportSeq: 2,
        changedPixels: 12_345, diffPixels: 12_000, tolerance: 2, minAreaPx: 4,
        bounds3006: { west: 500_100, south: 6_400_100, east: 500_300, north: 6_400_250 },
        bounds3857: { west: 1_750_000, south: 8_000_000, east: 1_750_200, north: 8_000_150 },
        regions: 3, ...over,
    };
}

interface Opts {
    exports?: OrthoExportSummary[];
    frame?: SimFrame | null;
    patchCount?: number;
    exportImpl?: () => Promise<OrthoExportResult>;
    upload?: UploadLike;
    infoPatchesGeneratedAt?: string | null;
    /** Apply in Unity: the ortho sources, and how the job ends (default: succeeds). */
    sources?: GsproOrthoSource[];
    unityError?: string;
    /** Mutated by the test between calls: what orthoPatchesInfo returns. */
    state?: { exports: OrthoExportSummary[]; generatedAt: string | null; count: number };
}

async function harness(opts: Opts = {}) {
    const state = opts.state ?? {
        exports: opts.exports ?? [exportSummary(1), exportSummary(2)],
        generatedAt: opts.infoPatchesGeneratedAt ?? null,
        count: opts.patchCount ?? 4,
    };
    const exportCalls: Array<{ courseId: string; format?: string }> = [];
    const uploads: UploadRequest[] = [];
    const refreshes: string[] = [];
    const photoStates: Array<{ layer: string; version: string }> = [];
    const patchesApi: OrthoPatchesApi = {
        applyOrthoEdits: async () => { throw new Error('unused'); },
        revertLastOrthoPatch: async () => { throw new Error('unused'); },
        exportOrthoSquare: async input => {
            exportCalls.push(input);
            return (opts.exportImpl ?? (async () => exportResult(state.exports.length + 1)))();
        },
        orthoPatchesInfo: async (): Promise<OrthoPatchesInfo> => ({
            count: state.count, lastCreatedAt: null, lastTool: null, bakeable: true, stampBakeable: true,
            patchesGeneratedAt: state.generatedAt,
            exports: state.exports,
            frame: opts.frame === undefined ? FRAME : opts.frame,
        }),
    };
    const upload: UploadLike = async req => {
        uploads.push(req);
        return (opts.upload ?? (async () => ({ status: 200, body: JSON.stringify(changedImport()) })))(req);
    };
    const unityStarts: Array<Record<string, unknown>> = [];
    let unityPolls = 0;
    const unityJob = (status: GsproExportJob['status']): GsproExportJob => ({
        id: 'job-1', courseId: 'course-1', kind: 'unity-ortho', label: 'x', status,
        startedAt: '', finishedAt: status === 'running' ? null : '',
        result: status === 'succeeded' ? { path: 'D:/out/x.jpg', report: ['wrote x.jpg', 'Unity (vreta_v4): x-meshes.jpg put onto Assets/y.jpg (761 renderers sample it; backup b.jpg)', 'Save the Unity project to keep it.'] } : null,
        error: status === 'failed' ? opts.unityError ?? null : null,
    });
    const unityApi: UnityOrthoApi = {
        orthoSources: async () => opts.sources ?? [
            { source: 'ortho-orto-l2-2025.tif', collection: 'orto-l2-2025', patched: false, active: true },
            { source: 'ortho-orto-l2-2025.patched.tif', collection: 'orto-l2-2025', patched: true, active: true },
            { source: 'ortho-orto-l2-2023.patched.tif', collection: 'orto-l2-2023', patched: true, active: false },
        ],
        start: async input => { unityStarts.push(input); return unityJob('running'); },
        job: async () => { unityPolls++; return unityJob(opts.unityError ? 'failed' : 'succeeded'); },
    };
    const svc = new CleanToolService(
        undefined, undefined, undefined, patchesApi, () => true, {},
        new OrthoImportClient('/api-test', upload), unityApi, 0,
    );
    const ctx: ToolContext = {
        map: {
            interactionMode: new Signal<string>('clean'),
            ready: new Signal(true),
            map: new Signal(null),
            onClick: () => () => {},
            onMouseMove: () => () => {},
            addImageOverlay: () => {},
            addOverlayLayer: () => {},
            updateOverlayData: () => {},
            removeOverlayLayer: () => {},
            refreshOrthoTiles: () => {},
            setOrthoPhotoState: (layer: string, version: string) => { photoStates.push({ layer, version }); },
        } as never,
        elevation: null as never,
        tileset: {
            manifest: new Signal({
                bounds: { west: 15.5, south: 58.3, east: 15.7, north: 58.5 },
                layers: { ortho: { minzoom: 14, maxzoom: 20 }, terrain: { minzoom: 12, maxzoom: 16 } },
                elevation: { min: 0, max: 100 },
                generatedAt: '2026-07-14T10:25:11.864Z',
            }),
            mapKey: new Signal('site-1'),
            tileVersion: new Signal('20260714T102511864Z'),
            reload: async () => {},
            refreshTiles: async (courseId: string) => { refreshes.push(courseId); },
        } as never,
        courseDetail: null as never,
        features: null as never,
        courseId: 'course-1',
        track: d => { cleanups.push(d); },
    };
    svc.activate(ctx);
    await tick();
    photoStates.length = 0;
    return { svc, state, exportCalls, uploads, refreshes, photoStates, unityStarts, unityPolls: () => unityPolls };
}

/** A file of the given size without allocating it. */
const fakeFile = (size: number, name = 'edit.png') => ({ size, name } as unknown as File);

// ─── apply in Unity ─────────────────────────────────────────────────────────

describe('applyInUnity', () => {
    test('starts the unity-ortho job on the patched photo of the built vintage with the tint on, follows it and reports what Unity took', async () => {
        const h = await harness();
        expect(await h.svc.applyInUnity()).toBe(true);
        expect(h.unityStarts).toEqual([{ courseId: 'course-1', kind: 'unity-ortho', source: 'ortho-orto-l2-2025.patched.tif', tint: true }]);
        expect(h.unityPolls()).toBe(1);
        expect(h.svc.unityMessage.get()).toEqual({
            kind: 'info',
            text: 'Unity (vreta_v4): x-meshes.jpg put onto Assets/y.jpg (761 renderers sample it; backup b.jpg) Save the Unity project to keep it.',
        });
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.externalBusy.get()).toBeNull();
    });

    test('a failed job shows the reason the server gave', async () => {
        const h = await harness({ unityError: 'No open Unity editor imports from D:/out — none is open' });
        expect(await h.svc.applyInUnity()).toBe(false);
        expect(h.svc.unityMessage.get()).toEqual({ kind: 'error', text: 'No open Unity editor imports from D:/out — none is open' });
        expect(h.svc.phase.get()).toBe('idle');
    });

    test('with nothing baked there is no patched photo and no job starts', async () => {
        const h = await harness({ sources: [{ source: 'ortho-orto-l2-2025.tif', collection: 'orto-l2-2025', patched: false, active: true }] });
        expect(await h.svc.applyInUnity()).toBe(false);
        expect(h.unityStarts).toEqual([]);
        expect(h.svc.unityMessage.get()?.text).toMatch(/Nothing is baked/);
    });
});

// ─── export ─────────────────────────────────────────────────────────────────

describe('exportPhoto', () => {
    test('activation loads the export list and the frame', async () => {
        const h = await harness();
        expect(h.svc.exports.get().map(e => e.seq)).toEqual([1, 2]);
        expect(h.svc.exportFrame.get()).toEqual(FRAME);
    });

    test('success: signals updated, download info kept, no map refresh unless replayed', async () => {
        const h = await harness({ frame: null, exports: [] });
        expect(h.svc.exportFrame.get()).toBeNull();
        expect(await h.svc.exportPhoto()).toBe(true);
        expect(h.exportCalls).toEqual([{ courseId: 'course-1' }]);
        expect(h.svc.lastExport.get()?.downloadPath).toBe('/ortho-patches/export/site-1/1/file');
        expect(h.svc.exports.get().map(e => e.seq)).toEqual([1]);
        expect(h.svc.exportFrame.get()).toEqual({ extent3006: FRAME.extent3006, size: 8192 });
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.externalBusy.get()).toBeNull();
        expect(h.refreshes).toEqual([]);
        expect(h.photoStates).toEqual([]);
    });

    test('replayed: the sim tiles moved, so the seamless refresh runs', async () => {
        const h = await harness({
            exportImpl: async () => exportResult(3, { replayed: true, patchesGeneratedAt: '2026-10-07T09:00:00.000Z' }),
        });
        expect(await h.svc.exportPhoto()).toBe(true);
        expect(h.refreshes).toEqual(['course-1']);
        expect(h.photoStates[h.photoStates.length - 1].layer).toBe('ortho-sim');
        expect(h.photoStates[h.photoStates.length - 1].version).not.toBe('20260714T102511864Z');
    });

    test('the request timeout is "still running", not a failure, and refreshes the list and map', async () => {
        const h = await harness({
            exportImpl: async () => { throw new Error('Request timeout'); },
        });
        // The server finishes meanwhile: a third export exists and the sim version moved.
        h.state.exports = [exportSummary(1), exportSummary(2), exportSummary(3)];
        h.state.generatedAt = '2026-10-07T09:30:00.000Z';
        expect(await h.svc.exportPhoto()).toBe(false);
        expect(h.svc.externalMessage.get()?.kind).toBe('info');
        expect(h.svc.externalMessage.get()?.text).toContain('still running');
        expect(h.svc.exports.get().map(e => e.seq)).toEqual([1, 2, 3]);
        expect(h.refreshes).toEqual(['course-1']);
        expect(h.svc.phase.get()).toBe('idle');
    });

    test('other failures show the server message', async () => {
        const h = await harness({ exportImpl: async () => { throw new Error('no source raster'); } });
        expect(await h.svc.exportPhoto()).toBe(false);
        expect(h.svc.externalMessage.get()).toEqual({ kind: 'error', text: 'Export failed: no source raster' });
    });

    test('refuses while another operation holds the phase', async () => {
        const h = await harness();
        h.svc.phase.set('applying');
        expect(await h.svc.exportPhoto()).toBe(false);
        expect(h.exportCalls).toHaveLength(0);
    });
});

// ─── import ─────────────────────────────────────────────────────────────────

describe('importPhoto', () => {
    test('success: progress, summary, patch count, seamless refresh', async () => {
        const progress: Array<number | null> = [];
        const h = await harness({
            patchCount: 4,
            upload: async req => {
                req.onProgress(50, 100);
                progress.push(h.svc.uploadProgress.get());
                expect(h.svc.phase.get()).toBe('applying');
                expect(h.svc.externalBusy.get()).toBe('import');
                req.onProgress(100, 100);
                progress.push(h.svc.uploadProgress.get());
                return { status: 200, body: JSON.stringify(changedImport()) };
            },
        });
        expect(await h.svc.importPhoto(fakeFile(1000), 2)).toBe(true);
        expect(progress).toEqual([0.5, 1]);
        expect(h.uploads).toHaveLength(1);
        expect(h.uploads[0].url).toBe('/api-test/ortho-patches/import/course-1?exportSeq=2');
        expect(h.svc.patchCount.get()).toBe(5);
        const summary = h.svc.importSummary.get()!;
        expect(summary.changed).toBe(true);
        expect(summary.headline).toBe('Imported as patch 5');
        expect(summary.details[0]).toBe('12,345 changed pixels in 3 regions');
        expect(summary.details[1]).toContain('Box 200 × 150 m');
        expect(summary.warning).toBeNull();
        expect(h.refreshes).toEqual(['course-1']);
        expect(h.photoStates[h.photoStates.length - 1].layer).toBe('ortho-sim');
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.uploadProgress.get()).toBeNull();
    });

    test('changed:false is a plain "no changes found" with the reason, no refresh', async () => {
        const h = await harness({
            upload: async () => ({
                status: 200,
                body: JSON.stringify(changedImport({
                    changed: false, reason: 'identical', seq: null, bounds3006: null, bounds3857: null,
                    regions: null, changedPixels: 0, patchesGeneratedAt: null, count: 4,
                })),
            }),
        });
        expect(await h.svc.importPhoto(fakeFile(1000), 2)).toBe(true);
        const summary = h.svc.importSummary.get()!;
        expect(summary.changed).toBe(false);
        expect(summary.headline).toBe('No changes found');
        expect(summary.details[0]).toContain('identical to export 2');
        expect(h.svc.patchCount.get()).toBe(4);
        expect(h.refreshes).toEqual([]);
    });

    test('a box over 30 % of the frame carries the warning that points at Revert', async () => {
        const h = await harness({
            upload: async () => ({
                status: 200,
                body: JSON.stringify(changedImport({
                    // 1200 x 1000 m of a 1700 x 1700 m frame = 41 %.
                    bounds3006: { west: 500_100, south: 6_400_100, east: 501_300, north: 6_401_100 },
                })),
            }),
        });
        await h.svc.importPhoto(fakeFile(1000), 2);
        const summary = h.svc.importSummary.get()!;
        expect(summary.coverage).toBeCloseTo(0.415, 2);
        expect(summary.warning).toContain('42 %');
        expect(summary.warning).toContain('Revert last patch');
        expect(summary.boxNote).toContain('one box');
    });

    test('oversize files are refused before any request', async () => {
        const h = await harness();
        expect(await h.svc.importPhoto(fakeFile(ORTHO_IMPORT_MAX_BYTES + 1), 2)).toBe(false);
        expect(h.uploads).toHaveLength(0);
        expect(h.svc.externalMessage.get()?.kind).toBe('error');
        expect(h.svc.externalMessage.get()?.text).toContain('limit is 400 MB');
        expect(h.svc.phase.get()).toBe('idle');
    });

    test('an empty file and a bad tolerance are refused without a request', async () => {
        const h = await harness();
        expect(await h.svc.importPhoto(fakeFile(0), 2)).toBe(false);
        expect(await h.svc.importPhoto(fakeFile(10), 2, 300)).toBe(false);
        expect(await h.svc.importPhoto(fakeFile(10), 2, Number.NaN)).toBe(false);
        expect(h.uploads).toHaveLength(0);
    });

    test('a 422 shows the pipeline message verbatim', async () => {
        const h = await harness({
            upload: async () => ({ status: 422, body: JSON.stringify({ error: 'Image is 4096 px, the export is 8192 px.' }) }),
        });
        expect(await h.svc.importPhoto(fakeFile(1000), 2)).toBe(false);
        expect(h.svc.externalMessage.get()).toEqual({
            kind: 'error', text: 'Import failed: Image is 4096 px, the export is 8192 px.',
        });
        expect(h.svc.importSummary.get()).toBeNull();
        expect(h.refreshes).toEqual([]);
        expect(h.svc.phase.get()).toBe('idle');
    });

    test('a 504 says the bake continues, then refreshes the count and the map', async () => {
        const h = await harness({
            patchCount: 4,
            upload: async () => ({ status: 504, body: '<html>Gateway Time-out</html>' }),
        });
        h.state.count = 5;
        h.state.generatedAt = '2026-10-07T12:00:00.000Z';
        expect(await h.svc.importPhoto(fakeFile(1000), 2)).toBe(false);
        expect(h.svc.externalMessage.get()?.kind).toBe('info');
        expect(h.svc.externalMessage.get()?.text).toContain('still baking');
        expect(h.svc.patchCount.get()).toBe(5);
        expect(h.refreshes).toEqual(['course-1']);
    });

    test('a transport failure is reported and recovers to idle', async () => {
        const h = await harness({ upload: async () => { throw new Error('network error'); } });
        expect(await h.svc.importPhoto(fakeFile(1000), 2)).toBe(false);
        expect(h.svc.externalMessage.get()?.text).toBe('Import failed: network error');
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.externalBusy.get()).toBeNull();
    });

    test('tolerance is omitted unless set, and sent when set', async () => {
        const h = await harness();
        await h.svc.importPhoto(fakeFile(1000), 2);
        await h.svc.importPhoto(fakeFile(1000), 1, 0);
        await h.svc.importPhoto(fakeFile(1000), 1, 12);
        expect(h.uploads.map(u => u.url)).toEqual([
            '/api-test/ortho-patches/import/course-1?exportSeq=2',
            '/api-test/ortho-patches/import/course-1?exportSeq=1&tolerance=0',
            '/api-test/ortho-patches/import/course-1?exportSeq=1&tolerance=12',
        ]);
    });

    test('refuses while a bake or export holds the phase', async () => {
        const h = await harness();
        h.svc.phase.set('applying');
        expect(await h.svc.importPhoto(fakeFile(1000), 2)).toBe(false);
        expect(h.uploads).toHaveLength(0);
    });
});

describe('export picker default', () => {
    test('the latest export unless one is picked; a vanished pick falls back', async () => {
        const h = await harness();
        expect(h.svc.effectiveExportSeq()).toBe(2);
        h.svc.pickedExportSeq.set(1);
        expect(h.svc.effectiveExportSeq()).toBe(1);
        h.svc.pickedExportSeq.set(9);
        expect(h.svc.effectiveExportSeq()).toBe(2);
    });

    test('no exports: nothing to import against', async () => {
        const h = await harness({ exports: [] });
        expect(h.svc.effectiveExportSeq()).toBeNull();
    });
});

// ─── pure helpers ───────────────────────────────────────────────────────────

describe('summary arithmetic', () => {
    test('countTiles counts the mercator tiles per zoom', () => {
        // A point-sized box sits in one tile per zoom: 7 zooms (14..20).
        const b = { west: 1_750_000, south: 8_000_000, east: 1_750_001, north: 8_000_001 };
        expect(countTiles(b, 14, 20)).toBe(7);
        // The whole world at z0..z1: 1 + 4 tiles.
        const world = { west: -20_037_508, south: -20_037_508, east: 20_037_508, north: 20_037_508 };
        expect(countTiles(world, 0, 1)).toBe(5);
    });

    test('reasons are worded for each no-change case', () => {
        const base = changedImport({ changed: false, bounds3006: null, bounds3857: null, seq: null });
        expect(summarizeImport({ ...base, reason: 'below-min-area' }, FRAME).details[0]).toContain('smaller than 4 pixels');
        expect(summarizeImport({ ...base, reason: 'outside-ortho' }, FRAME).details[0]).toContain('outside the ortho photo');
    });

    test('without a frame there is no coverage and no warning', () => {
        const summary = summarizeImport(changedImport(), null);
        expect(summary.coverage).toBeNull();
        expect(summary.warning).toBeNull();
    });
});

// ─── upload client contract ─────────────────────────────────────────────────

describe('OrthoImportClient', () => {
    test('parses a 200 and encodes the course id', async () => {
        let url = '';
        const client = new OrthoImportClient('/b', async req => {
            url = req.url;
            return { status: 200, body: JSON.stringify(changedImport()) };
        });
        const res = await client.importPhoto('a b', new Blob(['x']), 3, null, () => {});
        expect(res.changed).toBe(true);
        expect(url).toBe('/b/ortho-patches/import/a%20b?exportSeq=3');
    });

    test('non-JSON error bodies fall back to the status', async () => {
        const client = new OrthoImportClient('/b', async () => ({ status: 502, body: 'bad gateway' }));
        await expect(client.importPhoto('c', new Blob(['x']), 1, null, () => {})).rejects.toThrow('HTTP 502');
    });
});

// ─── panel render ───────────────────────────────────────────────────────────

describe('External edit section', () => {
    async function mountPanel(opts: Opts = {}) {
        const h = await harness(opts);
        di.set(CleanToolService, h.svc);
        const host = document.createElement('div');
        new CleanPanelComponent({}).mount(host);
        await tick();
        const q = <T extends HTMLElement>(id: string) => host.querySelector(`[data-testid="${id}"]`) as T;
        return { ...h, host, q };
    }

    test('idle: frame line, export button, newest-first list with download links, picker on the latest', async () => {
        const p = await mountPanel();
        expect(p.q('ext-frame-line').textContent).toContain('Frame 8192 × 8192 px');
        expect(p.q('ext-frame-line').textContent).toContain('2 exports');
        const btn = p.q<HTMLButtonElement>('export-btn');
        expect(btn.disabled).toBe(false);
        const rows = [...p.q('export-list').querySelectorAll('li')];
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain('#2');
        const link = rows[0].querySelector('a') as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe(`${API_BASE}/ortho-patches/export/site-1/2/file`);
        expect(link.download).toBe('ortho-sim-2.png');
        const picker = p.q<HTMLSelectElement>('import-export-picker');
        expect([...picker.options].map(o => o.value)).toEqual(['2', '1']);
        expect(picker.value).toBe('2');
        expect(p.q('export-result').className).not.toContain('show');
        expect(p.q('import-summary').className).not.toContain('show');
    });

    test('before the first export: no list, picker and file input disabled', async () => {
        const p = await mountPanel({ exports: [], frame: null });
        expect(p.q('ext-frame-line').textContent).toContain('first export fixes the frame');
        expect(p.q<HTMLInputElement>('import-file').disabled).toBe(true);
        expect(p.q<HTMLSelectElement>('import-export-picker').disabled).toBe(true);
    });

    test('clicking Export shows the file name and a download link, and the list grows', async () => {
        const p = await mountPanel();
        p.q<HTMLButtonElement>('export-btn').click();
        await tick();
        const result = p.q('export-result');
        expect(result.className).toContain('show');
        expect(result.textContent).toContain('ortho-sim-3.png');
        expect((p.q('export-result-link') as HTMLAnchorElement).getAttribute('href'))
            .toBe(`${API_BASE}/ortho-patches/export/site-1/3/file`);
        expect(p.q('export-list').querySelectorAll('li')).toHaveLength(3);
        expect(p.q<HTMLSelectElement>('import-export-picker').value).toBe('3');
    });

    test('buttons are disabled while an operation runs', async () => {
        const p = await mountPanel();
        p.svc.phase.set('applying');
        expect(p.q<HTMLButtonElement>('export-btn').disabled).toBe(true);
        expect(p.q<HTMLInputElement>('import-file').disabled).toBe(true);
    });

    test('picking a file imports against the picked export and shows the summary', async () => {
        const p = await mountPanel();
        const picker = p.q<HTMLSelectElement>('import-export-picker');
        picker.value = '1';
        picker.dispatchEvent(new Event('change'));
        const tol = p.q<HTMLInputElement>('import-tolerance');
        tol.value = '8';
        const input = p.q<HTMLInputElement>('import-file');
        const file = new File([new Uint8Array([137, 80, 78, 71])], 'edited.png', { type: 'image/png' });
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new Event('change'));
        await tick();
        await tick();
        expect(p.uploads.map(u => u.url)).toEqual(['/api-test/ortho-patches/import/course-1?exportSeq=1&tolerance=8']);
        expect(p.q('import-summary').className).toContain('show');
        expect(p.q('import-summary').textContent).toContain('Imported as patch 5');
        expect(p.q('import-warning').className).not.toContain('show');
    });
});
