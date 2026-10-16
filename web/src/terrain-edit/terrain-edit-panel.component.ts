import { Component, Computed, Signal, effect, template, untrack } from '@basics/core/client/core';
import { t } from '../theme';
import { s, iconBtn } from '../css';
import { dockBody, sectionTitle, panelInput, busyAndNotice, hintsFooter } from '../editor/panel-recipes.css';
import { icon } from '../ui/icons';
import { SELECTION_COLOR } from '../draw/feature-palette';
import { ConfirmService } from '../app/confirm-dialog.component';
import {
    NO_RECIPE, SEED, inapplicable, overridesToSave, surfaceOf, type RecipeParam, type ShapingRecipe,
} from './shaping.service';
import {
    TerrainEditToolService,
    OP_GLYPHS,
    DEFAULT_RADIUS_M,
    isRecipeEdit,
    paramsSummary,
    recipeParams,
    type DigSettings,
    type PondEdgeReview,
    type EditGroup,
    type TerrainEditOp,
} from './terrain-edit-tool.service';
import type { TerrainEdit } from '../../../shared/api/terrain-edits.gen';
import {
    BUNKER_DIG, CREEK_DIG_PRESETS, DEFAULT_CREEK_DIG_PRESET, DEFAULT_WATER_DIG_PRESET, WATER_DIG_PRESETS,
} from '../../../shared/features/dig-presets';

const tpl = template(`
    <div class="tedit-panel" bind="root" data-testid="terrain-edit-panel">
        <div bind="shapeSection" class="section shape" data-testid="terrain-shape-section">
            <div class="shape__head">
                <h4 class="section-title">Shape in Blender</h4>
                <button bind="shapeCloseBtn" type="button" class="edit-row__btn" aria-label="Close" title="Deselect (Esc)">${icon('x', 16)}</button>
            </div>
            <div bind="shapeFeature" class="shape__feature" data-testid="terrain-shape-feature"></div>
            <label class="field field--stack">
                <span>Recipe</span>
                <select bind="recipeSelect" class="input" data-testid="terrain-shape-recipe" aria-label="Recipe"></select>
            </label>
            <div bind="recipeHint" class="hint" data-testid="terrain-shape-recipe-hint"></div>
            <div bind="paramsHost" class="shape-params" data-testid="terrain-shape-params"></div>
            <div class="edit-form__actions">
                <button bind="recipeSaveBtn" type="button" data-testid="terrain-shape-save">Save</button>
            </div>
            <div class="hint" data-testid="terrain-shape-apply-hint">Save the recipe, then <b>Update meshes (this feature)</b> in the command bar.</div>
            <div bind="shapeJob" class="shape-job" data-testid="terrain-shape-job"></div>
        </div>
        <div class="section">
            <h4 class="section-title">New edit</h4>
            <select bind="opSelect" class="input" data-testid="terrain-edit-op" aria-label="Operation">
                <option value="plane">Plane fit — even fall</option>
                <option value="smooth">Smooth — kill spikes</option>
            </select>
            <label class="field">
                <span>Feather (m)</span>
                <input bind="featherInput" class="input input--num" type="number" min="0" step="0.5" data-testid="terrain-edit-feather" />
            </label>
            <label bind="radiusField" class="field">
                <span>Radius (m)</span>
                <input bind="radiusInput" class="input input--num" type="number" min="0.5" step="0.5" data-testid="terrain-edit-radius" />
            </label>
            <label bind="flatField" class="field field--check">
                <input bind="flatInput" type="checkbox" data-testid="terrain-edit-flat" />
                <span>Dead flat (level pad)</span>
            </label>
        </div>
        <div class="section">
            <h4 class="section-title">Generate</h4>
            <button bind="genPadsBtn" type="button" class="gen-btn" data-testid="terrain-edit-gen-pads"></button>
            <button bind="genRoadsBtn" type="button" class="gen-btn" data-testid="terrain-edit-gen-roads"></button>
            <button bind="genPondsBtn" type="button" class="gen-btn" data-testid="terrain-edit-gen-ponds"></button>
            <button bind="fitEdgesBtn" type="button" class="gen-btn" data-testid="terrain-edit-fit-edges"></button>
            <button bind="genBunkersBtn" type="button" class="gen-btn" data-testid="terrain-edit-gen-bunkers"></button>
            <button bind="genCreeksBtn" type="button" class="gen-btn" data-testid="terrain-edit-gen-creeks"></button>
            <div class="hint">Building pads: every OSM building footprint in the map area, measured on the lidar, gets a flat pad. Road grades: every OSM road, smoothed along and levelled across. Each run replaces its own previous edits only — yours stay. Then Apply to terrain.</div>
            <div class="hint">Bunkers, ponds and creeks under the course meshes are shaped in Blender by their recipe (the course default unless you pick one — click the feature). The DEM digs here still shape the terrain around and outside the meshes.</div>
        </div>
        <div bind="pondEdgeSection" class="section hidden" data-testid="terrain-edit-pond-edge">
            <h4 bind="pondEdgeTitle" class="section-title"></h4>
            <div bind="pondEdgeSummary" class="hint" data-testid="terrain-edit-pond-edge-summary"></div>
            <div class="hint">Red: the proposed edge, found on the photo between the lidar's open water (yellow, dashed) and the drawn line. Accept stores it on the pond as a B-spline.</div>
            <div class="edit-form__actions">
                <button bind="pondEdgeDiscardBtn" type="button" data-testid="terrain-edit-pond-edge-discard"></button>
                <button bind="pondEdgeAcceptBtn" type="button" data-testid="terrain-edit-pond-edge-accept">Accept</button>
            </div>
        </div>
        <div bind="savingLine" class="busy-line">Saving…</div>
        <div bind="notice" class="notice" data-testid="terrain-edit-notice"></div>
        <button bind="pondEdgeUndoBtn" type="button" class="gen-btn hidden" data-testid="terrain-edit-pond-edge-undo"></button>
        <div class="section">
            <h4 class="section-title">Edits on this site</h4>
            <div bind="list" class="edit-list" data-testid="terrain-edit-list"></div>
            <div bind="empty" class="empty">No terrain edits yet.</div>
        </div>
        <button bind="applyBtn" type="button" class="apply-btn" data-testid="terrain-edit-apply">Apply to terrain</button>
        <div bind="applyLine" class="busy-line" data-testid="terrain-edit-apply-progress"></div>
        <div class="hint" data-testid="terrain-edit-meshes-hint"><b>Update meshes</b> and <b>Update terrain</b> are in the command bar.</div>
        <div bind="courseJob" class="shape-job" data-testid="terrain-edit-meshes-job"></div>
        <div class="tedit-panel__hints">
            <div><b>Click</b> a bunker, pond, creek or path to pick its Blender recipe; <b>Cmd/Ctrl+click</b> more of the same kind to give them all one recipe.</div>
            <div><b>Click</b> open ground (or <b>Shift+click</b> anywhere) to outline an area (parking lot, road, house pad…).</div>
            <div><b>Click the first point</b> or press <b>Enter</b> to save the edit; <b>Esc</b> discards the outline.</div>
            <div><b>Backspace</b> or <b>⌘Z</b> removes the last point.</div>
            <div>Edits replay onto the DEM at build time — the raw lidar DEM stays pristine.</div>
        </div>
    </div>
`);

const rowTpl = template(`
    <div class="edit-item" bind="item">
        <div class="edit-row" bind="row" data-testid="terrain-edit-row">
            <span bind="glyph" class="edit-row__glyph"></span>
            <span bind="text" class="edit-row__text" title="Show on the map">
                <span bind="name" class="edit-row__name" data-testid="terrain-edit-name"></span>
                <span bind="params" class="edit-row__params"></span>
            </span>
            <button bind="editBtn" type="button" class="edit-row__btn" data-testid="terrain-edit-change" aria-label="Change edit">${icon('pencil', 16)}</button>
            <button bind="toggleBtn" type="button" class="edit-row__btn" data-testid="terrain-edit-toggle"></button>
            <button bind="deleteBtn" type="button" class="edit-row__btn" data-testid="terrain-edit-delete" aria-label="Delete edit">${icon('trash-2', 16)}</button>
        </div>
        <div bind="form" class="edit-form" data-testid="terrain-edit-form"></div>
    </div>
`);

const groupTpl = template(`
    <button bind="head" type="button" class="edit-group" data-testid="terrain-edit-group">
        <span bind="chevron" class="edit-group__chevron"></span>
        <span bind="label" class="edit-group__label"></span>
        <span bind="count" class="edit-group__count"></span>
    </button>
`);

/** Seconds as the shaping job view shows them: "0.4 s", "13 s", "1 min 35 s". */
function secs(seconds: number): string {
    if (seconds < 10) return `${Math.round(seconds * 10) / 10} s`;
    if (seconds < 60) return `${Math.round(seconds)} s`;
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** One entry of the edit list: a group's header, or one of its edits. */
type ListItem = { kind: 'group'; group: EditGroup } | { kind: 'edit'; edit: TerrainEdit; group: string };

/** The dig profiles a generated dig's form offers (bunkers have one fixed profile). */
function digPresetsOf(edit: TerrainEdit): { presets: Record<string, { label: string; depthM: number; bankSlopeDeg: number }>; fallback: string } | null {
    if (edit.origin === 'creek-digs') return { presets: CREEK_DIG_PRESETS, fallback: DEFAULT_CREEK_DIG_PRESET };
    if (edit.origin === 'water-digs') return { presets: WATER_DIG_PRESETS, fallback: DEFAULT_WATER_DIG_PRESET };
    return null;
}

const FEATURE_NOUNS: Record<string, string> = { 'creek-digs': 'creek', 'water-digs': 'pond', 'bunker-digs': 'bunker' };

/** The recipe choice (and saved-overrides key) while the selected features differ; never a library id. */
const MIXED = '*mixed*';

/**
 * Dock panel for the terrain-edit tool (hosted by the contextual right dock
 * via the EditorTool `panel` contract): op/params for the next drawn edit,
 * the site's edit list with enabled toggle + delete, and the "Apply to
 * terrain" button, which starts the fast re-terrain job (T56) and shows its
 * step progress while polling. Shares the TerrainEditToolService DI
 * singleton with the tool descriptor.
 */
export class TerrainEditPanelComponent extends Component {
    static styles = `
        .tedit-panel {
            /* Flat dock body (feature-dock.component.ts hosting contract). */
            ${dockBody()}

            & .section { display: flex; flex-direction: column; gap: ${s('xs')}; }
            ${sectionTitle()}

            & .input { ${panelInput()} }

            & .field {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: ${s('sm')};
                & span { color: ${t('color-text-secondary')}; }
                & .input--num { width: 76px; text-align: right; }
                &.hidden { display: none; }
            }
            & .field--check {
                justify-content: flex-start;
                cursor: pointer;
                & input { margin: 0; }
            }

            ${busyAndNotice()}

            & .edit-list { display: flex; flex-direction: column; gap: 2px; }
            & .empty {
                display: none;
                color: ${t('color-text-tertiary')};
                &.show { display: block; }
            }

            /* Name and buttons on one line, the summary across the whole row under them. */
            & .edit-row {
                display: grid;
                grid-template-columns: auto minmax(0, 1fr) auto auto auto;
                align-items: center;
                column-gap: ${s('sm')};
                padding: ${s('xs')} ${s('sm')};
                border-radius: ${t('radius-sm')};
                line-height: 1.3;
                &:hover { background: color-mix(in srgb, ${t('color-text-primary')} 5%, transparent); }
                &.disabled .edit-row__name, &.disabled .edit-row__params { opacity: 0.45; }
            }
            & .edit-row__glyph { color: #b653e6; font-weight: 700; grid-row: 1; }
            & .edit-row__text { display: contents; cursor: pointer; }
            & .edit-item.hidden { display: none; }
            & .edit-row__name { font-weight: 600; grid-column: 2; grid-row: 1; cursor: pointer; }
            & .edit-row__params { grid-column: 2 / -1; grid-row: 2; cursor: pointer; }
            & .edit-row__btn { grid-row: 1; }
            & .edit-row.highlight { background: color-mix(in srgb, #b653e6 12%, transparent); }
            & .edit-group {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                margin-top: ${s('xs')};
                padding: ${s('xs')} ${s('sm')};
                font: inherit;
                font-weight: 600;
                text-align: left;
                border: none;
                border-radius: ${t('radius-sm')};
                background: color-mix(in srgb, ${t('color-text-primary')} 6%, transparent);
                color: ${t('color-text-primary')};
                cursor: pointer;
            }
            & .edit-group__chevron { display: inline-flex; color: ${t('color-text-secondary')}; }
            & .edit-group__label { flex: 1; }
            & .edit-group__count { color: ${t('color-text-secondary')}; font-weight: 400; }
            & .edit-row__params { font-size: 0.72rem; color: ${t('color-text-secondary')}; }
            & .edit-row__btn { ${iconBtn()} flex: none; &.hidden { display: none; } }

            & .edit-form {
                display: none;
                flex-direction: column;
                gap: ${s('xs')};
                margin: 2px 0 ${s('sm')} 22px;
                padding: ${s('sm')};
                border-left: 2px solid #b653e6;
                background: color-mix(in srgb, ${t('color-text-primary')} 4%, transparent);
                border-radius: ${t('radius-sm')};
                &.show { display: flex; }
            }
            & .edit-form__actions { display: flex; gap: ${s('sm')}; justify-content: flex-end; }
            & .edit-form__actions button {
                font: inherit;
                padding: ${s('xs')} ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-raised')};
                color: ${t('color-text-primary')};
                cursor: pointer;
                &:disabled { opacity: 0.45; cursor: not-allowed; }
            }

            & .hint {
                color: ${t('color-text-tertiary')};
                line-height: 1.4;
            }
            & .gen-btn, & .apply-btn {
                font: inherit;
                font-weight: 600;
                padding: ${s('sm')};
                border: 1px solid ${t('color-border-default')};
                border-radius: ${t('radius-sm')};
                background: ${t('color-surface-raised')};
                color: ${t('color-text-primary')};
                cursor: pointer;
                &:disabled { opacity: 0.45; cursor: not-allowed; }
            }

            & .shape {
                padding: ${s('sm')};
                border-left: 2px solid ${SELECTION_COLOR};
                background: color-mix(in srgb, ${t('color-text-primary')} 4%, transparent);
                border-radius: ${t('radius-sm')};
                &.hidden { display: none; }
            }
            & .shape__head { display: flex; align-items: center; justify-content: space-between; }
            & .shape__head .section-title { margin: 0; }
            & .shape__feature { font-weight: 600; }
            & .field--stack { flex-direction: column; align-items: stretch; gap: 2px; }
            & .shape-params {
                display: flex;
                flex-direction: column;
                gap: 2px;
                &.hidden { display: none; }
            }
            /* One param per row: name + range, slider, number, reset. */
            & .param-row {
                display: grid;
                grid-template-columns: minmax(0, 6.5em) minmax(0, 1fr) 56px 22px;
                align-items: center;
                column-gap: ${s('xs')};
            }
            & .param-row__label { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
            & .param-row__name { color: ${t('color-text-secondary')}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            & .param-row.changed .param-row__name { color: ${t('color-text-primary')}; font-weight: 600; }
            & .param-row__range { font-size: 0.68rem; color: ${t('color-text-tertiary')}; white-space: nowrap; }
            & .param-row input[type='range'] { width: 100%; min-width: 0; margin: 0; accent-color: ${SELECTION_COLOR}; }
            & .param-row .input--num { width: 56px; padding: 2px ${s('xs')}; text-align: right; }
            & .param-reset {
                width: 22px;
                height: 22px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                border: none;
                border-radius: ${t('radius-sm')};
                background: transparent;
                color: ${t('color-text-secondary')};
                cursor: pointer;
                &:hover:not(:disabled) { background: color-mix(in srgb, ${t('color-text-primary')} 8%, transparent); }
                &:disabled { opacity: 0.3; cursor: default; }
            }
            & .shape-params__seed {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                margin-top: 2px;
                & .shape-params__seed-text { flex: 1; min-width: 0; color: ${t('color-text-secondary')}; }
                & button:not(.param-reset) {
                    font: inherit;
                    padding: 2px ${s('sm')};
                    border: 1px solid ${t('color-border-default')};
                    border-radius: ${t('radius-sm')};
                    background: ${t('color-surface-raised')};
                    color: ${t('color-text-primary')};
                    cursor: pointer;
                    white-space: nowrap;
                    &:disabled { opacity: 0.45; cursor: not-allowed; }
                }
            }
            & .shape-job {
                display: none;
                flex-direction: column;
                gap: 2px;
                line-height: 1.4;
                color: ${t('color-text-secondary')};
                &.show { display: flex; }
                & .shape-job__error, & .shape-job__warning { color: var(--data-bad); }
                & ul { margin: 0; padding-left: ${s('md')}; }
                & .shape-job__phases {
                    margin: 0;
                    padding: 0;
                    list-style: none;
                    & li[data-status="running"] { color: ${t('color-text-primary')}; }
                    & li[data-status="failed"] { color: var(--data-bad); }
                    & li[data-status="pending"] { opacity: 0.6; }
                }
            }

            ${hintsFooter('tedit-panel__hints')}
        }
    `;

    private tool = this.inject(TerrainEditToolService);
    /** The groups shown open; your own edits and recipes start open, the generated ones folded. */
    private expanded = new Signal<ReadonlySet<string>>(new Set(['hand', 'recipes']));
    /** Several features selected: Save gives them all one recipe and the same settings (each keeps its seed). */
    private multi = new Computed(() => this.tool.selectedFeatures.get().length > 1);
    /** The selected features' saved recipe ('' = the course default), MIXED when they differ. */
    private savedRecipe = new Computed(() => {
        const recipes = new Set(this.tool.selectedFeatures.get().map(feature => {
            const edit = this.tool.recipeEditOf(feature.id);
            return edit ? recipeParams(edit).recipe : '';
        }));
        return recipes.size > 1 ? MIXED : [...recipes][0] ?? '';
    });
    /** The recipe picked in the select (Save writes it). */
    private recipeChoice = new Signal('');
    /**
     * The selected features' saved overrides (numbers only; not the seed when
     * several), as a key the working values restart from; MIXED when they differ.
     */
    private savedOverrides = new Computed(() => {
        const multi = this.multi.get();
        const keys = new Set(this.tool.selectedFeatures.get().map(feature => {
            const edit = this.tool.recipeEditOf(feature.id);
            const values = edit ? numericOverrides(recipeParams(edit).overrides) : {};
            if (multi) delete values[SEED];
            return overridesKey(values);
        }));
        return keys.size > 1 ? MIXED : [...keys][0] ?? overridesKey({});
    });
    /** The working overrides: params set in the form and the seed (Save writes the non-default ones). */
    private overrides = new Signal<Readonly<Record<string, number>>>({});
    /** The recipe the choice runs (the course default for ''), null for none or one not in the library. */
    private chosenRecipe = new Computed<ShapingRecipe | null>(() => {
        const feature = this.tool.selectedFeature.get();
        const surface = feature ? surfaceOf(feature.type) : null;
        return surface ? this.tool.shaping.resolve(this.recipeChoice.get(), surface) : null;
    });
    private confirmDialog = this.inject(ConfirmService);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            radiusField: { className: () => this.tool.op.get() === 'smooth' ? 'field' : 'field hidden' },
            flatField: { className: () => this.tool.op.get() === 'plane' ? 'field field--check' : 'field field--check hidden' },
            savingLine: { className: () => this.tool.saving.get() ? 'busy-line show' : 'busy-line' },
            notice: {
                textContent: () => this.tool.notice.get() ?? '',
                className: () => this.tool.notice.get() ? 'notice show' : 'notice',
            },
            empty: {
                className: () => !this.tool.loading.get() && this.tool.edits.get().length === 0 ? 'empty show' : 'empty',
            },
            genPadsBtn: {
                disabled: () => this.tool.generating.get() !== null || this.tool.applying.get(),
                textContent: () => this.tool.generating.get() === 'building-pads' ? 'Surveying buildings…' : 'Generate building pads',
                title: 'OSM building footprints + lidar roof heights → one flat pad per building on the inner terrain (the outer is scenery; its buildings are surveyed but not padded). Replaces the previous pads',
                onclick: () => void this.tool.generate('building-pads'),
            },
            genRoadsBtn: {
                disabled: () => this.tool.generating.get() !== null || this.tool.applying.get(),
                textContent: () => this.tool.generating.get() === 'road-grades' ? 'Grading roads…' : 'Grade roads',
                title: 'OSM road centerlines → one corridor edit per road, smooth along, level across (replaces the previous grades)',
                onclick: () => void this.tool.generate('road-grades'),
            },
            genPondsBtn: {
                disabled: () => this.tool.generating.get() !== null || this.tool.applying.get(),
                textContent: () => this.tool.generating.get() === 'water-digs' ? 'Digging ponds…' : 'Dig ponds (DEM)',
                title: 'DEM digs: each water feature dug below its water level (its dig preset, default Natural Pond); the shoreline stays at the level. Creeks are left alone. Replaces the previous pond digs. Under the course meshes the pond is shaped in Blender by its recipe instead (the course default lake recipe unless you pick one), so this matters outside the meshes',
                onclick: () => void this.tool.generate('water-digs'),
            },
            fitEdgesBtn: {
                disabled: () => this.tool.proposingEdge.get() || this.tool.generating.get() !== null || this.tool.applying.get(),
                textContent: () => this.tool.proposingEdge.get() ? 'Reading the photos…' : 'Fit pond edges (lidar + photo)',
                title: "Each pond's edge found on the orthophoto between the lidar's open water and the drawn line (the lidar smears a steep bank over the water; a drawn or Hydrografi line follows the shore or reed line). Shown one pond at a time on the map, biggest change first: Accept stores it, Discard skips it. Where the photo shows no clear edge (reeds, shade) the drawn line stays. Same as `bun run water:edge`",
                onclick: () => void this.tool.proposeAllEdges(),
            },
            pondEdgeSection: {
                className: () => this.tool.pondEdge.get() ? 'section pond-edge' : 'section pond-edge hidden',
            },
            pondEdgeTitle: {
                textContent: () => {
                    const r = this.tool.pondEdge.get();
                    return r ? `Water edge — ${r.proposal.shape}` : '';
                },
            },
            pondEdgeSummary: {
                textContent: () => {
                    const r = this.tool.pondEdge.get();
                    return r ? pondEdgeSummary(r) : '';
                },
            },
            pondEdgeAcceptBtn: {
                disabled: () => this.tool.saving.get(),
                onclick: () => void this.tool.acceptEdge(),
            },
            pondEdgeDiscardBtn: {
                textContent: () => (this.tool.pondEdge.get()?.queue.length ?? 0) > 0 ? 'Skip' : 'Discard',
                onclick: () => this.tool.discardEdge(),
            },
            pondEdgeUndoBtn: {
                className: () => this.tool.edgeUndo.get() ? 'gen-btn' : 'gen-btn hidden',
                textContent: () => {
                    const u = this.tool.edgeUndo.get();
                    return u ? `Undo the edge fit (${u.shape})` : '';
                },
                onclick: () => void this.tool.undoEdge(),
            },
            genBunkersBtn: {
                disabled: () => this.tool.generating.get() !== null || this.tool.applying.get(),
                textContent: () => this.tool.generating.get() === 'bunker-digs' ? 'Digging bunkers…' : 'Dig bunkers (DEM)',
                title: 'DEM digs: each bunker dug below the ground around it, steep face towards its green, gentle entry opposite. Replaces the previous bunker digs. Under the course meshes the bunker is shaped in Blender by its recipe instead (the course default bunker recipe unless you pick one), so this matters outside the meshes',
                onclick: () => void this.tool.generate('bunker-digs'),
            },
            genCreeksBtn: {
                disabled: () => this.tool.generating.get() !== null || this.tool.applying.get(),
                textContent: () => this.tool.generating.get() === 'creek-digs' ? 'Digging creeks…' : 'Dig creeks (DEM)',
                title: 'DEM digs: each creek\'s bed dug below its water surface, which only falls downstream — the level the R.A.M. creeks export puts the water at. Along its centerline, or the line found down its polygon. Replaces the previous creek digs. Under the course meshes the creek is shaped in Blender by its recipe instead (the course default creek recipe unless you pick one), so this matters outside the meshes',
                onclick: () => void this.tool.generate('creek-digs'),
            },
            applyBtn: {
                disabled: () => !this.tool.canApply.get(),
                textContent: () => this.tool.applying.get() ? 'Applying…' : 'Apply to terrain',
                title: 'Re-tile terrain + hillshade with the enabled edits (fast — no lidar/ortho refetch)',
                onclick: () => void this.tool.applyToTerrain(),
            },
            applyLine: {
                textContent: () => {
                    const step = this.tool.applyStep.get();
                    return step ? `${step}…` : '';
                },
                className: () => this.tool.applying.get() ? 'busy-line show' : 'busy-line',
            },
            shapeSection: {
                className: () => this.tool.selectedFeature.get() ? 'section shape' : 'section shape hidden',
            },
            shapeCloseBtn: { onclick: () => this.tool.selectFeature(null) },
            recipeHint: {
                textContent: () => {
                    const feature = this.tool.selectedFeature.get();
                    const surface = feature ? surfaceOf(feature.type) : null;
                    if (!surface) return '';
                    const error = this.tool.shaping.recipesError.get();
                    if (error) return error;
                    const choice = this.recipeChoice.get();
                    const n = this.tool.selectedFeatures.get().length;
                    if (choice === MIXED) return `These ${n} have different recipes. Pick one to give it to all of them.`;
                    if (choice === NO_RECIPE) {
                        return n > 1 ? `No recipe runs on these ${n}, not even the course default.` : 'No recipe runs on this feature, not even the course default.';
                    }
                    const recipe = choice ? this.tool.shaping.recipe(choice) : this.tool.shaping.defaultFor(surface);
                    if (!recipe) return choice ? 'Not in the recipe library.' : 'No course default for this surface in the recipe library.';
                    const about = [`By ${recipe.author}`, recipe.notes].filter(Boolean).join(' — ');
                    if (n > 1) return `${about.replace(/\.$/, '')}. Save gives ${n === 2 ? 'both' : `all ${n}`} this recipe and these settings; each keeps its own seed.`;
                    // Settings live on a recipe edit, which names its recipe: saving them pins the default.
                    return !choice && Object.keys(this.toSave()).length > 0
                        ? `${about}. Saving these settings pins this recipe to the feature.` : about;
                },
            },
            shapeFeature: {
                textContent: () => this.tool.describeSelection(this.tool.selectedFeatures.get()),
            },
            recipeSaveBtn: {
                disabled: () => this.tool.saving.get() || this.recipeChoice.get() === MIXED
                    || (this.recipeChoice.get() === this.savedRecipe.get() && overridesKey(this.toSave()) === this.savedOverrides.get()),
                onclick: () => {
                    const features = this.tool.selectedFeatures.peek();
                    if (features.length === 0) return;
                    const overrides = untrack(() => this.toSave());
                    const choice = this.recipeChoice.peek();
                    // Overrides need a recipe edit, and an edit names its recipe: the course default gets pinned.
                    const recipeId = choice || (Object.keys(overrides).length > 0 ? this.chosenRecipe.peek()?.id ?? null : null);
                    if (features.length === 1) void this.tool.saveRecipe(features[0].id, recipeId, overrides);
                    else void this.tool.saveRecipes(features.map(f => f.id), recipeId, overrides, { keepSeeds: true });
                },
            },
        });

        // Shape in Blender: the recipe choice follows the selected feature's saved recipe.
        const recipeSelect = this.ref(frag, 'recipeSelect') as HTMLSelectElement;
        recipeSelect.addEventListener('change', () => void this.chooseRecipe(recipeSelect));
        this.track(effect(() => {
            const feature = this.tool.selectedFeature.get();
            const surface = feature ? surfaceOf(feature.type) : null;
            const recipes = surface ? this.tool.shaping.recipesFor(surface) : [];
            const def = surface ? this.tool.shaping.defaultFor(surface) : null;
            const saved = this.savedRecipe.get();
            untrack(() => {
                recipeSelect.replaceChildren(
                    ...(saved === MIXED ? [option('Different recipes — pick one for all', MIXED)] : []),
                    option(def ? `Course default (${def.name})` : 'Course default', ''),
                    ...recipes.map(r => option(r.name, r.id)),
                    option('No recipe (leave the meshes as built)', NO_RECIPE),
                );
                // A saved recipe missing from the library still shows, by its id.
                if (saved && saved !== NO_RECIPE && saved !== MIXED && !recipes.some(r => r.id === saved)) recipeSelect.add(option(`${saved} (not in the library)`, saved));
                recipeSelect.value = saved;
                this.recipeChoice.set(saved);
            });
        }));
        // The working overrides restart from the saved ones for each selection (and after each save).
        this.track(effect(() => {
            this.tool.selectedFeatureIds.get();
            const key = this.savedOverrides.get();
            const saved = key === MIXED ? {} : JSON.parse(key) as Record<string, number>;
            untrack(() => this.overrides.set(saved));
        }));
        this.recipeParamsForm(this.ref(frag, 'paramsHost') as HTMLElement);
        this.shapeJob(this.ref(frag, 'shapeJob') as HTMLElement, () => {
            const scope = this.tool.shaping.jobScope.get();
            return scope !== null && scope === this.tool.selectionScope.get();
        });
        this.shapeJob(this.ref(frag, 'courseJob') as HTMLElement, () => this.tool.shaping.jobScope.get() === null);

        // Op / params controls — imperative two-way wiring (range/number
        // inputs need input events; sam-panel select pattern).
        const opSelect = this.ref(frag, 'opSelect') as HTMLSelectElement;
        opSelect.addEventListener('change', () => this.tool.op.set(opSelect.value as TerrainEditOp));
        this.track(effect(() => { opSelect.value = this.tool.op.get(); }));

        const featherInput = this.ref(frag, 'featherInput') as HTMLInputElement;
        featherInput.addEventListener('input', () => {
            const v = Number(featherInput.value);
            if (Number.isFinite(v) && v >= 0) this.tool.featherM.set(v);
        });
        this.track(effect(() => { featherInput.value = String(this.tool.featherM.get()); }));

        const radiusInput = this.ref(frag, 'radiusInput') as HTMLInputElement;
        radiusInput.addEventListener('input', () => {
            const v = Number(radiusInput.value);
            if (Number.isFinite(v) && v > 0) this.tool.radiusM.set(v);
        });
        this.track(effect(() => { radiusInput.value = String(this.tool.radiusM.get()); }));

        const flatInput = this.ref(frag, 'flatInput') as HTMLInputElement;
        flatInput.addEventListener('change', () => this.tool.flat.set(flatInput.checked));
        this.track(effect(() => { flatInput.checked = this.tool.flat.get(); }));

        // Edit list — a header per group, then its edits (hidden while folded).
        const items = new Computed<ListItem[]>(() => this.tool.groups.get().flatMap(group => [
            { kind: 'group' as const, group },
            ...group.edits.map(edit => ({ kind: 'edit' as const, edit, group: group.key })),
        ]));
        this.$each(this.ref(frag, 'list'), items, (item, _i, track) =>
            item.kind === 'group' ? this.groupHeader(item.group, track) : this.editRow(item.edit, item.group, track),
        item => (item.kind === 'group' ? `group:${item.group.key}` : `${item.group}:${item.edit.id}`));

        // The open row's form, built fresh each time it opens.
        const list = this.ref(frag, 'list') as HTMLElement;
        this.track(effect(() => {
            const id = this.tool.editingId.get();
            untrack(() => {
                for (const host of list.querySelectorAll<HTMLElement>('.edit-form')) host.replaceChildren();
                const edit = this.tool.edits.peek().find(e => e.id === id);
                const host = edit ? list.querySelector<HTMLElement>(`[data-edit-id="${CSS.escape(edit.id)}"] .edit-form`) : null;
                if (!edit || !host) return;
                host.append(...(this.tool.formKind(edit) === 'dig' ? this.digForm(edit) : this.paramsForm(edit)));
            });
        }));

        return frag;
    }

    /** The overrides Save writes for the current choice and working values (never the seed for several features). */
    private toSave(): Record<string, number> {
        const choice = this.recipeChoice.get();
        if (choice === NO_RECIPE || choice === MIXED) return {};
        const recipe = this.chosenRecipe.get();
        const out = overridesToSave(recipe ? recipe.params : null, this.overrides.get());
        if (this.multi.get()) delete out[SEED];
        return out;
    }

    /**
     * The select picked another recipe: working values it cannot take (params
     * it lacks, values outside its ranges; the seed for "no recipe") are
     * dropped, after a confirm; cancelling keeps the previous recipe.
     */
    private async chooseRecipe(select: HTMLSelectElement): Promise<void> {
        const next = select.value;
        const prev = this.recipeChoice.peek();
        const feature = this.tool.selectedFeature.peek();
        const surface = feature ? surfaceOf(feature.type) : null;
        const recipe = surface ? this.tool.shaping.resolve(next, surface) : null;
        const values = this.overrides.peek();
        const dropped = next === NO_RECIPE ? Object.keys(values)
            : recipe ? inapplicable(recipe.params, values) : [];
        if (dropped.length > 0) {
            const before = surface ? this.tool.shaping.resolve(prev, surface)?.params ?? [] : [];
            const names = dropped.map(key => (key === SEED ? 'the seed' : before.find(p => p.id === key)?.label ?? key));
            const target = next === NO_RECIPE ? 'No recipe' : recipe?.name ?? next;
            const ok = await this.confirmDialog.confirm({
                title: 'Drop overrides?',
                body: `${target} does not take ${listOf(names)}: switching drops ${dropped.length === 1 ? 'it' : 'them'}.`,
                confirmLabel: 'Switch recipe',
                cancelLabel: 'Keep the recipe',
                tone: 'primary',
            });
            if (!ok) {
                select.value = prev;
                return;
            }
            const kept = { ...values };
            for (const key of dropped) delete kept[key];
            this.overrides.set(kept);
        }
        this.recipeChoice.set(next);
    }

    /**
     * The chosen recipe's params (SHAPING-PLAN.md, "Composite and
     * parameterised recipes"): a slider + number per param with its unit and
     * range and a reset, then the seed (default the feature number; every
     * recipe takes it, params or not) with Variation, and Reset all. Rows are built when the recipe changes and
     * kept in step with the working values.
     */
    private recipeParamsForm(host: HTMLElement): void {
        let sync: Array<(values: Readonly<Record<string, number>>) => void> = [];
        this.track(effect(() => {
            const recipe = this.recipeChoice.get() === NO_RECIPE ? null : this.chosenRecipe.get();
            const feature = this.tool.selectedFeature.get();
            const multi = this.multi.get();
            untrack(() => {
                sync = [];
                host.replaceChildren();
                // Every recipe takes the seed; "no recipe" and one not in the library show nothing.
                host.className = recipe && feature ? 'shape-params' : 'shape-params hidden';
                if (!recipe || !feature) return;
                const params = recipe.params;
                const onSync = (fn: (values: Readonly<Record<string, number>>) => void) => sync.push(fn);
                for (const param of params) host.append(this.paramRow(param, onSync));
                host.append(multi ? hint('Each keeps its own seed (its feature number unless set), so they stay different shapes.') : this.seedRow(feature.no ?? null, onSync));
                const values = this.overrides.peek();
                for (const fn of sync) fn(values);
            });
        }));
        this.track(effect(() => {
            const values = this.overrides.get();
            untrack(() => { for (const fn of sync) fn(values); });
        }));
    }

    /** Sets one working value; undefined clears it (the param's default, the default seed). */
    private setValue(key: string, value: number | undefined): void {
        this.overrides.update(current => {
            const next = { ...current };
            if (value === undefined) delete next[key];
            else next[key] = value;
            return next;
        });
    }

    /** One param: name and range, slider, number, reset to its default. */
    private paramRow(param: RecipeParam, onSync: (fn: (values: Readonly<Record<string, number>>) => void) => void): HTMLElement {
        const row = document.createElement('div');
        row.className = 'param-row';
        row.setAttribute('data-testid', 'terrain-shape-param');
        row.setAttribute('data-param', param.id);
        const unit = param.unit ? ` ${param.unit}` : '';
        const label = document.createElement('div');
        label.className = 'param-row__label';
        const name = document.createElement('span');
        name.className = 'param-row__name';
        name.textContent = param.label;
        name.title = param.label;
        const range = document.createElement('span');
        range.className = 'param-row__range';
        range.textContent = `${param.min}–${param.max}${unit}`;
        label.append(name, range);

        const step = param.step !== undefined ? String(param.step) : 'any';
        const title = `${param.label}: ${param.min}–${param.max}${unit} (default ${param.default}${unit})`;
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(param.min);
        slider.max = String(param.max);
        slider.step = step;
        slider.title = title;
        slider.setAttribute('aria-label', param.label);
        const num = numberInput(param.default, param.min, 1);
        num.step = step;
        num.max = String(param.max);
        num.title = title;
        num.setAttribute('aria-label', param.unit ? `${param.label} (${param.unit})` : param.label);
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'param-reset';
        reset.innerHTML = icon('undo', 16);
        reset.title = `Back to the default (${param.default}${unit})`;
        reset.setAttribute('aria-label', `Reset ${param.label}`);
        reset.setAttribute('data-testid', 'terrain-shape-param-reset');

        /** Takes a typed or slid value, clamped to the range; false when it is not a number. */
        const set = (raw: string): boolean => {
            const v = Number(raw);
            if (raw.trim() === '' || !Number.isFinite(v)) return false;
            const clamped = Math.min(Math.max(v, param.min), param.max);
            this.setValue(param.id, clamped === param.default ? undefined : clamped);
            return true;
        };
        slider.addEventListener('input', () => set(slider.value));
        num.addEventListener('change', () => {
            const before = this.overrides.peek()[param.id] ?? param.default;
            if (!set(num.value)) num.value = String(before);
            // A value clamped back to the one already there changes no signal: show it anyway.
            num.value = String(this.overrides.peek()[param.id] ?? param.default);
        });
        reset.addEventListener('click', () => this.setValue(param.id, undefined));
        onSync(values => {
            const value = values[param.id] ?? param.default;
            const changed = value !== param.default;
            row.className = changed ? 'param-row changed' : 'param-row';
            slider.value = String(value);
            num.value = String(value);
            reset.disabled = !changed;
        });
        row.append(label, slider, num, reset);
        return row;
    }

    /** The seed (the feature number unless set; Variation picks a new one, reset goes back), then Reset all. */
    private seedRow(featureNo: number | null, onSync: (fn: (values: Readonly<Record<string, number>>) => void) => void): HTMLElement {
        const row = document.createElement('div');
        row.className = 'shape-params__seed';
        const text = document.createElement('span');
        text.className = 'shape-params__seed-text';
        text.setAttribute('data-testid', 'terrain-shape-seed');
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'param-reset';
        clear.innerHTML = icon('undo', 16);
        clear.title = 'Back to the default seed (the feature number)';
        clear.setAttribute('aria-label', 'Default seed');
        clear.setAttribute('data-testid', 'terrain-shape-seed-reset');
        clear.addEventListener('click', () => this.setValue(SEED, undefined));
        const variation = button('🎲 Variation', () => {
            const current = this.overrides.peek()[SEED] ?? featureNo;
            let seed: number;
            do seed = 1 + Math.floor(Math.random() * 999_999); while (seed === current);
            this.setValue(SEED, seed);
        });
        variation.title = 'A new random seed: the same settings, another take on the shape';
        variation.setAttribute('data-testid', 'terrain-shape-variation');
        const resetAll = button('Reset all', () => this.overrides.set({}));
        resetAll.title = 'Every param back to its default, and the default seed';
        resetAll.setAttribute('data-testid', 'terrain-shape-reset-all');
        onSync(values => {
            const seed = values[SEED];
            text.textContent = seed !== undefined ? `Seed ${seed}` : `Seed ${featureNo ?? '—'} (feature number)`;
            clear.disabled = seed === undefined;
            resetAll.disabled = Object.keys(values).length === 0;
        });
        row.append(text, clear, variation, resetAll);
        return row;
    }

    /**
     * The shaping job's progress and outcome, shown in `host` while `inScope`
     * (the feature section for a feature's job, under the course button for
     * the whole course's): each phase live (generating layers → starting the
     * worker, with the cold start's seconds → Blender sync → Unity refresh),
     * then the outcome with the changed objects, the phase and Unity step
     * timings and the warnings, or the failure.
     */
    private shapeJob(host: HTMLElement, inScope: () => boolean): void {
        this.track(effect(() => {
            const shaping = this.tool.shaping;
            const job = shaping.job.get();
            const error = shaping.jobError.get();
            const connection = shaping.connection.get();
            const show = inScope() && (job !== null || error !== null);
            untrack(() => {
                host.className = show ? 'shape-job show' : 'shape-job';
                host.replaceChildren();
                if (!show) return;
                const line = (text: string, cls = '') => {
                    const el = document.createElement('div');
                    if (cls) el.className = cls;
                    el.textContent = text;
                    host.append(el);
                    return el;
                };
                if (error) {
                    line(error, 'shape-job__error');
                    return;
                }
                if (!job) return;
                const phases = job.phases ?? [];
                const unity = phases.find(p => p.id === 'unity');
                if (job.status === 'running') {
                    line('Shaping in Blender…').setAttribute('data-testid', 'terrain-shape-status');
                } else if (job.status === 'failed') {
                    const at = phases.find(p => p.id === job.phase);
                    line(`Applying to the meshes failed${at ? ` (${at.label.toLowerCase()})` : ''}: ${job.error ?? 'unknown error'}`, 'shape-job__error')
                        .setAttribute('data-testid', 'terrain-shape-status');
                } else {
                    const changed = job.result?.changedObjects ?? [];
                    const refreshed = unity?.status === 'done' ? ' and refreshed in Unity' : '';
                    line(changed.length === 0
                        ? `Done in ${secs(job.seconds)} — no mesh changed.`
                        : `Done in ${secs(job.seconds)} — ${changed.length} object${changed.length === 1 ? '' : 's'} re-shaped${refreshed}:`)
                        .setAttribute('data-testid', 'terrain-shape-status');
                    if (changed.length > 0) {
                        const list = document.createElement('ul');
                        list.setAttribute('data-testid', 'terrain-shape-changed');
                        for (const name of changed) {
                            const li = document.createElement('li');
                            li.textContent = name;
                            list.append(li);
                        }
                        host.append(list);
                    }
                }
                // Every phase: done ✓ / running … / failed ✗ / skipped – / pending ·, with what it did and its seconds.
                const list = document.createElement('ol');
                list.className = 'shape-job__phases';
                list.setAttribute('data-testid', 'terrain-shape-phases');
                for (const p of phases) {
                    const li = document.createElement('li');
                    li.dataset.phase = p.id;
                    li.dataset.status = p.status;
                    const mark = { done: '✓', running: '…', failed: '✗', skipped: '–', pending: '·' }[p.status] ?? '·';
                    const detail = p.detail && p.status !== 'pending' ? ` — ${p.detail}` : '';
                    li.textContent = `${mark} ${p.label}${detail}${p.seconds !== null ? ` (${secs(p.seconds)})` : ''}`;
                    list.append(li);
                }
                if (phases.length > 0) host.append(list);
                const steps = (job.result?.unitySteps ?? []).filter(st => st.seconds !== null && st.seconds >= 0.05);
                if (steps.length > 0) {
                    line(`Unity: ${steps.map(st => `${st.id} ${secs(st.seconds!)}`).join(' · ')}`)
                        .setAttribute('data-testid', 'terrain-shape-unity-steps');
                }
                if (connection && job.status === 'running') line(connection, 'shape-job__warning');
                for (const warning of job.result?.warnings ?? []) line(warning, 'shape-job__warning');
                if (job.result?.unityError && unity?.status !== 'failed') line(`Unity: ${job.result.unityError}`, 'shape-job__warning');
            });
        }));
    }

    /** A group's header: click to fold or unfold it. */
    private groupHeader(group: EditGroup, track: (d: () => void) => void): HTMLElement {
        const open = () => this.expanded.get().has(group.key);
        return this.wireEl(groupTpl, {
            head: {
                'aria-expanded': () => String(open()),
                onclick: () => this.expanded.update(set => {
                    const next = new Set(set);
                    if (!next.delete(group.key)) next.add(group.key);
                    return next;
                }),
            },
            chevron: { innerHTML: () => icon(open() ? 'chevron-down' : 'chevron-right', 16) },
            label: { textContent: group.label },
            count: { textContent: () => String(this.tool.groups.get().find(g => g.key === group.key)?.edits.length ?? 0) },
        }, track);
    }

    /** One edit: its name and summary (click to show it on the map), change / enable / delete. */
    private editRow(edit: TerrainEdit, group: string, track: (d: () => void) => void): HTMLElement {
        return this.wireEl(rowTpl, {
                row: {
                    className: () => {
                        const current = this.tool.edits.get().find(e => e.id === edit.id) ?? edit;
                        const highlight = this.tool.highlightId.get() === edit.id ? ' highlight' : '';
                        return (current.enabled ? 'edit-row' : 'edit-row disabled') + highlight;
                    },
                },
                glyph: { textContent: () => OP_GLYPHS[(this.tool.edits.get().find(e => e.id === edit.id) ?? edit).op] },
                text: {
                    title: isRecipeEdit(edit) ? 'Select its feature and show it on the map' : 'Show on the map',
                    onclick: () => this.tool.showEdit(edit.id),
                },
                name: { textContent: () => this.tool.editName(this.tool.edits.get().find(e => e.id === edit.id) ?? edit) },
                params: {
                    textContent: () => {
                        const current = this.tool.edits.get().find(e => e.id === edit.id) ?? edit;
                        return paramsSummary(current);
                    },
                },
                toggleBtn: {
                    innerHTML: () => {
                        const current = this.tool.edits.get().find(e => e.id === edit.id) ?? edit;
                        return icon(current.enabled ? 'eye' : 'eye-off', 16);
                    },
                    title: () => {
                        const current = this.tool.edits.get().find(e => e.id === edit.id) ?? edit;
                        return current.enabled ? 'Disable (skip at build time)' : 'Enable';
                    },
                    'aria-pressed': () => {
                        const current = this.tool.edits.get().find(e => e.id === edit.id) ?? edit;
                        return String(current.enabled);
                    },
                    onclick: () => {
                        const current = this.tool.edits.peek().find(e => e.id === edit.id) ?? edit;
                        void this.tool.setEnabled(edit.id, !current.enabled);
                    },
                },
                editBtn: {
                    className: () => this.tool.formKind(edit) ? 'edit-row__btn' : 'edit-row__btn hidden',
                    title: edit.origin
                        ? `Change this ${FEATURE_NOUNS[edit.origin] ?? ''} dig (saved on the feature, so re-running keeps it)`
                        : 'Change this edit',
                    'aria-expanded': () => String(this.tool.editingId.get() === edit.id),
                    onclick: () => this.tool.editingId.set(this.tool.editingId.peek() === edit.id ? null : edit.id),
                },
                deleteBtn: {
                    onclick: () => void this.tool.remove(edit.id),
                    title: isRecipeEdit(edit)
                        ? 'Back to the course default recipe'
                        : edit.origin && FEATURE_NOUNS[edit.origin]
                            ? `Don't dig this ${FEATURE_NOUNS[edit.origin]} (marks the feature dig: false, so re-running leaves it out)`
                            : 'Delete edit',
                },
                item: {
                    'data-edit-id': edit.id,
                    className: () => (this.expanded.get().has(group) ? 'edit-item' : 'edit-item hidden'),
                    onmouseenter: () => this.tool.hoveredId.set(edit.id),
                    onmouseleave: () => { if (this.tool.hoveredId.peek() === edit.id) this.tool.hoveredId.set(null); },
                },
                form: {
                    className: () => this.tool.editingId.get() === edit.id ? 'edit-form show' : 'edit-form',
                },
            }, track);
    }

    /** A hand-drawn edit's op and params. */
    private paramsForm(edit: TerrainEdit): HTMLElement[] {
        const op = select([['plane', 'Plane fit — even fall'], ['smooth', 'Smooth — kill spikes']], edit.op);
        const feather = numberInput(edit.params.featherM ?? 0, 0, 0.5);
        const radius = numberInput(edit.params.radiusM ?? DEFAULT_RADIUS_M, 0.5, 0.5);
        const flat = document.createElement('input');
        flat.type = 'checkbox';
        flat.checked = edit.params.flat === true;
        const radiusField = field('Radius (m)', radius);
        const flatField = checkField('Dead flat (level pad)', flat);
        const sync = () => {
            radiusField.classList.toggle('hidden', op.value !== 'smooth');
            flatField.classList.toggle('hidden', op.value !== 'plane');
        };
        op.addEventListener('change', sync);
        sync();
        const save = () => this.tool.saveParams(edit.id, {
            op: op.value as 'plane' | 'smooth',
            featherM: Math.max(Number(feather.value) || 0, 0),
            radiusM: Math.max(Number(radius.value) || DEFAULT_RADIUS_M, 0.5),
            flat: flat.checked,
        });
        return [op, field('Feather (m)', feather), radiusField, flatField, this.actions(save)];
    }

    /** A generated dig's settings, saved on its feature. */
    private digForm(edit: TerrainEdit): HTMLElement[] {
        const current = this.tool.digSettings(edit);
        const noun = FEATURE_NOUNS[edit.origin ?? ''] ?? 'feature';
        if (!current) return [hint(`The ${noun} this dig was made from is not on this course.`)];
        const table = digPresetsOf(edit);
        const out: HTMLElement[] = [];
        let preset: HTMLSelectElement | null = null;
        if (table) {
            const def = table.presets[table.fallback];
            preset = select([['', `Default — ${def.label}`], ...Object.entries(table.presets).map(([k, p]) => [k, p.label] as [string, string])],
                current.preset && current.preset in table.presets ? current.preset : '');
            preset.setAttribute('data-testid', 'terrain-edit-dig-preset');
            out.push(preset);
        }
        const depth = optionalNumber(current.depthM, 0.05, 0.05);
        const bank = optionalNumber(current.bankSlopeDeg, 1, 1);
        const face = optionalNumber(current.faceSlopeDeg, 1, 1);
        const placeholders = () => {
            const p = table ? table.presets[preset!.value || table.fallback] : BUNKER_DIG;
            depth.placeholder = String(p.depthM);
            bank.placeholder = String(p.bankSlopeDeg);
            face.placeholder = String(BUNKER_DIG.faceSlopeDeg);
        };
        preset?.addEventListener('change', placeholders);
        placeholders();
        out.push(field('Depth (m)', depth), field(edit.origin === 'bunker-digs' ? 'Entry slope (°)' : 'Bank slope (°)', bank));
        if (edit.origin === 'bunker-digs') out.push(field('Face slope (°)', face));
        const above = optionalNumber(current.bankAboveDeg, 1, 1);
        above.placeholder = 'off';
        above.setAttribute('data-testid', 'terrain-edit-dig-bank-above');
        if (edit.origin === 'water-digs') {
            out.push(field('Bank above water (°)', above),
                hint('Set: the outline is the water\'s edge — the bank outside comes down to the water there at this angle (45 is a steep pond bank), and the water plane stands at the dig\'s level. Empty: the bank tapers in under the water.'));
            const featureId = this.tool.pondOf(edit);
            if (featureId) {
                const fit = button('Fit edge to water (lidar + photo)', () => void this.tool.proposeEdge(featureId));
                fit.className = 'gen-btn';
                fit.setAttribute('data-testid', 'terrain-edit-fit-edge');
                fit.title = "This pond's edge found on the orthophoto between the lidar's open water and the drawn line; shown on the map to Accept or Discard";
                out.push(fit);
            }
        }
        out.push(hint(`Saved on this ${noun}; an empty box uses the preset. Re-digs every ${noun}.`));
        const read = (el: HTMLInputElement) => (el.value.trim() === '' || !Number.isFinite(Number(el.value)) ? undefined : Number(el.value));
        const save = () => {
            const settings: DigSettings = { preset: preset?.value || undefined, depthM: read(depth), bankSlopeDeg: read(bank) };
            if (edit.origin === 'bunker-digs') settings.faceSlopeDeg = read(face);
            if (edit.origin === 'water-digs') settings.bankAboveDeg = read(above);
            return this.tool.saveDigSettings(edit.id, settings);
        };
        out.push(this.actions(save));
        return out;
    }

    /** Save / Cancel; a successful save closes the form. */
    private actions(save: () => Promise<boolean>): HTMLElement {
        const row = document.createElement('div');
        row.className = 'edit-form__actions';
        const cancel = button('Cancel', () => this.tool.editingId.set(null));
        const ok = button('Save', async () => {
            ok.disabled = true;
            try {
                if (await save()) this.tool.editingId.set(null);
            } finally {
                ok.disabled = false;
            }
        });
        ok.setAttribute('data-testid', 'terrain-edit-save');
        row.append(cancel, ok);
        return row;
    }
}

/** What a pond edge proposal changes, in a line or two. */
function pondEdgeSummary(r: PondEdgeReview): string {
    const p = r.proposal;
    const kept = p.kept.reduce((sum, k) => sum + (k.toM - k.fromM), 0);
    const parts = [
        `Moves the line ${p.movedM.p50} m (median), up to ${p.movedM.max} m; area ${p.areaM2.drawn} → ${p.areaM2.new} m² (lidar's open water ${p.areaM2.lidar} m²).`,
        kept > 0 ? `Keeps the drawn line on ${Math.round(kept)} m where the photo shows no clear edge (reeds, shade).` : '',
        `${r.controls.length} control points.`,
        r.queue.length ? `${r.queue.length} more pond(s) after this one.` : '',
        r.failed.length ? `Not proposed: ${r.failed.map((f) => `${f.shape} (${f.error})`).join('; ')}.` : '',
    ];
    return parts.filter(Boolean).join(' ');
}

/** A saved `overrides` object's numeric entries (the only kind the form edits). */
function numericOverrides(overrides: Record<string, unknown> | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(overrides ?? {})) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    return out;
}

/** Overrides as a comparable key (sorted: the order they were saved in does not matter). */
function overridesKey(overrides: Record<string, number>): string {
    return JSON.stringify(Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** "a", "a and b", "a, b and c". */
function listOf(items: string[]): string {
    return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function select(options: Array<[string, string]>, value: string): HTMLSelectElement {
    const el = document.createElement('select');
    el.className = 'input';
    for (const [v, label] of options) el.add(new Option(label, v));
    el.value = value;
    return el;
}

function option(label: string, value: string): HTMLOptionElement {
    const el = document.createElement('option');
    el.value = value;
    el.textContent = label;
    return el;
}

function numberInput(value: number, min: number, step: number): HTMLInputElement {
    const el = document.createElement('input');
    el.type = 'number';
    el.className = 'input input--num';
    el.min = String(min);
    el.step = String(step);
    el.value = String(value);
    return el;
}

function optionalNumber(value: number | undefined, min: number, step: number): HTMLInputElement {
    const el = numberInput(0, min, step);
    el.value = value === undefined ? '' : String(value);
    return el;
}

function field(label: string, input: HTMLElement): HTMLElement {
    const el = document.createElement('label');
    el.className = 'field';
    const span = document.createElement('span');
    span.textContent = label;
    el.append(span, input);
    return el;
}

function checkField(label: string, input: HTMLInputElement): HTMLElement {
    const el = document.createElement('label');
    el.className = 'field field--check';
    const span = document.createElement('span');
    span.textContent = label;
    el.append(input, span);
    return el;
}

function hint(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'hint';
    el.textContent = text;
    return el;
}

function button(label: string, onclick: () => void): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.addEventListener('click', onclick);
    return el;
}
