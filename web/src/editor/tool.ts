// ─── Editor tool plug-in architecture ─────────────────────────────────────
//
// The editor canvas hosts a set of TOOLS (draw, furniture placement,
// measurement, green analysis, …). Each tool is a plain object implementing
// `EditorTool`, registered in exactly ONE place: `editor/tools/index.ts`.
// Adding a tool never requires touching the toolbar, this file, or another
// tool's files.
//
// ## Lifecycle (driven by EditorToolbarComponent)
//
// 1. `attach(ctx)` — called ONCE when the editor canvas mounts for a course
//    (before any activation, map possibly not ready yet). For always-on
//    concerns: loading data, rendering persistent overlays. Register
//    cleanup with `ctx.track()`; disposers run when the canvas unmounts.
//    Optional.
// 2. `activate(ctx)` — called when the user selects the tool button. The
//    toolbar has ALREADY claimed exclusive interaction via
//    `MapService.claimInteraction(tool.id)` — but per the interaction
//    contract (map/interaction.ts) every onClick/onMouseMove handler the
//    tool registers MUST still check `ctx.map.interactionMode.get() ===
//    tool.id` and bail otherwise. Register handler unsubscribes and any
//    other teardown with `ctx.track()`; disposers run at deactivation.
// 3. `deactivate()` — called when the user toggles the tool off, presses
//    ESC (see `onEscape`), activates another tool, or an outside party
//    claims the interaction mode. Runs AFTER the activation-span disposers.
//    Must leave the map free of tool-transient state (previews, cursor
//    overrides). Persistent overlays created in `attach` stay.
// 4. `onEscape()` — optional. While the tool is active, ESC first asks the
//    tool: return `true` to consume the keypress (e.g. cancel an
//    in-progress polygon, drop a selection); return `false` to let the
//    toolbar deactivate the tool.
//
// ## Panels
//
// A tool may declare `panel`: a Component class rendered inside the
// editor's docked panel (floating over the left side of the canvas) while
// the tool is active. Panels are constructed with no props — get your tool's
// state via DI (`this.inject(MyToolService)`) so panel and tool share one
// instance.
//
// ## Help (D27)
//
// A tool may declare `help`: an array of titled shortcut sections shown in
// the contextual help modal (editor/help-modal.component.ts) while the tool
// is active — opened by `?` (guarded against input targets) or the small
// `?` buttons in the dock headers. Static data, not a Component: the modal
// reads whichever tool currently holds `MapService.interactionMode`. A tool
// with no `help` (or none active) falls back to a generic empty state.
//
// ## Overlays
//
// Use `ctx.map.addOverlayLayer(id, …)` with your tool id as the overlay id
// prefix (`draw`, `measure-…`). Overlays die with the map — watch
// `ctx.map.ready` via `effect` and re-add when it turns true.

import type { Component } from '@basics/core/client/core';
import type { MapService } from '../map/map.service';
import type { ElevationService } from '../map/elevation.service';
import type { TilesetService } from '../map/tileset.service';
import type { CourseDetailService } from '../course-detail/course-detail.service';
import type { FeaturesService } from '../draw/features.service';
import type { IconName } from '../ui/icons';

/** Services + lifetime tracking handed to tools by the toolbar. */
export interface ToolContext {
    /** Map lifecycle, events, exclusive-interaction claims, overlays. */
    map: MapService;
    /** Terrain-RGB elevation sampling. */
    elevation: ElevationService;
    /** Tile manifest / bounds for the current course. */
    tileset: TilesetService;
    /** Course + holes for the current course. */
    courseDetail: CourseDetailService;
    /** Course features store (loaded by the toolbar during mount). */
    features: FeaturesService;
    /** The course this editor canvas is showing. */
    courseId: string;
    /**
     * Register a disposer bound to this context's lifetime: the canvas
     * mount for `attach` contexts, the activation span for `activate`
     * contexts. Pass unsubscribe functions from onClick/onMouseMove/effect
     * here — never manage teardown manually.
     */
    track(dispose: () => void): void;
}

/** One row in a help-modal section: a key combo + what it does. */
export interface HelpShortcut {
    keys: string;
    desc: string;
}

/** A titled group of shortcuts shown together in the help modal. */
export interface HelpSection {
    title: string;
    shortcuts: HelpShortcut[];
}

/** A toolbar tool. Register instances in editor/tools/index.ts. */
export interface EditorTool {
    /** Unique id — doubles as the MapService interaction mode string. */
    id: string;
    /** Button tooltip / accessible name. */
    label: string;
    /** Monoline icon on the toolbar button (ui/icons.ts name, guide §06). */
    icon: IconName;
    /** Toolbar sort order (draw=10, furniture=20, measure=30, analysis=40). */
    order: number;
    /** Optional side-panel component shown while active (see header doc). */
    panel?: new () => Component;
    /** Optional contextual-help sections shown by `?` (see header doc). */
    help?: HelpSection[];
    /** Optional one-time setup per canvas mount (see header doc). */
    attach?(ctx: ToolContext): void;
    /** Tool selected — register interaction handlers (see header doc). */
    activate(ctx: ToolContext): void;
    /** Tool deselected/displaced — runs after activation disposers. */
    deactivate(): void;
    /** ESC while active: return true to consume, false to deactivate. */
    onEscape?(): boolean;
}
