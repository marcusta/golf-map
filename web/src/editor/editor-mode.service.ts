import { Signal, Router, di } from '@basics/core/client/core';
import { MapService } from '../map/map.service';
import { ElevationService } from '../map/elevation.service';
import { TilesetService } from '../map/tileset.service';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FeaturesService } from '../draw/features.service';
import type { EditorTool, ToolContext } from './tool';
import { EDITOR_TOOLS } from './tools/index';

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
 */
export class EditorModeService {
    private mapSvc = di.get(MapService);
    private elevation = di.get(ElevationService);
    private tileset = di.get(TilesetService);
    private courseDetail = di.get(CourseDetailService);
    private features = di.get(FeaturesService);
    private router = di.get(Router);
    private params = this.router.params<{ courseId: string }>('/:host/:courseId');

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
