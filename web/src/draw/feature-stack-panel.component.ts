import { Component, Signal, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, field } from '../css';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FeaturesService } from './features.service';
import { DrawToolService } from './draw-tool.service';
import { FEATURE_STYLES } from './feature-palette';
import { HelpModalService } from '../editor/help-modal.component';
import type { CourseFeature } from '../../../shared/api/course-features.gen';

const tpl = template(`
    <div class="stack-panel" bind="root" data-testid="stack-panel">
        <div class="stack-panel__section">
            <div class="stack-panel__section-head">
                <h4 class="section-title">Feature stack</h4>
                <button bind="helpBtn" type="button" class="help-btn" title="Keyboard shortcuts (?)">?</button>
            </div>
            <label class="scope-field">Scope
                <select bind="scopeSelect" data-testid="stack-panel-scope"></select>
            </label>
        </div>
        <div bind="rows" class="stack-rows" data-testid="stack-panel-rows"></div>
        <div bind="empty" class="stack-empty">No features in this scope.</div>
        <div class="stack-panel__section reorder-ops">
            <button bind="raiseBtn" type="button" class="op-btn" title="Raise (PageUp)">↑ Raise</button>
            <button bind="lowerBtn" type="button" class="op-btn" title="Lower (PageDown)">↓ Lower</button>
            <button bind="topBtn" type="button" class="op-btn" title="Raise to top (Home)">⤒ Top</button>
            <button bind="bottomBtn" type="button" class="op-btn" title="Lower to bottom (End)">⤓ Bottom</button>
        </div>
    </div>
`);

const rowTpl = template(`
    <div bind="row" class="stack-row" data-testid="stack-row">
        <span bind="swatch" class="type-swatch"></span>
        <span bind="label" class="stack-row__label"></span>
        <span bind="count" class="stack-row__count"></span>
    </div>
`);

/**
 * Right-dock panel for the draw tool (D25/D27): lists the active scope's
 * feature stack topmost-first, click-to-select (bidirectional with
 * `features.selectedIds`), and raise/lower/top/bottom buttons over the
 * current selection — the same ops as the T23 keyboard bindings
 * (PageUp/PageDown/Home/End), just reachable by mouse. Per-feature
 * visibility stays out of scope (left panel's type eye toggles own that).
 */
export class FeatureStackPanelComponent extends Component {
    static styles = `
        .stack-panel {
            display: flex;
            flex-direction: column;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};

            & .stack-panel__section {
                padding: ${s('sm')} ${s('md')};
                border-bottom: 1px solid ${t('color-border-default')};
                display: flex;
                flex-direction: column;
                gap: ${s('sm')};
            }

            & .section-title {
                margin: 0;
                font-size: 0.7rem;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                color: ${t('color-text-secondary')};
            }

            & .stack-panel__section-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: ${s('sm')};
            }

            & .help-btn {
                width: 18px;
                height: 18px;
                flex-shrink: 0;
                padding: 0;
                border: 1px solid ${t('color-border-default')};
                border-radius: 50%;
                background: ${t('color-surface-card')};
                color: ${t('color-text-secondary')};
                font-size: 0.68rem;
                line-height: 1;
                cursor: pointer;
                &:hover { background: ${t('color-surface-sunken')}; color: ${t('color-text-primary')}; }
            }

            & .scope-field { ${field()} }

            & .stack-rows {
                display: flex;
                flex-direction: column;
                overflow-y: auto;
            }

            & .stack-row {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                padding: ${s('xs')} ${s('md')};
                cursor: pointer;
                border-bottom: 1px solid ${t('color-border-default')};
                &:hover { background: ${t('color-surface-sunken')}; }
                &.selected {
                    background: ${t('color-surface-sunken')};
                    box-shadow: inset 3px 0 0 ${t('color-accent-primary')};
                }
            }

            & .type-swatch {
                width: 12px;
                height: 12px;
                flex-shrink: 0;
                border-radius: 3px;
                border: 1px solid rgba(0, 0, 0, 0.25);
            }

            & .stack-row__label {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            & .stack-row__count {
                flex-shrink: 0;
                font-size: 0.7rem;
                color: ${t('color-text-secondary')};
            }

            & .stack-empty {
                display: none;
                padding: ${s('sm')} ${s('md')};
                font-size: 0.75rem;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
            }

            & .reorder-ops {
                flex-direction: row;
                flex-wrap: wrap;
            }
            & .op-btn {
                flex: 1 1 auto;
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.72rem;
                ${btn(t('radius-sm'))}
                &:disabled { opacity: 0.4; cursor: default; }
            }
        }
    `;

    private tool = this.inject(DrawToolService);
    private features = this.inject(FeaturesService);
    private courseDetail = this.inject(CourseDetailService);
    private helpModal = this.inject(HelpModalService);

    /**
     * Scope filter (course-level = null). Follows the draw target until the
     * user explicitly changes this filter; selecting a shape on the map still
     * follows the selection into its group (see the effects below).
     */
    private scopeHoleId = new Signal<string | null>(this.tool.drawHoleId.peek());
    private scopeUserPinned = false;
    private scopeSelect!: HTMLSelectElement;
    private rowsHost!: HTMLElement;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            helpBtn: { onclick: () => this.helpModal.show() },
            empty: {
                className: () => this.stack().length === 0 ? 'stack-empty show' : 'stack-empty',
            },
            raiseBtn: {
                onclick: () => void this.features.raise(this.selectedIds()),
                disabled: () => this.selectedIds().length === 0,
            },
            lowerBtn: {
                onclick: () => void this.features.lower(this.selectedIds()),
                disabled: () => this.selectedIds().length === 0,
            },
            topBtn: {
                onclick: () => void this.features.raiseToTop(this.selectedIds()),
                disabled: () => this.selectedIds().length === 0,
            },
            bottomBtn: {
                onclick: () => void this.features.lowerToBottom(this.selectedIds()),
                disabled: () => this.selectedIds().length === 0,
            },
        });

        this.scopeSelect = this.ref(frag, 'scopeSelect') as HTMLSelectElement;
        this.scopeSelect.addEventListener('change', () => {
            this.scopeUserPinned = true;
            this.scopeHoleId.set(this.scopeSelect.value || null);
        });

        // Scope options: "Course level" + one per hole. Rebuilt on holes
        // load / scope changes. Unlike the draw panel's hole select
        // (draw-panel.component.ts:546), this one FILTERS the row list
        // rather than assigning a feature's hole.
        this.track(effect(() => {
            const holes = this.courseDetail.holes.get();
            const value = this.scopeHoleId.get() ?? '';
            this.scopeSelect.textContent = '';
            const courseLevel = document.createElement('option');
            courseLevel.value = '';
            courseLevel.textContent = 'Course level';
            this.scopeSelect.appendChild(courseLevel);
            for (const hole of holes) {
                const option = document.createElement('option');
                option.value = hole.id;
                option.textContent = `Hole ${hole.number} (par ${hole.par})`;
                this.scopeSelect.appendChild(option);
            }
            this.scopeSelect.value = value;
        }));

        this.rowsHost = this.ref(frag, 'rows');
        this.$each(
            this.rowsHost,
            () => this.stack(),
            (feature, _index, track) => this.renderRow(feature, track),
            feature => feature.id,
        );

        // Follow the draw target while the stack filter is still implicit.
        this.track(effect(() => {
            const drawHoleId = this.tool.drawHoleId.get();
            if (this.scopeUserPinned) return;
            untrack(() => this.scopeHoleId.set(drawHoleId));
        }));

        // Follow selection: a shape selected on the map (or via alt-cycle)
        // switches scope to its group and scrolls its row into view. The
        // scroll happens on a microtask so it runs after $each has moved the
        // row into the (possibly just-switched) scope's list.
        this.track(effect(() => {
            const selected = this.features.selected.get();
            if (!selected) return;
            untrack(() => {
                this.scopeHoleId.set(selected.holeId);
                queueMicrotask(() => {
                    this.rowsHost
                        .querySelector(`[data-feature-id="${CSS.escape(selected.id)}"]`)
                        ?.scrollIntoView({ block: 'nearest' });
                });
            });
        }));

        return frag;
    }

    /** Current scope's stack, topmost-first (D27 panel convention). */
    private stack(): CourseFeature[] {
        return [...this.features.stackFor(this.scopeHoleId.get())].reverse();
    }

    private selectedIds(): string[] {
        return [...this.features.selectedIds.get()];
    }

    private renderRow(feature: CourseFeature, track: (d: () => void) => void): HTMLElement {
        const el = this.wireEl(rowTpl, {
            row: {
                onclick: () => this.features.select(feature.id),
                className: () => this.features.selectedIds.get().has(feature.id) ? 'stack-row selected' : 'stack-row',
            },
            swatch: {
                'style': () => {
                    const style = FEATURE_STYLES[this.liveType(feature.id) as keyof typeof FEATURE_STYLES];
                    return style ? `background:${style.fill}; border-color:${style.outline}` : '';
                },
            },
            label: { textContent: () => FEATURE_STYLES[this.liveType(feature.id) as keyof typeof FEATURE_STYLES]?.label ?? this.liveType(feature.id) },
            count: { textContent: () => `${this.pointCount(feature.id)} pts` },
        }, track);
        el.dataset.featureId = feature.id;
        return el;
    }

    private liveFeature(id: string): CourseFeature | undefined {
        return this.features.store.items.get().find(f => f.id === id);
    }

    private liveType(id: string): string {
        return this.liveFeature(id)?.type ?? '';
    }

    private pointCount(id: string): number {
        const f = this.liveFeature(id);
        if (!f) return 0;
        return f.geometry.rings.reduce((sum, r) => sum + r.points.length, 0);
    }
}
