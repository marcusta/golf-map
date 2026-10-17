import { Component, Computed, Signal, batch, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, field, input, selectedRow, metric } from '../css';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FeaturesService, fillScopeOptions, scopeFromKey, scopeKey, scopeOf } from './features.service';
import { DrawToolService } from './draw-tool.service';
import { FEATURE_STYLES } from './feature-palette';
import { icon } from '../ui/icons';
import { MapService } from '../map/map.service';
import { sweref99tmToWgs84 } from '../geo/transform';
import { findByShapeName, svgShapeName } from '../export/svg-exclusions';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import { ROUGHS_LAYER } from '../../../shared/render/stack-key';
import { ZoneTypesService, zoneTypeKeyOf, zoneVariantKeyOf } from '../zones/zone-types.service';
import { zoneBlendOf, zoneExtraPalettesOf } from '../../../shared/features/zone-layers';
import { TREE_AREA_TYPE, speciesMixLabel, speciesMixOf, treeAreaNameOf } from '../../../shared/features/tree-areas';
import {
    generatedBadgeLabel,
    generatedGroupLabel,
    generatedHeightLabel,
    groupRowKey,
    groupStackRows,
    isGeneratedFeature,
    type StackRow,
} from './generated-features';

/**
 * One scope member: feature id plus its generated group key (null when
 * hand-drawn), or a hole heading of the "All zones" list (`header` set, `id`
 * its row key).
 */
type ScopeEntry = { id: string; group: string | null; header?: string };

function sameEntries(a: readonly ScopeEntry[], b: readonly ScopeEntry[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i]!.id !== b[i]!.id || a[i]!.group !== b[i]!.group || a[i]!.header !== b[i]!.header) return false;
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
        <div bind="layerControls" class="stack-panel__section">
            <button bind="closeLayerOrder" type="button" class="op-btn" data-testid="layer-order-done">Done · back to contents</button>
            <label class="scope-field">Layers · top to bottom
                <select bind="layerList" size="8" class="layer-list" data-testid="draw-layers" aria-label="Layers"></select>
            </label>
            <div class="drawing-group-ops">
                <button bind="layerUp" type="button" class="op-btn" data-testid="layer-up">${icon('arrow-up')} Move up</button>
                <button bind="layerDown" type="button" class="op-btn" data-testid="layer-down">${icon('arrow-down')} Move down</button>
            </div>
        </div>
        <div class="stack-panel__section content-view">
            <label class="scope-field">Draw on
                <select bind="drawTarget" data-testid="draw-target-select"></select>
            </label>
            <details class="drawing-groups">
                <summary>Drawing groups (SVG only)</summary>
                <input bind="groupName" type="text" required maxlength="80" placeholder="Group name" aria-label="Drawing group name" data-testid="drawing-group-name" />
                <div class="drawing-group-ops">
                    <button bind="addGroup" type="button" class="op-btn" data-testid="drawing-group-add">Add group</button>
                    <button bind="renameGroup" type="button" class="op-btn" data-testid="drawing-group-rename">Rename</button>
                    <button bind="removeGroup" type="button" class="op-btn" data-testid="drawing-group-remove">Delete empty group</button>
                </div>
                <div bind="groupError" class="stack-empty show" role="status"></div>
            </details>
        </div>
        <div class="stack-panel__section content-view">
            <label class="scope-field">Scope
                <select bind="scopeSelect" data-testid="stack-panel-scope"></select>
            </label>
            <button bind="holeToggle" type="button" class="layer-toggle" data-testid="stack-hole-toggle"></button>
            <input bind="findShape" type="search" class="find-shape" placeholder="Find shape id, e.g. hole_5_15c"
                aria-label="Find shape by id" title="Shape id from the GSPro SVG or an OPCD mesh name; Enter selects and zooms to it" data-testid="stack-find-shape" />
            <button bind="editLayerOrder" type="button" class="op-btn" data-testid="layer-order-edit">Edit layer order…</button>
            <button bind="roughsToggle" type="button" class="layer-toggle" data-testid="stack-roughs-toggle"></button>
        </div>
        <div bind="rows" class="stack-rows content-view" data-testid="stack-panel-rows"></div>
        <div bind="empty" class="stack-empty content-view">No features in this scope.</div>
        <div bind="reorderOps" class="stack-panel__section reorder-ops content-view">
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

/** A hole's heading in the Vegetation mode's "All zones" list. */
const headerRowTpl = template(`
    <div bind="row" class="stack-header" data-testid="stack-header-row"></div>
`);

/**
 * The Vegetation mode's default list: every zone, under a heading per hole
 * (course level first). A zone's hole is only where it is filed (D-VZ14),
 * so this is how to find one; the per-scope stacks stay a pick away.
 */
export const ALL_ZONES_KEY = '__all-zones';

type PanelRow = StackRow | { kind: 'header'; key: string; label: string };

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
            & .find-shape {
                ${input()} width: 100%; box-sizing: border-box; padding: ${s('sm')} ${s('md')}; font-size: 0.8rem;
                &.not-found { outline: 1px solid ${t('color-status-negative')}; }
            }
            & .layer-list {
                min-height: 12rem;
                & option { padding: ${s('xs')} ${s('sm')}; }
            }
            & .drawing-groups {
                font-size: 0.75rem;
                & summary { cursor: pointer; color: ${t('color-text-secondary')}; }
                & input { ${input()} width: 100%; box-sizing: border-box; margin-top: ${s('sm')}; padding: ${s('sm')} ${s('md')}; font-size: 0.875rem; }
            }
            & .drawing-group-ops { display: flex; flex-wrap: wrap; gap: ${s('xs')}; margin-top: ${s('sm')}; }

            /* Roughs layer eye: editor-only view state (the planner and the
               GSPro export always include the layer). */
            & .layer-toggle {
                display: inline-flex;
                align-items: center;
                gap: var(--space-2);
                align-self: flex-start;
                border: none;
                background: none;
                padding: 2px 0;
                cursor: pointer;
                font: inherit;
                color: ${t('color-text-secondary')};
                &:hover { color: ${t('color-text-primary')}; }
                &[aria-pressed="true"] { color: ${t('color-text-primary')}; }
            }

            /* The long list scrolls INSIDE the panel (law 01); rows carry
               structure with spacing + hover tint, not hairlines (law 03). */
            & .stack-header {
                padding: ${s('sm')} ${s('xs')} ${s('xs')};
                font-size: 0.7rem;
                font-weight: 600;
                letter-spacing: 0.06em;
                text-transform: uppercase;
                color: ${t('color-text-secondary')};
            }
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
            /* Override contextual .show rules while editing the layer order. */
            &.stack-panel--ordering > .content-view { display: none; }
        }
    `;

    private tool = this.inject(DrawToolService);
    private features = this.inject(FeaturesService);
    private courseDetail = this.inject(CourseDetailService);
    private zoneTypes = this.inject(ZoneTypesService);
    private map = this.inject(MapService);
    /** Vegetation mode: the list defaults to every zone, grouped by hole. */
    private vegetation = new Computed(() => this.tool.scope.get() === 'vegetation');

    /**
     * Scope filter, as a `scopeKey`. Follows the draw target until the user
     * explicitly changes this filter; selecting a shape on the map still
     * follows the selection into its group (see the effects below).
     */
    private scopeKey = new Signal<string>(scopeKey({ holeId: this.tool.drawHoleId.peek(), layer: null }));
    private scopeUserPinned = false;
    /** Layer-order editing never changes the content filter, draw target or feature selection. */
    private layerOrderOpen = new Signal(false);
    private layerOrderKey = new Signal('');
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
    private rows = new Signal<PanelRow[]>([]);
    /** Feature row elements by id: selection and visibility toggle classes here directly. */
    private rowEls = new Map<string, HTMLElement>();
    /** Last plain or Cmd/Ctrl-clicked row: the fixed end of a Shift-click range. */
    private anchorId: string | null = null;

    /** Row count in the current scope (generated groups count once) — the dock's collapsed rail badge. */
    readonly scopeCount = new Signal(0);

    render(): DocumentFragment {
        let groupNameInput: HTMLInputElement;
        const frag = this.wire(tpl, {
            root: { className: () => this.layerOrderOpen.get() ? 'stack-panel stack-panel--ordering' : 'stack-panel' },
            layerControls: { style: () => this.layerOrderOpen.get() ? '' : 'display:none' },
            editLayerOrder: {
                style: () => this.tool.scope.get() === 'surfaces' ? '' : 'display:none',
                onclick: () => {
                    this.layerOrderKey.set(this.scopeKey.peek());
                    this.layerOrderOpen.set(true);
                },
            },
            closeLayerOrder: { onclick: () => this.layerOrderOpen.set(false) },
            layerList: {
                onchange: (e: Event) => this.layerOrderKey.set((e.target as HTMLSelectElement).value),
            },
            layerUp: {
                disabled: () => !this.canMoveLayer(1) || this.courseDetail.loading.get(),
                onclick: () => this.moveLayer(1),
            },
            layerDown: {
                disabled: () => !this.canMoveLayer(-1) || this.courseDetail.loading.get(),
                onclick: () => this.moveLayer(-1),
            },
            drawTarget: {
                onchange: (e: Event) => {
                    const key = (e.target as HTMLSelectElement).value;
                    this.tool.setDrawScope(scopeFromKey(key));
                    this.scopeUserPinned = false;
                    this.scopeKey.set(key);
                },
            },
            addGroup: {
                disabled: () => this.courseDetail.loading.get(),
                onclick: async () => {
                    const input = groupNameInput;
                    input.value = input.value.trim();
                    if (!input.reportValidity()) return;
                    const group = await this.courseDetail.addDrawingGroup(input.value);
                    if (group) {
                        this.tool.setDrawScope({ holeId: group.id, layer: null });
                        this.scopeUserPinned = false;
                        this.scopeKey.set(group.id);
                        input.value = group.drawingGroupName ?? '';
                    }
                },
            },
            renameGroup: {
                disabled: () => !this.activeDrawingGroup() || this.courseDetail.loading.get(),
                onclick: () => {
                    const group = this.activeDrawingGroup();
                    groupNameInput.value = groupNameInput.value.trim();
                    if (!groupNameInput.reportValidity()) return;
                    if (group) void this.courseDetail.renameDrawingGroup(group.id, groupNameInput.value);
                },
            },
            removeGroup: {
                disabled: () => !this.activeDrawingGroup() || this.groupHasShapes() || this.courseDetail.loading.get(),
                title: () => this.groupHasShapes() ? 'Move the shapes to another group before deleting this group' : 'Delete this empty drawing group',
                onclick: async () => {
                    const group = this.activeDrawingGroup();
                    if (group && await this.courseDetail.removeDrawingGroup(group.id)) {
                        if (this.tool.drawHoleId.peek() === group.id) this.tool.setDrawScope({ holeId: null, layer: null });
                        if (this.scopeKey.peek() === group.id) {
                            this.scopeUserPinned = false;
                            this.scopeKey.set('');
                        }
                    }
                },
            },
            groupError: {
                textContent: () => this.courseDetail.error.get()?.message ?? '',
                className: () => this.courseDetail.error.get() ? 'stack-empty show' : 'stack-empty',
            },
            empty: {
                className: () => this.scopeCount.get() === 0 ? 'stack-empty content-view show' : 'stack-empty content-view',
            },
            roughsToggle: {
                onclick: () => this.features.toggleRoughsLayerVisibility(),
                innerHTML: () => `${icon(this.features.roughsLayerHidden.get() ? 'eye-off' : 'eye', 16)}<span>Roughs layer</span>`,
                title: () => this.features.roughsLayerHidden.get()
                    ? 'Show the Roughs layer (editor only)'
                    : 'Hide the Roughs layer while editing (planner and export still include it)',
                'aria-pressed': () => String(this.features.roughsLayerHidden.get()),
            },
            holeToggle: {
                style: () => this.tool.scope.get() === 'surfaces' && this.scopeHole() ? '' : 'display:none',
                onclick: () => {
                    const hole = this.scopeHole();
                    if (hole) this.features.toggleHoleVisibility(hole.id);
                },
                innerHTML: () => `${icon(this.features.hiddenHoleIds.get().has(this.scopeKey.get()) ? 'eye-off' : 'eye', 16)}<span>Shapes in this ${this.scopeHole()?.drawingGroupName ? 'group' : 'hole'}</span>`,
                title: () => `${this.features.hiddenHoleIds.get().has(this.scopeKey.get()) ? 'Show' : 'Hide'} all shapes in ${this.scopeHole()?.drawingGroupName ?? `Hole ${this.scopeHole()?.number}`} (editor only)`,
                'aria-pressed': () => String(this.features.hiddenHoleIds.get().has(this.scopeKey.get())),
            },
            // Contextual controls (law 04): reorder ops appear only while a
            // row is selected — selection is the context they act on.
            // Not for the backdrop rows Vegetation selects (creeks, water):
            // their stack order is Draw's.
            // Nor for vegetation zones: drawn ones add up whatever their
            // order (D-VZ14), so a stack position would promise nothing.
            reorderOps: {
                className: () => this.features.selectedFeatures.get()
                    .some(f => !this.features.modeBackdropTypes.get().has(f.type) && f.type !== 'vegetation_zone')
                    ? 'stack-panel__section reorder-ops content-view show'
                    : 'stack-panel__section reorder-ops content-view',
            },
            // Reorder is a hand-drawn verb: disabled while any generated
            // (read-only) or backdrop row is in the selection.
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

        const target = this.ref(frag, 'drawTarget') as HTMLSelectElement;
        const layerList = this.ref(frag, 'layerList') as HTMLSelectElement;
        groupNameInput = this.ref(frag, 'groupName') as HTMLInputElement;
        this.track(effect(() => {
            if (this.tool.scope.get() !== 'surfaces') this.layerOrderOpen.set(false);
        }));
        this.track(effect(() => {
            const scopes = this.courseDetail.drawScopes.get();
            const key = this.layerOrderKey.get();
            untrack(() => {
                const scroll = layerList.scrollTop;
                layerList.textContent = '';
                fillScopeOptions(layerList, scopes);
                layerList.options[0]!.textContent = 'Course level (fixed top)';
                layerList.options[layerList.options.length - 1]!.textContent = 'Roughs (fixed bottom)';
                layerList.value = key;
                layerList.scrollTop = scroll;
                if (layerList.isConnected) layerList.selectedOptions[0]?.scrollIntoView({ block: 'nearest' });
            });
        }));
        this.track(effect(() => {
            const scopes = this.courseDetail.drawScopes.get();
            const id = this.tool.drawHoleId.get();
            const layer = this.tool.drawLayer.get();
            const drawScope = this.tool.scope.get();
            untrack(() => {
                target.textContent = '';
                fillScopeOptions(target, scopes, { roughsDisabled: drawScope !== 'surfaces' });
                target.value = scopeKey({ holeId: id, layer });
            });
        }));

        this.track(effect(() => {
            const scopes = this.courseDetail.drawScopes.get();
            const id = scopeFromKey(this.scopeKey.get()).holeId;
            untrack(() => {
                const group = scopes.find(h => h.id === id && h.drawingGroupName);
                groupNameInput.value = group?.drawingGroupName ?? '';
            });
        }));

        const findShape = this.ref(frag, 'findShape') as HTMLInputElement;
        findShape.addEventListener('input', () => findShape.classList.remove('not-found'));
        findShape.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            const found = this.findShape(findShape.value);
            findShape.classList.toggle('not-found', found === 0 && findShape.value.trim() !== '');
        });

        this.scopeSelect = this.ref(frag, 'scopeSelect') as HTMLSelectElement;
        this.scopeSelect.addEventListener('change', () => {
            this.scopeUserPinned = true;
            this.scopeKey.set(this.scopeSelect.value);
        });

        // Scope options: course level, one per hole, Roughs (and "All zones"
        // in Vegetation mode), built once per hole list. Unlike the selection
        // panel's move select, this one FILTERS the row list rather than
        // assigning a feature's hole.
        this.track(effect(() => {
            const holes = this.courseDetail.drawScopes.get();
            const vegetation = this.vegetation.get();
            untrack(() => {
                this.scopeSelect.textContent = '';
                if (vegetation) this.scopeSelect.appendChild(option(ALL_ZONES_KEY, 'All zones, by hole'));
                fillScopeOptions(this.scopeSelect, holes);
                this.scopeSelect.value = this.scopeKey.peek();
            });
        }));
        this.track(effect(() => {
            const value = this.scopeKey.get();
            if (this.scopeSelect.value !== value) this.scopeSelect.value = value;
        }));

        // Membership + order of the scope. Runs on every store change (an
        // O(N) scan with no DOM work); publishes only when the result differs.
        // Types the mode keeps off the map (Draw: the rules lines, which
        // Furniture edits) or shows only as a backdrop (Vegetation: the
        // course) are not listed either.
        this.track(effect(() => {
            const key = this.scopeKey.get();
            const modeHidden = this.features.modeHiddenTypes.get();
            const backdrop = this.features.modeBackdropTypes.get();
            const membersOf = (scope: string): ScopeEntry[] => this.features.stackFor(scopeFromKey(scope))
                .filter(f => !modeHidden.has(f.type) && !backdrop.has(f.type))
                .reverse()
                .map(f => ({ id: f.id, group: isGeneratedFeature(f) ? groupRowKey(f.source!, f.type) : null }));
            let next: ScopeEntry[];
            if (key !== ALL_ZONES_KEY) {
                next = membersOf(key);
            } else {
                // Every zone, under a heading per hole (course level first).
                const groups: [string, string][] = [
                    [scopeKey({ holeId: null, layer: null }), 'No hole (course level)'],
                    ...this.courseDetail.drawScopes.get().map(h => [h.id, h.drawingGroupName ?? `Hole ${h.number}`] as [string, string]),
                ];
                next = [];
                for (const [scope, label] of groups) {
                    const scoped = membersOf(scope);
                    if (scoped.length === 0) continue;
                    const zones = scoped.filter(e => e.group === null).length;
                    const header = `${label} · ${zones} drawn`;
                    next.push({ id: `header:${scope}:${header}`, group: null, header }, ...scoped);
                }
            }
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
                const next: PanelRow[] = [];
                let segment: CourseFeature[] = [];
                const flush = () => {
                    next.push(...groupStackRows(segment, selected));
                    segment = [];
                };
                for (const e of entries) {
                    if (e.header !== undefined) {
                        flush();
                        next.push({ kind: 'header', key: e.id, label: e.header });
                    } else if (ids.has(e.id)) {
                        segment.push(this.features.store.item(e.id).peek());
                    }
                }
                flush();
                const prev = this.rows.peek();
                if (next.length === prev.length && next.every((r, i) => r.key === prev[i]!.key)) return;
                this.rows.set(next);
                this.scopeCount.set(next.filter(r => r.kind !== 'header').length);
            });
        }));

        this.rowsHost = this.ref(frag, 'rows');
        this.$each(
            this.rowsHost,
            this.rows,
            (row, _index, track) => row.kind === 'header'
                ? this.wireEl(headerRowTpl, { row: { textContent: row.label } }, track)
                : row.kind === 'group'
                    ? this.renderGroupRow(row, track)
                    : this.renderRow(row.feature.id, track),
            // A feature id that leaves the store and comes back gets a new
            // entity signal; the serial makes that a new row bound to it.
            row => row.kind !== 'feature' ? row.key : `${row.key}#${entitySerial(this.features.store.item(row.key))}`,
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
            const next = this.features.effectiveHiddenIds.get();
            untrack(() => {
                for (const id of shownHidden) if (!next.has(id)) this.paintHidden(id);
                for (const id of next) if (!shownHidden.has(id)) this.paintHidden(id);
                shownHidden = next;
            });
        }));

        // The Roughs layer eye dims every row of that layer.
        this.track(effect(() => {
            this.features.roughsLayerOff.get();
            untrack(() => {
                for (const id of this.rowEls.keys()) this.paintHidden(id);
            });
        }));

        // Follow the draw target while the stack filter is still implicit;
        // Vegetation mode lists every zone instead (and leaving it drops
        // that choice, which Draw does not have).
        this.track(effect(() => {
            const drawHoleId = this.tool.drawHoleId.get();
            const drawLayer = this.tool.drawLayer.get();
            const vegetation = this.vegetation.get();
            untrack(() => {
                if (!vegetation && this.scopeKey.peek() === ALL_ZONES_KEY) this.scopeUserPinned = false;
                if (this.scopeUserPinned) return;
                this.scopeKey.set(vegetation ? ALL_ZONES_KEY : scopeKey({ holeId: drawHoleId, layer: drawLayer }));
            });
        }));

        // Follow selection: a shape selected on the map (or via alt-cycle)
        // switches scope to its group and scrolls its row into view. Acts on
        // a new selected id or a hole change only, not on every edit of the
        // selected feature. The scroll runs on a microtask, after the row
        // list has caught up with the (possibly just-switched) scope.
        let followed: { id: string; scope: string } | null = null;
        this.track(effect(() => {
            const selected = this.features.selected.get();
            if (!selected) {
                followed = null;
                return;
            }
            const scope = scopeKey(scopeOf(selected));
            if (followed && followed.id === selected.id && followed.scope === scope) return;
            followed = { id: selected.id, scope };
            untrack(() => {
                // "All zones" already lists it; only a scoped list switches.
                if (this.scopeKey.peek() !== ALL_ZONES_KEY) this.scopeKey.set(scope);
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

    private activeDrawingGroup() {
        const id = scopeFromKey(this.scopeKey.get()).holeId;
        return this.courseDetail.drawingGroups.get().find(h => h.id === id);
    }

    private scopeHole() {
        return this.courseDetail.drawScopes.get().find(h => h.id === this.scopeKey.get());
    }

    private groupHasShapes(): boolean {
        const id = this.activeDrawingGroup()?.id;
        return id !== undefined && this.features.store.items.get().some(f => f.holeId === id);
    }

    private movableLayers() {
        const ranks = this.courseDetail.drawRanks.get();
        return [...this.courseDetail.drawScopes.get()].sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
    }

    private canMoveLayer(delta: number): boolean {
        const peers = this.movableLayers();
        const index = peers.findIndex(h => h.id === this.layerOrderKey.get());
        return index >= 0 && index + delta >= 0 && index + delta < peers.length;
    }

    private moveLayer(delta: number): void {
        const peers = this.movableLayers();
        const index = peers.findIndex(h => h.id === this.layerOrderKey.peek());
        if (!this.canMoveLayer(delta)) return;
        const before = delta < 0 ? peers[index - 1]!.id : peers[index + 2]?.id ?? null;
        void this.courseDetail.moveDrawingLayer(peers[index]!.id, before);
    }

    private canReorder(): boolean {
        const items = this.features.selectedFeatures.get();
        const backdrop = this.features.modeBackdropTypes.get();
        return items.length > 0 && items.every(f => !isGeneratedFeature(f) && !backdrop.has(f.type));
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

    private holeNumberOf(holeId: string | null): number | undefined {
        return holeId ? this.courseDetail.drawScopes.peek().find(h => h.id === holeId)?.number : undefined;
    }

    /**
     * Select the features a typed shape id names (`findByShapeName`) and fit
     * the map to them, so a name from the SVG, an OPCD log or a bisect is one
     * Enter away. Returns how many were found.
     */
    private findShape(query: string): number {
        const found = findByShapeName(this.features.store.items.peek(), id => this.holeNumberOf(id), query);
        if (!found.length) return 0;
        this.features.setSelection(found.map(f => f.id));
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const f of found) {
            for (const ring of f.geometry.rings) {
                for (const p of ring.points) {
                    const { lat, lon } = sweref99tmToWgs84(p.x, p.y);
                    w = Math.min(w, lon); e = Math.max(e, lon);
                    s = Math.min(s, lat); n = Math.max(n, lat);
                }
            }
        }
        if (Number.isFinite(w)) this.map.fitBounds([w, s, e, n], { maxZoom: 19 });
        return found.length;
    }

    /** Dim hidden-hole members while keeping each individual eye's own state. */
    private paintHidden(id: string): void {
        const el = this.rowEls.get(id);
        if (!el) return;
        const hidden = this.features.hiddenIds.peek().has(id);
        const layerOff = this.features.roughsLayerOff.peek()
            && this.features.featureIdSet.peek().has(id)
            && this.features.store.item(id).peek().layer === ROUGHS_LAYER;
        el.classList.toggle('hidden', this.features.effectiveHiddenIds.peek().has(id) || layerOff);
        const eye = el.querySelector<HTMLElement>('[bind="eye"]')!;
        eye.innerHTML = icon(hidden ? 'eye-off' : 'eye', 16);
        eye.title = hidden ? 'Show' : 'Hide';
    }

    private renderGroupRow(group: Extract<StackRow, { kind: 'group' }>, track: (d: () => void) => void): HTMLElement {
        const hidden = () => this.features.hiddenSources.get().has(group.source);
        const holeHidden = () => this.features.hiddenHoleIds.get().has(this.scopeKey.get());
        const style = FEATURE_STYLES[group.type as keyof typeof FEATURE_STYLES];
        const el = this.wireEl(groupRowTpl, {
            row: {
                className: () => hidden() || holeHidden() ? 'stack-row stack-row--group hidden' : 'stack-row stack-row--group',
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

    /** A row's swatch: the type's palette fill, or a vegetation zone's own zone-type colour. */
    private swatchStyle(f: CourseFeature): string {
        const style = FEATURE_STYLES[f.type as keyof typeof FEATURE_STYLES];
        const zoneColor = f.type === 'vegetation_zone' ? this.zoneTypes.colorFor(zoneTypeKeyOf(f.attributes)) : '';
        return style ? `background:${zoneColor || style.fill}; border-color:${style.outline}` : '';
    }

    /**
     * A row's name: the type's palette label, except a vegetation zone, which
     * says what it plants - "Creek bank · Vass (common reed) + 2 · adds" - and a
     * tree species area, which says its mix - "Oak grove · oak 90% · birch 10%" -
     * so they can be told apart in the list.
     */
    private rowLabel(f: CourseFeature): string {
        if (f.type === TREE_AREA_TYPE) {
            return `${treeAreaNameOf(f.attributes) || FEATURE_STYLES.tree_area.label} · ${speciesMixLabel(speciesMixOf(f.attributes))}`;
        }
        if (f.type !== 'vegetation_zone') return FEATURE_STYLES[f.type as keyof typeof FEATURE_STYLES]?.label ?? f.type;
        const zoneType = zoneTypeKeyOf(f.attributes);
        const variantKey = zoneVariantKeyOf(f.attributes);
        const variant = variantKey ? this.zoneTypes.variantsOf(zoneType).find(v => v.key === variantKey)?.name ?? variantKey : '';
        const extras = zoneExtraPalettesOf(f.attributes).length;
        return [
            this.zoneTypes.labelFor(zoneType) + (variant ? ` · ${variant}` : '') + (extras ? ` + ${extras}` : ''),
            zoneBlendOf(f.attributes) === 'mix' ? 'adds' : '',
        ].filter(Boolean).join(' · ');
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

        let shown: { swatch: string; label: string; badge: string | null; points: number; layer: CourseFeature['layer'] } | null = null;
        track(effect(() => {
            const f = entity.get();
            const next = { swatch: this.swatchStyle(f), label: this.rowLabel(f), badge: generatedBadge(f), points: pointCount(f), layer: f.layer };
            if (!shown || shown.swatch !== next.swatch) swatch.setAttribute('style', next.swatch);
            if (!shown || shown.label !== next.label) label.textContent = next.label;
            el.title = svgShapeName(f, untrack(() => this.holeNumberOf(f.holeId)));
            // A row moved into or out of the Roughs layer follows its eye.
            if (shown && shown.layer !== next.layer) untrack(() => this.paintHidden(id));
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
        this.paintHidden(id);
        track(() => {
            if (this.rowEls.get(id) === el) this.rowEls.delete(id);
        });
        return el;
    }
}
