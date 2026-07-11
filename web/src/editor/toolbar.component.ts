import { Component, Router, Signal, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, segmented, glassPanel, OVERLAY_W, OVERLAY_INSET, OVERLAY_GAP } from '../css';
import { icon } from '../ui/icons';
import { MapService } from '../map/map.service';
import { ElevationService } from '../map/elevation.service';
import { TilesetService } from '../map/tileset.service';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FeaturesService } from '../draw/features.service';
import type { EditorTool, ToolContext } from './tool';
import { EDITOR_TOOLS } from './tools/index';
import { HelpModalComponent } from './help-modal.component';

const tpl = template(`
    <div class="editor-tools" bind="root" data-testid="editor-toolbar">
        <div bind="bar" class="editor-tools__bar" data-testid="editor-toolbar-bar"></div>
        <div bind="panelHost" class="editor-tools__panel"></div>
    </div>
    <div bind="sidePanelHost" class="editor-tools-side" data-testid="editor-toolbar-side"></div>
    <div bind="helpHost"></div>
`);

const toolBtnTpl = template(`
    <button bind="button" type="button" class="tool-btn">
        <span bind="icon" class="tool-btn__icon"></span>
        <span bind="label" class="tool-btn__label"></span>
    </button>
`);

/**
 * The editor's tool host: renders one button per registered tool (see
 * editor/tools/index.ts), manages exclusive activation through
 * MapService.claimInteraction (per the interaction contract), runs each
 * tool's `attach` hook once per canvas mount, shows the active tool's
 * panel in a dock on the canvas's left edge (and, optionally, a second
 * `sidePanel` docked on the right edge), hosts the contextual help modal
 * (help-modal.component.ts, D27), and handles ESC (help modal first if
 * open, then tool.onEscape, then deactivation).
 *
 * Spawned by EditorCanvasComponent; one instance == one courseId (the
 * canvas is recreated per navigation). Tools never talk to this component
 * — everything they need arrives via ToolContext (editor/tool.ts).
 */
export class EditorToolbarComponent extends Component {
    static styles = `
        .editor-tools {
            /* Corner-inset contract (layout law 02): toolbar + left dock
               share the top-left inset and LEFT EDGE, stacked with an
               OVERLAY_GAP. The bottom anchor only BOUNDS the column so the
               dock can shrink-scroll — children hug content (law 01). */
            position: absolute;
            top: ${OVERLAY_INSET};
            left: ${OVERLAY_INSET};
            bottom: ${OVERLAY_INSET};
            display: none;
            flex-direction: column;
            align-items: flex-start;
            gap: ${OVERLAY_GAP};
            z-index: 5;
            pointer-events: none;
            &.show { display: flex; }

            /* Tool switcher: one sunken segmented track, not loose buttons —
               active tool gets aria-pressed="true" (guide §04). */
            & .editor-tools__bar {
                pointer-events: auto;
                ${segmented()}

                & .tool-btn {
                    display: flex;
                    align-items: center;
                    gap: ${s('xs')};
                    padding: ${s('xs')} ${s('sm')};
                    font-size: 0.75rem;

                    /* Monoline icon (guide §06) — currentColor, so the active
                       segment tints the icon clay via the rule below. */
                    & .tool-btn__icon { display: flex; align-items: center; }
                    &[aria-pressed="true"] .tool-btn__icon {
                        color: ${t('color-accent-primary')};
                    }
                }
            }

            /* Left-edge dock: glass over the map (guide §01) — terrain reads
               through, rim-light stroke, radius-lg, elev-3. Width is the
               340 bucket (law 01: the draw panel's 2-col grid fits FULL
               labels; furniture/measure/analysis inherit it). Height hugs
               content — flex shrink + min-height:0 cap it at the viewport
               bound, and overflow scrolls INSIDE. Padding 0: hosted panels
               carry their own section rhythm (law 03). */
            & .editor-tools__panel {
                display: none;
                width: ${OVERLAY_W.standard};
                flex: 0 1 auto;
                min-height: 0;
                overflow-y: auto;
                pointer-events: auto;
                ${glassPanel()}
                padding: 0;
                &.show { display: block; }
            }
        }

        /*
         * Right-edge dock — mirrors .editor-tools__panel above (same glass
         * treatment), but it is its own top-level element (no button bar on
         * this side) so its show/hide doesn't depend on the left toolbar's
         * map-ready gating beyond what's folded into its own className
         * function.
         */
        .editor-tools-side {
            /* Layout laws 01+02: floats at the top-right corner inset,
               280 bucket, and HUGS its content — no bottom anchor, only a
               max-height bound so the hosted panel's list can scroll
               inside (the panel is never full-height). Flex column so the
               hosted component can give its row list min-height:0. */
            display: none;
            position: absolute;
            top: ${OVERLAY_INSET};
            right: ${OVERLAY_INSET};
            width: ${OVERLAY_W.narrow};
            max-height: calc(100% - 2 * ${OVERLAY_INSET});
            z-index: 5;
            pointer-events: auto;
            ${glassPanel()}
            padding: 0;
            &.show { display: flex; flex-direction: column; }
        }
    `;

    private mapSvc = this.inject(MapService);
    private elevation = this.inject(ElevationService);
    private tileset = this.inject(TilesetService);
    private courseDetail = this.inject(CourseDetailService);
    private features = this.inject(FeaturesService);
    private router = this.inject(Router);
    private params = this.router.params<{ courseId: string }>('/course/:courseId');

    private readonly activeToolId = new Signal<string | null>(null);
    private active: { tool: EditorTool; disposers: Array<() => void>; release: () => void } | null = null;
    private panelChild: Component | null = null;
    private panelHost!: HTMLElement;
    private sidePanelChild: Component | null = null;
    private sidePanelHost!: HTMLElement;
    private helpHost!: HTMLElement;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { className: () => this.mapSvc.ready.get() ? 'editor-tools show' : 'editor-tools' },
            panelHost: {
                className: () => {
                    const tool = this.activeTool();
                    return tool?.panel ? 'editor-tools__panel show' : 'editor-tools__panel';
                },
            },
            sidePanelHost: {
                className: () => {
                    const tool = this.activeTool();
                    return this.mapSvc.ready.get() && tool?.sidePanel ? 'editor-tools-side show' : 'editor-tools-side';
                },
            },
        });
        this.panelHost = this.ref(frag, 'panelHost');
        this.sidePanelHost = this.ref(frag, 'sidePanelHost');
        this.helpHost = this.ref(frag, 'helpHost');

        const bar = this.ref(frag, 'bar');
        for (const tool of [...EDITOR_TOOLS].sort((a, b) => a.order - b.order)) {
            const btnEl = this.wireEl(toolBtnTpl, {
                button: {
                    onclick: () => this.toggle(tool),
                    className: 'tool-btn',
                    title: tool.label,
                    'aria-pressed': () => this.activeToolId.get() === tool.id,
                },
                icon: { innerHTML: icon(tool.icon, 16) },
                label: { textContent: tool.label },
            });
            // E2E instrumentation (inert in prod): stable per-tool hook so the
            // smoke suite can assert every tool button is present + which is armed.
            btnEl.dataset.testid = `tool-btn-${tool.id}`;
            btnEl.dataset.toolId = tool.id;
            bar.appendChild(btnEl);
        }
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
            tool.attach?.(this.makeContext(d => this.track(d)));
        }

        // Deactivate when displaced: another claimant took the interaction
        // mode (contract in map/interaction.ts).
        this.track(effect(() => {
            const mode = this.mapSvc.interactionMode.get();
            const activeId = this.activeToolId.get();
            if (activeId && mode !== activeId) untrack(() => this.deactivate());
        }));

        // Panel dock: swap the active tool's panel component in/out.
        this.track(effect(() => {
            const tool = this.activeTool();
            untrack(() => {
                this.panelChild?.destroy();
                this.panelChild = null;
                this.panelHost.textContent = '';
                if (tool?.panel) {
                    const PanelCtor = tool.panel;
                    this.panelChild = new PanelCtor();
                    this.panelChild.mount(this.panelHost);
                }
            });
        }));

        // Right-edge dock: same swap lifecycle as the left panel above.
        this.track(effect(() => {
            const tool = this.activeTool();
            untrack(() => {
                this.sidePanelChild?.destroy();
                this.sidePanelChild = null;
                this.sidePanelHost.textContent = '';
                if (tool?.sidePanel) {
                    const SidePanelCtor = tool.sidePanel;
                    this.sidePanelChild = new SidePanelCtor();
                    this.sidePanelChild.mount(this.sidePanelHost);
                }
            });
        }));

        // ESC: offer to the active tool first; deactivate if unconsumed.
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || !this.active) return;
            if (this.active.tool.onEscape?.()) return;
            this.deactivate();
        };
        window.addEventListener('keydown', onKeyDown);
        this.track(() => window.removeEventListener('keydown', onKeyDown));

        this.track(() => {
            this.deactivate();
            this.panelChild?.destroy();
            this.panelChild = null;
            this.sidePanelChild?.destroy();
            this.sidePanelChild = null;
        });
    }

    private activeTool(): EditorTool | null {
        const id = this.activeToolId.get();
        return id ? EDITOR_TOOLS.find(tool => tool.id === id) ?? null : null;
    }

    private toggle(tool: EditorTool): void {
        if (this.active?.tool === tool) {
            this.deactivate();
            return;
        }
        this.deactivate();
        const disposers: Array<() => void> = [];
        const release = this.mapSvc.claimInteraction(tool.id);
        this.active = { tool, disposers, release };
        tool.activate(this.makeContext(d => disposers.push(d)));
        this.activeToolId.set(tool.id);
    }

    private deactivate(): void {
        const active = this.active;
        if (!active) return;
        this.active = null;
        this.activeToolId.set(null);
        for (const dispose of active.disposers) dispose();
        active.tool.deactivate();
        active.release(); // stale-safe no-op when displaced
    }

    private makeContext(track: (d: () => void) => void): ToolContext {
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
