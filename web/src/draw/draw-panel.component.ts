import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, field } from '../css';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FeaturesService } from './features.service';
import { DrawToolService, OFFSET_PRESETS } from './draw-tool.service';
import { FEATURE_TYPES, FEATURE_STYLES } from './feature-palette';

const tpl = template(`
    <div class="draw-panel" bind="root">
        <div class="draw-panel__section">
            <h4 class="section-title">Feature type</h4>
            <div bind="types" class="type-grid"></div>
        </div>
        <div class="draw-panel__section">
            <button bind="newPoly" type="button" class="new-poly"></button>
            <div bind="drawHint" class="draw-hint"></div>
            <label class="hole-field">Hole
                <select bind="holeSelect"></select>
            </label>
            <div class="history-row">
                <button bind="undoBtn" type="button" class="history-btn">↶ Undo</button>
                <button bind="redoBtn" type="button" class="history-btn">↷ Redo</button>
            </div>
        </div>
        <div bind="selection" class="draw-panel__section selection">
            <h4 class="section-title">Selection</h4>
            <div bind="selInfo" class="sel-info"></div>
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
        <div class="draw-panel__hints">
            <div><b>N</b> new polygon &nbsp;·&nbsp; <b>Enter</b>/dbl-click close &nbsp;·&nbsp; <b>Esc</b> cancel</div>
            <div>Click: smooth point · <b>Shift</b>-click: corner point</div>
            <div><b>⌘Z</b> undo · <b>⌘⇧Z</b>/<b>⌘Y</b> redo (points while drawing)</div>
            <div><b>⌘</b>-click: multi-select · drag empty ground: marquee (<b>Alt</b>: touch)</div>
            <div>Drag inside selection: move · <b>⌘D</b> duplicate</div>
            <div>Drag vertex to move · click edge to insert</div>
            <div><b>Shift</b>-click/drag: select vertices · <b>I</b> insert between</div>
            <div><b>C</b> toggle vertex smooth/corner · right-click: remove</div>
            <div>Bezier only: <b>Alt</b>-drag: handles · <b>Alt</b>-click: straighten</div>
            <div><b>Del</b> delete selection (or selected vertices)</div>
        </div>
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
 * buttons toggle per-type visibility (client-side only); the hole select
 * assigns the selection (or the next polygon) to a hole; the ops section
 * exposes undo/redo, expand/contract with live preview, RDP simplify with
 * an epsilon slider, auto-surround, duplicate and bulk delete.
 */
export class DrawPanelComponent extends Component {
    static styles = `
        .draw-panel {
            display: flex;
            flex-direction: column;
            font-size: 0.8rem;
            color: ${t('text')};

            & .draw-panel__section {
                padding: ${s('sm')} ${s('md')};
                border-bottom: 1px solid ${t('border')};
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
                color: ${t('text-muted')};
            }

            & .type-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 2px;
            }

            & .type-row {
                display: flex;
                align-items: center;
                gap: 1px;
                min-width: 0;
            }

            & .type-btn {
                flex: 1;
                min-width: 0;
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                padding: 3px ${s('xs')};
                font-size: 0.72rem;
                border: 1px solid transparent;
                border-radius: ${t('radius-sm')};
                background: transparent;
                font-family: inherit;
                color: ${t('text')};
                cursor: pointer;
                text-align: left;
                &:hover { background: ${t('hover-bg')}; }
                &.active {
                    border-color: ${t('primary')};
                    background: ${t('hover-bg')};
                }
            }

            & .eye-btn {
                flex-shrink: 0;
                width: 18px;
                padding: 1px 0;
                font-size: 0.65rem;
                border: none;
                border-radius: ${t('radius-sm')};
                background: transparent;
                cursor: pointer;
                opacity: 0.75;
                &:hover { background: ${t('hover-bg')}; opacity: 1; }
                &.hidden-type { opacity: 0.35; }
            }

            & .type-swatch {
                width: 12px;
                height: 12px;
                flex-shrink: 0;
                border-radius: 3px;
                border: 1px solid rgba(0, 0, 0, 0.25);
            }
            & .type-name {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            & .new-poly {
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.8rem;
                ${primaryBtn()}
                &.drawing {
                    background: ${t('error')};
                    &:hover { background: ${t('error')}; }
                }
            }

            & .draw-hint {
                display: none;
                font-size: 0.72rem;
                color: ${t('text-muted')};
                &.show { display: block; }
            }

            & .hole-field { ${field()} }

            & .history-row {
                display: flex;
                gap: ${s('xs')};
            }
            & .history-btn {
                flex: 1;
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.75rem;
                ${btn(t('radius-sm'))}
                &:disabled { opacity: 0.4; cursor: default; }
            }

            & .selection { display: none; }
            & .selection.show { display: flex; }

            & .sel-info {
                font-size: 0.75rem;
                color: ${t('text-muted')};
            }

            & .curve-hint {
                display: none;
                font-size: 0.7rem;
                color: ${t('text-muted')};
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
                color: ${t('text-muted')};
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
                    border-color: ${t('primary')};
                    color: ${t('primary')};
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
                color: ${t('text-muted')};
                & input { flex: 1; }
            }
            & .simplify-info {
                font-size: 0.72rem;
                color: ${t('text-muted')};
            }

            & .delete-btn {
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.75rem;
                ${btn(t('radius-sm'))}
                color: ${t('error')};
                border-color: ${t('error')};
            }

            & .draw-panel__status {
                padding: ${s('xs')} ${s('md')};
                font-size: 0.72rem;
                color: ${t('text-muted')};
                min-height: 1.4em;
                &.error { color: ${t('error')}; }
            }

            & .draw-panel__hints {
                padding: ${s('xs')} ${s('md')} ${s('sm')};
                font-size: 0.68rem;
                line-height: 1.5;
                color: ${t('text-muted')};
                border-top: 1px solid ${t('border')};
            }
        }
    `;

    private tool = this.inject(DrawToolService);
    private features = this.inject(FeaturesService);
    private courseDetail = this.inject(CourseDetailService);
    private holeSelect!: HTMLSelectElement;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            newPoly: {
                onclick: () => {
                    if (this.tool.state.isDrawing.peek()) this.tool.state.disarm();
                    else this.tool.state.arm();
                },
                textContent: () => this.tool.state.isDrawing.get() ? 'Cancel drawing (Esc)' : 'New polygon (N)',
                className: () => this.tool.state.isDrawing.get() ? 'new-poly drawing' : 'new-poly',
            },
            drawHint: {
                className: () => this.tool.state.isDrawing.get() ? 'draw-hint show' : 'draw-hint',
                textContent: () => {
                    const n = this.tool.state.draft.get().length;
                    return n === 0
                        ? 'Click the map to place the first point.'
                        : `${n} point${n === 1 ? '' : 's'} placed — Enter or double-click to close.`;
                },
            },
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
                onclick: () => this.tool.convertSelectedToBezier(),
                className: () => this.features.selected.get()?.geometry.curveType === 'bspline'
                    ? 'op-btn convert-btn show' : 'op-btn convert-btn',
            },
            deleteBtn: {
                onclick: () => this.tool.deleteSelected(),
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
                    className: () => {
                        const selected = this.features.selected.get();
                        const multi = this.features.selectedIds.get().size > 1;
                        const current = multi ? null : selected ? selected.type : this.tool.drawType.get();
                        return current === type ? 'type-btn active' : 'type-btn';
                    },
                    title: style.label,
                },
                swatch: { 'style': `background:${style.fill}; border-color:${style.outline}` },
                name: { textContent: style.label },
                eye: {
                    onclick: () => this.features.toggleTypeVisibility(type),
                    className: () => this.features.hiddenTypes.get().has(type) ? 'eye-btn hidden-type' : 'eye-btn',
                    textContent: () => this.features.hiddenTypes.get().has(type) ? '🚫' : '👁',
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

        this.holeSelect = this.ref(frag, 'holeSelect') as HTMLSelectElement;
        this.holeSelect.addEventListener('change', () => {
            const holeId = this.holeSelect.value || null;
            if (this.features.selectedIds.peek().size > 0) this.tool.assignSelectionHole(holeId);
            else this.tool.drawHoleId.set(holeId);
        });

        // Hole options + current value: rebuilt on holes load / selection /
        // draw-target changes (cheap — a course has ≤ 18 holes).
        this.track(effect(() => {
            const holes = this.courseDetail.holes.get();
            const selected = this.features.selected.get();
            const value = selected ? selected.holeId ?? '' : this.tool.drawHoleId.get() ?? '';
            this.holeSelect.textContent = '';
            const courseLevel = document.createElement('option');
            courseLevel.value = '';
            courseLevel.textContent = 'Course level';
            this.holeSelect.appendChild(courseLevel);
            for (const hole of holes) {
                const option = document.createElement('option');
                option.value = hole.id;
                option.textContent = `Hole ${hole.number} (par ${hole.par})`;
                this.holeSelect.appendChild(option);
            }
            this.holeSelect.value = value;
        }));

        return frag;
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
