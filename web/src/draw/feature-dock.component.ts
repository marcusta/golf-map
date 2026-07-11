import { Component, Signal, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, panelTitle } from '../css';
import { icon } from '../ui/icons';
import { EditorModeService } from '../editor/editor-mode.service';
import { DRAW_TOOL_ID, DrawToolService } from './draw-tool.service';
import { FeaturesService } from './features.service';
import { drawTool } from './draw-tool';
import { SelectionPanelComponent } from './selection-panel.component';
import { FeatureStackPanelComponent } from './feature-stack-panel.component';

/** Independent of the left dock so each side remembers its own state. */
const RIGHT_DOCK_KEY = 'golf-map.featureDock.collapsed';

function loadCollapsed(): boolean {
    try {
        return localStorage.getItem(RIGHT_DOCK_KEY) === '1';
    } catch {
        return false;
    }
}

function saveCollapsed(value: boolean): void {
    try {
        localStorage.setItem(RIGHT_DOCK_KEY, value ? '1' : '0');
    } catch {
        // Non-fatal — the dock just won't remember its state across reloads.
    }
}

const tpl = template(`
    <div class="ctx-dock" bind="root" data-testid="feature-dock">
        <div class="ctx-dock__expanded">
            <div class="ctx-dock__head">
                <button bind="collapseBtn" type="button" class="ctx-dock__chevron" aria-label="Collapse dock" title="Collapse">${icon('chevron-right')}</button>
                <span bind="overline" class="ctx-dock__overline"></span>
            </div>
            <div bind="body" class="ctx-dock__body"></div>
            <div bind="footer" class="ctx-dock__footer"></div>
        </div>
        <div bind="rail" class="ctx-dock__rail" data-testid="feature-dock-rail" role="button" tabindex="0" aria-label="Expand dock">
            <span class="ctx-dock__chevron ctx-dock__chevron--ghost">${icon('chevron-left')}</span>
            <span bind="railLabel" class="ctx-dock__rail-label"></span>
            <span bind="railCount" class="ctx-dock__rail-count" data-testid="feature-dock-count"></span>
        </div>
    </div>
`);

/**
 * The single contextual right dock for the /course builder (Builder redesign
 * v2), mounted in course-detail's layout across ALL Create sub-modes. Its body
 * follows the active editor sub-mode (EditorModeService):
 *
 *   • Draw   → the SelectionPanel (top, shown only while a selection exists)
 *              above the permanent FeatureStackPanel, plus a muted status
 *              footer ("N features · autosaves").
 *   • Others → that tool's own `panel` component (furniture / measure / green
 *              analysis), hosted flat in the dock body.
 *
 * ── Dock hosting contract (follow-up restyles conform to this) ──
 *   The dock owns the surface, the fixed 268px column width, the collapse
 *   header/rail and the scroll bound (`min-height:0; overflow-y:auto` on the
 *   body). A hosted `tool.panel` is constructed with NO props (state via DI),
 *   mounted directly into the body, and destroyed when `activeToolId` changes —
 *   lifecycle-equivalent to the old floating toolbar host. Panels must therefore
 *   be flat column content: NO glass wrapper, NO fixed width, and their own
 *   interior section padding (the body has none). Header + rail label come from
 *   the tool (`Feature stack` for draw, else `tool.label`); the rail count badge
 *   is draw-only.
 *
 * Collapse state persists in localStorage (independent of the left dock); a
 * selection appearing while collapsed auto-expands the dock (never auto-collapses).
 */
export class ContextDockComponent extends Component {
    static styles = `
        .ctx-dock {
            flex: none;
            width: 268px;
            /* height:100% resolves against the (definite) grid row so the dock
               caps to the viewport and its list scrolls INSIDE. */
            height: 100%;
            min-height: 0;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            background: ${t('color-surface-card')};
            border-left: 1px solid ${t('color-border-default')};

            &.is-collapsed { width: 40px; }

            /* ── expanded ── */
            & .ctx-dock__expanded {
                flex: 1;
                min-height: 0;
                display: flex;
                flex-direction: column;
            }
            &.is-collapsed .ctx-dock__expanded { display: none; }

            & .ctx-dock__head {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                padding: ${s('md')} ${s('md')} ${s('sm')};
            }
            & .ctx-dock__overline { ${panelTitle()} flex: 1; }

            & .ctx-dock__chevron {
                width: 26px;
                height: 26px;
                flex: none;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border: 1px solid ${t('color-border-default')};
                border-radius: 7px;
                background: ${t('color-surface-raised')};
                color: ${t('color-text-secondary')};
                cursor: pointer;
                transition: border-color var(--dur-fast) var(--ease-standard),
                    color var(--dur-fast) var(--ease-standard);
                &:hover { border-color: ${t('color-border-strong')}; color: ${t('color-text-primary')}; }
            }

            & .ctx-dock__body {
                flex: 1;
                min-height: 0;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
            }

            /* Quiet dock footer (draw only): tertiary, minimal height. */
            & .ctx-dock__footer {
                display: none;
                flex: none;
                padding: var(--space-2) var(--space-4) var(--space-3);
                border-top: 1px solid ${t('color-border-default')};
                font-size: 0.7rem;
                color: ${t('color-text-tertiary')};
                &.show { display: block; }
                &.error { color: ${t('color-status-negative')}; }
            }

            /* ── collapsed rail (whole rail expands) ── */
            & .ctx-dock__rail {
                display: none;
                flex-direction: column;
                align-items: center;
                gap: ${s('md')};
                padding: ${s('md')} 0;
                cursor: pointer;
                &:hover .ctx-dock__chevron--ghost { color: ${t('color-text-primary')}; }
            }
            &.is-collapsed .ctx-dock__rail { display: flex; }

            & .ctx-dock__chevron--ghost {
                width: auto;
                height: auto;
                border: none;
                background: transparent;
                color: ${t('color-text-secondary')};
            }

            & .ctx-dock__rail-label {
                writing-mode: vertical-rl;
                ${panelTitle()}
            }

            & .ctx-dock__rail-count {
                writing-mode: vertical-rl;
                font-family: var(--font-mono);
                font-variant-numeric: tabular-nums;
                font-size: 0.8rem;
                font-weight: 700;
                color: ${t('color-accent-primary')};
                &:empty { display: none; }
            }
        }
    `;

    private mode = this.inject(EditorModeService);
    private features = this.inject(FeaturesService);
    private tool = this.inject(DrawToolService);
    private collapsed = new Signal(loadCollapsed());

    /** Current draw stack panel (draw sub-mode only) — publishes the rail badge count. */
    private stackPanel = new Signal<FeatureStackPanelComponent | null>(null);
    private selectionPanel: SelectionPanelComponent | null = null;
    private toolPanel: Component | null = null;
    private mountedToolId: string | null = null;
    private body!: HTMLElement;

    /** Active tool, defaulting to draw before the canvas auto-activates it. */
    private activeTool() {
        return this.mode.activeTool() ?? drawTool;
    }

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { className: () => this.collapsed.get() ? 'ctx-dock is-collapsed' : 'ctx-dock' },
            collapseBtn: { onclick: () => this.setCollapsed(true) },
            overline: { textContent: () => this.dockLabel() },
            railLabel: { textContent: () => this.dockLabel() },
            railCount: {
                textContent: () => this.activeTool().id === DRAW_TOOL_ID
                    ? String(this.stackPanel.get()?.scopeCount.get() ?? 0)
                    : '',
            },
            footer: {
                className: () => {
                    if (this.activeTool().id !== DRAW_TOOL_ID) return 'ctx-dock__footer';
                    return this.statusIsError() ? 'ctx-dock__footer show error' : 'ctx-dock__footer show';
                },
                textContent: () => this.activeTool().id === DRAW_TOOL_ID ? this.statusText() : '',
            },
            rail: {
                onclick: () => this.setCollapsed(false),
                onkeydown: (e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this.setCollapsed(false);
                    }
                },
            },
        });

        this.body = this.ref(frag, 'body');
        return frag;
    }

    onMount(): void {
        // Swap the dock body to the active sub-mode's content. Depends only on
        // the active tool id, so it re-runs on sub-mode switches — not on
        // selection changes (SelectionPanel toggles its own visibility).
        this.track(effect(() => {
            const tool = this.activeTool();
            untrack(() => {
                if (this.mountedToolId === tool.id) return;
                this.mountedToolId = tool.id;
                this.clearBody();
                if (tool.id === DRAW_TOOL_ID) {
                    this.selectionPanel = this.spawn(SelectionPanelComponent, this.body);
                    this.stackPanel.set(this.spawn(FeatureStackPanelComponent, this.body));
                } else if (tool.panel) {
                    const PanelCtor = tool.panel;
                    this.toolPanel = new PanelCtor();
                    this.toolPanel.mount(this.body);
                }
            });
        }));

        // Auto-expand when a selection appears while collapsed (draw only).
        // Never auto-collapses on deselect.
        this.track(effect(() => {
            const hasSelection = this.features.selectedIds.get().size > 0;
            const isDraw = this.activeTool().id === DRAW_TOOL_ID;
            if (hasSelection && isDraw && this.collapsed.peek()) {
                untrack(() => this.setCollapsed(false));
            }
        }));

        this.track(() => this.clearBody());
    }

    private clearBody(): void {
        this.selectionPanel?.destroy();
        this.selectionPanel = null;
        this.stackPanel.get()?.destroy();
        this.stackPanel.set(null);
        this.toolPanel?.destroy();
        this.toolPanel = null;
        if (this.body) this.body.textContent = '';
    }

    private dockLabel(): string {
        const tool = this.activeTool();
        return tool.id === DRAW_TOOL_ID ? 'Feature stack' : tool.label;
    }

    private setCollapsed(value: boolean): void {
        this.collapsed.set(value);
        saveCollapsed(value);
    }

    // ── Draw status footer (moved from the old draw panel) ────────────────
    private statusText(): string {
        if (this.features.saving.get()) return 'Saving…';
        const saveError = this.features.saveError.get();
        if (saveError) return `Save failed: ${saveError.message}`;
        const historyNotice = this.tool.history.notice.get();
        if (historyNotice) return historyNotice;
        const actionNotice = this.tool.actionNotice.get();
        if (actionNotice) return actionNotice;
        if (this.features.loading.get()) return 'Loading features…';
        const error = this.features.error.get();
        if (error) return `Load failed: ${error.message}`;
        const count = this.features.store.items.get().length;
        return `${count} feature${count === 1 ? '' : 's'} · autosaves on close & edit`;
    }

    private statusIsError(): boolean {
        return !!(
            this.features.saveError.get()
            || this.features.error.get()
            || this.tool.history.notice.get()
            || this.tool.actionNotice.get()
        );
    }
}
