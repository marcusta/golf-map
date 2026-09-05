import { Component, Computed, Signal, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, field, selectedRow, metric } from '../css';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FeaturesService } from './features.service';
import { DrawToolService } from './draw-tool.service';
import { FEATURE_STYLES } from './feature-palette';
import { icon } from '../ui/icons';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import {
    generatedBadgeLabel,
    generatedGroupLabel,
    generatedHeightLabel,
    groupStackRows,
    isGeneratedFeature,
    type StackRow,
} from './generated-features';

const tpl = template(`
    <div class="stack-panel" bind="root" data-testid="stack-panel">
        <div class="stack-panel__section">
            <label class="scope-field">Scope
                <select bind="scopeSelect" data-testid="stack-panel-scope"></select>
            </label>
        </div>
        <div bind="rows" class="stack-rows" data-testid="stack-panel-rows"></div>
        <div bind="empty" class="stack-empty">No features in this scope.</div>
        <div bind="reorderOps" class="stack-panel__section reorder-ops">
            <button bind="raiseBtn" type="button" class="op-btn" title="Raise (PageUp)">${icon('arrow-up')} Raise</button>
            <button bind="lowerBtn" type="button" class="op-btn" title="Lower (PageDown)">${icon('arrow-down')} Lower</button>
            <button bind="topBtn" type="button" class="op-btn" title="Raise to top (Home)">${icon('arrow-up-to-line')} Top</button>
            <button bind="bottomBtn" type="button" class="op-btn" title="Lower to bottom (End)">${icon('arrow-down-to-line')} Bottom</button>
        </div>
    </div>
`);

const rowTpl = template(`
    <div bind="row" class="stack-row" data-testid="stack-row">
        <span bind="swatch" class="type-swatch"></span>
        <span bind="label" class="stack-row__label"></span>
        <span bind="badge" class="stack-row__badge"></span>
        <span bind="count" class="stack-row__count"></span>
        <button bind="eye" type="button" class="stack-row__eye" data-testid="stack-row-eye"></button>
    </div>
`);

/** One collapsed row per generated (source, type) group — never N tree rows. */
const groupRowTpl = template(`
    <div bind="row" class="stack-row stack-row--group" data-testid="stack-group-row">
        <span bind="swatch" class="type-swatch"></span>
        <span bind="label" class="stack-row__label"></span>
        <span bind="count" class="stack-row__count"></span>
        <button bind="eye" type="button" class="stack-row__eye" data-testid="stack-group-eye"></button>
    </div>
`);

/**
 * Feature-stack panel body (D25/D27): lists the active scope's feature stack
 * topmost-first, click-to-select (bidirectional with `features.selectedIds`),
 * and raise/lower/top/bottom buttons over the current selection — the same
 * ops as the T23 keyboard bindings (PageUp/PageDown/Home/End), just reachable
 * by mouse. Per-feature visibility stays out of scope (the command bar's
 * feature-type dropdown owns the type eye toggles).
 *
 * Hosted inside the permanent right "Feature stack" dock (FeatureDockComponent),
 * which owns the dock header + collapse; this component is just the scope
 * select + row list + reorder ops, and publishes `scopeCount` for the dock's
 * collapsed rail badge.
 */
export class FeatureStackPanelComponent extends Component {
    static styles = `
        .stack-panel {
            /* Flat dock body: the dock provides the surface + max-height bound;
               min-height:0 here lets .stack-rows scroll INSIDE while the panel
               hugs content. */
            display: flex;
            flex-direction: column;
            min-height: 0;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};

            /* Law 03: space carries structure — interior padding space-4,
               no hairline after the header (the ONLY divider sits between
               the list and the actions area, see .reorder-ops). */
            & .stack-panel__section {
                padding: var(--space-4) var(--space-4) var(--space-3);
                display: flex;
                flex-direction: column;
                gap: var(--space-2);
            }

            & .scope-field { ${field()} }

            /* The long list scrolls INSIDE the panel (law 01); rows carry
               structure with spacing + hover tint, not hairlines (law 03). */
            & .stack-rows {
                display: flex;
                flex-direction: column;
                gap: 2px;
                padding: 0 var(--space-2) var(--space-3);
                overflow-y: auto;
                min-height: 0;
            }

            & .stack-row {
                display: flex;
                align-items: center;
                gap: var(--space-2);
                padding: var(--space-2);
                border-radius: ${t('radius')};
                cursor: pointer;
                transition: background var(--dur-fast) var(--ease-standard);
                &:hover { background: color-mix(in srgb, ${t('color-text-primary')} 6%, transparent); }
                &.selected {
                    ${selectedRow()}
                    & .stack-row__label { font-weight: 600; }
                }
                /* Hidden features stay listed but read as absent. */
                &.hidden {
                    & .type-swatch, & .stack-row__label, & .stack-row__count { opacity: 0.4; }
                }
            }

            /* Eye toggle: quiet until the row is hovered — except a hidden
               row's closed eye, which stays fully visible as the state cue
               (Inkscape convention). */
            & .stack-row__eye {
                flex-shrink: 0;
                display: inline-flex;
                align-items: center;
                border: none;
                background: none;
                padding: 2px;
                cursor: pointer;
                color: ${t('color-text-secondary')};
                opacity: 0.25;
                transition: opacity var(--dur-fast) var(--ease-standard);
            }
            & .stack-row:hover .stack-row__eye,
            & .stack-row.hidden .stack-row__eye { opacity: 1; }

            & .type-swatch {
                width: 14px;
                height: 14px;
                flex-shrink: 0;
                border-radius: ${t('radius-sm')};
                border: 1px solid rgba(0, 0, 0, 0.25);
            }

            /* Law 05: labels never truncate — the 280 bucket fits the
               longest palette label plus the mono count column. */
            & .stack-row__label {
                flex: 1;
                white-space: nowrap;
            }

            /* Generated rows: provenance badge; the group row itself is
               not selectable (nothing to edit), only toggled. */
            & .stack-row__badge {
                display: none;
                flex-shrink: 0;
                padding: 0 ${s('xs')};
                border-radius: ${t('radius-sm')};
                font-size: 0.65rem;
                background: color-mix(in srgb, ${t('color-text-primary')} 8%, transparent);
                color: ${t('color-text-secondary')};
                &.show { display: inline-block; }
            }
            & .stack-row--group {
                cursor: default;
                & .stack-row__label { color: ${t('color-text-secondary')}; }
            }

            & .stack-row__count {
                flex-shrink: 0;
                text-align: right;
                font-size: 0.75rem;
                color: ${t('color-text-tertiary')};
                ${metric()}
            }

            & .stack-empty {
                display: none;
                padding: 0 var(--space-4) var(--space-3);
                font-size: 0.75rem;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
            }

            /* Law 04 (disclosure on demand): the order controls render only
               while a row is selected — contextual, not permanent. The
               hairline above them is the one allowed major-group divider
               (list ↔ actions, law 03). */
            & .reorder-ops {
                display: none;
                border-top: 1px solid ${t('color-border-default')};
                padding: var(--space-3) var(--space-4) var(--space-4);
                flex-direction: row;
                flex-wrap: wrap;
                &.show { display: flex; }
            }
            & .op-btn {
                flex: 1 1 auto;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 3px;
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

    /**
     * Scope filter (course-level = null). Follows the draw target until the
     * user explicitly changes this filter; selecting a shape on the map still
     * follows the selection into its group (see the effects below).
     */
    private scopeHoleId = new Signal<string | null>(this.tool.drawHoleId.peek());
    private scopeUserPinned = false;
    private scopeSelect!: HTMLSelectElement;
    private rowsHost!: HTMLElement;

    /** Row count in the current scope (generated groups count once) — the dock's collapsed rail badge. */
    readonly scopeCount = new Computed(() => this.stack().length);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            empty: {
                className: () => this.stack().length === 0 ? 'stack-empty show' : 'stack-empty',
            },
            // Contextual controls (law 04): reorder ops appear only while a
            // row is selected — selection is the context they act on.
            reorderOps: {
                className: () => this.selectedIds().length > 0
                    ? 'stack-panel__section reorder-ops show'
                    : 'stack-panel__section reorder-ops',
            },
            // Reorder is a hand-drawn verb: disabled while any generated
            // (read-only) row is in the selection.
            raiseBtn: {
                onclick: () => void this.features.raise(this.selectedIds()),
                disabled: () => !this.canReorder(),
            },
            lowerBtn: {
                onclick: () => void this.features.lower(this.selectedIds()),
                disabled: () => !this.canReorder(),
            },
            topBtn: {
                onclick: () => void this.features.raiseToTop(this.selectedIds()),
                disabled: () => !this.canReorder(),
            },
            bottomBtn: {
                onclick: () => void this.features.lowerToBottom(this.selectedIds()),
                disabled: () => !this.canReorder(),
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
            (row, _index, track) => row.kind === 'group'
                ? this.renderGroupRow(row, track)
                : this.renderRow(row.feature, track),
            row => row.key,
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

    /**
     * Current scope's stack, topmost-first (D27 panel convention), with
     * generated features collapsed into one group row per source/type
     * ("Trees (lidar) · 2200") and only the selected generated ones listed
     * individually beneath it.
     */
    private stack(): StackRow[] {
        const topDown = [...this.features.stackFor(this.scopeHoleId.get())].reverse();
        return groupStackRows(topDown, this.features.selectedIds.get());
    }

    private selectedIds(): string[] {
        return [...this.features.selectedIds.get()];
    }

    private canReorder(): boolean {
        const items = this.features.selectedFeatures.get();
        return items.length > 0 && items.every(f => !isGeneratedFeature(f));
    }

    private renderGroupRow(group: Extract<StackRow, { kind: 'group' }>, track: (d: () => void) => void): HTMLElement {
        const hidden = () => this.features.hiddenSources.get().has(group.source);
        const el = this.wireEl(groupRowTpl, {
            row: {
                className: () => hidden() ? 'stack-row stack-row--group hidden' : 'stack-row stack-row--group',
            },
            eye: {
                onclick: (e: Event) => {
                    e.stopPropagation();
                    this.features.toggleSourceVisibility(group.source);
                },
                innerHTML: () => icon(hidden() ? 'eye-off' : 'eye', 16),
                title: () => hidden() ? 'Show' : 'Hide',
            },
            swatch: {
                'style': () => {
                    const style = FEATURE_STYLES[group.type as keyof typeof FEATURE_STYLES];
                    return style ? `background:${style.fill}; border-color:${style.outline}` : '';
                },
            },
            label: { textContent: generatedGroupLabel(group.type, group.source) },
            count: { textContent: () => String(this.liveGroupCount(group)) },
        }, track);
        el.dataset.source = group.source;
        el.dataset.featureType = group.type;
        return el;
    }

    /** Live member count (the row is keyed by source/type and outlives deletes). */
    private liveGroupCount(group: Extract<StackRow, { kind: 'group' }>): number {
        return this.features.store.items.get()
            .filter(f => f.source === group.source && f.type === group.type && f.holeId === this.scopeHoleId.get())
            .length;
    }

    private renderRow(feature: CourseFeature, track: (d: () => void) => void): HTMLElement {
        const el = this.wireEl(rowTpl, {
            row: {
                onclick: () => this.features.select(feature.id),
                className: () => {
                    const classes = ['stack-row'];
                    if (this.features.selectedIds.get().has(feature.id)) classes.push('selected');
                    if (this.features.hiddenIds.get().has(feature.id)) classes.push('hidden');
                    return classes.join(' ');
                },
            },
            eye: {
                onclick: (e: Event) => {
                    e.stopPropagation(); // eye toggles visibility, never selects
                    this.features.toggleFeatureVisibility(feature.id);
                },
                innerHTML: () => icon(this.features.hiddenIds.get().has(feature.id) ? 'eye-off' : 'eye', 16),
                title: () => this.features.hiddenIds.get().has(feature.id) ? 'Show' : 'Hide',
            },
            swatch: {
                'style': () => {
                    const style = FEATURE_STYLES[this.liveType(feature.id) as keyof typeof FEATURE_STYLES];
                    return style ? `background:${style.fill}; border-color:${style.outline}` : '';
                },
            },
            label: { textContent: () => FEATURE_STYLES[this.liveType(feature.id) as keyof typeof FEATURE_STYLES]?.label ?? this.liveType(feature.id) },
            badge: {
                className: () => this.generatedBadge(feature.id) ? 'stack-row__badge show' : 'stack-row__badge',
                textContent: () => this.generatedBadge(feature.id) ?? '',
            },
            count: { innerHTML: () => `${this.pointCount(feature.id)}<span class="metric__unit"> pts</span>` },
        }, track);
        el.dataset.featureId = feature.id;
        if (isGeneratedFeature(feature)) el.dataset.generated = 'true';
        return el;
    }

    private liveFeature(id: string): CourseFeature | undefined {
        return this.features.store.items.get().find(f => f.id === id);
    }

    private liveType(id: string): string {
        return this.liveFeature(id)?.type ?? '';
    }

    /** "Generated from lidar · Height ~13 m" for generated rows, null otherwise. */
    private generatedBadge(id: string): string | null {
        const f = this.liveFeature(id);
        if (!f) return null;
        const badge = generatedBadgeLabel(f);
        if (!badge) return null;
        const height = generatedHeightLabel(f);
        return height ? `${badge} · ${height}` : badge;
    }

    private pointCount(id: string): number {
        const f = this.liveFeature(id);
        if (!f) return 0;
        return f.geometry.rings.reduce((sum, r) => sum + r.points.length, 0);
    }
}
