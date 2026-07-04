import { Component, Router, Signal, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn } from '../css';
import { MapService } from '../map/map.service';
import { ElevationService } from '../map/elevation.service';
import { TilesetService } from '../map/tileset.service';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FeaturesService } from '../draw/features.service';
import type { EditorTool, ToolContext } from './tool';
import { EDITOR_TOOLS } from './tools/index';

const tpl = template(`
    <div class="editor-tools" bind="root">
        <div bind="bar" class="editor-tools__bar"></div>
        <div bind="panelHost" class="editor-tools__panel"></div>
    </div>
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
 * panel in a dock on the canvas's left edge, and handles ESC
 * (tool.onEscape first, then deactivation).
 *
 * Spawned by EditorCanvasComponent; one instance == one courseId (the
 * canvas is recreated per navigation). Tools never talk to this component
 * — everything they need arrives via ToolContext (editor/tool.ts).
 */
export class EditorToolbarComponent extends Component {
    static styles = `
        .editor-tools {
            position: absolute;
            top: ${s('md')};
            left: ${s('md')};
            bottom: ${s('md')};
            display: none;
            flex-direction: column;
            align-items: flex-start;
            gap: ${s('sm')};
            z-index: 5;
            pointer-events: none;
            &.show { display: flex; }

            & .editor-tools__bar {
                display: flex;
                gap: ${s('xs')};
                pointer-events: auto;

                & .tool-btn {
                    display: flex;
                    align-items: center;
                    gap: ${s('xs')};
                    padding: ${s('xs')} ${s('sm')};
                    font-size: 0.75rem;
                    ${btn(t('radius-sm'))}
                    background: ${t('surface')};
                    box-shadow: ${t('shadow')};
                    &.active {
                        border-color: ${t('primary')};
                        color: ${t('primary')};
                        background: ${t('surface')};
                    }
                    & .tool-btn__icon { font-size: 0.9rem; line-height: 1; }
                }
            }

            & .editor-tools__panel {
                display: none;
                width: 240px;
                max-height: 100%;
                overflow-y: auto;
                pointer-events: auto;
                border: 1px solid ${t('border')};
                border-radius: ${t('radius-sm')};
                background: ${t('surface')};
                box-shadow: ${t('shadow')};
                &.show { display: block; }
            }
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

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { className: () => this.mapSvc.ready.get() ? 'editor-tools show' : 'editor-tools' },
            panelHost: {
                className: () => {
                    const tool = this.activeTool();
                    return tool?.panel ? 'editor-tools__panel show' : 'editor-tools__panel';
                },
            },
        });
        this.panelHost = this.ref(frag, 'panelHost');

        const bar = this.ref(frag, 'bar');
        for (const tool of [...EDITOR_TOOLS].sort((a, b) => a.order - b.order)) {
            bar.appendChild(this.wireEl(toolBtnTpl, {
                button: {
                    onclick: () => this.toggle(tool),
                    className: () => this.activeToolId.get() === tool.id ? 'tool-btn active' : 'tool-btn',
                    title: tool.label,
                },
                icon: { textContent: tool.icon },
                label: { textContent: tool.label },
            }));
        }
        return frag;
    }

    onMount(): void {
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
