import { Component, Signal, batch, effect, template, untrack } from '@basics/core/client/core';
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
    groupRowKey,
    groupStackRows,
    isGeneratedFeature,
    type StackRow,
} from './generated-features';

/** One scope member: feature id plus its generated group key (null when hand-drawn). */
type ScopeEntry = { id: string; group: string | null };

function sameEntries(a: readonly ScopeEntry[], b: readonly ScopeEntry[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i]!.id !== b[i]!.id || a[i]!.group !== b[i]!.group) return false;
    return true;
}

/** Serial per entity signal object (see the `$each` key in `render`). */
const entitySerials = new WeakMap<object, number>();
let nextEntitySerial = 0;
function entitySerial(entity: object): number {
    let n = entitySerials.get(entity);
    if (n === undefined) {
        n = ++nextEntitySerial;
        entitySerials.set(entity, n);
    }
    return n;
}

function option(value: string, text: string): HTMLOptionElement {
    const el = document.createElement('option');
    el.value = value;
    el.textContent = text;
    return el;
}

/** "Generated from lidar · Height ~13 m" for generated rows, null otherwise. */
function generatedBadge(f: CourseFeature): string | null {
    const badge = generatedBadgeLabel(f);
    if (!badge) return null;
    const height = generatedHeightLabel(f);
    return height ? `${badge} · ${height}` : badge;
}

function pointCount(f: CourseFeature): number {
    return f.geometry.rings.reduce((sum, r) => sum + r.points.length, 0);
}

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

    /**
     * The scope's members topmost-first. Replaced only when membership,
     * order or grouping changes, so a geometry or type edit leaves it (and
     * the row list below) untouched.
     */
    private scopeEntries = new Signal<readonly ScopeEntry[]>([]);
    /** Live member count per generated group row key, for the current scope. */
    private groupCounts = new Signal<ReadonlyMap<string, number>>(new Map());
    /** Rows handed to `$each`; replaced only when the row keys change. */
    private rows = new Signal<StackRow[]>([]);
    /** Feature row elements by id: selection and visibility toggle classes here directly. */
    private rowEls = new Map<string, HTMLElement>();
    /** Last plain or Cmd/Ctrl-clicked row: the fixed end of a Shift-click range. */
    private anchorId: string | null = null;

    /** Row count in the current scope (generated groups count once) — the dock's collapsed rail badge. */
    readonly scopeCount = new Signal(0);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            empty: {
                className: () => this.scopeCount.get() === 0 ? 'stack-empty show' : 'stack-empty',
            },
            // Contextual controls (law 04): reorder ops appear only while a
            // row is selected — selection is the context they act on.
            reorderOps: {
                className: () => this.features.selectedIds.get().size > 0
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

        // Scope options: "Course level" + one per hole, built once per hole
        // list. Unlike the selection panel's move select, this one FILTERS
        // the row list rather than assigning a feature's hole.
        this.track(effect(() => {
            const holes = this.courseDetail.holes.get();
            untrack(() => {
                this.scopeSelect.textContent = '';
                this.scopeSelect.appendChild(option('', 'Course level'));
                for (const hole of holes) this.scopeSelect.appendChild(option(hole.id, `Hole ${hole.number} (par ${hole.par})`));
                this.scopeSelect.value = this.scopeHoleId.peek() ?? '';
            });
        }));
        this.track(effect(() => {
            const value = this.scopeHoleId.get() ?? '';
            if (this.scopeSelect.value !== value) this.scopeSelect.value = value;
        }));

        // Membership + order of the scope. Runs on every store change (an
        // O(N) scan with no DOM work); publishes only when the result differs.
        this.track(effect(() => {
            const scope = this.scopeHoleId.get();
            const members = this.features.stackFor(scope).reverse();
            const next: ScopeEntry[] = members.map(f => ({
                id: f.id,
                group: isGeneratedFeature(f) ? groupRowKey(f.source!, f.type) : null,
            }));
            untrack(() => {
                if (sameEntries(this.scopeEntries.peek(), next)) return;
                const counts = new Map<string, number>();
                for (const e of next) if (e.group) counts.set(e.group, (counts.get(e.group) ?? 0) + 1);
                batch(() => {
                    this.groupCounts.set(counts);
                    this.scopeEntries.set(next);
                });
            });
        }));

        // Row list: generated members collapse into one group row, selected
        // generated members list beneath it. Selection is read here only
        // for that expansion; row highlight is the diff effect below.
        this.track(effect(() => {
            const entries = this.scopeEntries.get();
            const selected = this.features.selectedIds.get();
            untrack(() => {
                const ids = this.features.featureIdSet.peek();
                const topDown = entries.filter(e => ids.has(e.id)).map(e => this.features.store.item(e.id).peek());
                const next = groupStackRows(topDown, selected);
                const prev = this.rows.peek();
                if (next.length === prev.length && next.every((r, i) => r.key === prev[i]!.key)) return;
                this.rows.set(next);
                this.scopeCount.set(next.length);
            });
        }));

        this.rowsHost = this.ref(frag, 'rows');
        this.$each(
            this.rowsHost,
            this.rows,
            (row, _index, track) => row.kind === 'group'
                ? this.renderGroupRow(row, track)
                : this.renderRow(row.feature.id, track),
            // A feature id that leaves the store and comes back gets a new
            // entity signal; the serial makes that a new row bound to it.
            row => row.kind === 'group' ? row.key : `${row.key}#${entitySerial(this.features.store.item(row.key))}`,
        );

        // Selection highlight: toggle only the rows whose membership changed.
        let shownSelection: ReadonlySet<string> = new Set();
        this.track(effect(() => {
            const next = this.features.selectedIds.get();
            untrack(() => {
                for (const id of shownSelection) if (!next.has(id)) this.rowEls.get(id)?.classList.remove('selected');
                for (const id of next) if (!shownSelection.has(id)) this.rowEls.get(id)?.classList.add('selected');
                shownSelection = next;
            });
        }));

        // Per-feature visibility: same diff for the hidden class + eye.
        let shownHidden: ReadonlySet<string> = new Set();
        this.track(effect(() => {
            const next = this.features.hiddenIds.get();
            untrack(() => {
                for (const id of shownHidden) if (!next.has(id)) this.paintHidden(id, false);
                for (const id of next) if (!shownHidden.has(id)) this.paintHidden(id, true);
                shownHidden = next;
            });
        }));

        // Follow the draw target while the stack filter is still implicit.
        this.track(effect(() => {
            const drawHoleId = this.tool.drawHoleId.get();
            if (this.scopeUserPinned) return;
            untrack(() => this.scopeHoleId.set(drawHoleId));
        }));

        // Follow selection: a shape selected on the map (or via alt-cycle)
        // switches scope to its group and scrolls its row into view. Acts on
        // a new selected id or a hole change only, not on every edit of the
        // selected feature. The scroll runs on a microtask, after the row
        // list has caught up with the (possibly just-switched) scope.
        let followed: { id: string; holeId: string | null } | null = null;
        this.track(effect(() => {
            const selected = this.features.selected.get();
            if (!selected) {
                followed = null;
                return;
            }
            if (followed && followed.id === selected.id && followed.holeId === selected.holeId) return;
            followed = { id: selected.id, holeId: selected.holeId };
            untrack(() => {
                this.scopeHoleId.set(selected.holeId);
                queueMicrotask(() => {
                    this.rowEls.get(selected.id)?.scrollIntoView({ block: 'nearest' });
                });
            });
        }));

        return frag;
    }

    private selectedIds(): string[] {
        return [...this.features.selectedIds.get()];
    }

    private canReorder(): boolean {
        const items = this.features.selectedFeatures.get();
        return items.length > 0 && items.every(f => !isGeneratedFeature(f));
    }

    /**
     * Row click. Plain: select this row. Cmd/Ctrl: toggle it. Shift: add
     * every feature row between the anchor (the last plain or Cmd/Ctrl
     * click) and this row to the selection.
     */
    private onRowClick(id: string, e: MouseEvent): void {
        if (e.shiftKey && this.anchorId && this.anchorId !== id) {
            const order = this.rows.peek().flatMap(r => r.kind === 'feature' ? [r.key] : []);
            const a = order.indexOf(this.anchorId);
            const b = order.indexOf(id);
            if (a >= 0 && b >= 0) {
                const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
                this.features.setSelection([...this.features.selectedIds.peek(), ...range]);
                return;
            }
        }
        this.anchorId = id;
        if (e.metaKey || e.ctrlKey) this.features.toggleSelected(id);
        else this.features.select(id);
    }

    private paintHidden(id: string, hidden: boolean): void {
        const el = this.rowEls.get(id);
        if (!el) return;
        el.classList.toggle('hidden', hidden);
        const eye = el.querySelector<HTMLElement>('[bind="eye"]')!;
        eye.innerHTML = icon(hidden ? 'eye-off' : 'eye', 16);
        eye.title = hidden ? 'Show' : 'Hide';
    }

    private renderGroupRow(group: Extract<StackRow, { kind: 'group' }>, track: (d: () => void) => void): HTMLElement {
        const hidden = () => this.features.hiddenSources.get().has(group.source);
        const style = FEATURE_STYLES[group.type as keyof typeof FEATURE_STYLES];
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
            swatch: { 'style': style ? `background:${style.fill}; border-color:${style.outline}` : '' },
            label: { textContent: generatedGroupLabel(group.type, group.source) },
            count: { textContent: () => String(this.groupCounts.get().get(group.key) ?? 0) },
        }, track);
        el.dataset.source = group.source;
        el.dataset.featureType = group.type;
        return el;
    }

    /**
     * One feature row, bound to that feature's entity signal: an edit to
     * this feature re-runs this row's one effect, an edit to any other
     * feature runs nothing here. DOM writes happen only for values that
     * changed.
     */
    private renderRow(id: string, track: (d: () => void) => void): HTMLElement {
        const entity = this.features.store.item(id);
        const el = this.wireEl(rowTpl, {
            row: { onclick: (e: Event) => this.onRowClick(id, e as MouseEvent) },
            eye: {
                onclick: (e: Event) => {
                    e.stopPropagation(); // eye toggles visibility, never selects
                    this.features.toggleFeatureVisibility(id);
                },
            },
        }, track);
        const swatch = el.querySelector<HTMLElement>('[bind="swatch"]')!;
        const label = el.querySelector<HTMLElement>('[bind="label"]')!;
        const badge = el.querySelector<HTMLElement>('[bind="badge"]')!;
        const count = el.querySelector<HTMLElement>('[bind="count"]')!;
        el.dataset.featureId = id;
        if (isGeneratedFeature(entity.peek())) el.dataset.generated = 'true';

        let shown: { type: string; badge: string | null; points: number } | null = null;
        track(effect(() => {
            const f = entity.get();
            const next = { type: f.type, badge: generatedBadge(f), points: pointCount(f) };
            if (!shown || shown.type !== next.type) {
                const style = FEATURE_STYLES[next.type as keyof typeof FEATURE_STYLES];
                swatch.setAttribute('style', style ? `background:${style.fill}; border-color:${style.outline}` : '');
                label.textContent = style?.label ?? next.type;
            }
            if (!shown || shown.badge !== next.badge) {
                badge.className = next.badge ? 'stack-row__badge show' : 'stack-row__badge';
                badge.textContent = next.badge ?? '';
            }
            if (!shown || shown.points !== next.points) {
                count.innerHTML = `${next.points}<span class="metric__unit"> pts</span>`;
            }
            shown = next;
        }));

        el.classList.toggle('selected', this.features.selectedIds.peek().has(id));
        this.rowEls.set(id, el);
        this.paintHidden(id, this.features.hiddenIds.peek().has(id));
        track(() => {
            if (this.rowEls.get(id) === el) this.rowEls.delete(id);
        });
        return el;
    }
}
