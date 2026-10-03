import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as LibreMap } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { Camera, Frustum, Matrix4, Mesh, Scene, Vector2, Vector3, WebGLRenderer, type BufferGeometry, type ShaderMaterial } from 'three';
import { waterGeometry } from './water-geometry';
import { waterMaterial } from './water-material';
import { WaterElevationQueue } from './water-elevation-queue';

import { WATER_LAYER_ID } from './custom-layer-ids';

export { WATER_LAYER_ID };

interface WaterEntry {
    type: string;
    /** The feature's coordinates array: its identity is the change key. */
    coordinates: unknown;
    meshes: Mesh<BufferGeometry, ShaderMaterial>[];
}

function coordinatesOf(feature: Feature): unknown {
    const geometry = feature.geometry;
    return geometry && 'coordinates' in geometry ? geometry.coordinates : geometry;
}

function sameWater(feature: Feature, entry: WaterEntry): boolean {
    return feature.properties?.type === entry.type && coordinatesOf(feature) === entry.coordinates;
}

/** Water follows the loaded DEM and shares the map depth buffer with terrain and trees. */
export class WaterLayer implements CustomLayerInterface {
    enabled = true;
    readonly id = WATER_LAYER_ID;
    readonly type = 'custom' as const;
    readonly renderingMode = '3d' as const;
    private map!: LibreMap;
    private renderer!: WebGLRenderer;
    private readonly scene = new Scene();
    private readonly camera = new Camera();
    private readonly model = new Matrix4();
    private readonly eye = new Vector3();
    private readonly scale = new Vector3();
    private readonly frustum = new Frustum();
    private readonly materials = [waterMaterial(), waterMaterial(true)];
    private meshes: Mesh<BufferGeometry, ShaderMaterial>[] = [];
    /** One entry per water feature, in feature order; `meshes` is their flattening. */
    private entries: WaterEntry[] = [];
    /** Sampler of the last full elevation pass, reused for water added since. */
    private sampler: ((x: number, y: number) => number) | null = null;
    /** Water set changes and meshes built (tests / diagnostics). */
    readonly builds = { sets: 0, meshes: 0 };
    private anchor = MercatorCoordinate.fromLngLat([0, 0]);
    private units = 1;
    private heightsDirty = true;
    private lastSample = -Infinity;
    private elevationQueue: WaterElevationQueue | null = null;
    private sampledTerrain: LibreMap['terrain'] | null = null;
    private sampledZoom = -1;
    private sampledExaggeration = NaN;
    private repaintTimer: ReturnType<typeof setTimeout> | null = null;
    readonly stats = { maxDrapeMs: 0, samples: 0, verticesProcessed: 0, pending: false };
    private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    private readonly terrainChanged = (event: { sourceId?: string }) => {
        if (event.sourceId?.includes('terrain') || event.sourceId?.includes('surface')) this.heightsDirty = true;
    };

    onAdd(map: LibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
        this.map = map;
        this.renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext });
        this.renderer.autoClear = false;
        map.on('sourcedata', this.terrainChanged);
    }

    /**
     * Replace the water set. Called on every features push, so the unchanged
     * case must stay cheap: features are matched by `[type, coordinates]`
     * reference (the features service reuses each feature's cached ring array
     * while its geometry is unchanged), which costs one compare per water and
     * no serialization. Changed or added features get new meshes; kept
     * features keep their meshes and their sampled heights.
     */
    setData(data: FeatureCollection): void {
        const waters = data.features.filter(f => f.properties?.type === 'water' || f.properties?.type === 'water_creek');
        if (waters.length === this.entries.length && waters.every((f, i) => sameWater(f, this.entries[i]))) return;
        this.builds.sets++;
        const previous = new Map<unknown, WaterEntry[]>();
        for (const entry of this.entries) {
            const list = previous.get(entry.coordinates);
            if (list) list.push(entry); else previous.set(entry.coordinates, [entry]);
        }
        const kept: WaterEntry[] = [];
        const next = waters.map(feature => {
            const list = previous.get(coordinatesOf(feature));
            const index = list?.findIndex(e => e.type === feature.properties?.type) ?? -1;
            if (index < 0) return { feature };
            const [entry] = list!.splice(index, 1);
            kept.push(entry);
            return { entry };
        });
        for (const list of previous.values()) for (const entry of list) for (const mesh of entry.meshes) mesh.geometry.dispose();
        // Kept meshes are positioned relative to the current anchor; only a
        // fully new set may move it.
        const keptMeshes = kept.some(entry => entry.meshes.length > 0);
        const build = { anchored: keptMeshes, fresh: new Set<BufferGeometry>() };
        this.entries = next.map(({ feature, entry }) => entry ?? this.buildEntry(feature!, build));
        this.meshes = this.entries.flatMap(entry => entry.meshes);
        this.scene.clear();
        for (const mesh of this.meshes) this.scene.add(mesh);
        const previousQueue = this.elevationQueue;
        this.elevationQueue = new WaterElevationQueue(this.meshes.map(mesh => mesh.geometry));
        if (keptMeshes && this.sampler && this.sampledTerrain && !previousQueue?.pending) {
            // Kept water already carries heights for the current DEM/zoom/
            // exaggeration: sample only the new surfaces with that sampler.
            this.elevationQueue.start(this.sampler, build.fresh);
        } else {
            this.sampledTerrain = null;
            this.heightsDirty = true;
            this.lastSample = -Infinity;
            Object.assign(this.stats, { maxDrapeMs: 0, samples: 0, verticesProcessed: 0, pending: false });
        }
        this.map?.triggerRepaint();
    }

    private buildEntry(feature: Feature, build: { anchored: boolean; fresh: Set<BufferGeometry> }): WaterEntry {
        const meshes: Mesh<BufferGeometry, ShaderMaterial>[] = [];
        const geometry = feature.geometry;
        const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
            : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
        for (const polygon of polygons) {
            if (!polygon[0]?.length) continue;
            if (!build.anchored) {
                this.anchor = MercatorCoordinate.fromLngLat(polygon[0][0] as [number, number]);
                this.units = this.anchor.meterInMercatorCoordinateUnits();
                build.anchored = true;
            }
            const rings = polygon.map(ring => ring.map(p => {
                const merc = MercatorCoordinate.fromLngLat(p as [number, number]);
                return new Vector2((merc.x - this.anchor.x) / this.units, (this.anchor.y - merc.y) / this.units);
            }));
            const mesh = new Mesh(waterGeometry(rings), this.materials[feature.properties?.type === 'water_creek' ? 1 : 0]);
            // Bounds are recomputed after terrain samples arrive.
            mesh.visible = false;
            meshes.push(mesh);
            build.fresh.add(mesh.geometry);
            this.builds.meshes++;
        }
        return { type: feature.properties?.type as string, coordinates: coordinatesOf(feature), meshes };
    }

    render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
        const pitch = this.map.getPitch();
        if (!this.enabled || pitch <= 5 || !this.meshes.length || !this.map.getTerrain() || document.hidden) return;
        const now = performance.now();
        const terrain = this.map.terrain;
        const exaggeration = this.map.getTerrain()?.exaggeration ?? 1;
        const zoom = Math.min(this.map.transform.tileZoom, terrain.tileManager.maxzoom);
        this.model.makeTranslation(this.anchor.x, this.anchor.y, 0).scale(this.scale.set(this.units, -this.units, this.units * exaggeration));
        const queue = this.elevationQueue!;
        const changed = this.sampledTerrain !== terrain || this.sampledZoom !== zoom || this.sampledExaggeration !== exaggeration;
        if (changed || (this.heightsDirty && !queue.pending && now - this.lastSample > 500)) {
            // queryTerrainElevation recalculates visible tile coverage on EVERY call.
            // This bulk path uses the installed MapLibre terrain API at a fixed zoom;
            // it still falls back to loaded parent DEM tiles and includes exaggeration.
            const anchor = this.anchor, units = this.units;
            this.sampler = (x, y) => {
                const merc = new MercatorCoordinate(anchor.x + x * units, anchor.y - y * units);
                return terrain.getElevationForLngLatZoom(merc.toLngLat(), zoom) / Math.max(exaggeration, 0.001) + 0.12;
            };
            queue.start(this.sampler);
            this.sampledTerrain = terrain;
            this.sampledZoom = zoom;
            this.sampledExaggeration = exaggeration;
            this.lastSample = now;
            this.heightsDirty = false;
        }
        if (queue.pending) {
            const started = performance.now();
            const result = queue.step();
            this.stats.maxDrapeMs = Math.max(this.stats.maxDrapeMs, performance.now() - started);
            this.stats.samples += result.sampled;
            this.stats.verticesProcessed += result.processed;
            if (result.completed.length) {
                const completed = new Set(result.completed);
                for (const mesh of this.meshes) if (completed.has(mesh.geometry)) mesh.visible = true;
            }
        }
        this.stats.pending = queue.pending;
        this.camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(this.model);
        const eye = MercatorCoordinate.fromLngLat(this.map.transform.getCameraLngLat());
        this.eye.set((eye.x - this.anchor.x) / this.units, (this.anchor.y - eye.y) / this.units, this.map.transform.getCameraAltitude() / Math.max(exaggeration, 0.001));
        for (const material of this.materials) {
            material.uniforms.uEye.value.copy(this.eye);
            material.uniforms.uTime.value = this.reducedMotion.matches ? 0 : (now / 1000) % 4096;
            material.uniforms.uFade.value = Math.min(1, (pitch - 5) / 15);
        }
        this.renderer.resetState();
        this.renderer.render(this.scene, this.camera);
        this.renderer.resetState();
        this.frustum.setFromProjectionMatrix(this.camera.projectionMatrix);
        if (queue.pending) this.map.triggerRepaint();
        else if ((this.heightsDirty || (!this.reducedMotion.matches && this.meshes.some(mesh => mesh.visible && this.frustum.intersectsObject(mesh)))) && this.repaintTimer === null) {
            // A static camera needs at most 30 water frames per second. Map gestures
            // provide their own frames; never queue more than one animation repaint.
            this.repaintTimer = setTimeout(() => {
                this.repaintTimer = null;
                this.map.triggerRepaint();
            }, 1000 / 30);
        }
    }

    onRemove(): void {
        if (this.repaintTimer !== null) clearTimeout(this.repaintTimer);
        this.elevationQueue = null;
        this.map.off('sourcedata', this.terrainChanged);
        for (const mesh of this.meshes) mesh.geometry.dispose();
        for (const material of this.materials) material.dispose();
        this.scene.clear();
        this.renderer.dispose();
    }
}
