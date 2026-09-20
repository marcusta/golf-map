import { Component, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, field, panelTitle } from '../css';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FeaturesService } from './features.service';
import { DrawToolService, OFFSET_PRESETS } from './draw-tool.service';
import { FEATURE_STYLES } from './feature-palette';
import { ZoneTypesService, type ZoneAttributes } from '../zones/zone-types.service';
import { generatedHeightLabel, isGeneratedFeature, provenanceBadgeLabel } from './generated-features';

const tpl = template(`
    <div class="sel-panel" bind="root" data-testid="selection-panel">
        <h4 class="section-title">Selection</h4>
        <div bind="selInfo" class="sel-info"></div>
        <div bind="generatedBadge" class="generated-badge" data-testid="selection-generated-badge"></div>
        <label bind="moveField" class="move-field">Move selected to
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
        <div bind="zoneSection" class="zone-section">
            <h4 class="section-title">Vegetation zone</h4>
            <label class="zone-field">Zone type
                <select bind="zoneType" data-testid="zone-type-select"></select>
            </label>
            <label class="zone-field">Weight
                <input bind="zoneWeight" type="number" min="0" max="1" step="0.05" data-testid="zone-weight" />
            </label>
            <label class="zone-field">Feather (m)
                <input bind="zoneFeather" type="number" min="0" step="0.5" data-testid="zone-feather" />
            </label>
            <label class="zone-field">Edge noise (m)
                <input bind="zoneNoise" type="number" min="0" step="0.25" data-testid="zone-noise" />
            </label>
            <button bind="zoneTypesBtn" type="button" class="op-btn show">Edit zone types…</button>
        </div>
        <button bind="surroundBtn" type="button" class="op-btn surround-btn"></button>
        <button bind="duplicateBtn" type="button" class="op-btn">Duplicate (⌘D)</button>
        <button bind="convertBtn" type="button" class="op-btn convert-btn">Convert to bezier…</button>
        <button bind="deleteBtn" type="button" class="delete-btn"></button>
    </div>
`);

const presetBtnTpl = template(`<button bind="button" type="button" class="preset-btn"></button>`);

/**
 * The Draw sub-mode's per-selection editing surface, hosted at the top of the
 * contextual right dock (ContextDockComponent) while Draw is active and the
 * selection is non-empty. Moved wholesale out of the old floating draw panel
 * (draw-panel.component.ts, now deleted): an explicit move-to-hole select,
 * corner/vertex ops, expand/contract with live preview, RDP simplify with an
 * epsilon slider, auto-surround, duplicate, convert-to-bezier and bulk delete.
 * Shares the DrawToolService/FeaturesService singletons with the tool, so every
 * binding and keyboard-shortcut hint is identical to the old panel — this is a
 * move restyled from glass palette to flat dock column, not a rewrite.
 *
 * Hides itself (root `display:none`) when nothing is selected; the dock owns the
 * surface, the 268px width and the scroll bound.
 */
export class SelectionPanelComponent extends Component {
    static styles = `
        .sel-panel {
            display: none;
            flex-direction: column;
            gap: var(--space-2);
            padding: var(--space-3) var(--space-4);
            border-bottom: 1px solid ${t('color-border-default')};
            font-size: 0.8rem;
            color: ${t('color-text-primary')};
            &.show { display: flex; }

            & .section-title {
                margin: 0;
                ${panelTitle()}
            }

            & .sel-info {
                font-size: 0.75rem;
                color: ${t('color-text-secondary')};
            }

            & .move-field {
                ${field()}
                &.hidden { display: none; }
            }

            /* Read-only provenance badge for pipeline-generated rows. */
            & .generated-badge {
                display: none;
                align-self: flex-start;
                padding: 2px ${s('sm')};
                border-radius: ${t('radius-sm')};
                font-size: 0.7rem;
                background: color-mix(in srgb, ${t('color-text-primary')} 8%, transparent);
                color: ${t('color-text-secondary')};
                &.show { display: inline-block; }
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

            & .zone-section {
                display: none;
                flex-direction: column;
                gap: ${s('xs')};
                &.show { display: flex; }
            }
            & .zone-field {
                ${field()}
            }

            & .delete-btn {
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.75rem;
                ${btn(t('radius-sm'))}
                color: ${t('color-status-negative')};
                border-color: ${t('color-status-negative')};
            }
        }
    `;

    private tool = this.inject(DrawToolService);
    private features = this.inject(FeaturesService);
    private courseDetail = this.inject(CourseDetailService);
    private zoneTypes = this.inject(ZoneTypesService);
    private moveSelect!: HTMLSelectElement;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { className: () => this.features.selectedIds.get().size > 0 ? 'sel-panel show' : 'sel-panel' },
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
            // Generated (read-only) rows: badge on, every edit control off.
            // Delete stays — false positives (roofs) are removed this way.
            generatedBadge: {
                className: () => this.provenanceBadgeText() ? 'generated-badge show' : 'generated-badge',
                textContent: () => this.provenanceBadgeText(),
            },
            moveField: {
                className: () => this.editingAllowed() ? 'move-field' : 'move-field hidden',
            },
            curveHint: {
                className: () => this.features.editableSelected.get()?.geometry.curveType === 'bspline'
                    ? 'curve-hint show' : 'curve-hint',
                textContent: 'Spline: points pull the curve — no bezier handles.',
            },
            cornerBtn: {
                onclick: () => this.tool.toggleHoveredVertexCorner(),
                className: () => this.features.editableSelected.get() && this.tool.hoverVertex.get()
                    ? 'op-btn corner-btn show' : 'op-btn corner-btn',
                textContent: () => this.tool.hoveredVertexIsCorner()
                    ? 'Make vertex smooth (C)'
                    : 'Make vertex corner (C)',
            },
            vertexOps: {
                className: () => this.features.editableSelected.get() && this.tool.vertexSelection.get().size > 0
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
                className: () => this.features.editableSelected.get() ? 'offset-section show' : 'offset-section',
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
                className: () => this.features.editableSelected.get() ? 'simplify-section show' : 'simplify-section',
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
                    const before = this.features.editableSelected.get()?.geometry.rings.reduce((sum, r) => sum + r.points.length, 0) ?? 0;
                    const after = this.tool.opPreviewGeometry.get()?.rings.reduce((sum, r) => sum + r.points.length, 0) ?? 0;
                    return `${before} → ${after} pts`;
                },
            },
            simplifyApplyBtn: { onclick: () => this.tool.applySimplify() },
            simplifyCancelBtn: { onclick: () => this.tool.setSimplifyActive(false) },
            // Vegetation zone (docs/feature-vegetation-zones.md §5): the
            // per-feature rasterizer inputs. Hidden for every other type and
            // for read-only (generated) rows.
            zoneSection: {
                className: () => this.zoneSelection() ? 'zone-section show' : 'zone-section',
            },
            zoneWeight: {
                value: () => String(this.zoneAttributes().weight),
                onchange: (e: Event) => this.saveZone({ weight: numberOf(e, 1) }),
            },
            zoneFeather: {
                value: () => String(this.zoneAttributes().feather),
                onchange: (e: Event) => this.saveZone({ feather: numberOf(e, 2) }),
            },
            zoneNoise: {
                value: () => String(this.zoneAttributes().noise),
                onchange: (e: Event) => this.saveZone({ noise: numberOf(e, 0) }),
            },
            zoneTypesBtn: {
                onclick: () => {
                    const courseId = this.features.selected.peek()?.courseId;
                    if (courseId) void this.zoneTypes.openFor(courseId);
                },
            },
            surroundBtn: {
                // Shift-click chains the surround pairings to exhaustion (T41).
                onclick: (e: Event) => void this.tool.autoSurroundSelection((e as MouseEvent).shiftKey),
                className: () => this.tool.selectionSurroundPairing() ? 'op-btn surround-btn show' : 'op-btn surround-btn',
                textContent: () => {
                    const pairing = this.tool.selectionSurroundPairing();
                    if (!pairing) return '';
                    const label = FEATURE_STYLES[pairing.targetType]?.label ?? pairing.targetType;
                    const base = `Surround with ${label} (+${pairing.expandAmount} m)`;
                    if (pairing.chainEnd === pairing.targetType) return base;
                    const endLabel = FEATURE_STYLES[pairing.chainEnd]?.label ?? pairing.chainEnd;
                    return `${base} · ⇧ chain to ${endLabel}`;
                },
            },
            duplicateBtn: {
                onclick: () => this.tool.duplicateSelection(),
                className: () => this.editingAllowed() ? 'op-btn show' : 'op-btn',
            },
            convertBtn: {
                onclick: () => void this.tool.convertSelectedToBezier(),
                className: () => this.features.editableSelected.get()?.geometry.curveType === 'bspline'
                    ? 'op-btn convert-btn show' : 'op-btn convert-btn',
            },
            deleteBtn: {
                onclick: () => void this.tool.deleteSelected(),
                textContent: () => {
                    const count = this.features.selectedIds.get().size;
                    return count > 1 ? `Delete ${count} features` : 'Delete feature';
                },
            },
        });

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

        // Zone-type picker: options from the course's table, value from the
        // selected zone. A zone naming a type the table no longer has keeps
        // an explicit option of its own, so saving weight never silently
        // retypes it.
        const zoneSelect = this.ref(frag, 'zoneType') as HTMLSelectElement;
        zoneSelect.addEventListener('change', () => this.saveZone({ zoneType: zoneSelect.value }));
        this.track(effect(() => {
            const types = this.zoneTypes.items.get();
            const current = this.zoneAttributes().zoneType;
            zoneSelect.textContent = '';
            const keys = types.map(z => z.key);
            for (const zoneType of types) {
                const option = document.createElement('option');
                option.value = zoneType.key;
                option.textContent = zoneType.name;
                zoneSelect.appendChild(option);
            }
            if (current && !keys.includes(current)) {
                const orphan = document.createElement('option');
                orphan.value = current;
                orphan.textContent = `${current} (no such zone type)`;
                zoneSelect.appendChild(orphan);
            }
            zoneSelect.value = current;
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

    /** The single selected feature when it is generated (read-only), else null. */
    private generatedSelection() {
        const f = this.features.selected.get();
        return f && isGeneratedFeature(f) ? f : null;
    }

    /**
     * Provenance badge for the single selection: generator output also shows
     * its canopy height; an import shows only where it came from (it edits
     * like any hand-drawn shape). Empty for hand-drawn features.
     */
    private provenanceBadgeText(): string {
        const f = this.features.selected.get();
        if (!f) return '';
        const label = provenanceBadgeLabel(f);
        if (!label) return '';
        const height = generatedHeightLabel(f);
        return height ? `${label} · ${height}` : label;
    }

    /** The single selected feature when it is an editable vegetation zone, else null. */
    private zoneSelection() {
        const f = this.features.editableSelected.get();
        return f && f.type === 'vegetation_zone' ? f : null;
    }

    /** The selected zone's four attributes, with the defaults filled in. */
    private zoneAttributes(): ZoneAttributes {
        return this.zoneTypes.attributesOf(this.zoneSelection()?.attributes);
    }

    /**
     * Persist one changed zone field. `attributes` replaces the whole object
     * server-side, so all four keys go every time — the other three come from
     * `zoneAttributes()`, which is the values on screen.
     */
    private saveZone(patch: Partial<ZoneAttributes>): void {
        const zone = this.zoneSelection();
        if (!zone) return;
        void this.features.update(zone.id, { attributes: { ...this.zoneAttributes(), ...patch } });
    }

    /** False while any selected row is generated: hides move/duplicate. */
    private editingAllowed(): boolean {
        const items = this.features.selectedFeatures.get();
        return items.length > 0 && items.every(f => !isGeneratedFeature(f));
    }
}

/** A number input's value, falling back when it was cleared or unparsable. */
function numberOf(e: Event, fallback: number): number {
    const value = Number((e.target as HTMLInputElement).value);
    return Number.isFinite(value) ? value : fallback;
}
