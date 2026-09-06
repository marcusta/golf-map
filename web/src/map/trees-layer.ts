import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as LibreMap } from 'maplibre-gl';
import { Camera, Matrix4, Vector3, WebGLRenderer } from 'three';
import { adjustStand } from './tree-geometry';
import { describeStem, TreeRenderer, treeStats, type RenderStem, type TreeRendererOptions } from './tree-renderer';
import type { TreeStem } from '../../../shared/strategy/tree-stems';
import { sweref99tmToLngLat } from '../geo/transform';

export { TREE_DRAW_DISTANCE_M, TREE_TEXTURE_FILES } from './tree-renderer';

export const TREES_LAYER_ID = 'individual-trees';
/** Kept for callers; the full-card distance now lives in tree-geometry (LOD_FULL_M). */
export const TREE_DETAIL_DISTANCE_M = 150;

export type TreesLayerOptions = Pick<TreeRendererOptions, 'lodFullM' | 'lodHalfM'>;

/**
 * Individual trees as a MapLibre custom layer sharing the map's WebGL context.
 * Coordinates stay near the course (local metres from an anchor) to retain float precision.
 * The three.js work (geometry, materials, LOD buckets, impostor bake) is TreeRenderer,
 * shared with the vegetation test scene; this class maps MapLibre's camera into it.
 *
 * Draw calls per frame: one per species (broadleaf, spruce, pine; all four variants
 * and both card levels live in one buffer and are selected in the vertex shader),
 * one impostor pass for trees beyond LOD_HALF_M, one ground-shadow pass, one shrub pass.
 */
export class TreesLayer implements CustomLayerInterface {
    readonly id = TREES_LAYER_ID;
    readonly type = 'custom' as const;
    readonly renderingMode = '3d' as const;
    enabled = false;
    exaggeration = 1;
    /** Wind sway; when on and trees are visible the layer requests continuous repaints. */
    sway = false;
    readonly stats = treeStats();
    private readonly previousProjection = new Matrix4();
    private lastFrameAt = 0;
    private lastStatsAt = 0;
    private previouslyMoving = false;
    private readonly frameIntervals: number[] = [];
    private map!: LibreMap;
    private renderer!: WebGLRenderer;
    private core: TreeRenderer | null = null;
    private readonly camera = new Camera();
    private readonly model = new Matrix4();
    private readonly scale = new Vector3();
    private readonly eye = new Vector3();
    private readonly trees: RenderStem[];
    private readonly anchor: MercatorCoordinate;
    private readonly units: number;

    constructor(stems: readonly TreeStem[], private readonly options: TreesLayerOptions = {}) {
        this.anchor = MercatorCoordinate.fromLngLat(stems.length ? sweref99tmToLngLat(stems[0].x, stems[0].y) : { lng: 0, lat: 0 });
        this.units = this.anchor.meterInMercatorCoordinateUnits();
        this.trees = stems.map(tree => {
            const merc = MercatorCoordinate.fromLngLat(sweref99tmToLngLat(tree.x, tree.y));
            // Asset schema v2 carries `kind` (0 broadleaf, 1 conifer, 2 unknown); v1 has none.
            const kind = (tree as TreeStem & { kind?: number }).kind ?? 2;
            return describeStem({
                x: (merc.x - this.anchor.x) / this.units, y: (this.anchor.y - merc.y) / this.units,
                ground: tree.groundM, heightM: tree.heightM, crownRadiusM: tree.crownRadiusM, kind, hashX: tree.x, hashY: tree.y,
            });
        });
        // Layer metres are a uniform scale of EPSG:3006 metres at this latitude, close enough for neighbour distances.
        adjustStand(this.trees);
        this.stats.total = stems.length;
        this.stats.shrubs = this.trees.filter(tree => tree.shrub).length;
    }

    onAdd(map: LibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
        this.map = map;
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        this.stats.gpu = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
        this.renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext });
        this.renderer.autoClear = false;
        this.core = new TreeRenderer(this.renderer, this.trees, this.stats, { ...this.options, onTextureLoaded: () => this.map?.triggerRepaint() });
    }

    render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
        const core = this.core!;
        if (!this.enabled) {
            this.stats.visible = 0; this.stats.visibleShrubs = 0; this.stats.detailed = 0; this.stats.half = 0; this.stats.impostors = 0;
            this.stats.triangles = 0; this.stats.drawCalls = 0;
            this.previouslyMoving = false;
            return;
        }
        const started = performance.now();
        this.model.makeTranslation(this.anchor.x, this.anchor.y, 0).scale(this.scale.set(this.units, -this.units, this.units * this.exaggeration));
        this.camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(this.model);
        const moving = !this.camera.projectionMatrix.equals(this.previousProjection);
        const interval = started - this.lastFrameAt;
        // Consecutive changed-camera render calls measure delivered moving frames.
        // Skip the first frame after a pause; retain the result when the user stops.
        if (moving && this.previouslyMoving && interval > 0 && interval < 3000) {
            this.frameIntervals.push(interval);
            if (this.frameIntervals.length > 120) this.frameIntervals.shift();
            const sorted = [...this.frameIntervals].sort((a, b) => a - b);
            this.stats.movingSamples = sorted.length;
            this.stats.frameMedianMs = sorted[Math.floor(sorted.length / 2)];
            this.stats.frameP95Ms = sorted[Math.floor(sorted.length * 0.95)];
            this.stats.medianFps = 1000 / this.stats.frameMedianMs;
        }
        this.previouslyMoving = moving;
        this.previousProjection.copy(this.camera.projectionMatrix);
        this.lastFrameAt = started;
        const eye = MercatorCoordinate.fromLngLat(this.map.transform.getCameraLngLat());
        this.eye.set((eye.x - this.anchor.x) / this.units, (this.anchor.y - eye.y) / this.units, this.map.transform.getCameraAltitude() / this.exaggeration);
        core.sway = this.sway;
        core.update(this.camera.projectionMatrix, this.eye);
        core.draw(this.camera);
        this.stats.cpuMs = performance.now() - started;
        if (import.meta.env.DEV && started - this.lastStatsAt > 1000) {
            this.map.getCanvas().dataset.treeStats = JSON.stringify(this.stats);
            this.lastStatsAt = started;
        }
        // Map movement supplies animation frames; sway needs its own when trees are on screen.
        if (core.swaying) this.map.triggerRepaint();
    }

    onRemove(): void {
        if (import.meta.env.DEV) delete this.map.getCanvas().dataset.treeStats;
        this.core?.dispose();
        this.core = null;
        this.renderer?.dispose();
    }
}
