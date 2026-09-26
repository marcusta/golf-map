import { Component, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, field, panelTitle } from '../css';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { FeaturesService, fillScopeOptions, scopeFromKey, scopeKey, scopeOf } from './features.service';
import { isRoughsLayerType } from '../../../shared/render/stack-key';
import { DrawToolService, OFFSET_PRESETS } from './draw-tool.service';
import { FEATURE_STYLES } from './feature-palette';
import { ZoneTypesService, type ZoneAttributes } from '../zones/zone-types.service';
import { generatedHeightLabel, isGeneratedFeature, provenanceBadgeLabel } from './generated-features';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import {
    PATH_SURFACE_ATTRIBUTE, PATH_SURFACE_LABELS, PATH_SURFACES, pathSurfaceOf, type PathSurface,
} from '../../../shared/features/path-surface';
import { KERB_FILLETS_ATTRIBUTE, kerbFilletsOn } from '../../../shared/features/road-junctions';

/** The surface picker's value for a selection whose paths disagree. */
const MIXED_SURFACE = '__mixed';

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
            <label bind="zoneVariantField" class="zone-field zone-variant-field">Variant
                <select bind="zoneVariant" data-testid="zone-variant-select"></select>
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
        <div bind="pathSection" class="zone-section" data-testid="path-surface-section">
            <h4 bind="pathTitle" class="section-title"></h4>
            <label class="zone-field">Surface
                <select bind="pathSurface" data-testid="path-surface-select"></select>
            </label>
            <label bind="pathWidthField" class="zone-field path-width-field">Width (m)
                <input bind="pathWidth" type="number" min="0.2" max="60" step="0.5" data-testid="path-width" />
            </label>
            <label bind="pathKerbsField" class="path-kerbs-field" title="Round the kerb corners where this road meets another (both roads need it on)">
                <input bind="pathKerbs" type="checkbox" data-testid="path-kerbs" />
                Round kerbs at junctions
            </label>
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
            & .zone-variant-field, & .path-width-field {
                display: none;
                &.show { display: flex; }
            }
            & .path-kerbs-field {
                display: none;
                align-items: center;
                gap: ${s('xs')};
                font-size: 0.75rem;
                color: ${t('color-text-secondary')};
                &.show { display: flex; }
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
            // Path surface (shared/features/path-surface.ts): what the road or
            // cart path is made of — every selected path at once, so a batch
            // of imported gravel lanes is set in one go.
            pathSection: {
                className: () => this.pathSelection().length > 0 ? 'zone-section show' : 'zone-section',
            },
            // A road drawn or imported as a centerline: its width is one
            // number (the line stays, the corridor is re-derived round it).
            pathWidthField: {
                className: () => this.centerlineWidth() !== null ? 'zone-field path-width-field show' : 'zone-field path-width-field',
            },
            pathWidth: {
                value: () => String(this.centerlineWidth() ?? ''),
                onchange: (e: Event) => {
                    const width = Number((e.target as HTMLInputElement).value);
                    if (Number.isFinite(width) && width > 0) this.tool.setSelectedCenterlineWidth(width);
                },
            },
            pathTitle: () => {
                const n = this.pathSelection().length;
                return n > 1 ? `Path surface (${n} paths)` : 'Path surface';
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

        // Surface picker: fixed options; Mixed only while the selected paths disagree.
        const surfaceSelect = this.ref(frag, 'pathSurface') as HTMLSelectElement;
        surfaceSelect.addEventListener('change', () => {
            if (surfaceSelect.value !== MIXED_SURFACE) this.savePathSurface(surfaceSelect.value as PathSurface | '');
        });
        this.track(effect(() => {
            const current = this.pathSurfaceValue();
            surfaceSelect.textContent = '';
            const add = (value: string, label: string) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                surfaceSelect.appendChild(option);
            };
            if (current === MIXED_SURFACE) add(MIXED_SURFACE, 'Mixed');
            add('', 'Unknown');
            for (const surface of PATH_SURFACES) add(surface, PATH_SURFACE_LABELS[surface]);
            surfaceSelect.value = current;
        }));

        // Kerb rounding: on/off for every selected centerline road; mixed
        // selections show the box indeterminate until clicked.
        const kerbs = this.ref(frag, 'pathKerbs') as HTMLInputElement;
        kerbs.addEventListener('change', () => this.savePathKerbs(kerbs.checked));
        this.track(effect(() => {
            const roads = this.centerlineSelection();
            const on = roads.filter(f => kerbFilletsOn(f.attributes)).length;
            kerbs.checked = roads.length > 0 && on === roads.length;
            kerbs.indeterminate = on > 0 && on < roads.length;
        }));
        const kerbsField = this.ref(frag, 'pathKerbsField');
        this.track(effect(() => {
            kerbsField.className = this.centerlineSelection().length > 0 ? 'path-kerbs-field show' : 'path-kerbs-field';
        }));

        // Zone-type picker: options from the course's table, value from the
        // selected zone. A zone naming a type the table no longer has keeps
        // an explicit option of its own, so saving weight never silently
        // retypes it.
        const zoneSelect = this.ref(frag, 'zoneType') as HTMLSelectElement;
        // A variant key belongs to its type: a new type starts on its Default.
        zoneSelect.addEventListener('change', () => this.saveZone({ zoneType: zoneSelect.value, zoneVariant: '' }));
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

        // Variant picker: "Default" plus the selected zone's type's variants;
        // hidden while that type has none. A zone naming a variant its type no
        // longer has keeps an explicit option (the export falls back to
        // Default for it), mirroring the zone-type picker.
        const variantField = this.ref(frag, 'zoneVariantField');
        const variantSelect = this.ref(frag, 'zoneVariant') as HTMLSelectElement;
        variantSelect.addEventListener('change', () => this.saveZone({ zoneVariant: variantSelect.value }));
        this.track(effect(() => {
            const { zoneType, zoneVariant } = this.zoneAttributes();
            const variants = this.zoneTypes.variantsOf(zoneType);
            const orphan = zoneVariant !== '' && !variants.some(v => v.key === zoneVariant);
            variantField.className = variants.length > 0 || orphan
                ? 'zone-field zone-variant-field show'
                : 'zone-field zone-variant-field';
            variantSelect.textContent = '';
            const options: [string, string][] = [
                ['', 'Default'],
                ...variants.map(v => [v.key, v.name] as [string, string]),
                ...(orphan ? [[zoneVariant, `${zoneVariant} (no such variant)`] as [string, string]] : []),
            ];
            for (const [value, label] of options) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                variantSelect.appendChild(option);
            }
            variantSelect.value = zoneVariant;
        }));

        this.moveSelect = this.ref(frag, 'moveSelect') as HTMLSelectElement;
        this.moveSelect.addEventListener('change', () => {
            if (this.moveSelect.value === '__mixed') return;
            this.tool.assignSelectionScope(scopeFromKey(this.moveSelect.value));
        });

        // Move-target options + current selection scope. This is explicit
        // repair UI for "I drew that on the wrong hole" mistakes.
        this.track(effect(() => {
            const holes = this.courseDetail.holes.get();
            const selected = this.features.selectedFeatures.get();
            const selectedScopes = new Set(selected.map(f => scopeKey(scopeOf(f))));
            const value = selectedScopes.size === 1 ? [...selectedScopes][0]! : '__mixed';
            this.moveSelect.textContent = '';
            if (selectedScopes.size > 1) {
                const mixed = document.createElement('option');
                mixed.value = '__mixed';
                mixed.textContent = 'Mixed holes';
                this.moveSelect.appendChild(mixed);
            }
            // The Roughs layer takes rough types only (D28).
            fillScopeOptions(this.moveSelect, holes, {
                roughsDisabled: !selected.every(f => isRoughsLayerType(f.type)),
            });
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

    /** The selected zone's attributes (type, variant, weight, feather, noise), with the defaults filled in. */
    private zoneAttributes(): ZoneAttributes {
        return this.zoneTypes.attributesOf(this.zoneSelection()?.attributes);
    }

    /**
     * Persist one changed zone field. `attributes` replaces the whole object
     * server-side, so every zone key goes every time — the others come from
     * `zoneAttributes()`, which is the values on screen.
     */
    private saveZone(patch: Partial<ZoneAttributes>): void {
        const zone = this.zoneSelection();
        if (!zone) return;
        void this.features.update(zone.id, { attributes: { ...this.zoneAttributes(), ...patch } });
    }

    /** The editable `path` features in the selection (others in a mixed selection are left alone). */
    private pathSelection(): CourseFeature[] {
        return this.features.editableSelectedFeatures.get().filter(f => f.type === 'path');
    }

    /** The selected paths drawn/imported as centerlines (the ones kerb rounding applies to). */
    private centerlineSelection(): CourseFeature[] {
        return this.pathSelection().filter(f => f.geometry.centerline);
    }

    /**
     * Kerb rounding on (the default: the attribute is dropped) or off
     * (`kerbFillets: false`) for every selected centerline road.
     */
    private savePathKerbs(on: boolean): void {
        for (const f of this.centerlineSelection()) {
            if (kerbFilletsOn(f.attributes) === on) continue;
            const attributes: Record<string, number | string | boolean> = { ...(f.attributes ?? {}) };
            if (on) delete attributes[KERB_FILLETS_ATTRIBUTE];
            else attributes[KERB_FILLETS_ATTRIBUTE] = false;
            void this.features.update(f.id, { attributes: Object.keys(attributes).length > 0 ? attributes : null });
        }
    }

    /** The single selected feature's centerline width, or null when it is not a centerline feature. */
    private centerlineWidth(): number | null {
        return this.features.editableSelected.get()?.geometry.centerline?.widthM ?? null;
    }

    /** The picker's value: the paths' shared surface, '' when all unknown, MIXED_SURFACE when they differ. */
    private pathSurfaceValue(): string {
        const surfaces = new Set(this.pathSelection().map(f => pathSurfaceOf(f.attributes) ?? ''));
        if (surfaces.size > 1) return MIXED_SURFACE;
        return surfaces.values().next().value ?? '';
    }

    /**
     * Set (or clear, with '') the surface on every selected path. `attributes`
     * replaces the whole object server-side, so each path's other keys go
     * along unchanged; a path already on that surface is not written.
     */
    private savePathSurface(surface: PathSurface | ''): void {
        for (const f of this.pathSelection()) {
            if ((pathSurfaceOf(f.attributes) ?? '') === surface) continue;
            const attributes: Record<string, number | string | boolean> = { ...(f.attributes ?? {}) };
            if (surface) attributes[PATH_SURFACE_ATTRIBUTE] = surface;
            else delete attributes[PATH_SURFACE_ATTRIBUTE];
            void this.features.update(f.id, { attributes: Object.keys(attributes).length > 0 ? attributes : null });
        }
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
