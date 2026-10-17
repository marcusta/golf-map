import { Component, Signal, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, field, panelTitle } from '../css';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { COURSE_SCOPE, FeaturesService, ROUGHS_SCOPE_KEY, fillScopeOptions, scopeFromKey, scopeKey, scopeOf } from './features.service';
import { isRoughsLayerType } from '../../../shared/render/stack-key';
import { DrawToolService, OFFSET_PRESETS } from './draw-tool.service';
import { FEATURE_STYLES } from './feature-palette';
import { ZONE_EDGE_BLEND_DEFAULT_M, ZoneTypesService, type ZoneAttributes } from '../zones/zone-types.service';
import { generatedHeightLabel, isGeneratedFeature, provenanceBadgeLabel } from './generated-features';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import {
    PATH_SURFACE_ATTRIBUTE, PATH_SURFACE_LABELS, PATH_SURFACES, isLoosePathSurface, pathSurfaceOf, type PathSurface,
} from '../../../shared/features/path-surface';
import { KERB_FILLETS_ATTRIBUTE, kerbFilletsOn } from '../../../shared/features/road-junctions';
import { CAP_PRESETS, capPresetOf, resolveCap, type CapPresetId, type CenterlineCap } from '../../../shared/features/centerline';

type CapEnds = 'start' | 'end' | 'both';

/** Small pictures of each end shape: a road stub running right into the end. */
const CAP_ICONS: Record<CapPresetId, string> = (() => {
    const svg = (shape: string) => `<svg viewBox="0 0 28 16" aria-hidden="true"><path d="${shape}" fill="currentColor"/></svg>`;
    const rounded = (r: number) => `M2 4 H${20 - r} A${r} ${r} 0 0 1 20 ${4 + r} V${12 - r} A${r} ${r} 0 0 1 ${20 - r} 12 H2 Z`;
    return {
        straight: svg('M2 4 H20 V12 H2 Z'),
        soft: svg(rounded(1.6)),
        rounded: svg(rounded(2.8)),
        round: svg('M2 4 H20 A4 4 0 0 1 20 12 H2 Z'),
        turning: svg('M2 4 H14 A6.5 6.5 0 1 1 14 12 H2 Z'),
        taper: svg('M2 4 H10 L23 7 A1 1 0 0 1 23 9 L10 12 H2 Z'),
    };
})();
import { MapService } from '../map/map.service';
import { mountPathTransitions } from './path-transitions-panel';
import {
    BANK_VEG_ATTRIBUTE, BANK_VEG_COVER_ATTRIBUTE, BANK_VEG_DEFAULT, CREEK_BANK_ZONE_TYPE, bankVegCoverOf, bankVegOf, isWetBankVariant,
    takesBankVeg, bankVegNumberOf, BANK_VEG_MAX_ATTRIBUTE, BANK_VEG_WET_ATTRIBUTE, DEFAULT_BANK_VEG_MAX_M, DEFAULT_BANK_VEG_WET_M,
    BANK_VEG_WET_SUFFIX,
} from '../../../shared/features/creek-vegetation';
import { formatZonePalettes, zoneExtraPalettesOf, type ZoneBlend, type ZonePalette } from '../../../shared/features/zone-layers';
import { ZONE_HEIGHT_LIMIT_M, editZoneHeight, zoneHeightOf } from '../../../shared/features/zone-height';
import {
    SUGGESTED_TREE_SPECIES, TREE_AREA_IGNORE_KIND_ATTRIBUTE, TREE_AREA_NAME_ATTRIBUTE, TREE_AREA_SPECIES_ATTRIBUTE, TREE_AREA_TYPE,
    formatSpeciesMix, speciesMixOf, treeAreaIgnoresKind, treeAreaNameOf, type TreeSpeciesShare,
} from '../../../shared/features/tree-areas';
import { svgShapeName } from '../export/svg-exclusions';
import {
    ROCK_SLAB_MARGIN_ATTRIBUTE, ROCK_SLAB_MARGIN_RANGE_M, ROCK_SLAB_TILE_ATTRIBUTE, ROCK_SLAB_TYPE, rockSlabMarginOf, rockSlabTileOf,
} from '../../../shared/features/rock-slab';

/** The `<datalist>` of species suggestions the mix rows' inputs share (one per page). */
const TREE_SPECIES_LIST_ID = 'tree-area-species-options';

/** The surface picker's value for a selection whose paths disagree. */
const MIXED_SURFACE = '__mixed';
/** The bank palette picker's value for creeks that disagree. */
const MIXED_PALETTE = '__mixed';

const tpl = template(`
    <div class="sel-panel" bind="root" data-testid="selection-panel">
        <h4 class="section-title">Selection</h4>
        <div bind="shapeId" class="shape-id" title="Shape id in the GSPro SVG and the OPCD mesh names" data-testid="selection-shape-id"></div>
        <div bind="selInfo" class="sel-info"></div>
        <div bind="generatedBadge" class="generated-badge" data-testid="selection-generated-badge"></div>
        <label bind="moveField" class="move-field"><span bind="moveLabel"></span>
            <select bind="moveSelect" data-testid="draw-move-hole"></select>
            <span bind="moveHint" class="move-hint" data-testid="move-hole-hint">Only to find it again: the hole does not change what grows.</span>
        </label>
        <div bind="curveHint" class="curve-hint"></div>
        <div bind="backdropHint" class="curve-hint" data-testid="backdrop-hint">Shape is edited in Draw; here only its bank vegetation.</div>
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
            <label class="zone-field" title="How wide this zone's mix fades into the vegetation next to it, around its edge. Only the mix changes: beside a path or mown rough the zone ends where it is drawn. 0 = a hard border. Empty = the default.">Blend into neighbours (m)
                <input bind="zoneEdgeBlend" type="number" min="0" step="0.5" data-testid="zone-edge-blend" />
            </label>
            <label class="zone-field" title="How tall the bushes in this zone grow, in metres: each one is scaled to a height between the two. Only bushes, not the grass. Empty = the sizes of the palette.">Bush height (m)
                <span class="zone-height">
                    <input bind="zoneHeightMin" type="number" min="0" step="0.5" placeholder="min" data-testid="zone-height-min" />
                    <span>to</span>
                    <input bind="zoneHeightMax" type="number" min="0" step="0.5" placeholder="max" data-testid="zone-height-max" />
                </span>
            </label>
            <label class="zone-field" title="Zones you draw always add up with each other, whatever their hole or order. This says what the zone does to the generated vegetation (tall rough, creek banks, lidar) under it: Replace takes its weight of that ground, Add grows on top of it (rocks in tall rough).">Generated vegetation under it
                <select bind="zoneBlend" data-testid="zone-blend-select">
                    <option value="replace">Replace it</option>
                    <option value="mix">Add to it</option>
                </select>
            </label>
            <div class="zone-extras" title="More palettes this zone plants on the same ground, each at the zone's weight times its own">
                <span class="zone-extras-title">Also plants</span>
                <div bind="zoneExtras" class="zone-extras-list" data-testid="zone-extra-palettes"></div>
                <button bind="zoneExtraAddBtn" type="button" class="op-btn show" data-testid="zone-extra-add">Add palette</button>
            </div>
            <button bind="zoneTypesBtn" type="button" class="op-btn show">Edit zone types…</button>
        </div>
        <div bind="treeAreaSection" class="zone-section" data-testid="tree-area-section">
            <h4 class="section-title">Tree species area</h4>
            <label class="zone-field">Name
                <input bind="treeAreaName" type="text" placeholder="e.g. Oak grove" data-testid="tree-area-name" />
            </label>
            <div class="zone-extras" title="The species the Unity tree planter gives the survey trees inside this area, by relative weight (9 and 1 = 90% and 10%). Each tree still takes the size of its species that fits it best.">
                <span class="zone-extras-title">Species mix</span>
                <div bind="treeAreaMix" class="zone-extras-list" data-testid="tree-area-mix"></div>
                <button bind="treeAreaAddBtn" type="button" class="op-btn show" data-testid="tree-area-add">Add species</button>
            </div>
            <label class="tree-area-kind" title="Off: a tree the survey classed conifer keeps the palette's conifers when the mix has none (and a broadleaf the broadleaves). On: every tree inside takes the mix.">
                <input bind="treeAreaIgnoreKind" type="checkbox" data-testid="tree-area-ignore-kind" />
                Also where the survey says conifer/broadleaf
            </label>
            <div class="tree-area-hint">Used by the Unity tree planter: export the trees, then Load and check / Plant.</div>
        </div>
        <div bind="pathSection" class="zone-section" data-testid="path-surface-section">
            <h4 bind="pathTitle" class="section-title"></h4>
            <label class="zone-field">Surface
                <select bind="pathSurface" data-testid="path-surface-select"></select>
            </label>
            <label bind="pathWidthField" class="zone-field path-width-field">Width (m)
                <input bind="pathWidth" type="number" min="0.2" max="60" step="0.5" data-testid="path-width" />
            </label>
            <div bind="pathEndsField" class="path-ends-field" data-testid="path-ends">
                <div class="path-ends-which" title="Which end the shapes set: the end you started drawing at, the end you finished at, or both">
                    <button type="button" class="cap-which" data-end="start" data-testid="path-ends-start">Start</button>
                    <button type="button" class="cap-which" data-end="both" data-testid="path-ends-both">Both</button>
                    <button type="button" class="cap-which" data-end="end" data-testid="path-ends-end">End</button>
                </div>
                <div bind="pathEndsShapes" class="path-ends-shapes"></div>
                <label bind="pathEndSizeField" class="zone-field path-end-size-field"><span bind="pathEndSizeLabel"></span>
                    <input bind="pathEndSize" type="number" min="0" max="200" step="0.5" data-testid="path-end-size" />
                </label>
            </div>
            <label bind="pathKerbsField" class="path-kerbs-field" title="Round the kerb corners where this road meets another (both roads need it on)">
                <input bind="pathKerbs" type="checkbox" data-testid="path-kerbs" />
                Round kerbs at junctions
            </label>
        </div>
        <div bind="rockSection" class="zone-section" data-testid="rock-slab-section">
            <h4 class="section-title">Rock slab (berghäll)</h4>
            <label class="zone-field" title="How far the cut-out reaches beyond the outline you drew, metres. An outline traced tight to the rock in the photo reads too small in game.">Margin (m)
                <input bind="rockMargin" type="number" min="0" max="5" step="0.1" data-testid="rock-slab-margin" />
            </label>
            <label class="zone-field" title="Metres per texture tile on the slab">Texture tile (m)
                <input bind="rockTile" type="number" min="0.5" step="0.5" data-testid="rock-slab-tile" />
            </label>
            <div class="tree-area-hint">Not in the SVG: <b>Update meshes</b> in the command bar cuts it out of the course meshes in Blender.</div>
        </div>
        <div bind="creekSection" class="zone-section" data-testid="creek-bank-section">
            <h4 bind="creekTitle" class="section-title"></h4>
            <label class="zone-field">Palette
                <select bind="creekPalette" data-testid="creek-bank-palette"></select>
            </label>
            <label bind="creekCoverField" class="zone-field creek-cover-field" title="Share of the water surface the grass covers; the rest stays open water">Water cover (%)
                <input bind="creekCover" type="number" min="0" max="100" step="5" data-testid="creek-bank-cover" />
            </label>
            <label bind="creekMaxField" class="zone-field creek-cover-field" title="How far up the bank the vegetation reaches at most, metres from the water (it stops earlier where the bank flattens)">Up the bank (m)
                <input bind="creekMax" type="number" min="0.5" max="30" step="0.5" data-testid="creek-bank-max" />
            </label>
            <label bind="creekWetField" class="zone-field creek-cover-field" title="How far up the bank the palette's water plants (reeds, cattails) reach, metres from the water; above that the palette's bank grass">Water plants up the bank (m)
                <input bind="creekWet" type="number" min="0" max="10" step="0.1" data-testid="creek-bank-wet" />
            </label>
        </div>
        <button bind="surroundBtn" type="button" class="op-btn surround-btn"></button>
        <button bind="duplicateBtn" type="button" class="op-btn">Duplicate (⌘D)</button>
        <button bind="unionBtn" type="button" class="op-btn" title="Merge the selected shapes into the one selected first; the others are deleted. They must overlap or touch.">Union</button>
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
        .path-transitions {
            display: flex; flex-direction: column; gap: ${s('xs')};
            & [hidden] { display: none; }
            & p { margin: 0; font-size: 0.72rem; color: ${t('color-text-secondary')}; }
            & .transition-button { ${btn(t('radius-sm'))} padding: ${s('xs')} ${s('sm')}; font-size: 0.75rem; }
            & details { display: flex; flex-direction: column; gap: ${s('xs')}; }
        }
        .path-transitions[hidden] { display: none; }
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

            & .shape-id {
                font-family: ui-monospace, monospace;
                font-size: 0.75rem;
                user-select: all;
                &:empty { display: none; }
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
            & .zone-height {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                font-weight: 400;
                & input { flex: 1 1 0; min-width: 0; }
            }
            & .move-hint {
                display: none;
                font-size: 0.72rem;
                font-weight: 400;
                font-style: italic;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
            }
            & .zone-extras {
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
            }
            & .zone-extras-title {
                font-size: 0.8rem;
                font-weight: 600;
                color: ${t('color-text-secondary')};
            }
            & .zone-extras-list {
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                &:empty { display: none; }
            }
            & .zone-extra {
                ${field()}
                flex-direction: row;
                flex-wrap: wrap;
                align-items: center;
                & select { flex: 1 1 6rem; min-width: 0; }
                & input { width: 4rem; }
                & .zone-extra-remove {
                    padding: ${s('xs')} ${s('sm')};
                    font-size: 0.9rem;
                    line-height: 1;
                    ${btn(t('radius-sm'))}
                }
            }
            & .zone-variant-field, & .path-width-field, & .creek-cover-field {
                display: none;
                &.show { display: flex; }
            }
            & .tree-area-kind {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                font-size: 0.75rem;
                color: ${t('color-text-secondary')};
            }
            & .tree-area-hint {
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
            }
            & .tree-species {
                ${field()}
                flex-direction: row;
                align-items: center;
                & input[type=text] { flex: 1 1 6rem; min-width: 0; }
                & input[type=number] { width: 4rem; }
                & .tree-species-share { width: 2.5rem; text-align: right; font-size: 0.75rem; color: ${t('color-text-secondary')}; }
                & .zone-extra-remove {
                    padding: ${s('xs')} ${s('sm')};
                    font-size: 0.9rem;
                    line-height: 1;
                    ${btn(t('radius-sm'))}
                }
            }
            & .path-ends-field {
                display: none;
                flex-direction: column;
                gap: ${s('xs')};
                &.show { display: flex; }
            }
            & .path-ends-which, & .path-ends-shapes { display: flex; gap: 2px; }
            & .cap-which {
                flex: 1 1 0;
                padding: 2px ${s('xs')};
                font-size: 0.72rem;
                ${btn(t('radius-sm'))}
                &.active { outline: 2px solid ${t('color-accent-primary')}; outline-offset: -2px; }
            }
            & .cap-btn {
                flex: 1 1 0;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 3px 0;
                ${btn(t('radius-sm'))}
                & svg { width: 28px; height: 16px; display: block; }
                &.active { outline: 2px solid ${t('color-accent-primary')}; outline-offset: -2px; }
            }
            & .path-end-size-field {
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
                &.hidden { display: none; }
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
    private transitionMap = this.inject(MapService);
    private transitionHost?: HTMLElement;
    private pathSurfaceSelect?: HTMLSelectElement;

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            root: { className: () => this.features.selectedIds.get().size > 0 ? 'sel-panel show' : 'sel-panel' },
            shapeId: () => {
                const f = this.features.selectedIds.get().size === 1 ? this.features.selected.get() : null;
                if (!f) return '';
                return svgShapeName(f, this.courseDetail.drawScopes.get().find(h => h.id === f.holeId)?.number);
            },
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
            // Vegetation zones are filed under a hole to find them again; the
            // hole plays no part in how zones add up (D-VZ14), so say so -
            // and do not call it a move next to the stack panel's own filter.
            moveLabel: { textContent: () => this.zonesOnlySelection() ? 'Hole (folder)' : 'Move selected to' },
            moveHint: { className: () => this.zonesOnlySelection() ? 'move-hint show' : 'move-hint' },
            // Vegetation mode selects creeks and water (read-only there) for
            // their bank vegetation: say where their shape is edited.
            backdropHint: {
                className: () => this.backdropSelected() ? 'curve-hint show' : 'curve-hint',
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
            // Tree species area (shared/features/tree-areas.ts): the species mix
            // the Unity tree planter uses for the survey trees inside it.
            treeAreaSection: {
                className: () => this.treeAreaSelection() ? 'zone-section show' : 'zone-section',
            },
            treeAreaName: {
                value: () => treeAreaNameOf(this.treeAreaSelection()?.attributes),
                onchange: (e: Event) => {
                    const name = (e.target as HTMLInputElement).value.trim();
                    this.saveTreeArea({ [TREE_AREA_NAME_ATTRIBUTE]: name || undefined });
                },
            },
            treeAreaIgnoreKind: {
                checked: () => treeAreaIgnoresKind(this.treeAreaSelection()?.attributes),
                onchange: (e: Event) => this.saveTreeArea({ [TREE_AREA_IGNORE_KIND_ATTRIBUTE]: (e.target as HTMLInputElement).checked || undefined }),
            },
            treeAreaAddBtn: {
                onclick: () => {
                    const mix = this.treeAreaMix();
                    const used = new Set(mix.map(m => m.species));
                    const next = SUGGESTED_TREE_SPECIES.find(sp => !used.has(sp));
                    if (next) this.saveTreeMix([...mix, { species: next, weight: 1 }]);
                },
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
            // Rock slab (shared/features/rock-slab.ts): how far the cut-out
            // grows past the outline and the texture tile size — every
            // selected slab at once.
            rockSection: {
                className: () => this.rockSelection().length > 0 ? 'zone-section show' : 'zone-section',
            },
            rockMargin: {
                value: () => this.sharedRockNumber(rockSlabMarginOf),
                onchange: (e: Event) => this.saveRockNumber(
                    e, ROCK_SLAB_MARGIN_ATTRIBUTE, ROCK_SLAB_MARGIN_RANGE_M.min, ROCK_SLAB_MARGIN_RANGE_M.max),
            },
            rockTile: {
                value: () => this.sharedRockNumber(rockSlabTileOf),
                onchange: (e: Event) => this.saveRockNumber(e, ROCK_SLAB_TILE_ATTRIBUTE, 0.5, Infinity),
            },
            // Creek bank vegetation (shared/features/creek-vegetation.ts):
            // which creek_bank palette plants the banks, and how much of the
            // water it covers — every selected creek and water at once.
            creekSection: {
                className: () => this.creekSelection().length > 0 ? 'zone-section show' : 'zone-section',
            },
            creekTitle: () => {
                const n = this.creekSelection().length;
                return n > 1 ? `Bank vegetation (${n} ${this.creekSelection().every(f => f.type === 'water_creek') ? 'creeks' : 'waters'})` : 'Bank vegetation';
            },
            creekCoverField: {
                className: () => this.creekSelection().some(f => bankVegOf(f.attributes))
                    ? 'zone-field creek-cover-field show' : 'zone-field creek-cover-field',
            },
            creekCover: {
                value: () => {
                    const covers = new Set(this.creekSelection().map(f => bankVegCoverOf(f.attributes)));
                    return covers.size === 1 ? String(Math.round([...covers][0]! * 100)) : '';
                },
                onchange: (e: Event) => {
                    const pct = Number((e.target as HTMLInputElement).value);
                    if (Number.isFinite(pct)) this.saveCreeks({ [BANK_VEG_COVER_ATTRIBUTE]: Math.min(100, Math.max(0, pct)) / 100 });
                },
            },
            creekMaxField: {
                className: () => this.creekSelection().some(f => bankVegOf(f.attributes))
                    ? 'zone-field creek-cover-field show' : 'zone-field creek-cover-field',
            },
            creekMax: {
                value: () => this.sharedCreekNumber(BANK_VEG_MAX_ATTRIBUTE, DEFAULT_BANK_VEG_MAX_M),
                onchange: (e: Event) => {
                    const m = Number((e.target as HTMLInputElement).value);
                    if (Number.isFinite(m)) this.saveCreeks({ [BANK_VEG_MAX_ATTRIBUTE]: Math.min(30, Math.max(0.5, m)) });
                },
            },
            // Only where a selected creek's palette has a water mix (`<palette>_wet`) to reach up the bank.
            creekWetField: {
                className: () => this.creekSelection().some(f => this.hasWetMix(bankVegOf(f.attributes)))
                    ? 'zone-field creek-cover-field show' : 'zone-field creek-cover-field',
            },
            creekWet: {
                value: () => this.sharedCreekNumber(BANK_VEG_WET_ATTRIBUTE, DEFAULT_BANK_VEG_WET_M),
                onchange: (e: Event) => {
                    const m = Number((e.target as HTMLInputElement).value);
                    if (Number.isFinite(m)) this.saveCreeks({ [BANK_VEG_WET_ATTRIBUTE]: Math.min(10, Math.max(0, m)) });
                },
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
            zoneEdgeBlend: {
                value: () => String(this.zoneAttributes().edgeBlend ?? ''),
                // Absent: a drawn zone that replaces blends by default, one that adds or was generated does not.
                placeholder: () => this.zoneAttributes().blend === 'mix' || this.zoneSelection()?.generated
                    ? '0' : String(ZONE_EDGE_BLEND_DEFAULT_M),
                onchange: (e: Event) => {
                    const raw = (e.target as HTMLInputElement).value.trim();
                    const m = Number(raw);
                    this.saveZone({ edgeBlend: raw !== '' && Number.isFinite(m) ? Math.max(0, m) : undefined });
                },
            },
            zoneHeightMin: {
                max: () => String(ZONE_HEIGHT_LIMIT_M),
                value: () => String(this.zoneAttributes().heightMin ?? ''),
                onchange: (e: Event) => this.saveZoneHeight('min', (e.target as HTMLInputElement).value),
            },
            zoneHeightMax: {
                max: () => String(ZONE_HEIGHT_LIMIT_M),
                value: () => String(this.zoneAttributes().heightMax ?? ''),
                onchange: (e: Event) => this.saveZoneHeight('max', (e.target as HTMLInputElement).value),
            },
            zoneBlend: {
                value: () => this.zoneAttributes().blend,
                onchange: (e: Event) => this.saveZone({ blend: (e.target as HTMLSelectElement).value as ZoneBlend }),
            },
            zoneExtraAddBtn: {
                onclick: () => {
                    const extras = this.zoneExtras();
                    const { zoneType } = this.zoneAttributes();
                    // Start on a type the zone does not plant yet, so the new row is not a no-op.
                    const used = new Set([zoneType, ...extras.map(e => e.zoneType)]);
                    const types = this.zoneTypes.items.peek();
                    const next = (types.find(z => !used.has(z.key)) ?? types[0])?.key;
                    if (!next) return;
                    this.saveZoneExtras([...extras, { zoneType: next, zoneVariant: this.zoneTypes.startVariantOf(next), weight: 1 }]);
                },
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
            unionBtn: {
                onclick: () => this.tool.unionSelection(),
                className: () => this.tool.selectionCanUnion() ? 'op-btn show' : 'op-btn',
            },
            convertBtn: {
                onclick: () => void this.tool.convertSelectedToBezier(),
                className: () => this.features.editableSelected.get()?.geometry.curveType === 'bspline'
                    ? 'op-btn convert-btn show' : 'op-btn convert-btn',
            },
            deleteBtn: {
                onclick: () => void this.tool.deleteSelected(),
                className: () => this.backdropSelected() ? 'delete-btn hidden' : 'delete-btn',
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

        const transitionHost = document.createElement('div');
        transitionHost.dataset.testid = 'path-transitions';
        transitionHost.className = 'path-transitions';
        this.transitionHost = transitionHost;
        this.ref(frag, 'pathSection').after(transitionHost);
        this.track(mountPathTransitions(transitionHost, this.features, this.tool, this.transitionMap));

        // Surface picker: fixed options; Mixed only while the selected paths disagree.
        const surfaceSelect = this.ref(frag, 'pathSurface') as HTMLSelectElement;
        this.pathSurfaceSelect = surfaceSelect;
        surfaceSelect.addEventListener('change', () => {
            if (surfaceSelect.value !== MIXED_SURFACE) this.savePathSurface(surfaceSelect.value as PathSurface | '');
        });
        this.track(effect(() => {
            const current = this.pathSurfaceValue();
            const options: [string, string][] = [];
            if (current === MIXED_SURFACE) options.push([MIXED_SURFACE, 'Mixed']);
            options.push(['', 'Unknown']);
            for (const surface of PATH_SURFACES) options.push([surface, PATH_SURFACE_LABELS[surface]]);
            syncOptions(surfaceSelect, options, current);
        }));

        // Creek palette picker: None, the creek_bank type's Default mix when it
        // has items, then its variants (not the `_wet` halves); Mixed only while the creeks disagree,
        // and an explicit option for a palette the type no longer has.
        const paletteSelect = this.ref(frag, 'creekPalette') as HTMLSelectElement;
        paletteSelect.addEventListener('change', () => {
            if (paletteSelect.value !== MIXED_PALETTE) this.saveCreeks({ [BANK_VEG_ATTRIBUTE]: paletteSelect.value || null });
        });
        this.track(effect(() => {
            const creeks = this.creekSelection();
            const values = new Set(creeks.map(f => bankVegOf(f.attributes) ?? ''));
            const current = values.size > 1 ? MIXED_PALETTE : values.values().next().value ?? '';
            const type = this.zoneTypes.items.get().find(z => z.key === CREEK_BANK_ZONE_TYPE);
            const options: [string, string][] = [];
            if (current === MIXED_PALETTE) options.push([MIXED_PALETTE, 'Mixed']);
            options.push(['', 'None']);
            if (type && type.items.length > 0) options.push([BANK_VEG_DEFAULT, 'Default']);
            // `<palette>_wet` variants are the lower half of a palette, not a choice of their own.
            for (const v of type?.variants ?? []) if (!isWetBankVariant(v.key)) options.push([v.key, v.name]);
            for (const value of values) {
                if (value && !options.some(([key]) => key === value)) options.push([value, `${value} (no such palette)`]);
            }
            syncOptions(paletteSelect, options, current);
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

        // End shapes (shared/features/centerline.ts CenterlineCap): pick which
        // end, then a shape; every selected centerline road at once. A shape
        // button is lit when every chosen end of the selection has it.
        const endsField = this.ref(frag, 'pathEndsField');
        const whichButtons = [...endsField.querySelectorAll<HTMLButtonElement>('.cap-which')];
        for (const b of whichButtons) b.addEventListener('click', () => this.capEnds.set(b.dataset['end'] as CapEnds));
        const shapeHost = this.ref(frag, 'pathEndsShapes');
        const shapeButtons = CAP_PRESETS.map(preset => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'cap-btn';
            b.title = preset.label;
            b.dataset['testid'] = `path-cap-${preset.id}`;
            b.innerHTML = CAP_ICONS[preset.id];
            b.addEventListener('click', () => this.tool.setSelectedCenterlineCaps(this.capEnds.peek(), preset.cap));
            shapeHost.append(b);
            return { preset, b };
        });
        const sizeField = this.ref(frag, 'pathEndSizeField');
        const sizeLabel = this.ref(frag, 'pathEndSizeLabel');
        const sizeInput = this.ref(frag, 'pathEndSize') as HTMLInputElement;
        sizeInput.addEventListener('change', () => {
            const value = Number(sizeInput.value);
            const shape = this.chosenCaps()[0]?.shape;
            if (!Number.isFinite(value) || value <= 0) return;
            if (shape === 'turning') this.tool.setSelectedCenterlineCaps(this.capEnds.peek(), { shape, diameterM: value });
            if (shape === 'taper') this.tool.setSelectedCenterlineCaps(this.capEnds.peek(), { shape, lengthM: value });
        });
        this.track(effect(() => {
            const roads = this.centerlineSelection();
            endsField.className = roads.length > 0 ? 'path-ends-field show' : 'path-ends-field';
            const ends = this.capEnds.get();
            for (const b of whichButtons) b.classList.toggle('active', b.dataset['end'] === ends);
            const caps = this.chosenCaps();
            const presets = new Set(caps.map(c => capPresetOf(c)));
            for (const { preset, b } of shapeButtons) b.classList.toggle('active', presets.size === 1 && presets.has(preset.id));
            // Turning circle / taper: their one size, when every chosen end has that shape.
            const shapes = new Set(caps.map(c => c?.shape ?? 'rounded'));
            const shape = shapes.size === 1 ? [...shapes][0] : null;
            const sized = roads.length > 0 && (shape === 'turning' || shape === 'taper');
            sizeField.className = sized ? 'zone-field path-end-size-field show' : 'zone-field path-end-size-field';
            if (!sized) return;
            sizeLabel.textContent = shape === 'turning' ? 'Diameter (m)' : 'Taper length (m)';
            sizeField.title = shape === 'turning' ? 'The turning circle across (default 2.5 × the road width)' : 'How long the road narrows (default 2 × the road width)';
            const sizes = new Set(roads.flatMap(f => this.capKeys().map(key => {
                const r = resolveCap(f.geometry.centerline![key], f.geometry.centerline!.widthM);
                return shape === 'turning' ? r.diameterM : r.lengthM;
            })));
            if (document.activeElement !== sizeInput) sizeInput.value = sizes.size === 1 ? String(Math.round([...sizes][0] * 100) / 100) : '';
        }));

        // Zone-type picker: options from the course's table, value from the
        // selected zone. A zone naming a type the table no longer has keeps
        // an explicit option of its own, so saving weight never silently
        // retypes it.
        const zoneSelect = this.ref(frag, 'zoneType') as HTMLSelectElement;
        // A variant key belongs to its type: a new type starts on its start variant (Default, unless that is empty).
        zoneSelect.addEventListener('change', () => this.saveZone({ zoneType: zoneSelect.value, zoneVariant: this.zoneTypes.startVariantOf(zoneSelect.value) }));
        this.track(effect(() => {
            const types = this.zoneTypes.items.get();
            const current = this.zoneAttributes().zoneType;
            const options: [string, string][] = types.map(z => [z.key, z.name]);
            if (current && !types.some(z => z.key === current)) options.push([current, `${current} (no such zone type)`]);
            syncOptions(zoneSelect, options, current);
        }));

        // Variant picker: "Default" plus the selected zone's type's pickable
        // variants (not a creek_bank `_wet` half); hidden while that type has
        // none. Default says so when it binds nothing. A zone naming a variant
        // its type no longer has keeps an explicit option (the export falls
        // back to Default for it), mirroring the zone-type picker; one on a
        // `_wet` half keeps it too.
        const variantField = this.ref(frag, 'zoneVariantField');
        const variantSelect = this.ref(frag, 'zoneVariant') as HTMLSelectElement;
        variantSelect.addEventListener('change', () => this.saveZone({ zoneVariant: variantSelect.value }));
        this.track(effect(() => {
            const { zoneType, zoneVariant } = this.zoneAttributes();
            const all = this.zoneTypes.variantsOf(zoneType);
            const variants = this.zoneTypes.pickableVariantsOf(zoneType);
            const hiddenCurrent = all.find(v => v.key === zoneVariant && !variants.includes(v));
            const orphan = zoneVariant !== '' && !all.some(v => v.key === zoneVariant);
            variantField.className = variants.length > 0 || orphan || hiddenCurrent
                ? 'zone-field zone-variant-field show'
                : 'zone-field zone-variant-field';
            const options: [string, string][] = [
                ['', this.zoneTypes.hasDefaultItems(zoneType) ? 'Default' : 'Default (no items: plants nothing)'],
                ...variants.map(v => [v.key, v.name] as [string, string]),
                ...(hiddenCurrent ? [[hiddenCurrent.key, `${hiddenCurrent.name} (water half only)`] as [string, string]] : []),
                ...(orphan ? [[zoneVariant, `${zoneVariant} (no such variant)`] as [string, string]] : []),
            ];
            syncOptions(variantSelect, options, zoneVariant);
        }));

        // The zone's extra palettes: one row each (type, variant, weight,
        // remove), rebuilt from the attribute string whenever it or the
        // table changes. Every edit writes the whole list back.
        const extrasList = this.ref(frag, 'zoneExtras');
        this.track(effect(() => {
            const extras = this.zoneExtras();
            this.zoneTypes.items.get();
            extrasList.textContent = '';
            extras.forEach((extra, index) => extrasList.appendChild(untrack(() => this.zoneExtraRow(extras, extra, index))));
        }));

        // The tree species area's mix: one row per species (name, weight, share,
        // remove) from the attribute string. Every edit writes it all back; the
        // rows are kept and refreshed in place so Tab after an edit moves on.
        const mixList = this.ref(frag, 'treeAreaMix');
        const mixRows: { row: HTMLElement; show: (mix: TreeSpeciesShare[]) => void }[] = [];
        this.track(effect(() => {
            const mix = this.treeAreaMix();
            untrack(() => {
                while (mixRows.length > mix.length) mixRows.pop()!.row.remove();
                while (mixRows.length < mix.length) {
                    const row = this.treeSpeciesRow(mixRows.length);
                    mixRows.push(row);
                    mixList.appendChild(row.row);
                }
                for (const row of mixRows) row.show(mix);
            });
        }));
        // Species suggestions for the rows (one list per page, shared by every row).
        if (!document.getElementById(TREE_SPECIES_LIST_ID)) {
            const list = document.createElement('datalist');
            list.id = TREE_SPECIES_LIST_ID;
            for (const sp of SUGGESTED_TREE_SPECIES) {
                const option = document.createElement('option');
                option.value = sp;
                list.appendChild(option);
            }
            document.body.appendChild(list);
        }

        this.moveSelect = this.ref(frag, 'moveSelect') as HTMLSelectElement;
        this.moveSelect.addEventListener('change', () => {
            if (this.moveSelect.value === '__mixed') return;
            this.tool.assignSelectionScope(scopeFromKey(this.moveSelect.value));
        });

        // Move-target options + current selection scope. This is explicit
        // repair UI for "I drew that on the wrong hole" mistakes. The options
        // depend on the selection (Roughs takes rough types only, zones have
        // no Roughs), so they are rebuilt when that changes; an edit of the
        // selected feature only moves the value.
        let builtFor: { holes: unknown; mixed: boolean; roughsDisabled: boolean; zonesOnly: boolean } | null = null;
        this.track(effect(() => {
            const holes = this.courseDetail.drawScopes.get();
            const selected = this.features.selectedFeatures.get();
            const selectedScopes = new Set(selected.map(f => scopeKey(scopeOf(f))));
            const value = selectedScopes.size === 1 ? [...selectedScopes][0]! : '__mixed';
            const next = {
                holes,
                mixed: selectedScopes.size > 1,
                roughsDisabled: !selected.every(f => isRoughsLayerType(f.type)),
                zonesOnly: this.zonesOnlySelection(),
            };
            if (builtFor && builtFor.holes === next.holes && builtFor.mixed === next.mixed
                && builtFor.roughsDisabled === next.roughsDisabled && builtFor.zonesOnly === next.zonesOnly) {
                if (this.moveSelect.value !== value) this.moveSelect.value = value;
                return;
            }
            builtFor = next;
            this.moveSelect.textContent = '';
            if (next.mixed) {
                const mixed = document.createElement('option');
                mixed.value = '__mixed';
                mixed.textContent = 'Mixed holes';
                this.moveSelect.appendChild(mixed);
            }
            // The Roughs layer takes rough types only (D28).
            fillScopeOptions(this.moveSelect, holes, { roughsDisabled: next.roughsDisabled });
            if (next.zonesOnly) {
                // A zone's "hole" is a folder: no stack words, no Roughs.
                for (const option of [...this.moveSelect.options]) {
                    if (option.value === scopeKey(COURSE_SCOPE)) option.textContent = 'No hole (course level)';
                    else if (option.value === ROUGHS_SCOPE_KEY) option.remove();
                }
            }
            this.moveSelect.value = value;
        }));

        return frag;
    }

    /** True when the selection is vegetation zones only. */
    private zonesOnlySelection(): boolean {
        const selected = this.features.selectedFeatures.get();
        return selected.length > 0 && selected.every(f => f.type === 'vegetation_zone');
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

    /** The selected zone's extra palettes, parsed from its attribute string. */
    private zoneExtras(): ZonePalette[] {
        return zoneExtraPalettesOf({ extraPalettes: this.zoneAttributes().extraPalettes });
    }

    private saveZoneExtras(extras: ZonePalette[]): void {
        this.saveZone({ extraPalettes: formatZonePalettes(extras) });
    }

    /** One extra-palette row: type and variant pickers like the zone's own, its weight, and remove. */
    private zoneExtraRow(extras: ZonePalette[], extra: ZonePalette, index: number): HTMLElement {
        const replace = (patch: Partial<ZonePalette>) =>
            this.saveZoneExtras(extras.map((e, i) => i === index ? { ...e, ...patch } : e));
        const row = document.createElement('div');
        row.className = 'zone-extra';
        row.dataset.testid = 'zone-extra-palette';

        const typeSelect = document.createElement('select');
        typeSelect.dataset.testid = 'zone-extra-type';
        const types = this.zoneTypes.items.peek();
        const typeOptions: [string, string][] = types.map(z => [z.key, z.name]);
        if (!types.some(z => z.key === extra.zoneType)) typeOptions.push([extra.zoneType, `${extra.zoneType} (no such zone type)`]);
        fillOptions(typeSelect, typeOptions, extra.zoneType);
        typeSelect.addEventListener('change', () =>
            replace({ zoneType: typeSelect.value, zoneVariant: this.zoneTypes.startVariantOf(typeSelect.value) }));

        const variantSelect = document.createElement('select');
        variantSelect.dataset.testid = 'zone-extra-variant';
        const all = this.zoneTypes.variantsOf(extra.zoneType);
        const variants = this.zoneTypes.pickableVariantsOf(extra.zoneType);
        const variantOptions: [string, string][] = [
            ['', this.zoneTypes.hasDefaultItems(extra.zoneType) ? 'Default' : 'Default (no items)'],
            ...variants.map(v => [v.key, v.name] as [string, string]),
        ];
        if (extra.zoneVariant && !variants.some(v => v.key === extra.zoneVariant)) {
            const hidden = all.find(v => v.key === extra.zoneVariant);
            variantOptions.push([extra.zoneVariant, hidden ? `${hidden.name} (water half only)` : `${extra.zoneVariant} (no such variant)`]);
        }
        fillOptions(variantSelect, variantOptions, extra.zoneVariant);
        variantSelect.style.display = variantOptions.length > 1 ? '' : 'none';
        variantSelect.addEventListener('change', () => replace({ zoneVariant: variantSelect.value }));

        const weight = document.createElement('input');
        weight.type = 'number';
        weight.min = '0';
        weight.max = '1';
        weight.step = '0.05';
        weight.title = "Weight, times the zone's own";
        weight.dataset.testid = 'zone-extra-weight';
        weight.value = String(extra.weight);
        weight.addEventListener('change', () => {
            const value = Number(weight.value);
            replace({ weight: Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : extra.weight });
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'zone-extra-remove';
        remove.textContent = '×';
        remove.title = 'Remove this palette';
        remove.setAttribute('aria-label', 'Remove this palette');
        remove.dataset.testid = 'zone-extra-remove';
        remove.addEventListener('click', () => this.saveZoneExtras(extras.filter((_, i) => i !== index)));

        row.append(typeSelect, variantSelect, weight, remove);
        return row;
    }

    /**
     * Persist one changed zone field. `attributes` replaces the whole object
     * server-side, so every zone key goes every time — the others come from
     * `zoneAttributes()`, which is the values on screen.
     */
    /** One end of the bush height was typed: the other follows (shared/features/zone-height.ts). */
    private saveZoneHeight(end: 'min' | 'max', raw: string): void {
        const height = editZoneHeight(zoneHeightOf(this.zoneAttributes()), end, raw);
        this.saveZone({ heightMin: height?.min, heightMax: height?.max });
    }

    private saveZone(patch: Partial<ZoneAttributes>): void {
        const zone = this.zoneSelection();
        if (!zone) return;
        void this.features.update(zone.id, { attributes: { ...this.zoneAttributes(), ...patch } });
    }

    /** The single selected feature when it is an editable tree species area, else null. */
    private treeAreaSelection(): CourseFeature | null {
        const f = this.features.editableSelected.get();
        return f && f.type === TREE_AREA_TYPE ? f : null;
    }

    private treeAreaMix(): TreeSpeciesShare[] {
        return speciesMixOf(this.treeAreaSelection()?.attributes);
    }

    /**
     * Persist the area's attributes with `patch` applied (undefined drops a key).
     * The mix edited last is also what the next drawn area starts with.
     */
    private saveTreeArea(patch: Record<string, string | boolean | undefined>): void {
        const area = this.treeAreaSelection();
        if (!area) return;
        const attributes = { ...(area.attributes ?? {}) } as Record<string, string | number | boolean>;
        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) delete attributes[key];
            else attributes[key] = value;
        }
        const mix = attributes[TREE_AREA_SPECIES_ATTRIBUTE];
        if (typeof mix === 'string') this.tool.drawTreeMix.set(mix);
        void this.features.update(area.id, { attributes });
    }

    /** False (nothing saved) for a mix of zeros: an area needs some weight, and the server refuses it. */
    private saveTreeMix(mix: TreeSpeciesShare[]): boolean {
        if (!mix.some(m => m.weight > 0)) return false;
        this.saveTreeArea({ [TREE_AREA_SPECIES_ATTRIBUTE]: formatSpeciesMix(mix) });
        return true;
    }

    /**
     * The mix's row `index`: the species (a palette label, with suggestions), its
     * weight, its share and remove. `show` fills it from the current mix; the
     * handlers read the mix when they fire.
     */
    private treeSpeciesRow(index: number): { row: HTMLElement; show: (mix: TreeSpeciesShare[]) => void } {
        const current = () => this.treeAreaMix()[index] ?? { species: '', weight: 0 };
        const replace = (patch: Partial<TreeSpeciesShare>) => this.saveTreeMix(this.treeAreaMix().map((m, i) => i === index ? { ...m, ...patch } : m));
        const row = document.createElement('div');
        row.className = 'tree-species';
        row.dataset.testid = 'tree-area-species';

        const species = document.createElement('input');
        species.type = 'text';
        species.setAttribute('list', TREE_SPECIES_LIST_ID);
        species.title = 'A species of the course tree palette (oak, birch, elm ...)';
        species.dataset.testid = 'tree-area-species-name';
        species.addEventListener('change', () => {
            const name = species.value.trim().toLowerCase();
            const ok = /^[a-z][a-z0-9_-]*$/.test(name) && !this.treeAreaMix().some((m, i) => i !== index && m.species === name);
            species.value = ok ? name : current().species;
            if (ok) replace({ species: name });
        });

        const weight = document.createElement('input');
        weight.type = 'number';
        weight.min = '0';
        weight.step = '1';
        weight.title = 'Relative weight (9 and 1 = 90% and 10%)';
        weight.dataset.testid = 'tree-area-species-weight';
        weight.addEventListener('change', () => {
            const value = Number(weight.value);
            const ok = weight.value.trim() !== '' && Number.isFinite(value) && value >= 0 && replace({ weight: value });
            weight.value = String(ok ? value : current().weight);
        });

        const pct = document.createElement('span');
        pct.className = 'tree-species-share';

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'zone-extra-remove';
        remove.textContent = '×';
        remove.title = 'Remove this species';
        remove.setAttribute('aria-label', 'Remove this species');
        remove.dataset.testid = 'tree-area-species-remove';
        remove.addEventListener('click', () => this.saveTreeMix(this.treeAreaMix().filter((_, i) => i !== index)));

        row.append(species, weight, pct, remove);
        const show = (mix: TreeSpeciesShare[]) => {
            const share = mix[index];
            // A field being typed in keeps its text until it is committed.
            if (document.activeElement !== species) species.value = share.species;
            if (document.activeElement !== weight) weight.value = String(share.weight);
            const total = mix.reduce((sum, m) => sum + m.weight, 0);
            pct.textContent = total > 0 ? `${Math.round((share.weight / total) * 100)}%` : '';
            remove.disabled = mix.length <= 1;
        };
        return { row, show };
    }

    /** The editable `path` features in the selection (others in a mixed selection are left alone). */
    private pathSelection(): CourseFeature[] {
        return this.features.editableSelectedFeatures.get().filter(f => f.type === 'path');
    }

    /** Which end the end-shape buttons set. */
    private capEnds = new Signal<CapEnds>('both');

    private capKeys(): Array<'startCap' | 'endCap'> {
        const ends = this.capEnds.get();
        return ends === 'both' ? ['startCap', 'endCap'] : [ends === 'start' ? 'startCap' : 'endCap'];
    }

    /** The chosen ends' caps across the selected centerline roads (undefined = half circle). */
    private chosenCaps(): Array<CenterlineCap | undefined> {
        const keys = this.capKeys();
        return this.centerlineSelection().flatMap(f => keys.map(key => f.geometry.centerline![key]));
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
        const invalid = !isLoosePathSurface(surface) && this.pathSelection().some(f => {
            const transitions = (f.attributes as unknown as {pathTransitions?: unknown[]})?.pathTransitions;
            return Array.isArray(transitions) && transitions.length > 0;
        });
        if (invalid) {
            const host = this.transitionHost;
            const warning = document.createElement('p'); warning.textContent = 'Remove transitions before changing to this surface.';
            host?.append(warning);
            const select = this.pathSurfaceSelect;
            if (select) select.value = this.pathSurfaceValue();
            return;
        }
        for (const f of this.pathSelection()) {
            if ((pathSurfaceOf(f.attributes) ?? '') === surface) continue;
            const attributes: Record<string, number | string | boolean> = { ...(f.attributes ?? {}) };
            if (surface) attributes[PATH_SURFACE_ATTRIBUTE] = surface;
            else delete attributes[PATH_SURFACE_ATTRIBUTE];
            void this.features.update(f.id, { attributes: Object.keys(attributes).length > 0 ? attributes : null });
        }
    }

    /** The editable rock slabs in the selection (others in a mixed selection are left alone). */
    private rockSelection(): CourseFeature[] {
        return this.features.editableSelectedFeatures.get().filter(f => f.type === ROCK_SLAB_TYPE);
    }

    /** The selected slabs' shared value of a numeric setting, the default when unset ('' while they differ). */
    private sharedRockNumber(read: (attributes: CourseFeature['attributes']) => number): string {
        const values = new Set(this.rockSelection().map(f => read(f.attributes)));
        return values.size === 1 ? String([...values][0]) : '';
    }

    /**
     * Set a numeric setting on every selected slab from a number input; cleared
     * drops the key (the default). A value outside min..max is clamped. `attributes`
     * replaces the whole object server-side, so each slab's other keys go along
     * unchanged.
     */
    private saveRockNumber(e: Event, key: string, min: number, max: number): void {
        const raw = (e.target as HTMLInputElement).value.trim();
        const value = raw === '' ? null : Math.min(max, Math.max(min, Number(raw)));
        for (const f of this.rockSelection()) {
            const attributes: Record<string, number | string | boolean> = { ...(f.attributes ?? {}) };
            if (value === null) delete attributes[key];
            else attributes[key] = value;
            if (JSON.stringify(attributes) === JSON.stringify(f.attributes ?? {})) continue;
            void this.features.update(f.id, { attributes: Object.keys(attributes).length > 0 ? attributes : null });
        }
    }

    /**
     * The creeks and water (`takesBankVeg`) in the selection, hand-drawn or
     * imported. Not `editableSelectedFeatures`: Vegetation mode selects them
     * read-only (backdrop), for this section only.
     */
    private creekSelection(): CourseFeature[] {
        return this.features.selectedFeatures.get().filter(f => takesBankVeg(f.type) && !isGeneratedFeature(f));
    }

    /** The selected creeks' shared value of a numeric bank setting ('' while they differ). */
    private sharedCreekNumber(key: string, fallback: number): string {
        const values = new Set(this.creekSelection().map(f => bankVegNumberOf(f.attributes, key, fallback)));
        return values.size === 1 ? String([...values][0]) : '';
    }

    /** Whether a palette key has a water mix: the creek_bank type binds `<palette>_wet`. */
    private hasWetMix(palette: string | null): boolean {
        if (!palette) return false;
        return this.zoneTypes.variantsOf(CREEK_BANK_ZONE_TYPE).some(v => v.key === `${palette}${BANK_VEG_WET_SUFFIX}`);
    }

    /** True while the selection holds a backdrop feature of the active mode (Vegetation: a creek or water). */
    private backdropSelected(): boolean {
        const backdrop = this.features.modeBackdropTypes.get();
        return this.features.selectedFeatures.get().some(f => backdrop.has(f.type));
    }

    /**
     * Set bank vegetation keys on every selected creek (`null` removes a key).
     * `attributes` replaces the whole object server-side, so each creek's
     * other keys (dig settings, R.A.M. profile) go along unchanged.
     */
    private saveCreeks(patch: Record<string, string | number | null>): void {
        for (const f of this.creekSelection()) {
            const attributes: Record<string, number | string | boolean> = { ...(f.attributes ?? {}) };
            for (const [key, value] of Object.entries(patch)) {
                if (value === null) delete attributes[key];
                else attributes[key] = value;
            }
            if (JSON.stringify(attributes) === JSON.stringify(f.attributes ?? {})) continue;
            void this.features.update(f.id, { attributes: Object.keys(attributes).length > 0 ? attributes : null });
        }
    }

    /** False while any selected row is read-only (generated, or a backdrop of the mode): hides move/duplicate. */
    private editingAllowed(): boolean {
        const items = this.features.selectedFeatures.get();
        return items.length > 0 && this.features.editableSelectedFeatures.get().length === items.length;
    }
}

/** A number input's value, falling back when it was cleared or unparsable. */
function fillOptions(select: HTMLSelectElement, options: [string, string][], value: string): void {
    for (const [key, label] of options) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = label;
        select.appendChild(option);
    }
    select.value = value;
}

/**
 * Give `select` exactly `options` and `value`. The options are rebuilt only
 * when they differ from what is there, so an edit of the selected feature
 * (which re-runs the picker effects) adds no DOM.
 */
function syncOptions(select: HTMLSelectElement, options: [string, string][], value: string): void {
    const current = select.options;
    const same = current.length === options.length
        && options.every(([key, label], i) => current[i]!.value === key && current[i]!.textContent === label);
    if (!same) {
        select.textContent = '';
        fillOptions(select, options, value);
    } else if (select.value !== value) {
        select.value = value;
    }
}

function numberOf(e: Event, fallback: number): number {
    const value = Number((e.target as HTMLInputElement).value);
    return Number.isFinite(value) ? value : fallback;
}
