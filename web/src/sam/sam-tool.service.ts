// SAM click-to-feature assist (T45) — the `sam` EditorTool's headless
// service. Click inside a bunker/green on the ortho → a 512 px crop is
// composed from ortho tiles (never the MapLibre canvas), sent to the local
// SAM sidecar (tools/sam-server), and the returned mask contour comes back
// as an editable b-spline feature of the armed type:
//
//   click → planCrop (sam-crop.ts) → compose crop (tile fetch, seam below)
//   → SamClient./segment → largestPolygon → crop px → EPSG:3006
//   → rdpSimplifyClosed (SAM_SIMPLIFY_EPS_M) → fitClosedBspline (T40)
//   → FeaturesService.create → ONE create history entry (⌘Z in draw undoes).
//
// Health-gated: the panel shows sidecar state and clicks are ignored while
// it's offline (the sidecar is a developer-workstation tool — absence is a
// normal state, not an error). All I/O sits behind constructor seams
// (SamClient's fetch, the crop source) so the whole flow runs under bun test.

import { Signal, di } from '@basics/core/client/core';
import type { ToolContext } from '../editor/tool';
import type { MapPointerEvent } from '../map/map.service';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import { tileUrlTemplate } from '../map/map-style';
import { rdpSimplifyClosed, MIN_RING_POINTS } from '../draw/draw-state';
import { DrawToolService } from '../draw/draw-tool.service';
import { snapshotOf, type EditHistory } from '../draw/history';
import type { FeatureType } from '../draw/feature-palette';
import { fitClosedBspline } from '../geo/spline-fit';
import { SamClient, largestPolygon, SAM_CROP_SIZE } from './sam-client';
import { planCrop, cropPolygonToSweref, fillTileUrl, type CropPlan } from './sam-crop';

/** Interaction-claim id for the SAM tool (also its registry id). */
export const SAM_TOOL_ID = 'sam';

/** RDP epsilon (meters) applied to the mask contour before fitting. */
export const SAM_SIMPLIFY_EPS_M = 0.4;
/** B-spline fit tolerance (meters) — contours are raster-quantized, so a
 * touch tighter than the freehand trace's 0.75 (the source is steadier). */
export const SAM_FIT_TOLERANCE_M = 0.5;

/** Sidecar reachability, as shown by the panel. */
export type SamHealth = 'checking' | 'online' | 'offline';

/**
 * Composes a crop from ortho tiles → base64 JPEG (no data-URL prefix).
 * `tiles` carry resolved URLs + draw offsets; missing tiles (out-of-coverage
 * 404s are a normal edge state) are skipped, leaving background pixels.
 */
export type SamCropSource = (
    tiles: Array<{ url: string; dx: number; dy: number }>,
    size: number,
) => Promise<string>;

/** Browser crop source: fetch tiles, composite on an OffscreenCanvas. */
export const browserCropSource: SamCropSource = async (tiles, size) => {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    await Promise.all(tiles.map(async tile => {
        try {
            const res = await fetch(tile.url);
            if (!res.ok) return; // out-of-coverage tile — keep background
            const bitmap = await createImageBitmap(await res.blob());
            ctx.drawImage(bitmap, tile.dx, tile.dy);
            bitmap.close();
        } catch {
            // Network hiccup on one tile: segment what we have.
        }
    }));
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
};

/**
 * DI singleton behind the `sam` EditorTool (sam-tool.ts) and its panel
 * (sam-panel.component.ts). See the module header for the flow.
 */
export class SamToolService {
    /** Sidecar reachability (drives the panel's gate + hint). */
    readonly health = new Signal<SamHealth>('checking');
    /** Feature type the next segmentation creates (panel picker). */
    readonly armedType = new Signal<FeatureType>('bunker');
    /** True while a crop/segment/create round trip is in flight. */
    readonly busy = new Signal(false);
    /** One-line panel notice (why the last click produced nothing). */
    readonly notice = new Signal<string | null>(null);

    private ctx: ToolContext | null = null;

    constructor(
        private client: SamClient = new SamClient(),
        private cropSource: SamCropSource = browserCropSource,
        // The DRAW tool's history: SAM-created features join the same undo
        // stack, so ⌘Z in draw mode peels them like any other create.
        private historyOf: () => EditHistory = () => di.get(DrawToolService).history,
    ) {}

    // ── EditorTool lifecycle ────────────────────────────────────────────────

    activate(ctx: ToolContext): void {
        this.ctx = ctx;
        this.notice.set(null);
        void this.checkHealth();
        ctx.track(ctx.map.onClick(e => this.onClick(e)));
    }

    deactivate(): void {
        this.ctx = null;
        this.busy.set(false);
        this.notice.set(null);
    }

    /** Probe the sidecar's /health (activation + the panel's retry button). */
    async checkHealth(): Promise<void> {
        this.health.set('checking');
        const ok = await this.client.health();
        this.health.set(ok ? 'online' : 'offline');
    }

    // ── Click → feature ─────────────────────────────────────────────────────

    private onClick(e: MapPointerEvent): void {
        // Interaction contract (map/interaction.ts): bail unless we hold the claim.
        if (this.ctx?.map.interactionMode.peek() !== SAM_TOOL_ID) return;
        void this.segmentAt(e.lngLat);
    }

    /**
     * The full click pipeline. Public: it is the testable seam (the pointer
     * wiring needs a live MaplibreMap — same rationale as commitTrace/T40).
     * Returns the created feature, or undefined with `notice` explaining why.
     */
    async segmentAt(lngLat: { lng: number; lat: number }): Promise<CourseFeature | undefined> {
        const ctx = this.ctx;
        if (!ctx || this.busy.peek()) return undefined;
        if (this.health.peek() !== 'online') {
            this.notice.set('SAM sidecar is offline — start tools/sam-server and retry.');
            return undefined;
        }
        const manifest = ctx.tileset.manifest.peek();
        const mapKey = ctx.tileset.mapKey.peek();
        const version = ctx.tileset.tileVersion.peek();
        if (!manifest || !mapKey || !version) {
            this.notice.set('No ortho tiles for this course — build the map first.');
            return undefined;
        }
        const plan = planCrop(lngLat.lng, lngLat.lat, manifest.layers.ortho.maxzoom, SAM_CROP_SIZE);
        if (!plan) {
            this.notice.set('That click is outside the tiled area.');
            return undefined;
        }

        this.busy.set(true);
        this.notice.set(null);
        try {
            const template = tileUrlTemplate(mapKey, 'ortho', 'jpg', version);
            const crop = await this.cropSource(
                plan.tiles.map(t => ({ url: fillTileUrl(template, plan.zoom, t.x, t.y), dx: t.dx, dy: t.dy })),
                plan.size,
            );
            const response = await this.client.segmentPoint(crop);
            return await this.commitMask(ctx, plan, response.polygons);
        } catch {
            // Sidecar died mid-flight (or a request timed out): re-gate.
            this.notice.set('SAM sidecar request failed — check tools/sam-server.');
            void this.checkHealth();
            return undefined;
        } finally {
            this.busy.set(false);
        }
    }

    /**
     * Mask polygons (crop px) → EPSG:3006 → simplify → b-spline fit →
     * create + ONE history entry. Split out so tests can drive the pure
     * commit path with a canned mask.
     */
    private async commitMask(
        ctx: ToolContext,
        plan: CropPlan,
        polygons: number[][][],
    ): Promise<CourseFeature | undefined> {
        const mask = largestPolygon(polygons);
        if (!mask) {
            this.notice.set('SAM found no shape there — try clicking nearer its center.');
            return undefined;
        }
        const ring = cropPolygonToSweref(plan, mask);
        const simplified = rdpSimplifyClosed(ring, SAM_SIMPLIFY_EPS_M);
        const { controls } = fitClosedBspline(simplified, SAM_FIT_TOLERANCE_M);
        if (controls.length < MIN_RING_POINTS) {
            this.notice.set('The segmented shape was too small to keep.');
            return undefined;
        }
        const created = await ctx.features.create({
            type: this.armedType.peek(),
            holeId: null,
            geometry: {
                crs: 'EPSG:3006',
                curveType: 'bspline',
                rings: [{ points: controls.map(p => ({ x: p.x, y: p.y })) }],
            },
        });
        if (!created) {
            this.notice.set('Saving the feature failed — see the draw panel.');
            return undefined;
        }
        // create() already selected it; one diff so ⌘Z (draw mode) undoes it.
        this.historyOf().push([
            { featureId: created.id, before: null, after: snapshotOf(created), beforeVersion: null },
        ]);
        return created;
    }
}
