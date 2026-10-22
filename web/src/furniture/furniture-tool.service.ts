import { Signal, Computed, effect, untrack, di, Router } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import type { ToolContext } from '../editor/tool';
import { bindDrag, type DragBinding } from '../editor/drag-binding';
import { flatProjector } from '../editor/screen-point';
import { ownedOverlay } from '../editor/owned-overlay';
import type { MapPointerEvent } from '../map/map.service';
import { ConfirmService } from '../app/confirm-dialog.component';
import { CourseDetailService } from '../course-detail/course-detail.service';
import type { Hole } from '../../../shared/api/holes.gen';
import { FurnitureService, FURNITURE_TOOL_ID, finiteWgs84Point, greenPointFields, type GreenPoint, type Selection } from './furniture.service';
import {
    FURNITURE_DRAG_OVERLAY_ID,
    FURNITURE_OVERLAY_ID,
    buildFurnitureGeojson,
    furnitureDragLayers,
    furnitureLayers,
} from './furniture-overlay';
import { DrawToolService } from '../draw/draw-tool.service';
import { isRulesType, type FeatureType } from '../draw/feature-palette';
import type { AnalysisRenderer } from '../analysis/analysis-tool.service';
import { PinTerrain, holeGreenFeature, pinRingsGeojson } from './pin-terrain';
import { HazardLinesService, HAZARD_LINES_OVERLAY_ID, hazardLineLayers, type WaterLine } from './hazard-lines';
import { hazardLineGeometry } from '../geo/hazard-line-fit';
import { holeOfWaters, noAsItLiesOf, withNoAsItLies } from '../../../shared/features/no-as-it-lies';
import type { CourseFeature } from '../../../shared/api/course-features.gen';

/** The drawn lines that carry their own "no as it lies" (the OOB rings never do). */
const PENALTY_TYPES: ReadonlySet<string> = new Set(['penalty_red', 'penalty_yellow']);

/** Screen-px radius for click-to-select and mousedown-to-drag hit testing. */
const MARKER_HIT_PX = 14;
/**
 * Screen-px radius around an existing SAME-kind marker within which an armed
 * placement click is reinterpreted as a select (prevents accidental dupes).
 */
const PLACEMENT_PROXIMITY_PX = 16;
const DRAG_MOVE_THRESHOLD_PX = 2;

/**
 * A hit-tested marker. Tees/pins/aims are `{ kind, id }`; green points are
 * `{ kind: 'green', holeId, point }` since all three share one row per hole.
 */
type MarkerHit =
    | { kind: 'tee'; id: string }
    | { kind: 'pin'; id: string }
    | { kind: 'aim'; id: string }
    | { kind: 'green'; holeId: string; point: GreenPoint };

interface DragTarget {
    hit: MarkerHit;
    startScreen: { x: number; y: number };
    moved: boolean;
}

const EMPTY_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };
/** The rings round the hole's pins while pins are placed (pin-terrain.ts). */
const PIN_RINGS_OVERLAY_ID = `${FURNITURE_OVERLAY_ID}-pin-rings`;

/** True when `f` is the main-overlay feature that renders `hit`. */
function featureIsHit(f: Feature, hit: MarkerHit): boolean {
    const p = f.properties;
    if (!p) return false;
    if (hit.kind === 'green') return p.role === `green-${hit.point}` && p.holeId === hit.holeId;
    return p.role === hit.kind && p.id === hit.id;
}

/** A hit as a Selection (they share shape). */
function hitToSelection(hit: MarkerHit): Selection {
    return hit.kind === 'green'
        ? { kind: 'green', holeId: hit.holeId, point: hit.point }
        : { kind: hit.kind, id: hit.id };
}

/**
 * Tees / pins / aim-points placement interactions. Registered as the
 * `furniture` EditorTool (furniture-tool.ts); FurniturePanelComponent shares
 * this DI singleton for its UI.
 *
 * Modes (FurnitureService.placing):
 * - select (default): click near a marker selects it; drag a marker moves it
 *   (autosave, re-samples elevation); Delete removes the selection (confirm).
 * - placing 'tee'|'pin'|'aim' (panel buttons): click places the item on the
 *   SELECTED hole (?hole= query). Requires a hole selected; pins additionally
 *   require the hole to have a green.
 */
export class FurnitureToolService {
    private svc = di.get(FurnitureService);
    private router = di.get(Router);
    private courseDetail = di.get(CourseDetailService);
    private confirm = di.get(ConfirmService);
    /**
     * The draw engine in its `rules` scope: the penalty areas and OOB are
     * drawn and edited here, with Draw's own vertex editing and undo.
     */
    readonly rules = di.get(DrawToolService);
    /** The course file's hazard lines: the automatic water lines drawn dashed, one selectable at a time. */
    readonly lines = di.get(HazardLinesService);
    /**
     * The automatic line under this click, found before the rules engine had
     * the click (undefined: this click is not one for an automatic line); the
     * handler after it selects the line when neither a marker nor a drawn
     * line took the click.
     */
    private pendingLineHit: WaterLine | null | undefined = undefined;
    private ctx: ToolContext | null = null;
    private drag: DragTarget | null = null;
    /** Raw mousedown/up binding (editor/drag-binding.ts); null while inactive. */
    private dragBinding: DragBinding | null = null;
    /**
     * Pointer position of the marker under drag, or null. Only the drag
     * overlay reads it: the main overlay and the stores keep the pre-drag
     * data until mouseup, so a move re-sends one feature, not all of them.
     */
    private readonly dragPos = new Signal<{ lng: number; lat: number } | null>(null);
    /** Last collection sent to the main overlay; the drag overlay copies its marker from here. */
    private lastMain: FeatureCollection = EMPTY_COLLECTION;
    /** The green's slope or height, shaded while pins are placed. */
    readonly pinTerrain = new PinTerrain();

    /** ?hole= carries the hole NUMBER; resolve to the Hole for the selected course. */
    private readonly selectedHoleNumber = this.router.query('hole');
    readonly selectedHole = new Computed<Hole | null>(() => {
        const num = this.selectedHoleNumber.get();
        if (num === undefined) return null;
        return this.courseDetail.holes.get().find(h => String(h.number) === num) ?? null;
    });

    /** Whether the current placement mode is actionable (hole + green as needed). */
    readonly placementHint = new Computed<string | null>(() => {
        const kind = this.svc.placing.get();
        if (kind === null) return null;
        const hole = this.selectedHole.get();
        if (!hole) return 'Select a hole first (pick one from the hole list).';
        if (kind === 'pin' && !this.svc.greenForHole(hole.id)) {
            return `Hole ${hole.number} has no green yet — draw/import one before placing pins.`;
        }
        if (kind === 'tee') {
            const set = this.svc.pendingTeeSet();
            if (!set) return 'Add a tee set first (Tee sets, further down).';
            return `Placing: Tee (${set.name}) on hole ${hole.number} — click map to place; `
                + `pick another set or hole and click again, Esc to finish.`;
        }
        if (kind === 'green') {
            const gp = this.svc.pendingGreenPoint.get();
            const gpLabel = gp === 'center' ? 'Center' : gp === 'front' ? 'Front' : 'Back';
            const hasGreen = !!this.svc.greenForHole(hole.id);
            if (!hasGreen && gp !== 'center') {
                return `Hole ${hole.number} has no green yet — place the green Center first `
                    + `(then Front/Back).`;
            }
            const verb = hasGreen ? 'set' : 'create';
            return `Placing green ${gpLabel} on hole ${hole.number} — click to ${verb} `
                + `${gpLabel} position, Esc to cancel.`;
        }
        if (kind === 'pin') {
            const day = this.svc.pendingPinDay.get();
            const green = this.svc.greenForHole(hole.id)!;
            this.svc.pins.items.get();  // re-read once that day's pin exists
            return this.svc.pinForDay(green.id, day)
                ? `${day} pin on hole ${hole.number} — drag it, or click the map to move it there. Esc to finish.`
                : `Placing: ${day} pin on hole ${hole.number} — click map to place; `
                    + `click again for the next day, Esc to finish.`;
        }
        const label = 'Aim point';
        return `Placing: ${label} on hole ${hole.number} — click map to place, `
            + `Shift-click to place multiple, Esc to cancel.`;
    });

    // ── EditorTool lifecycle ────────────────────────────────────────────────

    /** Canvas mount: load furniture + always-on overlay. */
    attach(ctx: ToolContext): void {
        this.ctx = ctx;
        this.svc.useElevation(ctx.elevation); // wire live elevation auto-sampling
        const holeIds = this.holeIds();
        this.svc.setHoleIds(holeIds);
        // Holes may still be loading when attach runs — load once they arrive.
        ctx.track(effect(() => {
            const ids = this.courseDetail.holes.get().map(h => h.id);
            if (ids.length === 0) return;
            untrack(() => {
                this.svc.setHoleIds(ids);
                void this.svc.load(ctx.courseId, ids);
            });
        }));
        ctx.track(this.attachOverlay(ctx));
        ctx.track(ownedOverlay(ctx.map, FURNITURE_DRAG_OVERLAY_ID, () => this.dragGeojson(), furnitureDragLayers));
        // Hole framing is canvas-level now (editor/hole-framing.ts, attached
        // by EditorCanvasComponent behind EditorModeService.followHole).
    }

    /** `terrainRenderer` draws the green's slope/height under the pins being placed; none in tests. */
    activate(ctx: ToolContext, terrainRenderer?: AnalysisRenderer): void {
        this.ctx = ctx;

        // A ring round each pin of the hole while pins are placed; the pin
        // under drag carries its ring along.
        ctx.track(ownedOverlay(ctx.map, PIN_RINGS_OVERLAY_ID, () => {
            const hole = this.selectedHole.get();
            if (this.svc.placing.get() !== 'pin' || !hole) return EMPTY_COLLECTION;
            this.svc.pins.items.get();
            this.svc.greens.get();
            const dragged = this.drag?.hit.kind === 'pin' ? this.drag.hit.id : null;
            const at = this.dragPos.get();
            return pinRingsGeojson(this.svc.pinsForHole(hole.id).map(pin =>
                (at && pin.id === dragged ? { lat: at.lat, lon: at.lng } : pin)));
        }, () => [
            { id: `${PIN_RINGS_OVERLAY_ID}-casing`, type: 'line', paint: { 'line-color': '#14281c', 'line-width': 3, 'line-opacity': 0.6 } },
            { id: `${PIN_RINGS_OVERLAY_ID}-line`, type: 'line', paint: { 'line-color': '#ffffff', 'line-width': 1.4 } },
        ]));

        // While pins are placed the selected pin IS the picked day's: a day
        // button, a placement moving on to the next day, or another hole
        // moves the selection with it (none for a day not placed yet).
        ctx.track(effect(() => {
            if (this.svc.placing.get() !== 'pin') return;
            const hole = this.selectedHole.get();
            const day = this.svc.pendingPinDay.get();
            this.svc.pins.items.get();
            const green = hole ? this.svc.greens.get().find(g => g.holeId === hole.id) : undefined;
            const pin = green ? this.svc.pinForDay(green.id, day) : undefined;
            untrack(() => this.svc.selection.set(pin ? { kind: 'pin', id: pin.id } : null));
        }));

        if (terrainRenderer) {
            ctx.track(this.pinTerrain.attach(ctx, terrainRenderer, () => {
                if (this.svc.placing.get() !== 'pin') return null;
                const hole = this.selectedHole.get();
                if (!hole) return null;
                const green = this.svc.greens.get().find(g => g.holeId === hole.id);
                return holeGreenFeature(
                    ctx.features.stackTopDown.get(), hole.id,
                    green ? { lat: green.centerLat, lon: green.centerLon } : null,
                );
            }));
        }

        // Registered before the rules engine's, so these run first on every
        // event and can stand aside while it is drawing or dragging.
        ctx.track(ctx.map.onClick(e => this.onClick(e)));

        const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
        window.addEventListener('keydown', onKeyDown);
        ctx.track(() => window.removeEventListener('keydown', onKeyDown));

        // Raw handlers for marker drag (mousedown near marker → move → up).
        this.dragBinding = bindDrag(ctx, {
            toolId: FURNITURE_TOOL_ID,
            onDown: (e, map) => this.onMouseDown(e, map),
            onUp: () => this.onMouseUp(),
        });

        // Move handler for the in-progress drag.
        ctx.track(ctx.map.onMouseMove(e => this.onMouseMove(e)));

        // The rules lines: a click or press on a marker, or any while a
        // placement is armed, stays with the furniture.
        this.rules.activate(ctx, {
            scope: 'rules',
            toolId: FURNITURE_TOOL_ID,
            yieldTo: screen => this.svc.placing.peek() !== null || this.hitMarker(screen) !== null,
        });
        // After the rules engine: an automatic water line is picked only by
        // a click nothing else took.
        ctx.track(ctx.map.onClick(() => this.pickLineAfterRules()));

        // The automatic water lines (dashed); the drawn penalty lines are
        // the rules engine's features. Loaded on every activation: the
        // water, the terrain or the drawn lines may have changed since.
        ctx.track(ownedOverlay(ctx.map, HAZARD_LINES_OVERLAY_ID, () => this.lines.geojson.get(), hazardLineLayers));
        void this.lines.load(ctx.courseId);
        // A drawn penalty line made or removed here (drawn, Edit line, an
        // undo, Delete) changes which water keeps an automatic line.
        let penaltyIds: string | null = null;
        ctx.track(effect(() => {
            const ids = ctx.features.store.items.get().filter(f => PENALTY_TYPES.has(f.type)).map(f => f.id).sort().join(',');
            const before = penaltyIds;
            penaltyIds = ids;
            // Once the change has landed: a removal leaves the store before the server.
            if (before !== null && before !== ids) untrack(() => { void ctx.features.flush().then(() => this.lines.load(ctx.courseId)); });
        }));

        // One selection at a time — a marker, rules lines or an automatic
        // line — so Delete and Esc always mean the thing highlighted.
        ctx.track(effect(() => {
            if (ctx.features.selectedIds.get().size > 0) untrack(() => { this.svc.select(null); this.lines.select(null); });
        }));
        ctx.track(effect(() => {
            if (this.svc.selection.get()) untrack(() => { ctx.features.select(null); this.lines.select(null); });
        }));
        // Arming a placement ends a rules line in progress, and vice versa.
        ctx.track(effect(() => {
            if (this.svc.placing.get() !== null) untrack(() => this.rules.cancelDrawing());
        }));
        ctx.track(effect(() => {
            if (this.rules.state.isDrawing.get()) untrack(() => this.svc.disarm());
        }));
    }

    deactivate(): void {
        this.endDrag();
        this.svc.disarm();
        this.svc.select(null);
        this.lines.reset();
        this.pendingLineHit = undefined;
        this.dragBinding = null;
        this.rules.deactivate();
    }

    /** The rules type being drawn right now, or null. */
    readonly drawingRule = new Computed<FeatureType | null>(() =>
        this.rules.scope.get() === 'rules' && this.rules.state.isDrawing.get() ? this.rules.drawType.get() : null);

    /** Panel button: start a new penalty area / OOB line, or stop if that one is already armed. */
    armRule(type: FeatureType): void {
        if (!isRulesType(type)) return;
        if (this.drawingRule.peek() === type) {
            this.rules.cancelDrawing();
            return;
        }
        this.svc.disarm();
        this.svc.select(null);
        this.lines.select(null);
        this.rules.armRules(type);
    }

    /** ESC: cancel placement → the rules engine's own chain (line in progress, vertices, selection) → drop the automatic line or marker selection → (unconsumed) deactivate. */
    onEscape(): boolean {
        if (this.svc.placing.peek() !== null) {
            this.svc.disarm();
            this.svc.notice.set(null);
            return true;
        }
        if (this.rules.onEscape()) return true;
        if (this.lines.selectedKey.peek() !== null) {
            this.lines.select(null);
            return true;
        }
        if (this.svc.selection.peek()) {
            this.svc.select(null);
            return true;
        }
        return false;
    }

    // ── Overlay ─────────────────────────────────────────────────────────────

    private attachOverlay(ctx: ToolContext): () => void {
        return ownedOverlay(ctx.map, FURNITURE_OVERLAY_ID, () => {
            const holeIds = this.courseDetail.holes.get().map(h => h.id);
            // Resolve each hole's aim-line origin tee reactively. Reads
            // activeTeeName (+ per-hole tees) so a "line from" change or any
            // tee move/place/delete re-runs this effect and re-anchors the line.
            const lineOriginByHole = new Map<string, string>();
            for (const holeId of holeIds) {
                const origin = this.svc.lineOriginTee(holeId);
                if (origin) lineOriginByHole.set(holeId, origin.id);
            }
            const par3 = this.svc.teeSets.get().find(set => set.gsproTee === 'Par3')?.id;
            const tees = this.svc.tees.items.get();
            return this.lastMain = buildFurnitureGeojson({
                tees,
                pins: this.svc.pins.items.get(),
                greens: this.svc.greens.get(),
                aims: this.svc.aims.items.get(),
                holeIds,
                selection: this.svc.selection.get(),
                highlightHoleId: this.selectedHole.get()?.id ?? null,
                lineOriginByHole,
                straightTeeIds: new Set(par3 ? tees.filter(t => t.teeSetId === par3).map(t => t.id) : []),
            });
        }, furnitureLayers);
    }

    /**
     * The drag overlay's data: the dragged marker's main-overlay feature
     * (same properties, so the same style and selection ring) at the
     * pointer. Empty when no drag is moving. The aim line is not redrawn
     * during the drag; it follows on mouseup with the main rebuild.
     */
    private dragGeojson(): FeatureCollection {
        const pos = this.dragPos.get();
        const hit = this.drag?.hit;
        if (!pos || !hit) return EMPTY_COLLECTION;
        const source = this.lastMain.features.find(f => featureIsHit(f, hit));
        if (!source) return EMPTY_COLLECTION;
        return {
            type: 'FeatureCollection',
            features: [{ ...source, geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] } }],
        };
    }

    // ── Event handling ──────────────────────────────────────────────────────

    private isMyClaim(): boolean {
        return this.ctx?.map.interactionMode.peek() === FURNITURE_TOOL_ID;
    }

    private onClick(e: MapPointerEvent): void {
        this.pendingLineHit = undefined;
        if (!this.isMyClaim()) return;
        if (this.dragBinding?.clickSuppressed || this.rules.isEngaged()) return;

        const kind = this.svc.placing.peek();
        if (kind !== null) {
            // Proximity guard: an armed click landing on an existing marker of
            // the SAME kind selects it instead of stacking a duplicate. For
            // greens, the same-kind guard is narrowed to the SAME point (C/F/B)
            // so e.g. arming Back near an existing Back selects it.
            const near = this.hitMarker(e.point, PLACEMENT_PROXIMITY_PX);
            if (near && near.kind === kind &&
                (kind !== 'green' || (near.kind === 'green' && near.point === this.svc.pendingGreenPoint.peek()))) {
                this.pick(near);
                return;
            }
            const keepArmed = e.originalEvent.shiftKey;
            void this.place(kind, e.lngLat, keepArmed);
            return;
        }

        // Select mode: pick the nearest marker within tolerance; else the
        // automatic line there, unless the rules engine takes the click.
        const hit = this.hitMarker(e.point);
        if (hit) this.pick(hit);
        else {
            this.svc.select(null);
            const map = this.ctx?.map.map.peek();
            this.pendingLineHit = map ? this.lines.hit(e.point, flatProjector(map)) : null;
        }
    }

    /**
     * The second half of a select-mode click, after the rules engine had it:
     * the automatic line found under it is selected when no marker and no
     * drawn line took the click; a click on nothing clears it.
     */
    private pickLineAfterRules(): void {
        const hit = this.pendingLineHit;
        this.pendingLineHit = undefined;
        if (hit === undefined || !this.ctx) return;
        if (this.svc.selection.peek() || this.ctx.features.selectedIds.peek().size > 0 || this.rules.state.isDrawing.peek()) return;
        this.lines.select(hit?.key ?? null);
    }

    // ── Hazard lines ─────────────────────────────────────────────────────────

    /**
     * Play as it lies (true = GSPro's noAIL off) for the selected line: an
     * automatic line's waters, every one of them (the pipeline sets noAIL on
     * a line when any of its waters asks), or the selected drawn penalty
     * lines' own attributes. Through the rules engine, so it is undoable and
     * saved like any edit; the lines are read again once it has landed.
     */
    async setPlayAsItLies(playAsItLies: boolean): Promise<void> {
        const ctx = this.ctx;
        if (!ctx) return;
        const auto = this.lines.selected.peek();
        const targets: CourseFeature[] = auto
            ? ctx.features.store.items.peek().filter(f => auto.line.waterIds!.includes(f.id))
            : ctx.features.selectedFeatures.peek().filter(f => PENALTY_TYPES.has(f.type));
        const changes = targets
            .filter(f => noAsItLiesOf(f.attributes) === playAsItLies)
            .map(f => ({ id: f.id, attributes: withNoAsItLies(f.attributes, !playAsItLies) }));
        if (changes.length === 0) return;
        this.lines.working.set(true);
        try {
            this.rules.commitAttributesMany(changes);
            await ctx.features.flush();
            await this.lines.load(ctx.courseId);
        } finally {
            this.lines.working.set(false);
        }
    }

    /**
     * Edit line: the selected automatic line becomes a drawn red penalty
     * line — fitted as a smooth spline (geo/hazard-line-fit.ts), on the
     * waters' hole when they share one, keeping its noAIL — created through
     * the rules engine (so it is in the rules undo history) and selected for
     * vertex editing. The water it holds then gets no automatic line: the
     * lines are read again (the new penalty line's id does that).
     */
    async editAutoLine(): Promise<CourseFeature | undefined> {
        const ctx = this.ctx;
        const auto = this.lines.selected.peek();
        if (!ctx || !auto || this.lines.working.peek()) return undefined;
        let geometry: ReturnType<typeof hazardLineGeometry>;
        try {
            geometry = hazardLineGeometry(auto.line.points);
        } catch (e) {
            this.svc.notice.set(`Edit line: ${(e as Error).message}`);
            return undefined;
        }
        const waters = ctx.features.store.items.peek().filter(f => auto.line.waterIds!.includes(f.id));
        this.lines.working.set(true);
        try {
            this.lines.select(null);
            return await this.rules.commitCreate({
                type: 'penalty_red',
                holeId: holeOfWaters(waters),
                geometry,
                attributes: auto.line.noAsItLies ? withNoAsItLies(null, true) : null,
            });
        } finally {
            this.lines.working.set(false);
        }
    }

    /**
     * Select the marker under the pointer. A pin goes to the Pin panel
     * (placement armed on its day, `focusPin`); any other marker is selected
     * and, when nothing is armed, stays so — `select` would disarm.
     */
    private pick(hit: MarkerHit): void {
        if (hit.kind === 'pin') this.svc.focusPin(hit.id);
        else if (this.svc.placing.peek() === null) this.svc.select(hitToSelection(hit));
        else this.svc.selection.set(hitToSelection(hit));
    }

    private onMouseMove(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;
        const drag = this.drag;
        if (!drag) return;
        if (!drag.moved && this.pxDist(drag.startScreen, e.point) < DRAG_MOVE_THRESHOLD_PX) return;
        drag.moved = true;
        // Feedback through the drag overlay only. The stores and the main
        // overlay change once, on mouseup.
        this.dragPos.set({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    }

    /**
     * Left press under the furniture claim. Cmd/Ctrl-drag pans even from a
     * marker: the drag binding filters that press before it gets here.
     *
     * A press on a marker grabs it whatever is armed in the panel: any
     * placed marker moves at any time, and a placement stays armed through
     * it (the click MapLibre makes of the release is swallowed in mouseup,
     * so grabbing a marker never places a new one on top of it).
     */
    private onMouseDown(e: MapMouseEvent, map: MaplibreMap): void {
        if (this.rules.isEngaged()) return;

        const hit = this.hitMarker(e.point);
        if (!hit) return;
        this.dragBinding?.claim(e, map);
        this.pick(hit);
        this.drag = {
            hit,
            startScreen: { x: e.point.x, y: e.point.y },
            moved: false,
        };
    }

    private onMouseUp(): void {
        const drag = this.drag;
        if (!drag) return;
        const pos = this.dragPos.peek();

        // Swallow the click MapLibre synthesizes right after this mouseup.
        this.dragBinding?.suppressNextClick();

        if (drag.moved && pos) {
            // The stores take the dropped position before the drag overlay
            // clears, so the main overlay's one rebuild is queued first.
            // moveTee/movePin/moveAim patch the store synchronously before
            // their first await; setGreenPoint awaits elevation first, so
            // the green patch happens here.
            const { lat, lng: lon } = pos;
            const hit = drag.hit;
            if (hit.kind === 'tee') void this.svc.moveTee(hit.id, lat, lon);
            else if (hit.kind === 'pin') void this.svc.movePin(hit.id, lat, lon);
            else if (hit.kind === 'aim') void this.svc.moveAim(hit.id, lat, lon);
            else {
                this.patchGreenLocal(hit.holeId, hit.point, lat, lon);
                void this.svc.setGreenPoint(hit.holeId, hit.point, lat, lon);
            }
        }
        this.endDrag();
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (!this.isMyClaim()) return;
        const target = e.target as HTMLElement | null;
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLSelectElement ||
            target instanceof HTMLTextAreaElement
        ) return;

        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this.svc.selection.peek()) {
                e.preventDefault();
                void this.deleteSelected();
            }
        }
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    /**
     * Place the armed item at a WGS84 position on the selected hole.
     *
     * One-shot by default: after a successful placement we DISARM (back to
     * select/move). Hold Shift (`keepArmed`) to stay armed for rapid
     * multi-placement. Tees always stay armed, with the picked tee set kept:
     * a set is placed hole after hole (or set after set on one hole), and
     * closing the set picker after every click made that a reopen each time.
     * Pins stay armed too, moved on to the next day the green has no pin for.
     */
    private async place(
        kind: 'tee' | 'pin' | 'aim' | 'green',
        lngLat: { lng: number; lat: number },
        keepArmed: boolean,
    ): Promise<void> {
        const hole = this.selectedHole.peek();
        if (!hole) return; // panel shows the hint

        let created: unknown;
        if (kind === 'green') {
            const gp = this.svc.pendingGreenPoint.peek();
            // Placing an existing point = moving it (correct semantics). Creates
            // the row on first Center placement; F/B on a green-less hole is
            // rejected inside setGreenPoint with a notice.
            created = await this.svc.setGreenPoint(hole.id, gp, lngLat.lat, lngLat.lng);
        } else if (kind === 'tee') {
            const set = this.svc.pendingTeeSet();
            if (!set) return; // hint covers this
            // Client-side duplicate guard: the server enforces UNIQUE(hole, name)
            // and would only surface a raw 500. Catch it here, tell the user, and
            // auto-advance to the next tee set the hole has no tee of.
            if (this.svc.teeNameTaken(hole.id, set.name)) {
                this.svc.notice.set(
                    `A '${set.name}' tee already exists on hole ${hole.number}.`
                    + (this.svc.advancePendingTee(hole.id)
                        ? ` Switched to '${this.svc.pendingTeeSet()?.name}'.`
                        : ' The hole has a tee of every tee set.'),
                );
                return; // stay armed so the next click places the advanced set
            }
            created = await this.svc.createTee({
                holeId: hole.id,
                teeSetId: set.id,
                lat: lngLat.lat,
                lon: lngLat.lng,
            });
        } else if (kind === 'pin') {
            const green = this.svc.greenForHole(hole.id);
            if (!green) return; // hint covers this
            // A green has one pin per day: placing a day it already has moves that pin.
            const day = this.svc.pendingPinDay.peek();
            const existing = this.svc.pinForDay(green.id, day);
            if (existing) {
                // The picked day's pin stays picked: click again to move it again.
                created = await this.svc.movePin(existing.id, lngLat.lat, lngLat.lng);
            } else {
                created = await this.svc.createPin({
                    greenId: green.id,
                    name: day,
                    difficulty: this.svc.pendingPinDifficulty.peek(),
                    lat: lngLat.lat,
                    lon: lngLat.lng,
                });
                // On to the next day the green has no pin for (the last one placed stays picked).
                if (created) this.svc.advancePendingPinDay(green.id);
            }
        } else {
            const n = this.svc.aimsForHole(hole.id).length + 1;
            created = await this.svc.createAim({ holeId: hole.id, lat: lngLat.lat, lon: lngLat.lng, label: `A${n}` });
        }

        // One-shot: disarm on success unless Shift is held (rapid multi-place) or it was a tee or a pin.
        if (created && !keepArmed && kind !== 'tee' && kind !== 'pin') this.svc.disarm();
    }

    /** Arm pin placement on the first day the selected hole's green has no pin for. */
    armPin(): void {
        this.svc.arm('pin');
        const hole = this.selectedHole.peek();
        const green = hole && this.svc.greenForHole(hole.id);
        if (green && this.svc.placing.peek() === 'pin') this.svc.advancePendingPinDay(green.id);
    }

    /** Delete the selected item after confirmation (Delete key or panel button). */
    async deleteSelected(): Promise<void> {
        const sel = this.svc.selection.peek();
        if (!sel) return;
        if (sel.kind === 'green') {
            // Green points are structural (part of the hole's green row) — no delete.
            this.svc.notice.set('Green points can\'t be deleted (they\'re part of the hole\'s green). Move it instead.');
            return;
        }
        const label = sel.kind === 'tee' ? 'tee' : sel.kind === 'pin' ? 'pin' : 'aim point';
        const ok = await this.confirm.confirm({
            title: `Delete ${label}?`,
            body: `This ${label} will be removed from the course.`,
            confirmLabel: `Delete ${label}`,
            tone: 'danger',
            layout: 'default',
        });
        if (!ok) return;
        if (sel.kind === 'tee') await this.svc.removeTee(sel.id);
        else if (sel.kind === 'pin') await this.svc.removePin(sel.id);
        else await this.svc.removeAim(sel.id);
    }

    /** Append a hole, select it, and leave the user in furniture mode ready to place markers. */
    async addHole(): Promise<void> {
        const courseId = this.ctx?.courseId ?? this.router.params<{ courseId: string }>('/course/:courseId').peek().courseId;
        if (!courseId) return;
        const created = await this.courseDetail.addHole(4);
        if (!created) return;
        this.router.navigate(`/course/${courseId}`, { query: { hole: String(created.number) } });
        const holeIds = this.courseDetail.holes.peek().map(h => h.id);
        this.svc.setHoleIds(holeIds);
        await this.svc.reload(holeIds);
        this.svc.disarm();
        this.svc.arm('tee');
    }

    /** Delete the selected hole and select the next sensible hole after server-side renumbering. */
    async deleteSelectedHole(): Promise<void> {
        const hole = this.selectedHole.peek();
        const courseId = this.ctx?.courseId ?? hole?.courseId;
        if (!hole || !courseId) return;

        const ok = await this.confirm.confirm({
            title: `Delete hole ${hole.number}?`,
            body: 'This removes the hole and its tees, green, pins, aim points, hazards, and hole-specific drawings.',
            detail: 'Later holes will be renumbered so the course list stays continuous.',
            confirmLabel: `Delete hole ${hole.number}`,
            cancelLabel: 'Keep hole',
            tone: 'danger',
            layout: 'review',
        });
        if (!ok) return;

        const removedNumber = hole.number;
        const removed = await this.courseDetail.removeHole(hole.id);
        const holes = this.courseDetail.holes.peek();
        const holeIds = holes.map(h => h.id);
        this.svc.setHoleIds(holeIds);
        await this.svc.reload(holeIds);
        this.svc.select(null);
        this.svc.disarm();
        if (!removed) return;

        const next = holes.find(h => h.number === removedNumber) ?? holes.at(-1) ?? null;
        if (next) {
            this.router.navigate(`/course/${courseId}`, { query: { hole: String(next.number) } });
        } else {
            this.router.navigate(`/course/${courseId}`);
        }
    }

    // ── Hit testing ───────────────────────────────────────────────────────────

    /** Nearest tee/pin/aim/green marker within `radiusPx` of the screen point. */
    private hitMarker(
        screen: { x: number; y: number },
        radiusPx: number = MARKER_HIT_PX,
    ): MarkerHit | null {
        const map = this.ctx?.map.map.peek();
        if (!map) return null;
        let best: MarkerHit | null = null;
        let bestDist = radiusPx;
        const project = flatProjector(map);
        const consider = (hit: MarkerHit, lat: number, lon: number) => {
            const pos = finiteWgs84Point(lat, lon);
            if (!pos) return;
            const p = project(pos.lon, pos.lat);
            const d = Math.hypot(p.x - screen.x, p.y - screen.y);
            if (d < bestDist) { bestDist = d; best = hit; }
        };
        for (const t of this.svc.tees.items.peek()) consider({ kind: 'tee', id: t.id }, t.lat, t.lon);
        for (const p of this.svc.pins.items.peek()) consider({ kind: 'pin', id: p.id }, p.lat, p.lon);
        for (const a of this.svc.aims.items.peek()) consider({ kind: 'aim', id: a.id }, a.lat, a.lon);
        for (const g of this.svc.greens.peek()) {
            for (const point of ['center', 'front', 'back'] as const) {
                const pos = this.svc.greenPointPos(g, point);
                if (pos) consider({ kind: 'green', holeId: g.holeId, point }, pos.lat, pos.lon);
            }
        }
        return best;
    }

    /** Local green-point patch for the drop (setGreenPoint persists it). */
    private patchGreenLocal(holeId: string, point: GreenPoint, lat: number, lon: number): void {
        const fields = greenPointFields(point, lat, lon);
        this.svc.greens.set(this.svc.greens.peek().map(x => x.holeId === holeId ? { ...x, ...fields } : x));
    }

    /** Ends a drag. A drag cut short (deactivate) drops its unsaved position. */
    private endDrag(): void {
        if (!this.drag) return;
        this.drag = null;
        this.dragPos.set(null);
        this.dragBinding?.release();
    }

    private pxDist(a: { x: number; y: number }, b: { x: number; y: number }): number {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    private holeIds(): string[] {
        return this.courseDetail.holes.peek().map(h => h.id);
    }
}
