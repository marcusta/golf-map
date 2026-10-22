// SAM click-to-feature assist (T45) — the `sam` EditorTool's headless
// service. Click inside a bunker/green on the ortho → a 512 px crop is
// composed from ortho tiles (never the MapLibre canvas), sent to the local
// SAM sidecar (tools/sam-server), and the returned mask contour comes back
// as an editable b-spline feature of the armed type:
//
//   click → planCrop (sam-crop.ts) → compose crop (tile fetch, seam below)
//   → SamClient./segment → largestPolygon → crop px → EPSG:3006
//   → rdpSimplifyClosed (SAM_SIMPLIFY_EPS_M) → fitClosedBspline (T40, with
//     a perimeter-scaled control floor and curvature-weighted spacing)
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
import { DrawToolService } from '../draw/draw-tool.service';
import { snapshotOf, type EditHistory } from '../draw/history';
import type { FeatureType } from '../draw/feature-palette';
import {
    OUTLINE_CURVATURE_SHARE, OUTLINE_FIT_TOLERANCE_M, OUTLINE_MAX_CONTROLS, OUTLINE_METERS_PER_CONTROL,
    OUTLINE_SIMPLIFY_EPS_M, outlineMinControls, outlineToBspline, ringPerimeter,
} from '../geo/outline-fit';
import { SamClient, largestPolygon, SAM_CROP_SIZE } from './sam-client';
import { planCrop, cropPolygonToSweref, type CropPlan } from './sam-crop';
import { composeCropCanvas, canvasToBase64, cropTiles, type CropTile } from '../imaging/crop-source';
import { SidecarHealth, type SidecarStatus } from '../imaging/sidecar-health';

/** Interaction-claim id for the SAM tool (also its registry id). */
export const SAM_TOOL_ID = 'sam';

// The mask contour's fit is the shared outline fit (geo/outline-fit.ts); its values under the SAM names.
export const SAM_SIMPLIFY_EPS_M = OUTLINE_SIMPLIFY_EPS_M;
export const SAM_FIT_TOLERANCE_M = OUTLINE_FIT_TOLERANCE_M;
export const SAM_METERS_PER_CONTROL = OUTLINE_METERS_PER_CONTROL;
export const SAM_MAX_CONTROLS = OUTLINE_MAX_CONTROLS;
export const SAM_CURVATURE_SHARE = OUTLINE_CURVATURE_SHARE;
export { ringPerimeter };
export const samMinControls = outlineMinControls;

/** Sidecar reachability, as shown by the panel. */
export type SamHealth = SidecarStatus;

/** `holeScope` sentinel: created features follow the draw target hole. */
export const SAM_SCOPE_FOLLOW = 'follow';
/** `holeScope` sentinel: created features go to course level (holeId null). */
export const SAM_SCOPE_COURSE = 'course';

/**
 * Composes a crop from ortho tiles → base64 JPEG (no data-URL prefix).
 * `tiles` carry resolved URLs + draw offsets; missing tiles (out-of-coverage
 * 404s are a normal edge state) are skipped, leaving background pixels.
 */
export type SamCropSource = (tiles: CropTile[], size: number) => Promise<string>;

/** Browser crop source: composite (imaging/crop-source.ts), JPEG at 0.9. */
export const browserCropSource: SamCropSource = async (tiles, size) =>
    canvasToBase64(await composeCropCanvas(tiles, size), 'image/jpeg', 0.9);

/**
 * DI singleton behind the `sam` EditorTool (sam-tool.ts) and its panel
 * (sam-panel.component.ts). See the module header for the flow.
 */
export class SamToolService {
    /** Sidecar /health probe (imaging/sidecar-health.ts). */
    readonly sidecar = new SidecarHealth(async () => ({ online: await this.client.health() }));
    /** Sidecar reachability (drives the panel's gate + hint). */
    readonly health: Signal<SamHealth> = this.sidecar.status;
    /** Feature type the next segmentation creates (panel picker). */
    readonly armedType = new Signal<FeatureType>('bunker');
    /**
     * Hole scope for created features (panel picker): SAM_SCOPE_FOLLOW
     * (default — track the draw target / sidebar hole), SAM_SCOPE_COURSE
     * (course level), or an explicit hole id.
     */
    readonly holeScope = new Signal<string>(SAM_SCOPE_FOLLOW);
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
        // The DRAW tool's target hole — what SAM_SCOPE_FOLLOW resolves to
        // (the command bar keeps it synced to the sidebar's selected hole).
        private followHoleId: () => string | null = () => di.get(DrawToolService).drawHoleId.peek(),
    ) {}

    /** The holeId the next created feature gets, per the armed scope. */
    private resolveHoleId(): string | null {
        const scope = this.holeScope.peek();
        if (scope === SAM_SCOPE_COURSE) return null;
        if (scope === SAM_SCOPE_FOLLOW) return this.followHoleId();
        return scope;
    }

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
    checkHealth(): Promise<void> {
        return this.sidecar.check();
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
            const crop = await this.cropSource(cropTiles(plan, template), plan.size);
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
        const geometry = outlineToBspline(cropPolygonToSweref(plan, mask));
        if (!geometry) {
            this.notice.set('The segmented shape was too small to keep.');
            return undefined;
        }
        const created = await ctx.features.create({
            type: this.armedType.peek(),
            holeId: this.resolveHoleId(),
            geometry,
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
