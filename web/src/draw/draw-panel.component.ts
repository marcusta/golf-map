import { Component, Computed, Router, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, field, panelTitle, selectedRow, keyHint } from '../css';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FeaturesService } from './features.service';
import { DrawToolService, OFFSET_PRESETS } from './draw-tool.service';
import { FEATURE_TYPES, FEATURE_STYLES } from './feature-palette';
import { HelpModalService } from '../editor/help-modal.component';
import { icon } from '../ui/icons';

const tpl = template(`
    <div class="draw-panel" bind="root">
        <div class="draw-panel__section">
            <div class="draw-panel__section-head">
                <h4 class="section-title">Feature type</h4>
                <span class="head-actions">
                    <button bind="undoBtn" type="button" class="icon-btn" aria-label="Undo">${icon('undo')}</button>
                    <button bind="redoBtn" type="button" class="icon-btn" aria-label="Redo">${icon('redo')}</button>
                    <button bind="helpBtn" type="button" class="help-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">${icon('circle-help')}</button>
                </span>
            </div>
            <div bind="types" class="type-grid"></div>
        </div>
        <div class="draw-panel__section">
            <button bind="newPoly" type="button" class="new-poly"></button>
            <button bind="boxSelectBtn" type="button" class="box-select"></button>
            <div bind="drawHint" class="draw-hint"></div>
            <div class="draw-target" data-testid="draw-target">
                <span class="draw-target__label">New shapes</span>
                <span bind="drawTargetValue" class="draw-target__value"></span>
            </div>
        </div>
        <div bind="selection" class="draw-panel__section selection">
            <h4 class="section-title">Selection</h4>
            <div bind="selInfo" class="sel-info"></div>
            <label class="move-field">Move selected to
                <select bind="moveSelect" data-testid="draw-move-hole"></select>
            </label>
            <div bind="curveHint" class="curve-hint"></div>
            <button bind="cornerBtn" type="button" class="op-btn corner-btn"></button>
            <div bind="vertexOps" class="vertex-ops">
                <button bind="insertBetweenBtn" type="button" class="op-btn">Insert between (I)</button>
                <button bind="deleteVerticesBtn" type="button" class="op-btn">Delete vertices (Del)</button>
            </div>
            <div bind="offsetSection" class="offset-section">
                <h4 class="section-title">Expand / contract</h4>
                <div class="offset-row"><span class="offset-label">+</span><span bind="expandPresets" class="offset-presets"></span></div>
                <div class="offset-row"><span class="offset-label">−</span><span bind="contractPresets" class="offset-presets"></span></div>
                <div bind="offsetApply" class="apply-row">
                    <button bind="offsetApplyBtn" type="button" class="apply-btn"></button>
                    <button bind="offsetCancelBtn" type="button" class="cancel-btn">Cancel</button>
                </div>
            </div>
            <div bind="simplifySection" class="simplify-section">
                <button bind="simplifyBtn" type="button" class="op-btn"></button>
                <div bind="simplifyControls" class="simplify-controls">
                    <label class="epsilon-label">ε <input bind="epsilonSlider" type="range" min="0.1" max="3" step="0.1"><span bind="epsilonValue"></span></label>
                    <div bind="simplifyInfo" class="simplify-info"></div>
                    <div class="apply-row">
                        <button bind="simplifyApplyBtn" type="button" class="apply-btn">Apply simplify</button>
                        <button bind="simplifyCancelBtn" type="button" class="cancel-btn">Cancel</button>
                    </div>
                </div>
            </div>
            <button bind="surroundBtn" type="button" class="op-btn surround-btn"></button>
            <button bind="duplicateBtn" type="button" class="op-btn">Duplicate (⌘D)</button>
            <button bind="convertBtn" type="button" class="op-btn convert-btn">Convert to bezier…</button>
            <button bind="deleteBtn" type="button" class="delete-btn"></button>
        </div>
        <div bind="status" class="draw-panel__status"></div>
    </div>
`);

const typeRowTpl = template(`
    <div bind="row" class="type-row">
        <button bind="button" type="button" class="type-btn">
            <span bind="swatch" class="type-swatch"></span>
            <span bind="name" class="type-name"></span>
        </button>
        <button bind="eye" type="button" class="eye-btn"></button>
    </div>
`);

const presetBtnTpl = template(`<button bind="button" type="button" class="preset-btn"></button>`);

/**
 * Side panel for the draw tool (spawned by the toolbar while the tool is
 * active). Shares DrawToolService/FeaturesService singletons with the
 * tool: the type grid sets the next polygon's type — or, with a selection,
 * re-types the selected feature(s) (autosave, one undo step); the eye
 * buttons toggle per-type visibility (client-side only); new polygons follow
 * the active sidebar/route hole; selected features get an explicit
 * move-to-hole select; the ops section exposes undo/redo, expand/contract
 * with live preview, RDP simplify with an epsilon slider, auto-surround,
 * duplicate and bulk delete.
 */
export class DrawPanelComponent extends Component {
    static styles = `
        .draw-panel {
            display: flex;
            flex-direction: column;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};

            /* Law 03: interior padding space-4, row gap space-2; hairlines
               only between these major-group sections. */
            & .draw-panel__section {
                padding: var(--space-3) var(--space-4);
                border-bottom: 1px solid ${t('color-border-default')};
                display: flex;
                flex-direction: column;
                gap: var(--space-2);
            }

            /* Keyboard hints inside labels: mono, dimmed (law 05 addendum). */
            & .key-hint { ${keyHint()} }

            & .section-title {
                margin: 0;
                ${panelTitle()}
            }

            & .draw-panel__section-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: ${s('sm')};
            }

            & .head-actions {
                display: flex;
                align-items: center;
                gap: var(--space-1);
            }

            & .help-btn, & .icon-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 20px;
                height: 20px;
                flex-shrink: 0;
                padding: 0;
                border: none;
                background: transparent;
                color: ${t('color-text-secondary')};
                cursor: pointer;
                &:hover { background: ${t('color-surface-sunken')}; color: ${t('color-text-primary')}; }
            }
            & .help-btn { border-radius: 50%; }
            & .icon-btn {
                border-radius: ${t('radius-sm')};
                &:disabled {
                    opacity: 0.35;
                    cursor: default;
                    &:hover { background: transparent; color: ${t('color-text-secondary')}; }
                }
            }

            /* Roomier grid in the 340 bucket — two columns of FULL labels
               (law 05: nothing ellipsizes; chrome yields, not the label). */
            & .type-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: var(--space-1) var(--space-2);
            }

            & .type-row {
                position: relative;
                min-width: 0;
            }

            & .type-btn {
                width: 100%;
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                padding: var(--space-2);
                font-size: 0.8rem;
                border: none;
                border-radius: ${t('radius')};
                background: transparent;
                font-family: inherit;
                color: ${t('color-text-primary')};
                cursor: pointer;
                text-align: left;
                transition: background var(--dur-fast) var(--ease-standard);
                &:hover { background: color-mix(in srgb, ${t('color-text-primary')} 6%, transparent); }
                &[aria-selected="true"] {
                    ${selectedRow()}
                    & .type-name { font-weight: 600; }
                }
            }

            /* Law 04: the eye reveals on row hover AND :focus-within
               (keyboard) — absolutely positioned, so it reserves ZERO
               permanent width and the label owns the full cell. A hidden
               type keeps its eye-off visible as the state indicator. */
            & .eye-btn {
                position: absolute;
                top: 50%;
                right: var(--space-1);
                transform: translateY(-50%);
                display: flex;
                align-items: center;
                justify-content: center;
                width: 20px;
                height: 20px;
                padding: 0;
                color: ${t('color-text-secondary')};
                border: none;
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-raised')};
                cursor: pointer;
                opacity: 0;
                pointer-events: none;
                transition: opacity var(--dur-fast) var(--ease-standard);
                &:hover { background: ${t('color-surface-sunken')}; color: ${t('color-text-primary')}; }
                &.hidden-type { opacity: 1; pointer-events: auto; color: ${t('color-text-tertiary')}; }
            }
            & .type-row:hover .eye-btn,
            & .type-row:focus-within .eye-btn {
                opacity: 1;
                pointer-events: auto;
            }

            & .type-swatch {
                width: 14px;
                height: 14px;
                flex-shrink: 0;
                border-radius: ${t('radius-sm')};
                border: 1px solid rgba(0, 0, 0, 0.25);
            }
            & .type-name {
                white-space: nowrap;
            }

            & .new-poly {
                width: 100%;
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.8rem;
                ${primaryBtn()}
                &.drawing {
                    background: ${t('color-status-negative')};
                    &:hover { background: ${t('color-status-negative')}; }
                }
            }

            & .box-select {
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.8rem;
                ${btn()}
                &.active {
                    background: ${t('color-accent-primary')};
                    border-color: ${t('color-accent-primary')};
                    color: ${t('color-on-accent')};
                    &:hover { background: ${t('color-accent-hover')}; }
                }
            }

            & .draw-hint {
                display: none;
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
            }

            /* Quiet scope row (not a boxed control): mono overline label +
               tertiary value, minimal height — text beats chrome (law 05,
               nothing ellipsizes). */
            & .draw-target {
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: ${s('sm')};
            }
            & .draw-target__label {
                ${panelTitle()}
            }
            & .draw-target__value {
                white-space: nowrap;
                font-size: 0.75rem;
                color: ${t('color-text-secondary')};
            }

            & .move-field { ${field()} }

            & .selection { display: none; }
            & .selection.show { display: flex; }

            & .sel-info {
                font-size: 0.75rem;
                color: ${t('color-text-secondary')};
            }

            & .curve-hint {
                display: none;
                font-size: 0.7rem;
                color: ${t('color-text-secondary')};
                font-style: italic;
                &.show { display: block; }
            }

            & .op-btn {
                display: none;
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.75rem;
                ${btn(t('radius-sm'))}
                &.show { display: block; }
            }

            & .vertex-ops {
                display: none;
                flex-direction: column;
                gap: ${s('xs')};
                &.show { display: flex; }
            }

            & .offset-section, & .simplify-section {
                display: none;
                flex-direction: column;
                gap: ${s('xs')};
                &.show { display: flex; }
            }

            & .offset-row {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
            }
            & .offset-label {
                width: 10px;
                font-weight: 600;
                color: ${t('color-text-secondary')};
            }
            & .offset-presets {
                display: flex;
                gap: 2px;
                flex: 1;
            }
            & .preset-btn {
                flex: 1;
                padding: 2px 0;
                font-size: 0.7rem;
                ${btn(t('radius-sm'))}
                &.active {
                    border-color: ${t('color-accent-primary')};
                    color: ${t('color-accent-primary')};
                }
            }

            & .apply-row {
                display: none;
                gap: ${s('xs')};
                &.show { display: flex; }
            }
            & .apply-btn {
                flex: 1;
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.75rem;
                ${primaryBtn()}
            }
            & .cancel-btn {
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.75rem;
                ${btn(t('radius-sm'))}
            }

            & .simplify-controls {
                display: none;
                flex-direction: column;
                gap: ${s('xs')};
                &.show { display: flex; }
            }
            & .epsilon-label {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                & input { flex: 1; }
            }
            & .simplify-info {
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
            }

            & .delete-btn {
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.75rem;
                ${btn(t('radius-sm'))}
                color: ${t('color-status-negative')};
                border-color: ${t('color-status-negative')};
            }

            /* Quiet footer: tertiary, minimal height (law 03 IA cleanup). */
            & .draw-panel__status {
                padding: var(--space-2) var(--space-4) var(--space-3);
                font-size: 0.7rem;
                color: ${t('color-text-tertiary')};
                min-height: 1.2em;
                &.error { color: ${t('color-status-negative')}; }
            }
        }
    `;

    private tool = this.inject(DrawToolService);
    private features = this.inject(FeaturesService);
    private courseDetail = this.inject(CourseDetailService);
    private helpModal = this.inject(HelpModalService);
    private router = this.inject(Router);
    private selectedHoleNumber = this.router.query('hole');
    private moveSelect!: HTMLSelectElement;

    private readonly activeHoleId = new Computed<string | null>(() => {
        const number = this.selectedHoleNumber.get();
        if (!number) return null;
        return this.courseDetail.holes.get().find(h => String(h.number) === number)?.id ?? null;
    });

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            helpBtn: { onclick: () => this.helpModal.show() },
            newPoly: {
                onclick: () => {
                    if (this.tool.state.isDrawing.peek()) this.tool.state.disarm();
                    else this.tool.state.arm();
                },
                innerHTML: () => this.tool.state.isDrawing.get()
                    ? 'Cancel drawing (Esc)'
                    : 'New polygon <span class="key-hint">N</span>',
                className: () => this.tool.state.isDrawing.get() ? 'new-poly drawing' : 'new-poly',
            },
            boxSelectBtn: {
                onclick: () => this.tool.state.toggleBoxSelect(),
                // Visible label stays "Box-select…" (accessible name must
                // match /Box-select/); the shortcut is a quiet mono hint.
                innerHTML: () => this.tool.state.boxSelect.get()
                    ? 'Box-select: on <span class="key-hint">B</span>'
                    : 'Box-select <span class="key-hint">B</span>',
                className: () => this.tool.state.boxSelect.get() ? 'box-select active' : 'box-select',
                title: 'Drag anywhere to rubber-band select — even over shapes. Hold Space for a one-off.',
            },
            drawHint: {
                className: () => this.tool.state.isDrawing.get() ? 'draw-hint show' : 'draw-hint',
                textContent: () => {
                    const n = this.tool.state.draft.get().length;
                    return n === 0
                        ? 'Click the map to place the first point.'
                        : `${n} point${n === 1 ? '' : 's'} placed — Enter or click the first point to close.`;
                },
            },
            drawTargetValue: () => this.holeLabel(this.tool.drawHoleId.get()),
            undoBtn: {
                onclick: () => this.tool.undo(),
                disabled: () => !this.tool.history.canUndo.get(),
                title: 'Undo (⌘Z / Ctrl+Z)',
            },
            redoBtn: {
                onclick: () => this.tool.redo(),
                disabled: () => !this.tool.history.canRedo.get(),
                title: 'Redo (⌘⇧Z / ⌘Y)',
            },
            selection: { className: () => this.features.selectedIds.get().size > 0 ? 'draw-panel__section selection show' : 'draw-panel__section selection' },
            selInfo: () => {
                const count = this.features.selectedIds.get().size;
                if (count > 1) return `${count} features selected`;
                const f = this.features.selected.get();
                if (!f) return '';
                const points = f.geometry.rings.reduce((sum, r) => sum + r.points.length, 0);
                const label = FEATURE_STYLES[f.type as keyof typeof FEATURE_STYLES]?.label ?? f.type;
                const curve = f.geometry.curveType === 'bspline' ? 'Spline' : 'Bezier';
                return `${label} · ${curve} · ${f.geometry.rings.length} ring${f.geometry.rings.length === 1 ? '' : 's'} · ${points} pts · v${f.version}`;
            },
            curveHint: {
                className: () => this.features.selected.get()?.geometry.curveType === 'bspline'
                    ? 'curve-hint show' : 'curve-hint',
                textContent: 'Spline: points pull the curve — no bezier handles.',
            },
            cornerBtn: {
                onclick: () => this.tool.toggleHoveredVertexCorner(),
                className: () => this.features.selected.get() && this.tool.hoverVertex.get()
                    ? 'op-btn corner-btn show' : 'op-btn corner-btn',
                textContent: () => this.tool.hoveredVertexIsCorner()
                    ? 'Make vertex smooth (C)'
                    : 'Make vertex corner (C)',
            },
            vertexOps: {
                className: () => this.features.selected.get() && this.tool.vertexSelection.get().size > 0
                    ? 'vertex-ops show' : 'vertex-ops',
            },
            insertBetweenBtn: {
                onclick: () => this.tool.insertBetweenSelectedVertices(),
                className: () => this.tool.vertexSelection.get().size === 2 ? 'op-btn show' : 'op-btn',
            },
            deleteVerticesBtn: {
                onclick: () => this.tool.deleteSelectedVertices(),
                className: 'op-btn show',
                textContent: () => `Delete ${this.tool.vertexSelection.get().size} vertices (Del)`,
            },
            offsetSection: {
                className: () => this.features.selected.get() ? 'offset-section show' : 'offset-section',
            },
            offsetApply: {
                className: () => this.tool.offsetDistance.get() !== null ? 'apply-row show' : 'apply-row',
            },
            offsetApplyBtn: {
                onclick: () => this.tool.applyOffset(),
                textContent: () => {
                    const d = this.tool.offsetDistance.get();
                    if (d === null) return 'Apply';
                    return d > 0 ? `Expand +${d} m` : `Contract −${Math.abs(d)} m`;
                },
            },
            offsetCancelBtn: { onclick: () => this.tool.setOffsetDistance(null) },
            simplifySection: {
                className: () => this.features.selected.get() ? 'simplify-section show' : 'simplify-section',
            },
            simplifyBtn: {
                onclick: () => this.tool.setSimplifyActive(!this.tool.simplifyActive.peek()),
                className: 'op-btn show',
                textContent: () => this.tool.simplifyActive.get() ? 'Simplify: previewing…' : 'Simplify (RDP)…',
            },
            simplifyControls: {
                className: () => this.tool.simplifyActive.get() ? 'simplify-controls show' : 'simplify-controls',
            },
            epsilonValue: { textContent: () => `${this.tool.simplifyEpsilon.get().toFixed(1)} m` },
            simplifyInfo: {
                textContent: () => {
                    if (!this.tool.simplifyActive.get()) return '';
                    const before = this.features.selected.get()?.geometry.rings.reduce((sum, r) => sum + r.points.length, 0) ?? 0;
                    const after = this.tool.opPreviewGeometry.get()?.rings.reduce((sum, r) => sum + r.points.length, 0) ?? 0;
                    return `${before} → ${after} pts`;
                },
            },
            simplifyApplyBtn: { onclick: () => this.tool.applySimplify() },
            simplifyCancelBtn: { onclick: () => this.tool.setSimplifyActive(false) },
            surroundBtn: {
                onclick: () => this.tool.autoSurroundSelection(),
                className: () => this.tool.selectionSurroundPairing() ? 'op-btn surround-btn show' : 'op-btn surround-btn',
                textContent: () => {
                    const pairing = this.tool.selectionSurroundPairing();
                    if (!pairing) return '';
                    const label = FEATURE_STYLES[pairing.targetType]?.label ?? pairing.targetType;
                    return `Surround with ${label} (+${pairing.expandAmount} m)`;
                },
            },
            duplicateBtn: {
                onclick: () => this.tool.duplicateSelection(),
                className: 'op-btn show',
            },
            convertBtn: {
                onclick: () => void this.tool.convertSelectedToBezier(),
                className: () => this.features.selected.get()?.geometry.curveType === 'bspline'
                    ? 'op-btn convert-btn show' : 'op-btn convert-btn',
            },
            deleteBtn: {
                onclick: () => void this.tool.deleteSelected(),
                textContent: () => {
                    const count = this.features.selectedIds.get().size;
                    return count > 1 ? `Delete ${count} features` : 'Delete feature';
                },
            },
            status: {
                textContent: () => this.statusText(),
                className: () => this.statusIsError() ? 'draw-panel__status error' : 'draw-panel__status',
            },
        });

        // Feature type grid: with a selection → re-type it (undo-able);
        // otherwise set the type for the next drawn polygon. The eye
        // button toggles the TYPE's visibility (client-side only).
        const grid = this.ref(frag, 'types');
        for (const type of FEATURE_TYPES) {
            const style = FEATURE_STYLES[type];
            grid.appendChild(this.wireEl(typeRowTpl, {
                button: {
                    onclick: () => {
                        if (this.features.selectedIds.peek().size > 0) this.tool.retypeSelection(type);
                        else this.tool.drawType.set(type);
                    },
                    className: 'type-btn',
                    'aria-selected': () => {
                        const selected = this.features.selected.get();
                        const multi = this.features.selectedIds.get().size > 1;
                        const current = multi ? null : selected ? selected.type : this.tool.drawType.get();
                        return current === type;
                    },
                    title: style.label,
                },
                swatch: { 'style': `background:${style.fill}; border-color:${style.outline}` },
                name: { textContent: style.label },
                eye: {
                    onclick: () => this.features.toggleTypeVisibility(type),
                    className: () => this.features.hiddenTypes.get().has(type) ? 'eye-btn hidden-type' : 'eye-btn',
                    innerHTML: () => this.features.hiddenTypes.get().has(type) ? icon('eye-off') : icon('eye'),
                    'aria-label': () => this.features.hiddenTypes.get().has(type)
                        ? `Show ${style.label} features` : `Hide ${style.label} features`,
                    title: () => this.features.hiddenTypes.get().has(type)
                        ? `Show ${style.label} features` : `Hide ${style.label} features`,
                },
            }));
        }

        // Epsilon slider (imperative — range inputs need input events).
        const slider = this.ref(frag, 'epsilonSlider') as HTMLInputElement;
        slider.value = String(this.tool.simplifyEpsilon.peek());
        slider.addEventListener('input', () => {
            this.tool.simplifyEpsilon.set(parseFloat(slider.value));
        });

        // Offset preset buttons: ± rows arm the live preview.
        for (const [bindName, sign] of [['expandPresets', 1], ['contractPresets', -1]] as const) {
            const host = this.ref(frag, bindName);
            for (const preset of OFFSET_PRESETS) {
                host.appendChild(this.wireEl(presetBtnTpl, {
                    button: {
                        onclick: () => {
                            const armed = this.tool.offsetDistance.peek();
                            this.tool.setOffsetDistance(armed === sign * preset ? null : sign * preset);
                        },
                        className: () => this.tool.offsetDistance.get() === sign * preset ? 'preset-btn active' : 'preset-btn',
                        textContent: `${preset}`,
                        title: `${sign > 0 ? 'Expand' : 'Contract'} by ${preset} m (preview)`,
                    },
                }));
            }
        }

        // New polygons follow the active route/sidebar hole. No second
        // creation selector: pick a hole in the left sidebar, then draw.
        this.track(effect(() => {
            const number = this.selectedHoleNumber.get();
            const holes = this.courseDetail.holes.get();
            const activeHoleId = this.activeHoleId.get();
            untrack(() => {
                if (!number) {
                    this.tool.drawHoleId.set(null);
                } else if (activeHoleId) {
                    this.tool.drawHoleId.set(activeHoleId);
                } else if (holes.length > 0) {
                    this.tool.drawHoleId.set(null);
                }
            });
        }));

        this.moveSelect = this.ref(frag, 'moveSelect') as HTMLSelectElement;
        this.moveSelect.addEventListener('change', () => {
            if (this.moveSelect.value === '__mixed') return;
            this.tool.assignSelectionHole(this.moveSelect.value || null);
        });

        // Move-target options + current selection scope. This is explicit
        // repair UI for "I drew that on the wrong hole" mistakes.
        this.track(effect(() => {
            const holes = this.courseDetail.holes.get();
            const selected = this.features.selectedFeatures.get();
            const selectedHoleIds = new Set(selected.map(f => f.holeId ?? ''));
            const value = selectedHoleIds.size === 1 ? [...selectedHoleIds][0]! : '__mixed';
            this.moveSelect.textContent = '';
            if (selectedHoleIds.size > 1) {
                const mixed = document.createElement('option');
                mixed.value = '__mixed';
                mixed.textContent = 'Mixed holes';
                this.moveSelect.appendChild(mixed);
            }
            const courseLevel = document.createElement('option');
            courseLevel.value = '';
            courseLevel.textContent = 'Course level';
            this.moveSelect.appendChild(courseLevel);
            for (const hole of holes) {
                const option = document.createElement('option');
                option.value = hole.id;
                option.textContent = `Hole ${hole.number} (par ${hole.par})`;
                this.moveSelect.appendChild(option);
            }
            this.moveSelect.value = value;
        }));

        return frag;
    }

    private holeLabel(holeId: string | null): string {
        if (holeId === null) return 'Course level';
        const hole = this.courseDetail.holes.get().find(h => h.id === holeId);
        return hole ? `Hole ${hole.number} (par ${hole.par})` : 'Selected hole';
    }

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
