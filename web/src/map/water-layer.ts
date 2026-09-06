import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as LibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { Camera, Frustum, Matrix4, Mesh, Scene, Vector2, Vector3, WebGLRenderer, type BufferGeometry, type ShaderMaterial } from 'three';
import { waterGeometry } from './water-geometry';
import { waterMaterial } from './water-material';
import { WaterElevationQueue } from './water-elevation-queue';

export const WATER_LAYER_ID = 'course-water-3d';

/** Water follows the loaded DEM and shares the map depth buffer with terrain and trees. */
export class WaterLayer implements CustomLayerInterface {
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
    private dataKey = '';
    private readonly materials = [waterMaterial(), waterMaterial(true)];
    private meshes: Mesh<BufferGeometry, ShaderMaterial>[] = [];
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

    setData(data: FeatureCollection): void {
        const waters = data.features.filter(f => f.properties?.type === 'water' || f.properties?.type === 'water_creek');
        const key = JSON.stringify(waters.map(f => [f.properties?.type, f.geometry]));
        if (key === this.dataKey) return;
        this.dataKey = key;
        for (const mesh of this.meshes) { this.scene.remove(mesh); mesh.geometry.dispose(); }
        this.meshes = [];
        let anchored = false;
        for (const feature of waters) {
            const polygons = feature.geometry?.type === 'Polygon' ? [feature.geometry.coordinates]
                : feature.geometry?.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
            for (const polygon of polygons) {
                if (!polygon[0]?.length) continue;
                if (!anchored) {
                    this.anchor = MercatorCoordinate.fromLngLat(polygon[0][0] as [number, number]);
                    this.units = this.anchor.meterInMercatorCoordinateUnits();
                    anchored = true;
                }
                const rings = polygon.map(ring => ring.map(p => {
                    const merc = MercatorCoordinate.fromLngLat(p as [number, number]);
                    return new Vector2((merc.x - this.anchor.x) / this.units, (this.anchor.y - merc.y) / this.units);
                }));
                const mesh = new Mesh(waterGeometry(rings), this.materials[feature.properties?.type === 'water_creek' ? 1 : 0]);
                // Bounds are recomputed after terrain samples arrive.
                mesh.visible = false;
                this.scene.add(mesh);
                this.meshes.push(mesh);
            }
        }
        this.elevationQueue = new WaterElevationQueue(this.meshes.map(mesh => mesh.geometry));
        this.sampledTerrain = null;
        this.heightsDirty = true;
        this.lastSample = -Infinity;
        Object.assign(this.stats, { maxDrapeMs: 0, samples: 0, verticesProcessed: 0, pending: false });
        this.map.triggerRepaint();
    }

    render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
        const pitch = this.map.getPitch();
        if (pitch <= 5 || !this.meshes.length || !this.map.getTerrain() || document.hidden) return;
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
            queue.start((x, y) => {
                const merc = new MercatorCoordinate(this.anchor.x + x * this.units, this.anchor.y - y * this.units);
                return terrain.getElevationForLngLatZoom(merc.toLngLat(), zoom) / Math.max(exaggeration, 0.001) + 0.12;
            });
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
