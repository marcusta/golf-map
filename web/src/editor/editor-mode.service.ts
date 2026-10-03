import { Signal, Computed, Router, di } from '@basics/core/client/core';
import { MapService } from '../map/map.service';
import { ElevationService } from '../map/elevation.service';
import { TilesetService } from '../map/tileset.service';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FeaturesService } from '../draw/features.service';
import { FurnitureService } from '../furniture/furniture.service';
import type { Hole } from '../../../shared/api/holes.gen';
import { holeFurnitureBounds } from './hole-framing';
import type { EditorTool, ToolContext } from './tool';
import { EDITOR_TOOLS } from './tools/index';

/** localStorage key for the Create-mode "follow hole" camera toggle. */
export const FOLLOW_HOLE_KEY = 'golf-map.followHole';
/** Dock collapse keys, owned by hole-sidebar and feature-dock; read here only. */
export const HOLE_DOCK_KEY = 'golf-map.holeDock.collapsed';
export const FEATURE_DOCK_KEY = 'golf-map.featureDock.collapsed';

function readFlag(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeFlag(key: string, value: boolean): void {
    try {
        localStorage.setItem(key, value ? '1' : '0');
    } catch { /* storage blocked: the in-memory signal still holds the value */ }
}

/**
 * Owns the editor's active-sub-mode (tool) selection for the /course builder:
 * which tool is armed, exclusive interaction claim, and the activation-span
 * disposers. Extracted from EditorToolbarComponent so BOTH the command-bar
 * sub-mode dropdown (app/command-bar.component.ts) and the toolbar (which keeps
 * hosting each tool's floating panel) drive one shared instance.
 *
 * The toolbar still owns the per-canvas lifetime concerns — running each tool's
 * one-time `attach` hook, hosting the active tool's `panel`, the
 * displaced-deactivate effect, and the ESC chain — and calls `deactivate()` on
 * teardown so this DI singleton resets between canvas mounts.
 *
 * It also owns the editor-wide actions that the keyboard (editor-keys.ts) and
 * the command bar share: hole step, fit hole, fit course, dock collapse and
 * the persisted `followHole` toggle (review items 21 and 22).
 */
export class EditorModeService {
    private mapSvc = di.get(MapService);
    private elevation = di.get(ElevationService);
    private tileset = di.get(TilesetService);
    private courseDetail = di.get(CourseDetailService);
    private features = di.get(FeaturesService);
    private router = di.get(Router);
    private params = this.router.params<{ courseId: string }>('/:host/:courseId');
    private holeQuery = this.router.query('hole');
    private _furniture?: FurnitureService;
    private get furniture(): FurnitureService { return (this._furniture ??= di.get(FurnitureService)); }

    /**
     * Create-mode camera follows the selected hole (review item 22). Persisted
     * under FOLLOW_HOLE_KEY, default on. Set it through `setFollowHole`.
     */
    readonly followHole = new Signal<boolean>(readFlag(FOLLOW_HOLE_KEY) !== '0');

    /**
     * Last dock-collapse request from `toggleDocks` (null = none yet). The
     * hole dock and the feature dock own their collapsed state; each should
     * apply this request in an effect (a fresh object per call, so a repeat
     * request still fires). `toggleDocks` also writes both docks' persisted
     * keys, so an unwired dock picks the state up on its next mount.
     */
    readonly dockRequest = new Signal<{ collapsed: boolean } | null>(null);

    /** The route's ?hole= (a hole NUMBER) resolved against the course's holes. */
    readonly selectedHole = new Computed<Hole | null>(() => {
        const num = this.holeQuery.get();
        if (num === undefined) return null;
        return this.courseDetail.holes.get().find(h => String(h.number) === num) ?? null;
    });

    /** Id of the armed tool (null = none). Doubles as the interaction mode. */
    readonly activeToolId = new Signal<string | null>(null);
    private active: { tool: EditorTool; disposers: Array<() => void>; release: () => void } | null = null;

    /** The registered tool matching `activeToolId`, reactively. */
    activeTool(): EditorTool | null {
        const id = this.activeToolId.get();
        return id ? EDITOR_TOOLS.find(tool => tool.id === id) ?? null : null;
    }

    /** Non-reactive read of the active tool (for imperative callers). */
    peekActiveTool(): EditorTool | null {
        const id = this.activeToolId.peek();
        return id ? EDITOR_TOOLS.find(tool => tool.id === id) ?? null : null;
    }

    /** Whether the active tool reports work a sub-mode switch would discard. */
    activeToolBusy(): boolean {
        return this.peekActiveTool()?.isBusy?.() ?? false;
    }

    /**
     * Select a sub-mode by tool id from among `offered` (the server mode's
     * visible tools). No-op when the tool is not offered or already active.
     * Returns true when the id names an offered tool.
     */
    selectSubMode(toolId: string, offered: readonly EditorTool[]): boolean {
        const tool = offered.find(candidate => candidate.id === toolId);
        if (!tool) return false;
        if (this.activeToolId.peek() !== tool.id) this.activate(tool);
        return true;
    }

    /**
     * Step the route's ?hole= by `delta` holes in hole-number order, clamped
     * to the first and last hole. With no hole selected, +1 selects the first
     * hole and -1 the last. Other query params are kept. Returns false when
     * the course has no holes or the selection would not change.
     */
    stepHole(delta: number): boolean {
        const numbers = this.courseDetail.holes.peek().map(h => h.number).sort((a, b) => a - b);
        if (numbers.length === 0) return false;
        const current = this.holeQuery.peek();
        const index = current === undefined ? -1 : numbers.findIndex(n => String(n) === current);
        let next: number;
        if (index < 0) next = delta > 0 ? 0 : numbers.length - 1;
        else next = Math.max(0, Math.min(numbers.length - 1, index + delta));
        const nextNumber = String(numbers[next]);
        if (nextNumber === current) return false;
        const query = Object.fromEntries(new URLSearchParams(this.router.search.peek()));
        query.hole = nextNumber;
        this.router.navigate(this.router.route.peek(), { query });
        return true;
    }

    /**
     * Fit the camera to the selected hole's furniture box (same box the
     * follow-hole framing uses). Returns false when no hole is selected or
     * the hole has no placed furniture.
     */
    fitHole(): boolean {
        const hole = this.selectedHole.peek();
        if (!hole) return false;
        const bounds = holeFurnitureBounds(this.furniture, hole.id);
        if (!bounds) return false;
        this.mapSvc.fitBounds(bounds);
        return true;
    }

    /** Fit the camera to the course's tile bounds. */
    fitCourse(): void {
        this.mapSvc.fitCourse();
    }

    /** Persist and set the follow-hole toggle. */
    setFollowHole(value: boolean): void {
        this.followHole.set(value);
        writeFlag(FOLLOW_HOLE_KEY, value);
    }

    /**
     * Collapse both docks, or expand both when both are already collapsed.
     * Reads the docks' persisted keys for their current state, writes the
     * new state to both keys and publishes `dockRequest`.
     */
    toggleDocks(): boolean {
        const bothCollapsed = readFlag(HOLE_DOCK_KEY) === '1' && readFlag(FEATURE_DOCK_KEY) === '1';
        const collapsed = !bothCollapsed;
        writeFlag(HOLE_DOCK_KEY, collapsed);
        writeFlag(FEATURE_DOCK_KEY, collapsed);
        this.dockRequest.set({ collapsed });
        return collapsed;
    }

    /** Toggle a tool: activate it, or deactivate if it's already the active one. */
    toggle(tool: EditorTool): void {
        if (this.active?.tool === tool) {
            this.deactivate();
            return;
        }
        this.activate(tool);
    }

    /**
     * Activate a tool: deactivate any current one, claim exclusive interaction
     * (MapService.claimInteraction, per map/interaction.ts), then run the tool's
     * `activate` hook with an activation-span ToolContext.
     */
    activate(tool: EditorTool): void {
        this.deactivate();
        const disposers: Array<() => void> = [];
        const release = this.mapSvc.claimInteraction(tool.id);
        this.active = { tool, disposers, release };
        tool.activate(this.makeContext(d => disposers.push(d)));
        this.activeToolId.set(tool.id);
    }

    /** Deactivate the current tool (runs activation-span disposers, releases the claim). */
    deactivate(): void {
        const active = this.active;
        if (!active) return;
        this.active = null;
        this.activeToolId.set(null);
        for (const dispose of active.disposers) dispose();
        active.tool.deactivate();
        active.release(); // stale-safe no-op when displaced
    }

    /**
     * Build a ToolContext bound to `track`. Public so the toolbar can also run
     * each tool's one-time `attach` hook against the canvas-mount lifetime.
     */
    makeContext(track: (d: () => void) => void): ToolContext {
        return {
            map: this.mapSvc,
            elevation: this.elevation,
            tileset: this.tileset,
            courseDetail: this.courseDetail,
            features: this.features,
            courseId: this.params.peek().courseId,
            track,
        };
    }
}
