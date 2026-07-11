import { Component, effect, template, untrack } from '@basics/core/client/core';
import { MapService } from '../map/map.service';
import { EditorModeService } from './editor-mode.service';
import { EDITOR_TOOLS } from './tools/index';
import { drawTool } from '../draw/draw-tool';
import { HelpModalComponent } from './help-modal.component';

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
 * D27), deactivates the active tool when displaced, and handles ESC (help modal
 * first if open, then tool.onEscape, then deactivation).
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

    private helpHost!: HTMLElement;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {});
        this.helpHost = this.ref(frag, 'helpHost');
        return frag;
    }

    onMount(): void {
        // Help modal (D27): spawned FIRST so its own Escape listener
        // (help-modal.component.ts) registers on window before this
        // component's own ESC listener below — window keydown listeners
        // fire in registration order, and the modal's handler
        // stopImmediatePropagation's while open, so closing help never
        // also falls through to tool.onEscape/deactivate.
        this.spawn(HelpModalComponent, this.helpHost);

        // One-time attach hooks (persistent overlays, data loads) — their
        // disposers live until this canvas unmounts.
        for (const tool of EDITOR_TOOLS) {
            tool.attach?.(this.mode.makeContext(d => this.track(d)));
        }

        // Auto-activate Draw on entering the builder so the command bar's
        // sub-mode dropdown never shows an empty sub-mode. Only when nothing
        // is armed yet — a re-mount that inherited a live claim keeps it.
        if (!this.mode.activeToolId.peek()) this.mode.activate(drawTool);

        // Deactivate when displaced: another claimant took the interaction
        // mode (contract in map/interaction.ts).
        this.track(effect(() => {
            const mode = this.mapSvc.interactionMode.get();
            const activeId = this.mode.activeToolId.get();
            if (activeId && mode !== activeId) untrack(() => this.mode.deactivate());
        }));

        // ESC: offer to the active tool first; deactivate if unconsumed.
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            const active = this.mode.peekActiveTool();
            if (!active) return;
            if (active.onEscape?.()) return;
            this.mode.deactivate();
        };
        window.addEventListener('keydown', onKeyDown);
        this.track(() => window.removeEventListener('keydown', onKeyDown));

        this.track(() => this.mode.deactivate());
    }
}
