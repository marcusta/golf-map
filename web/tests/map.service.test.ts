import { test, expect, describe } from 'bun:test';
import { MapService } from '../src/map/map.service';
import { ORTHO_SOURCE_ID, orthoSourceId, tileUrlTemplate } from '../src/map/map-style';

// MapLibre GL can't render under happy-dom (no WebGL), so init()/the real
// map lifecycle stay integration-tested in the app. These cover the seamless
// in-place ortho refresh (T55 flicker fix): the tile-version bump reaches the
// LIVE raster sources without a re-init, driven off a fake maplibre map.

/** A fake maplibregl.Map recording the source/layer mutations we assert on. */
function fakeMap(opts: { withSetTiles?: boolean; sources?: Record<string, any>; layers?: any[] } = {}) {
    const withSetTiles = opts.withSetTiles ?? true;
    const setTilesCalls: Array<{ id: string; tiles: string[] }> = [];
    const added: Array<{ type: 'source' | 'layer'; id: string; spec?: any; beforeId?: string }> = [];
    const removed: string[] = [];
    const sources: Record<string, any> = {};
    for (const [id, spec] of Object.entries(opts.sources ?? {})) {
        sources[id] = withSetTiles
            ? { ...spec, type: 'raster', setTiles: (tiles: string[]) => setTilesCalls.push({ id, tiles }) }
            : { ...spec, type: 'raster' };
    }
    let layers = [...(opts.layers ?? [])];
    const map = {
        getSource: (id: string) => sources[id],
        getLayer: (id: string) => layers.find(l => l.id === id),
        getStyle: () => ({ sources: opts.sources ?? {}, layers: [...layers] }),
        removeLayer: (id: string) => { removed.push(id); layers = layers.filter(l => l.id !== id); },
        removeSource: (id: string) => { removed.push(id); delete sources[id]; },
        addSource: (id: string, spec: any) => { sources[id] = spec; added.push({ type: 'source', id, spec }); },
        addLayer: (layer: any, beforeId?: string) => { layers.push(layer); added.push({ type: 'layer', id: layer.id, beforeId }); },
    };
    return { map, setTilesCalls, added, removed, sources };
}

describe('setRasterTileUrl', () => {
    test('prefers RasterTileSource.setTiles — no source/layer churn', () => {
        const svc = new MapService();
        const f = fakeMap({ sources: { [ORTHO_SOURCE_ID]: {} } });
        svc.map.set(f.map as never);

        svc.setRasterTileUrl(ORTHO_SOURCE_ID, '/tiles/site-1/ortho/{z}/{x}/{y}.jpg?v=V2');

        expect(f.setTilesCalls).toEqual([{ id: ORTHO_SOURCE_ID, tiles: ['/tiles/site-1/ortho/{z}/{x}/{y}.jpg?v=V2'] }]);
        expect(f.removed).toHaveLength(0);
        expect(f.added).toHaveLength(0);
    });

    test('falls back to a source swap at the same layer position without setTiles', () => {
        const svc = new MapService();
        const f = fakeMap({
            withSetTiles: false,
            sources: { [ORTHO_SOURCE_ID]: { minzoom: 14, tiles: ['old'] } },
            // ortho layer sits below the hillshade layer — must re-insert there.
            layers: [
                { id: 'editor-background', type: 'background' },
                { id: 'course-ortho', type: 'raster', source: ORTHO_SOURCE_ID },
                { id: 'course-hillshade', type: 'raster', source: 'course-hillshade-dem' },
            ],
        });
        svc.map.set(f.map as never);

        svc.setRasterTileUrl(ORTHO_SOURCE_ID, '/tiles/site-1/ortho/{z}/{x}/{y}.jpg?v=V2');

        // Source re-created with the new template, layer re-added before the
        // surviving hillshade layer (position preserved).
        expect(f.added).toEqual([
            { type: 'source', id: ORTHO_SOURCE_ID, spec: { minzoom: 14, tiles: ['/tiles/site-1/ortho/{z}/{x}/{y}.jpg?v=V2'] } },
            { type: 'layer', id: 'course-ortho', beforeId: 'course-hillshade' },
        ]);
        expect(f.removed).toEqual(['course-ortho', ORTHO_SOURCE_ID]);
    });

    test('no-op when the source is absent (map mid-teardown)', () => {
        const svc = new MapService();
        const f = fakeMap({ sources: {} });
        svc.map.set(f.map as never);
        svc.setRasterTileUrl(ORTHO_SOURCE_ID, '/tiles/x?v=V2');
        expect(f.setTilesCalls).toHaveLength(0);
    });
});

describe('refreshOrthoTiles version-bump propagation', () => {
    test('single ortho source: new ?v= reaches the live source, displayedVersion tracks it', () => {
        const svc = new MapService();
        const f = fakeMap({ sources: { [ORTHO_SOURCE_ID]: {} } });
        svc.map.set(f.map as never);
        // Stand in for what init() records (init needs a real GL context).
        (svc as unknown as { mapKey: string }).mapKey = 'site-1';
        (svc as unknown as { orthoSources: unknown }).orthoSources = [{ sourceId: ORTHO_SOURCE_ID }];

        svc.refreshOrthoTiles('V2');

        expect(f.setTilesCalls).toEqual([{ id: ORTHO_SOURCE_ID, tiles: [tileUrlTemplate('site-1', 'ortho', 'jpg', 'V2')] }]);
        expect(svc.displayedVersion.get()).toBe('V2');
    });

    test('multi-vintage: active source omits ?c=, others keep it — all bumped, terrain untouched', () => {
        const svc = new MapService();
        const activeId = orthoSourceId('a');
        const otherId = orthoSourceId('b');
        const f = fakeMap({ sources: { [activeId]: {}, [otherId]: {}, 'course-terrain': {} } });
        svc.map.set(f.map as never);
        (svc as unknown as { mapKey: string }).mapKey = 'site-1';
        (svc as unknown as { orthoSources: unknown }).orthoSources = [
            { sourceId: activeId },
            { sourceId: otherId, collection: 'b' },
        ];

        svc.refreshOrthoTiles('V3');

        expect(f.setTilesCalls).toEqual([
            { id: activeId, tiles: [tileUrlTemplate('site-1', 'ortho', 'jpg', 'V3')] },
            { id: otherId, tiles: [tileUrlTemplate('site-1', 'ortho', 'jpg', 'V3', 'b')] },
        ]);
        // Terrain source is never touched by an ortho patch refresh.
        expect(f.setTilesCalls.some(c => c.id === 'course-terrain')).toBe(false);
        expect(svc.displayedVersion.get()).toBe('V3');
    });

    test('no-op before init (no map / no mapKey)', () => {
        const svc = new MapService();
        svc.refreshOrthoTiles('V2');
        expect(svc.displayedVersion.get()).toBeNull();
    });
});
