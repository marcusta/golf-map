import { Signal, Computed, effect, untrack, di, Router } from '@basics/core/client/core';
import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { Hole } from '../../../shared/api/holes.gen';
import type { Tee } from '../../../shared/api/tees.gen';
import type { Club } from '../../../shared/api/clubs.gen';
import type { PlanGate, PlanShot } from '../../../shared/api/game-plans.gen';
import { bearingToUnitVector } from '../../../shared/strategy';
import { MapService, type MapPointerEvent } from '../map/map.service';
import { ElevationService } from '../map/elevation.service';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FurnitureService } from '../furniture/furniture.service';
import { lngLatToSweref99tm, sweref99tmToWgs84, wgs84ToSweref99tm } from '../geo/transform';
import { PlanService, type PlanHoleRow } from './plan.service';
import { ClubsService } from '../player/clubs.service';
import {
    PLAN_OVERLAY_ID,
    GATE_DEFAULT_HALF_WIDTH_M,
    buildHolePlan,
    buildPlanGeojson,
    nearestLegFoot,
    planLayers,
    type EffectiveWind,
    type HolePlan,
} from './plan-overlay';

/** Interaction-claim id for the planner's single tool. */
export const PLANNER_TOOL_ID = 'planner';

/** Screen-px radius for click-to-select and mousedown-to-drag hit testing. */
const MARKER_HIT_PX = 12;
/** Screen-px point-to-segment tolerance for gate-line (move) hits. */
const GATE_LINE_HIT_PX = 8;
/** Screen-px max distance from a leg for placing a gate on it. */
const GATE_PLACE_PX = 32;
/** Smallest draggable gate half-width, meters. */
const MIN_HALF_WIDTH_M = 1;
const DRAG_MOVE_THRESHOLD_PX = 2;

export type PlannerMode = 'select' | 'add-shot' | 'add-gate';

export type PlannerSelection = { kind: 'shot' | 'gate'; id: string } | null;

type DragTarget =
    | { kind: 'shot'; id: string }
    | { kind: 'gate-side'; id: string; side: 'left' | 'right' }
    | { kind: 'gate-move'; id: string };

interface Drag {
    target: DragTarget;
    startScreen: { x: number; y: number };
    moved: boolean;
}

/**
 * The planner page's single map tool: shot placement/drag, corridor-gate
 * rulers, selection, and the plan overlay. Follows the furniture tool's
 * drag conventions (raw mousedown + dragPan.disable, patchLocal per frame,
 * persist on mouseup) and the measure tool's overlay lifecycle — but is NOT
 * an EditorTool: the planner hosts no builder toolbar, so `start()` claims
 * the interaction mode directly for the page's lifetime.
 *
 * Modes:
 * - select (default): click near a marker selects; drag a shot moves it
 *   (re-samples elevation); drag a gate endpoint adjusts that side's
 *   half-width; drag the gate line moves its station (stored bearing kept).
 * - add-shot: every click appends a shot at the click point — Esc to stop.
 * - add-gate: click near a leg drops a gate at the perpendicular foot with
 *   the leg's bearing and 30/30 m half-widths (one-shot; Shift keeps armed).
 */
export class PlannerToolService {
    private map = di.get(MapService);
    private elevation = di.get(ElevationService);
    private router = di.get(Router);
    private courseDetail = di.get(CourseDetailService);
    private furniture = di.get(FurnitureService);
    private plan = di.get(PlanService);
    private clubs = di.get(ClubsService);

    readonly mode = new Signal<PlannerMode>('select');
    readonly selection = new Signal<PlannerSelection>(null);
    /** Transient hint shown in the panel (placement guidance / rejections). */
    readonly notice = new Signal<string | null>(null);

    private drag: Drag | null = null;
    private suppressClick = false;
    private overlayAdded = false;

    /** ?hole= carries the hole NUMBER; resolve to the Hole for the course. */
    private readonly selectedHoleNumber = this.router.query('hole');
    readonly selectedHole = new Computed<Hole | null>(() => {
        const num = this.selectedHoleNumber.get();
        if (num === undefined) return null;
        return this.courseDetail.holes.get().find(h => String(h.number) === num) ?? null;
    });

    /** The plan-hole row for the selected hole (null until first edit). */
    readonly planHole = new Computed<PlanHoleRow | null>(() => {
        const hole = this.selectedHole.get();
        return hole ? this.plan.holeRow(hole.number) ?? null : null;
    });

    /** Origin tee: GamePlanHole.teeId, falling back to first by sortOrder. */
    readonly originTee = new Computed<Tee | null>(() => {
        const hole = this.selectedHole.get();
        if (!hole) return null;
        const tees = this.furniture.teesForHole(hole.id);
        const teeId = this.planHole.get()?.teeId ?? null;
        return (teeId && tees.find(t => t.id === teeId)) || tees[0] || null;
    });

    /** The bag in sortOrder (shared player ClubsService store). */
    readonly orderedClubs = new Computed<Club[]>(() =>
        [...this.clubs.store.items.get()].sort((a, b) => a.sortOrder - b.sortOrder));

    /** Effective wind: per-field hole override ?? plan wind; null = calm. */
    readonly effectiveWind = new Computed<EffectiveWind | null>(() => {
        const hole = this.planHole.get();
        const plan = this.plan.plan.get();
        const speedMps = hole?.windSpeedMps ?? plan?.windSpeedMps ?? null;
        const directionDeg = hole?.windDirectionDeg ?? plan?.windDirectionDeg ?? null;
        if (speedMps === null || directionDeg === null) return null;
        return { speedMps, directionDeg };
    });

    /** The selected hole's shots in sort order. */
    readonly holeShots = new Computed<PlanShot[]>(() => {
        const ph = this.planHole.get();
        return ph ? this.plan.shotsForHole(ph.id) : [];
    });

    /** The selected hole's gates in sort order. */
    readonly holeGates = new Computed<PlanGate[]>(() => {
        const ph = this.planHole.get();
        return ph ? this.plan.gatesForHole(ph.id) : [];
    });

    /** The full planning model for the selected hole (overlay + readouts). */
    readonly holePlan = new Computed<HolePlan | null>(() => {
        const hole = this.selectedHole.get();
        if (!hole) return null;
        const tee = this.originTee.get();
        const green = this.furniture.greenForHole(hole.id);
        return buildHolePlan({
            tee: tee ? { lat: tee.lat, lon: tee.lon, elevation: tee.elevation } : null,
            shots: this.holeShots.get(),
            green: green
                ? { lat: green.centerLat, lon: green.centerLon, elevation: green.elevation }
                : null,
            clubs: this.orderedClubs.get(),
            preferredClubId: this.planHole.get()?.preferredClubId ?? null,
            wind: this.effectiveWind.get(),
        });
    });

    private readonly overlayData = new Computed<FeatureCollection>(() => {
        const sel = this.selection.get();
        return buildPlanGeojson({
            plan: this.holePlan.get(),
            gates: this.holeGates.get(),
            selectedShotId: sel?.kind === 'shot' ? sel.id : null,
            selectedGateId: sel?.kind === 'gate' ? sel.id : null,
        });
    });

    /** The selected shot row (for the panel), or null. */
    readonly selectedShot = new Computed<PlanShot | null>(() => {
        const sel = this.selection.get();
        if (sel?.kind !== 'shot') return null;
        return this.plan.shots.items.get().find(s => s.id === sel.id) ?? null;
    });

    /** The selected gate row (for the panel), or null. */
    readonly selectedGate = new Computed<PlanGate | null>(() => {
        const sel = this.selection.get();
        if (sel?.kind !== 'gate') return null;
        return this.plan.gates.items.get().find(g => g.id === sel.id) ?? null;
    });

    // ── Lifecycle (driven by PlannerComponent) ──────────────────────────────

    /**
     * Wire the tool to the live map for the page's lifetime. `track` is the
     * hosting component's disposer registry — everything (interaction claim,
     * handlers, overlay) unwinds when the page unmounts.
     */
    start(track: (dispose: () => void) => void): void {
        track(this.map.claimInteraction(PLANNER_TOOL_ID));

        track(this.map.onClick(e => this.onClick(e)));
        track(this.map.onMouseMove(e => this.onMouseMove(e)));

        const onKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
        window.addEventListener('keydown', onKeyDown);
        track(() => window.removeEventListener('keydown', onKeyDown));

        // Raw handlers for drags (mousedown near marker → move → up).
        track(effect(() => {
            if (!this.map.ready.get()) return;
            const map = this.map.map.get();
            if (!map) return;
            untrack(() => this.bindRawHandlers(map, track));
        }));

        // Plan overlay — re-added whenever the map becomes ready.
        track(effect(() => {
            const ready = this.map.ready.get();
            const data = this.overlayData.get();
            if (!ready) {
                this.overlayAdded = false; // overlay died with the map
                return;
            }
            if (!this.overlayAdded) {
                this.map.addOverlayLayer(PLAN_OVERLAY_ID, data, planLayers());
                this.overlayAdded = true;
            } else {
                this.map.updateOverlayData(PLAN_OVERLAY_ID, data);
            }
        }));
        track(() => {
            if (this.overlayAdded) {
                this.map.removeOverlayLayer(PLAN_OVERLAY_ID);
                this.overlayAdded = false;
            }
        });

        // Crosshair cursor while an add mode is armed.
        track(effect(() => {
            const armed = this.mode.get() !== 'select';
            if (!this.map.ready.get()) return;
            const canvas = this.map.map.get()?.getCanvas();
            if (canvas) canvas.style.cursor = armed ? 'crosshair' : '';
        }));

        track(() => {
            this.endDrag();
            this.mode.set('select');
            this.selection.set(null);
            this.notice.set(null);
            this.suppressClick = false;
        });
    }

    /** Arm an add mode (toggles back to select when already armed). */
    setMode(mode: Exclude<PlannerMode, 'select'>): void {
        this.notice.set(null);
        if (this.mode.peek() === mode) {
            this.mode.set('select');
            return;
        }
        this.selection.set(null);
        this.mode.set(mode);
    }

    /** Delete the selected shot/gate after confirmation (Del key / panel). */
    async deleteSelected(): Promise<void> {
        const sel = this.selection.peek();
        if (!sel) return;
        const label = sel.kind === 'shot' ? 'shot' : 'gate';
        if (!window.confirm(`Delete this ${label}?`)) return;
        const ok = sel.kind === 'shot'
            ? await this.plan.removeShot(sel.id)
            : await this.plan.removeGate(sel.id);
        if (ok && this.selection.peek() === sel) this.selection.set(null);
    }

    // ── Event handling ──────────────────────────────────────────────────────

    private isMyClaim(): boolean {
        return this.map.interactionMode.peek() === PLANNER_TOOL_ID;
    }

    private onClick(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;
        if (this.suppressClick) return;

        const mode = this.mode.peek();
        if (mode === 'add-shot') {
            void this.placeShot(e.lngLat);
            return;
        }
        if (mode === 'add-gate') {
            void this.placeGate(e);
            return;
        }

        const hit = this.hitTest(e.point);
        this.selection.set(hit ? { kind: hit.kind === 'shot' ? 'shot' : 'gate', id: hit.id } : null);
    }

    private onMouseMove(e: MapPointerEvent): void {
        if (!this.isMyClaim()) return;
        const drag = this.drag;
        if (!drag) return;
        if (!drag.moved && this.pxDist(drag.startScreen, e.point) < DRAG_MOVE_THRESHOLD_PX) return;
        drag.moved = true;
        this.applyDrag(drag.target, e);
    }

    private bindRawHandlers(map: MaplibreMap, track: (dispose: () => void) => void): void {
        const onMouseDown = (e: MapMouseEvent) => this.onMouseDown(e, map);
        const onMouseUp = () => this.onMouseUp(map);
        map.on('mousedown', onMouseDown);
        map.on('mouseup', onMouseUp);
        track(() => {
            map.off('mousedown', onMouseDown);
            map.off('mouseup', onMouseUp);
        });
    }

    private onMouseDown(e: MapMouseEvent, map: MaplibreMap): void {
        if (!this.isMyClaim()) return;
        if (e.originalEvent.button !== 0) return;
        if (this.mode.peek() !== 'select') return;

        const hit = this.hitTest(e.point);
        if (!hit) return;
        e.preventDefault(); // stops the map's drag-pan for this gesture
        map.dragPan.disable();
        this.selection.set({ kind: hit.kind === 'shot' ? 'shot' : 'gate', id: hit.id });
        this.drag = {
            target: hit,
            startScreen: { x: e.point.x, y: e.point.y },
            moved: false,
        };
    }

    private onMouseUp(map: MaplibreMap): void {
        const drag = this.drag;
        if (!drag) return;
        this.endDrag(map);

        // Swallow the click MapLibre synthesizes right after this mouseup.
        this.suppressClick = true;
        setTimeout(() => { this.suppressClick = false; }, 0);

        if (!drag.moved) return;
        void this.persistDrag(drag.target);
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (!this.isMyClaim()) return;
        const target = e.target as HTMLElement | null;
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLSelectElement ||
            target instanceof HTMLTextAreaElement
        ) return;

        if (e.key === 'Escape') {
            if (this.mode.peek() !== 'select') {
                this.mode.set('select');
                this.notice.set(null);
                e.preventDefault();
            } else if (this.selection.peek()) {
                this.selection.set(null);
                e.preventDefault();
            }
            return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this.selection.peek()) {
                e.preventDefault();
                void this.deleteSelected();
            }
        }
    }

    // ── Placement ───────────────────────────────────────────────────────────

    /**
     * Append a shot at a WGS84 position (samples elevation first, like
     * furniture placement). add-shot stays armed — planning a hole is a
     * click sequence; Esc (or the panel button) leaves the mode.
     */
    private async placeShot(lngLat: { lng: number; lat: number }): Promise<void> {
        const hole = this.selectedHole.peek();
        if (!hole) {
            this.notice.set('Select a hole first (pick one from the hole list).');
            return;
        }
        const elevation = await this.elevation.elevationAt(lngLat);
        const created = await this.plan.addShot(hole.number, {
            lat: lngLat.lat,
            lon: lngLat.lng,
            elevation,
        });
        if (created) {
            this.notice.set(null);
            this.selection.set({ kind: 'shot', id: created.id });
        }
    }

    /**
     * Drop a gate at the perpendicular foot of the click on the nearest leg:
     * station = foot, axis bearing = leg bearing, half-widths 30/30 m,
     * source 'manual'. One-shot (Shift keeps the mode armed).
     */
    private async placeGate(e: MapPointerEvent): Promise<void> {
        const hole = this.selectedHole.peek();
        if (!hole) {
            this.notice.set('Select a hole first (pick one from the hole list).');
            return;
        }
        const plan = this.holePlan.peek();
        const map = this.map.map.peek();
        if (!plan || plan.legs.length === 0 || !map) {
            this.notice.set('No legs to attach a gate to — the hole needs a tee/green (and optionally shots) first.');
            return;
        }
        const foot = nearestLegFoot(lngLatToSweref99tm(e.lngLat), plan.legs);
        if (!foot) return;
        const { lat, lon } = sweref99tmToWgs84(foot.point.x, foot.point.y);
        const projected = map.project([lon, lat]);
        if (this.pxDist(projected, e.point) > GATE_PLACE_PX) {
            this.notice.set('Click closer to a leg to place the gate on it.');
            return;
        }
        const created = await this.plan.addGate(hole.number, {
            lat,
            lon,
            directionDeg: plan.legs[foot.legIndex].bearingDeg,
            halfWidthLeftM: GATE_DEFAULT_HALF_WIDTH_M,
            halfWidthRightM: GATE_DEFAULT_HALF_WIDTH_M,
            source: 'manual',
        });
        if (created) {
            this.notice.set(null);
            this.selection.set({ kind: 'gate', id: created.id });
            if (!e.originalEvent.shiftKey) this.mode.set('select');
        }
    }

    // ── Dragging ────────────────────────────────────────────────────────────

    private applyDrag(target: DragTarget, e: MapPointerEvent): void {
        if (target.kind === 'shot') {
            this.plan.patchShotLocal(target.id, { lat: e.lngLat.lat, lon: e.lngLat.lng });
            return;
        }
        const gate = this.plan.gates.items.peek().find(g => g.id === target.id);
        if (!gate) return;
        if (target.kind === 'gate-move') {
            // Move the station; the stored corridor bearing is kept as-is
            // (deliberate — no recompute against the nearest leg).
            this.plan.patchGateLocal(target.id, { lat: e.lngLat.lat, lon: e.lngLat.lng });
            return;
        }
        // Endpoint drag: the new half-width is the cursor's projection onto
        // that side's ruler axis (perpendicular to the corridor bearing).
        const station = wgs84ToSweref99tm(gate.lat, gate.lon);
        const cursor = lngLatToSweref99tm(e.lngLat);
        const unit = bearingToUnitVector(gate.directionDeg + (target.side === 'left' ? -90 : 90));
        const width = Math.max(
            MIN_HALF_WIDTH_M,
            (cursor.x - station.x) * unit.x + (cursor.y - station.y) * unit.y,
        );
        this.plan.patchGateLocal(
            target.id,
            target.side === 'left' ? { halfWidthLeftM: width } : { halfWidthRightM: width },
        );
    }

    private async persistDrag(target: DragTarget): Promise<void> {
        if (target.kind === 'shot') {
            const shot = this.plan.shots.items.peek().find(s => s.id === target.id);
            if (!shot) return;
            const elevation = await this.elevation.elevationAt({ lng: shot.lon, lat: shot.lat });
            await this.plan.updateShot(target.id, { lat: shot.lat, lon: shot.lon, elevation });
            return;
        }
        const gate = this.plan.gates.items.peek().find(g => g.id === target.id);
        if (!gate) return;
        if (target.kind === 'gate-move') {
            await this.plan.updateGate(target.id, { lat: gate.lat, lon: gate.lon });
        } else if (target.side === 'left') {
            await this.plan.updateGate(target.id, { halfWidthLeftM: gate.halfWidthLeftM });
        } else {
            await this.plan.updateGate(target.id, { halfWidthRightM: gate.halfWidthRightM });
        }
    }

    private endDrag(map?: MaplibreMap): void {
        if (!this.drag) return;
        this.drag = null;
        (map ?? this.map.map.peek())?.dragPan.enable();
    }

    // ── Hit testing ─────────────────────────────────────────────────────────

    /**
     * Nearest drag/select target within tolerance: shot nodes and gate
     * endpoint handles first (point targets), then gate lines (segment
     * targets, for station moves) at a tighter tolerance.
     */
    private hitTest(screen: { x: number; y: number }): DragTarget | null {
        const map = this.map.map.peek();
        if (!map) return null;

        let best: DragTarget | null = null;
        let bestDist = MARKER_HIT_PX;
        const consider = (target: DragTarget, lat: number, lon: number) => {
            const p = map.project([lon, lat]);
            const d = Math.hypot(p.x - screen.x, p.y - screen.y);
            if (d < bestDist) { bestDist = d; best = target; }
        };

        for (const shot of this.holeShots.peek()) {
            consider({ kind: 'shot', id: shot.id }, shot.lat, shot.lon);
        }
        const gates = this.holeGates.peek();
        for (const gate of gates) {
            const station = wgs84ToSweref99tm(gate.lat, gate.lon);
            const left = bearingToUnitVector(gate.directionDeg - 90);
            const right = bearingToUnitVector(gate.directionDeg + 90);
            const lp = sweref99tmToWgs84(
                station.x + left.x * gate.halfWidthLeftM, station.y + left.y * gate.halfWidthLeftM);
            const rp = sweref99tmToWgs84(
                station.x + right.x * gate.halfWidthRightM, station.y + right.y * gate.halfWidthRightM);
            consider({ kind: 'gate-side', id: gate.id, side: 'left' }, lp.lat, lp.lon);
            consider({ kind: 'gate-side', id: gate.id, side: 'right' }, rp.lat, rp.lon);
        }
        if (best) return best;

        // No point target — try the gate lines (move the whole gate).
        let lineBest: DragTarget | null = null;
        let lineDist = GATE_LINE_HIT_PX;
        for (const gate of gates) {
            const station = wgs84ToSweref99tm(gate.lat, gate.lon);
            const left = bearingToUnitVector(gate.directionDeg - 90);
            const right = bearingToUnitVector(gate.directionDeg + 90);
            const lp = sweref99tmToWgs84(
                station.x + left.x * gate.halfWidthLeftM, station.y + left.y * gate.halfWidthLeftM);
            const rp = sweref99tmToWgs84(
                station.x + right.x * gate.halfWidthRightM, station.y + right.y * gate.halfWidthRightM);
            const a = map.project([lp.lon, lp.lat]);
            const b = map.project([rp.lon, rp.lat]);
            const d = pointToSegmentPx(screen, a, b);
            if (d < lineDist) { lineDist = d; lineBest = { kind: 'gate-move', id: gate.id }; }
        }
        return lineBest;
    }

    private pxDist(a: { x: number; y: number }, b: { x: number; y: number }): number {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }
}

/** Screen-space distance from a point to segment a→b, pixels. */
function pointToSegmentPx(
    p: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
): number {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
    return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}
