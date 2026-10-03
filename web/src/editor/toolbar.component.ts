import { Component, effect, template, untrack } from '@basics/core/client/core';
import { MapService } from '../map/map.service';
import { EditorModeService } from './editor-mode.service';
import { ServerModeService, visibleEditorTools } from '../app/server-mode.service';
import { drawTool } from '../draw/draw-tool';
import { HelpModalComponent } from './help-modal.component';
import { ShortcutService, LAYER } from './shortcut.service';

const tpl = template(`
    <div class="editor-tools" bind="root" data-testid="editor-toolbar">
        <div bind="helpHost"></div>
    </div>
`);

/**
 * The editor's tool CONTROLLER (no longer a visible dock). Sub-mode SELECTION
 * lives in the shared EditorModeService (driven by the command bar's sub-mode
 * dropdown), and each sub-mode's editing surface is now hosted by the
 * contextual right dock (ContextDockComponent) — Draw has no floating panel and
 * the other tools' panels render inside that dock. So the floating left glass
 * panel this component used to host is gone.
 *
 * What remains here is the per-canvas-mount lifetime glue: it runs each tool's
 * one-time `attach` hook, auto-activates Draw so the command bar never shows an
 * empty sub-mode, hosts the contextual help modal (help-modal.component.ts,
 * D27), deactivates the active tool when displaced, and pushes the tool-chain
 * ESC layer (tool.onEscape, then back to Draw) onto the ShortcutService stack,
 * below open popovers and the help modal (editor/shortcut.service.ts).
 *
 * Spawned by EditorCanvasComponent; one instance == one courseId (the canvas
 * is recreated per navigation). Tools never talk to this component —
 * everything they need arrives via ToolContext (editor/tool.ts).
 */
export class EditorToolbarComponent extends Component {
    static styles = `
        /* Controller only — renders no map chrome of its own; the help modal
           spawns its own full-screen overlay. */
        .editor-tools { display: contents; }
    `;

    private mapSvc = this.inject(MapService);
    private mode = this.inject(EditorModeService);
    private serverMode = this.inject(ServerModeService);
    private shortcuts = this.inject(ShortcutService);

    private helpHost!: HTMLElement;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {});
        this.helpHost = this.ref(frag, 'helpHost');
        return frag;
    }

    onMount(): void {
        // Help modal (D27). Its Escape layer sits above the tool chain by
        // stack level, not by spawn order.
        this.spawn(HelpModalComponent, this.helpHost);

        // Course features + their map overlay: the /course page's content in
        // EVERY server mode. Not a tool concern — the green-analysis tool
        // hit-tests the same stack, and it must not go dark on a serve box
        // just because the (builder-only) draw tool isn't attached there.
        const ctx = this.mode.makeContext(d => this.track(d));
        void ctx.features.load(ctx.courseId);
        this.track(ctx.features.attachOverlay(ctx.map));

        // One-time attach hooks (persistent overlays, data loads) — their
        // disposers live until this canvas unmounts. Serve mode attaches only
        // the tools it offers: a builder tool's `attach` loads from APIs that
        // are unmounted there (terrain edits, ortho patches, SAM models).
        const tools = visibleEditorTools(this.serverMode.mode.peek());
        for (const tool of tools) {
            tool.attach?.(this.mode.makeContext(d => this.track(d)));
        }

        // Auto-activate Draw on entering the builder so the command bar's
        // sub-mode dropdown never shows an empty sub-mode. Only when nothing
        // is armed yet — a re-mount that inherited a live claim keeps it. In
        // serve mode Draw is gone, so the first offered tool takes its place.
        if (!this.mode.activeToolId.peek()) {
            const initial = tools.includes(drawTool) ? drawTool : tools[0];
            if (initial) this.mode.activate(initial);
        }

        // Deactivate when displaced: another claimant took the interaction
        // mode (contract in map/interaction.ts).
        this.track(effect(() => {
            const mode = this.mapSvc.interactionMode.get();
            const activeId = this.mode.activeToolId.get();
            if (activeId && mode !== activeId) untrack(() => this.mode.deactivate());
        }));

        // ESC: offer to the active tool first. Unconsumed, it returns to the
        // default tool (Draw, when offered): from another tool it re-arms
        // Draw, and on Draw itself it does nothing. Deactivating Draw would
        // leave no tool armed, so every key and map click goes dead while
        // the command bar's sub-mode trigger still reads "Draw". Without a
        // default (serve mode) ESC deactivates as before.
        const defaultTool = tools.includes(drawTool) ? drawTool : null;
        this.track(this.shortcuts.push({
            id: 'tool-chain',
            level: LAYER.toolChain,
            onKey: (e: KeyboardEvent) => {
                if (e.key !== 'Escape') return false;
                const active = this.mode.peekActiveTool();
                if (!active) return false;
                if (active.onEscape?.()) return true;
                if (defaultTool) {
                    // On Draw itself an unconsumed Esc does nothing and stays
                    // unconsumed for any later listener.
                    if (active === defaultTool) return false;
                    this.mode.activate(defaultTool);
                    return true;
                }
                this.mode.deactivate();
                return true;
            },
        }));

        this.track(() => this.mode.deactivate());
    }
}
