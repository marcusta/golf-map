import { afterEach, describe, expect, test } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import { di, Signal } from '@basics/core/client/core';
import type { ToolContext } from '../src/editor/tool';
import { CleanToolService, type UnityOrthoApi } from '../src/clean/clean-tool.service';
import type { GsproExportJob, GsproOrthoSource } from '../../shared/api/gspro-export.gen';
import { CleanPanelComponent } from '../src/clean/clean-panel.component';
import {
    PhotoImportClient,
    cleanedPhotoExportUrl,
    importSummaryText,
    type UploadLike,
    type UploadRequest,
} from '../src/clean/clean-external';
import { API_BASE } from '../src/api';
import { CLEANED_IMPORT_MAX_BYTES, type CleanedImportResult } from '../../shared/cleaned-photo';
import type { CleanedPhotoApi, CleanedPhotoInfo } from '../../shared/api/cleaned-photo.gen';
import type { RetouchEngine } from '../src/clean/retouch-engine';

// Clean tool beyond the brushes: the cleaned photo out to an image editor and
// back (a plain download, an import of any image of the size), undo, and
// Apply in Unity. Server calls sit behind the generated-client fake and the
// upload seam, so no network is involved; the panel renders through happy-dom.

let cleanups: Array<() => void> = [];

afterEach(() => {
    for (const c of cleanups) c();
    cleanups = [];
    _reset();
    di.reset();
});

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function imported(over: Partial<CleanedImportResult> = {}): CleanedImportResult {
    return {
        changed: true, changedPixels: 933_671, size: 8192,
        bounds3006: { west: 530_000, south: 6_487_000, east: 530_567, north: 6_487_768 },
        undoDepth: 3, patchesGeneratedAt: '2026-10-08T11:00:00.000Z', ...over,
    };
}

interface Opts {
    undoDepth?: number;
    exists?: boolean;
    upload?: UploadLike;
    infoPatchesGeneratedAt?: string | null;
    /** Mutated by the test between calls: what cleanedPhotoInfo returns. */
    state?: { undoDepth: number; generatedAt: string | null };
    /** Apply in Unity: the ortho sources, and how the job ends (default: succeeds). */
    sources?: GsproOrthoSource[];
    unityError?: string;
}

async function harness(opts: Opts = {}) {
    const state = opts.state ?? { undoDepth: opts.undoDepth ?? 2, generatedAt: opts.infoPatchesGeneratedAt ?? null };
    const uploads: UploadRequest[] = [];
    const refreshes: string[] = [];
    const photoStates: Array<{ layer: string; version: string }> = [];
    const photoApi: CleanedPhotoApi = {
        undoPhotoChange: async () => { throw new Error('unused'); },
        cleanedPhotoInfo: async (): Promise<CleanedPhotoInfo> => ({
            exists: opts.exists ?? true, undoDepth: state.undoDepth, size: 8192,
            bounds3006: { west: 529000, south: 6486000, east: 531048, north: 6488048 },
            patchesGeneratedAt: state.generatedAt,
        }),
    };
    const upload: UploadLike = async req => {
        uploads.push(req);
        return (opts.upload ?? (async () => ({ status: 200, body: JSON.stringify(imported()) })))(req);
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
            { source: 'ortho-orto-l2-2025.tif', collection: 'orto-l2-2025', cleaned: false, active: true },
            { source: 'ortho-orto-l2-2025.cleaned.tif', collection: 'orto-l2-2025', cleaned: true, active: true },
            { source: 'ortho-orto-l2-2023.cleaned.tif', collection: 'orto-l2-2023', cleaned: true, active: false },
        ],
        start: async input => { unityStarts.push(input); return unityJob('running'); },
        job: async () => { unityPolls++; return unityJob(opts.unityError ? 'failed' : 'succeeded'); },
    };
    // The pixel engine is not what these tests are about: it loads and idles.
    const engine = {
        load: async () => ({ size: 8192 }),
        dispose: () => {},
    } as unknown as RetouchEngine;
    const svc = new CleanToolService(
        () => engine, photoApi, async () => { throw new Error('unused'); }, {},
        new PhotoImportClient('/api-test', upload), unityApi, 0,
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
    await tick();
    photoStates.length = 0;
    return { svc, state, uploads, refreshes, photoStates, unityStarts, unityPolls: () => unityPolls };
}

/** A file of the given size without allocating it. */
const fakeFile = (size: number, name = 'edit.png') => ({ size, name } as unknown as File);

// ─── apply in Unity ─────────────────────────────────────────────────────────

describe('applyInUnity', () => {
    test('starts the unity-ortho job on the cleaned photo of the built vintage with the tint on, follows it and reports what Unity took', async () => {
        const h = await harness();
        expect(await h.svc.applyInUnity()).toBe(true);
        expect(h.unityStarts).toEqual([{ courseId: 'course-1', kind: 'unity-ortho', source: 'ortho-orto-l2-2025.cleaned.tif', tint: true }]);
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

    test('without a cleaned photo no job starts', async () => {
        const h = await harness({ sources: [{ source: 'ortho-orto-l2-2025.tif', collection: 'orto-l2-2025', cleaned: false, active: true }] });
        expect(await h.svc.applyInUnity()).toBe(false);
        expect(h.unityStarts).toEqual([]);
        expect(h.svc.unityMessage.get()?.text).toMatch(/no cleaned photo yet/);
    });
});

// ─── export ─────────────────────────────────────────────────────────────────

describe('export', () => {
    test('is a plain download of the photo, with no state and no request beforehand', async () => {
        const h = await harness();
        expect(h.svc.exportUrl()).toBe(`${API_BASE}/cleaned-photo/course-1/export.png`);
        expect(cleanedPhotoExportUrl('a/b', '/x')).toBe('/x/cleaned-photo/a%2Fb/export.png');
    });
});

// ─── import ─────────────────────────────────────────────────────────────────

describe('importPhoto', () => {
    test('activation loads what can be undone', async () => {
        const h = await harness({ undoDepth: 4 });
        expect(h.svc.undoDepth.get()).toBe(4);
        expect(h.svc.photoExists.get()).toBe(true);
    });

    test('success: progress, a one-line summary, the undo count, seamless refresh; nothing but the file is sent', async () => {
        const progress: Array<number | null> = [];
        const h = await harness({
            upload: async req => {
                req.onProgress(50, 100);
                progress.push(h.svc.uploadProgress.get());
                req.onProgress(100, 100);
                progress.push(h.svc.uploadProgress.get());
                return { status: 200, body: JSON.stringify(imported()) };
            },
        });
        expect(await h.svc.importPhoto(fakeFile(1000))).toBe(true);
        expect(h.uploads.map(u => u.url)).toEqual(['/api-test/cleaned-photo/course-1/import']);
        expect(progress).toEqual([0.5, 1]);
        expect(h.svc.uploadProgress.get()).toBeNull();
        expect(h.svc.importSummary.get()).toBe(
            'Imported: 933,671 pixels changed (1 % of the photo), within 567 × 768 m. Undo puts the previous photo back.');
        expect(h.svc.undoDepth.get()).toBe(3);
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.refreshes).toEqual(['course-1']);
        expect(h.photoStates[h.photoStates.length - 1]).toEqual({ layer: 'ortho-sim', version: '20261008T110000000Z' });
    });

    test('an image that is the photo as it was says so and refreshes nothing', async () => {
        const h = await harness({
            upload: async () => ({
                status: 200,
                body: JSON.stringify(imported({ changed: false, changedPixels: 0, bounds3006: null, undoDepth: 2, patchesGeneratedAt: null })),
            }),
        });
        expect(await h.svc.importPhoto(fakeFile(1000))).toBe(true);
        expect(h.svc.importSummary.get()).toMatch(/Nothing changed/);
        expect(h.refreshes).toEqual([]);
    });

    test('oversize and empty files are refused before any request', async () => {
        const h = await harness();
        expect(await h.svc.importPhoto(fakeFile(CLEANED_IMPORT_MAX_BYTES + 1))).toBe(false);
        expect(h.svc.externalMessage.get()?.text).toMatch(/the limit is 400 MB/);
        expect(await h.svc.importPhoto(fakeFile(0))).toBe(false);
        expect(h.svc.externalMessage.get()?.text).toBe('The file is empty.');
        expect(h.uploads).toEqual([]);
    });

    test('a refusal shows the server\'s own words: another size (422), a stalled upload (408)', async () => {
        const wrongSize = 'cleaned-replace failed: error: the image is 4096 x 4096 px and the cleaned photo is 8192 x 8192 px: save it at 8192 x 8192 px, uncropped';
        const a = await harness({ upload: async () => ({ status: 422, body: JSON.stringify({ error: wrongSize }) }) });
        expect(await a.svc.importPhoto(fakeFile(1000))).toBe(false);
        expect(a.svc.externalMessage.get()).toEqual({ kind: 'error', text: `Import failed: ${wrongSize}` });
        expect(a.svc.phase.get()).toBe('idle');

        const stalled = 'The upload stopped: 1670522 of 100075137 bytes arrived, then nothing for 30 s. Pick the file again once the image editor has finished saving it.';
        const b = await harness({ upload: async () => ({ status: 408, body: JSON.stringify({ error: stalled }) }) });
        expect(await b.svc.importPhoto(fakeFile(1000))).toBe(false);
        expect(b.svc.externalMessage.get()?.text).toBe(`Import failed: ${stalled}`);
    });

    test('a 504 says the server carries on, then refreshes the count and the map', async () => {
        const state = { undoDepth: 2, generatedAt: null as string | null };
        const h = await harness({
            state,
            upload: async () => {
                state.undoDepth = 3;
                state.generatedAt = '2026-10-08T12:00:00.000Z';
                return { status: 504, body: JSON.stringify({ error: 'Request timeout' }) };
            },
        });
        expect(await h.svc.importPhoto(fakeFile(1000))).toBe(false);
        expect(h.svc.externalMessage.get()?.kind).toBe('info');
        expect(h.svc.undoDepth.get()).toBe(3);
        expect(h.refreshes).toEqual(['course-1']);
    });

    test('a transport failure is reported and recovers to idle', async () => {
        const h = await harness({ upload: async () => { throw new Error('network error'); } });
        expect(await h.svc.importPhoto(fakeFile(1000))).toBe(false);
        expect(h.svc.externalMessage.get()).toEqual({ kind: 'error', text: 'Import failed: network error' });
        expect(h.svc.phase.get()).toBe('idle');
        expect(h.svc.uploadProgress.get()).toBeNull();
    });

    test('refuses while another operation holds the phase', async () => {
        const h = await harness();
        h.svc.phase.set('applying');
        expect(await h.svc.importPhoto(fakeFile(1000))).toBe(false);
        expect(h.uploads).toEqual([]);
    });
});

describe('PhotoImportClient and the summary line', () => {
    test('parses a 200 and encodes the course id; a non-JSON error body falls back to the status', async () => {
        const urls: string[] = [];
        const ok = new PhotoImportClient('/api', async req => { urls.push(req.url); return { status: 200, body: JSON.stringify(imported()) }; });
        expect((await ok.importPhoto('a/b', new Blob(['x']), () => {})).changedPixels).toBe(933_671);
        expect(urls).toEqual(['/api/cleaned-photo/a%2Fb/import']);
        const bad = new PhotoImportClient('/api', async () => ({ status: 502, body: '<html>Bad gateway</html>' }));
        await expect(bad.importPhoto('c', new Blob(['x']), () => {})).rejects.toThrow('HTTP 502');
    });

    test('a whole new picture reads as most of the photo', () => {
        const all = imported({ changedPixels: 8192 * 8192 * 0.97, bounds3006: { west: 0, south: 0, east: 2050, north: 2050 } });
        expect(importSummaryText(all)).toContain('(97 % of the photo), within 2,050 × 2,050 m');
        expect(importSummaryText(imported({ changedPixels: 40 }))).toContain('(under 1 % of the photo)');
    });
});

// ─── panel ──────────────────────────────────────────────────────────────────

describe('Clean panel: undo, download, import', () => {
    async function mountPanel(opts: Opts = {}) {
        const h = await harness(opts);
        di.set(CleanToolService, h.svc);
        const host = document.createElement('div');
        new CleanPanelComponent({}).mount(host);
        await tick();
        const q = <T extends HTMLElement>(id: string) => host.querySelector(`[data-testid="${id}"]`) as T;
        return { ...h, host, q };
    }

    test('idle: what can be undone, a download link, an import input that needs no export first', async () => {
        const p = await mountPanel({ undoDepth: 0, exists: false });
        expect(p.q('undo-count').textContent).toBe('No earlier photo kept');
        expect(p.q<HTMLButtonElement>('undo-btn').disabled).toBe(true);
        expect(p.q<HTMLAnchorElement>('export-link').getAttribute('href')).toBe(`${API_BASE}/cleaned-photo/course-1/export.png`);
        // Never cleaned, never exported: the import is open all the same.
        expect(p.q<HTMLInputElement>('import-file').disabled).toBe(false);
        expect(p.q('import-summary').className).not.toContain('show');
        // Nothing of the old export bookkeeping is left.
        for (const gone of ['export-list', 'import-export-picker', 'import-tolerance', 'ext-frame-line', 'export-btn']) {
            expect(p.q(gone)).toBeNull();
        }

        const some = await mountPanel({ undoDepth: 2 });
        expect(some.q('undo-count').textContent).toBe('2 earlier photos kept');
        expect(some.q<HTMLButtonElement>('undo-btn').disabled).toBe(false);
    });

    test('the controls are disabled while an operation runs', async () => {
        const p = await mountPanel();
        p.svc.phase.set('applying');
        expect(p.q<HTMLButtonElement>('undo-btn').disabled).toBe(true);
        expect(p.q<HTMLInputElement>('import-file').disabled).toBe(true);
        expect(p.q<HTMLButtonElement>('unity-apply-btn').disabled).toBe(true);
    });

    test('picking a file uploads it and shows what changed', async () => {
        const p = await mountPanel();
        const input = p.q<HTMLInputElement>('import-file');
        const file = new File([new Uint8Array([137, 80, 78, 71])], 'edited.png', { type: 'image/png' });
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new Event('change'));
        await tick();
        await tick();
        expect(p.uploads.map(u => u.url)).toEqual(['/api-test/cleaned-photo/course-1/import']);
        expect(p.q('import-summary').className).toContain('show');
        expect(p.q('import-summary').textContent).toContain('Imported: 933,671 pixels changed');
        expect(p.q('undo-count').textContent).toBe('3 earlier photos kept');
    });
});
