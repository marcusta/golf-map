import { Component, Computed, Router, Signal, template, effect, untrack } from '@basics/core/client/core';
import { AuthService } from '@basics/core/client/auth';
// Only the literal `href` needs the deploy prefix — router.navigate() adds it.
import { BASE_PATH } from '@basics/core/client/base';
import { t } from '../theme';
import { s, statusTag, iconBtn, input, metric, panelTitle, selectedRow, keyHint, primaryBtn, ghostBtn } from '../css';
import { icon } from '../ui/icons';
import { PopoverComponent } from '../ui/popover.component';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { ConfirmService } from './confirm-dialog.component';
import { ToastComponent } from './toast.component';
import { FeaturesService } from '../draw/features.service';
import { HelpModalService } from '../editor/help-modal.component';
import { SUB_MODE_KEYS } from '../editor/editor-keys';
import { DrawToolService, DRAW_TOOL_ID } from '../draw/draw-tool.service';
import { drawTool } from '../draw/draw-tool';
import { FEATURE_TYPES, FEATURE_STYLES, digitForFeatureType, isRulesType, isVegetationType, type FeatureType } from '../draw/feature-palette';
import { EditorModeService } from '../editor/editor-mode.service';
import { ServerModeService, visibleEditorTools } from './server-mode.service';
import { SvgImportService, boundsFromGeoreference } from '../import/svg-import.service';
import { GeojsonImportService } from '../import/geojson-import.service';
import { GsproSyncService } from '../export/gspro-sync.service';
import { ZoneTypesService, zoneTypeKeyOf } from '../zones/zone-types.service';
import { VegetationRulesService } from '../zones/vegetation-rules.service';
import { PhotoStemsService } from '../zones/photo-stems.service';
import { SvgCheckService, isSvgCheckError } from '../draw/svg-check.service';
import { VEGETATION_TOOL_ID } from '../zones/vegetation-tool';
import { PlantVegetationService, arboristOutcome } from '../zones/plant-vegetation.service';
import { ShapingService, type ShapingJob } from '../terrain-edit/shaping.service';
import { TerrainEditToolService, TERRAIN_EDIT_TOOL_ID } from '../terrain-edit/terrain-edit-tool.service';
import { CleanToolService, CLEAN_TOOL_ID } from '../clean/clean-tool.service';
import { FURNITURE_TOOL_ID } from '../furniture/furniture.service';
import { MESH_FEATURE_TYPES, gsproTarget, type GsproTargetId } from '../../../shared/gspro-targets';
import { MapBuildClientService, formatBytes } from '../map-build/map-build.service';
import { TilesetService } from '../map/tileset.service';
import { MapService } from '../map/map.service';
import { PublishClientService, PUBLISH_STEP_LABELS, type PublishState } from './publish-client.service';
import { PATH_SURFACE_LABELS, PATH_SURFACES, type PathSurface } from '../../../shared/features/path-surface';
import { TREE_AREA_TYPE } from '../../../shared/features/tree-areas';

/** The zone-type trigger's value while a tree species area is picked (zone keys are [a-z0-9_], so it never clashes). */
const TREE_AREA_PICK = '~tree_area';

type CommandBarMode = 'create' | 'plan';

/** Autosave pill state (review item 26). */
export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/** How long the pill reads "Saved" before it drops back to idle. */
export const SAVED_MS = 1500;

/**
 * Sub-mode key hints, keyed by editor tool id (review items 21 and 29).
 * Display only; derived from the shortcut layer's table so the two cannot
 * drift.
 */
export const SUBMODE_KEY_HINTS: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(SUB_MODE_KEYS).map(([key, toolId]) => [toolId, key.toUpperCase()]),
);

const tpl = template(`
    <header class="cmdbar" bind="root">
        <span class="cmdbar__identity">
            <span class="cmdbar__glyph">${icon('flag', 16)}</span>
            <a bind="courses" class="cmdbar__courses" href="${BASE_PATH}/">&#8249; Courses</a>
            <span bind="name" class="cmdbar__name" data-testid="course-name"></span>
            <span bind="status" class="cmdbar__pill"></span>
            <span bind="odbl" class="cmdbar__pill odbl" data-testid="course-odbl-pill"></span>
            <span bind="infoHost" class="cmdbar__slot"></span>
        </span>
        <span class="cmdbar__divider"></span>
        <div bind="modesHost" class="cmdbar__modes"></div>
        <span bind="zone3Divider" class="cmdbar__divider"></span>
        <div bind="zone3Host" class="cmdbar__zone3"></div>
        <div class="cmdbar__right">
            <span bind="gsproHost" class="cmdbar__gspro"></span>
            <span bind="saveHost" class="cmdbar__save-slot"></span>
            <span bind="actionsHost" class="cmdbar__slot"></span>
            <span class="cmdbar__divider cmdbar__divider--sm"></span>
            <span bind="avatarHost" class="cmdbar__slot"></span>
        </div>
        <span bind="toastHost"></span>
    </header>
`);

type ModeMeta = {
    id: CommandBarMode | 'play' | 'review';
    label: string;
    dot: string;
    hint: string;
    enabled: boolean;
    nav?: '/course' | '/planner';
    testid?: string;
};

/** Zone-2 modes: Create/Plan navigate; Play/Review are mobile-app only. */
const MODES: ModeMeta[] = [
    { id: 'create', label: 'Create', dot: t('color-accent-primary'), hint: 'Draw & edit the course map', enabled: true, nav: '/course' },
    { id: 'plan', label: 'Plan', dot: t('color-status-info'), hint: 'Strategy, aim & gates', enabled: true, nav: '/planner', testid: 'course-plan-btn' },
    { id: 'play', label: 'Play', dot: t('color-status-positive'), hint: 'Mobile app', enabled: false },
    { id: 'review', label: 'Review', dot: t('color-accent-secondary'), hint: 'Mobile app', enabled: false },
];

const zone3Tpl = template(`
    <span bind="subHost" class="cmdbar__slot"></span>
    <span bind="featWrap" class="cmdbar__feat-wrap">
        <span bind="featHost" class="cmdbar__slot"></span>
        <span bind="zoneHost" class="cmdbar__slot"></span>
        <span bind="drawTarget" class="cmdbar__target" data-testid="draw-target">
            <span bind="targetHole" class="cmdbar__target-hole"></span>
            <span bind="targetChain" class="cmdbar__target-chain" data-testid="draw-target-chain"></span>
        </span>
        <button bind="newPoly" type="button" class="cmdbar__new"></button>
        <button bind="newPath" type="button" class="cmdbar__path"></button>
        <input bind="pathWidth" type="number" class="cmdbar__path-width" min="0.5" step="0.5" aria-label="Path width (m)" data-testid="path-width-input">
        <select bind="pathSurface" class="cmdbar__path-width cmdbar__path-surface" aria-label="Path surface" data-testid="path-surface-default"></select>
        <button bind="boxSelect" type="button" class="cmdbar__box"></button>
        <button bind="generatedBtn" type="button" class="cmdbar__plant" data-testid="generated-vegetation-btn"></button>
        <span class="cmdbar__divider cmdbar__divider--sm"></span>
        <button bind="undoBtn" type="button" class="cmdbar__hist" aria-label="Undo">${icon('undo', 16)}</button>
        <button bind="redoBtn" type="button" class="cmdbar__hist" aria-label="Redo">${icon('redo', 16)}</button>
    </span>
    <button bind="helpBtn" type="button" class="cmdbar__help" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">${icon('circle-help', 16)}</button>
`);

/**
 * The GSPro group at the right end of the bar (Create, builder only): the
 * contextual **Update** buttons of the active sub-mode — the same words as the
 * status board's rows — and then the permanent board button with the stale
 * count. These are the only places a push into GSPro/Unity starts from; the
 * right-hand panels keep the editing controls only (docs/web-features.md,
 * "The GSPro dialog is a status board").
 */
const gsproTpl = template(`
    <button bind="terrainBtn" type="button" class="cmdbar__gspro-btn" data-testid="gspro-update-terrain-btn"></button>
    <button bind="meshesFeatureBtn" type="button" class="cmdbar__gspro-btn" data-testid="gspro-update-meshes-feature-btn"></button>
    <button bind="meshesBtn" type="button" class="cmdbar__gspro-btn" data-testid="gspro-update-meshes-btn"></button>
    <button bind="pathsBtn" type="button" class="cmdbar__gspro-btn" data-testid="update-paths-btn"></button>
    <button bind="checkShapesBtn" type="button" class="cmdbar__gspro-btn" data-testid="svg-check-cmd-btn"></button>
    <button bind="shapesBtn" type="button" class="cmdbar__gspro-btn" data-testid="gspro-update-shapes-btn"></button>
    <button bind="plantBtn" type="button" class="cmdbar__gspro-btn" data-testid="plant-vegetation-btn"></button>
    <button bind="zonesBtn" type="button" class="cmdbar__gspro-btn" data-testid="update-zones-btn"></button>
    <button bind="photoBtn" type="button" class="cmdbar__gspro-btn" data-testid="gspro-update-photo-btn"></button>
    <button bind="courseFileBtn" type="button" class="cmdbar__gspro-btn" data-testid="gspro-update-course-file-btn"></button>
    <button bind="propsBtn" type="button" class="cmdbar__gspro-btn" data-testid="gspro-update-props-btn"></button>
    <button bind="boardBtn" type="button" class="cmdbar__gspro-btn" data-testid="gspro-board-btn"></button>
`);

/** A job phase, as much of it as the Unity question needs. */
export interface UnityPhase { id: string; status: string }

/**
 * A push's own report line: `Unity (vreta_v4): …` from a bridge command,
 * `Unity inner: …` from a heightmap push, either behind a chain's `inner: `
 * prefix. The lines that say nothing was pushed ("Not in Unity: …", "Still
 * manual in Unity: …", "there is no Unity push for the outer terrain") start
 * elsewhere, so they never match.
 */
const UNITY_PUSH_LINE = /^(?:[a-z][\w ]*: )?Unity (?:\(|inner\b|outer\b)/;

/**
 * True when this job pushed something into the open Unity editor. The phases
 * decide when the job has one (`unity`, `terrain:unity`, `meshes:unity`, …:
 * `done` is a push, `skipped` is not); only a chain without a Unity phase of
 * its own (shapes, vegetation, the course file) is read from the report, and
 * then from the push's own line, never from the words "Unity" or "Not in
 * Unity" anywhere in it.
 */
export function pushedIntoUnity(report: readonly string[], phases: readonly UnityPhase[] | null = null): boolean {
    const unity = phases?.filter(p => /(?:^|:)unity$/.test(p.id)) ?? [];
    if (unity.length > 0) return unity.some(p => p.status === 'done');
    return report.some(l => UNITY_PUSH_LINE.test(l) && !/\bskipped\b/.test(l));
}

/**
 * True when a result dialog still has to ask for the Unity scene to be saved:
 * something went into Unity and no `Saved …` line says the chain saved it
 * itself (unity/README.md, "Saving what a command changed").
 */
export function needsSceneSave(report: readonly string[], phases: readonly UnityPhase[] | null = null): boolean {
    return pushedIntoUnity(report, phases) && !report.some(l => l.includes('Saved '));
}

/**
 * Why a `vegetation-update` job says the quick path cannot do these zones (the
 * server's `needsPlanting` + `reason` on the result), as one sentence, or
 * null when it did them. Read off the result by name: the field is newer than
 * the generated type.
 */
export function needsPlanting(result: unknown): string | null {
    const r = result as { needsPlanting?: unknown; reason?: unknown } | null | undefined;
    if (!r || r.needsPlanting !== true) return null;
    const reason = typeof r.reason === 'string' ? r.reason.trim() : '';
    if (!reason) return 'These zones cannot be updated on their own.';
    return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}

/** `Course shapes` → `course shapes`, for "Could not update …". */
function lower(label: string): string {
    return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * The unified command bar (Builder redesign v2) — one 58px header shared by
 * /course (mode 'create') and /planner (mode 'plan'), replacing both the app
 * topbar and each page's old per-page header on those routes.
 *
 * Zones (see docs/ui-design "UNIFIED COMMAND BAR"):
 *   1 identity — app glyph, ‹ Courses, course name, status pill, (i) info popover
 *   2 modes    — Create · Plan · Play · Review segmented (Play/Review disabled)
 *   3 context  — Create only: sub-mode dropdown + feature-type dropdown + New/Box
 *   4 right    — ⋯ actions menu (Import SVG / Publish) + avatar menu
 *
 * Sub-mode selection lives in the shared EditorModeService (the toolbar keeps
 * hosting each tool's floating panel); the feature-type / New / Box controls
 * drive the same DrawToolService/DrawState the draw panel used to own.
 */
export class CommandBarComponent extends Component<{ mode: CommandBarMode }> {
    static styles = `
        .cmdbar {
            display: flex;
            align-items: center;
            gap: ${s('sm')};
            height: 58px;
            flex: none;
            padding: 0 ${s('md')};
            background: ${t('color-surface-card')};
            border-bottom: 1px solid ${t('color-border-default')};
            position: relative;
            z-index: 40;
            font-size: 0.85rem;
            color: ${t('color-text-primary')};

            & .cmdbar__slot { display: inline-flex; align-items: center; }

            & .cmdbar__identity {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                min-width: 0;
            }

            & .cmdbar__glyph {
                width: 26px;
                height: 26px;
                flex: none;
                border-radius: 7px;
                background: ${t('color-surface-brand')};
                color: ${t('overlay-text')};
                display: flex;
                align-items: center;
                justify-content: center;
            }

            & .cmdbar__courses {
                font-size: 0.82rem;
                color: ${t('color-text-secondary')};
                text-decoration: none;
                white-space: nowrap;
                cursor: pointer;
                &:hover { color: ${t('color-text-primary')}; }
            }

            & .cmdbar__name {
                font-weight: 700;
                font-size: 0.95rem;
                color: ${t('color-text-primary')};
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                max-width: 220px;
            }

            /* Status pill: quiet tinted tag; variants pick the colour. */
            & .cmdbar__pill {
                &:empty { display: none; }
                &.published { ${statusTag(t('color-status-positive'))} }
                &.draft { ${statusTag('var(--data-risk)')} }
                /* T49: course contains OSM-derived (ODbL) map data. */
                &.odbl { ${statusTag(t('color-status-info'))} text-transform: none; }
            }

            & .cmdbar__divider {
                width: 1px;
                height: 26px;
                flex: none;
                background: ${t('color-border-default')};
            }
            & .cmdbar__divider--sm { height: 22px; }

            /* Zone 2: mode toggle — a compact dropdown chip (guide §06). */
            & .cmdbar__modes { display: inline-flex; align-items: center; }

            & .cmdbar__zone3 {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
            }
            & .cmdbar__feat-wrap {
                display: none;
                align-items: center;
                gap: ${s('sm')};
                &.show { display: flex; }
            }
            /* A Draw control Vegetation mode has no use for (and vice versa). */
            & [data-off="true"] { display: none !important; }

            /* Dropdown chip trigger (guide §06): swatch/icon + label + chevron. */
            & .cmdbar__chip {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                background: ${t('color-surface-raised')};
                border: 1px solid ${t('color-border-default')};
                border-radius: 9px;
                padding: 6px 10px;
                font-size: 0.82rem;
                font-weight: 600;
                color: ${t('color-text-primary')};
                cursor: pointer;
                white-space: nowrap;
                transition: border-color var(--dur-fast) var(--ease-standard);
                &:hover { border-color: ${t('color-border-strong')}; }
                &[aria-expanded="true"] { border-color: ${t('color-border-focus')}; }
                & .cmdbar__chip-icon { display: flex; align-items: center; color: ${t('color-accent-primary')}; }
                & .cmdbar__chip-chev { display: flex; align-items: center; color: ${t('color-text-tertiary')}; }
                & .cmdbar__chip-sw { width: 16px; height: 16px; flex: none; border-radius: 4px; }
                & .cmdbar__chip-dot { width: 8px; height: 8px; flex: none; border-radius: 999px; }
            }

            /* Read-only draw-target chip: quiet surface, no hover/press.
               Line 1 is where new shapes land ("→ Hole 1"), line 2 the
               type policy the next chained shape follows. */
            & .cmdbar__target {
                display: inline-flex;
                flex-direction: column;
                justify-content: center;
                max-width: 160px;
                padding: ${s('xs')} ${s('sm')};
                border: 1px solid ${t('color-border-subtle')};
                border-radius: 9px;
                background: ${t('color-surface-sunken')};
                font-size: 0.8rem;
                line-height: 1.2;
                color: ${t('color-text-secondary')};
                white-space: nowrap;
                & > span { overflow: hidden; text-overflow: ellipsis; }
                & .cmdbar__target-chain {
                    font-size: 0.7rem;
                    color: ${t('color-text-tertiary')};
                }
            }

            /* Autosave pill (item 26). The slot has a fixed width so the
               right-hand group never shifts between states; the pill sits
               flush right inside it. Only the failed state is clickable. */
            & .cmdbar__save-slot {
                display: inline-flex;
                align-items: center;
                justify-content: flex-end;
                width: 132px;
                flex: none;
                &:empty { display: none; }
            }
            & .cmdbar__save {
                display: inline-flex;
                align-items: center;
                gap: ${s('xs')};
                padding: ${s('xs')} ${s('sm')};
                border: 1px solid transparent;
                border-radius: 999px;
                font-size: 0.78rem;
                white-space: nowrap;
                color: ${t('color-text-tertiary')};
                & .cmdbar__save-dot {
                    width: 7px;
                    height: 7px;
                    flex: none;
                    border-radius: 999px;
                    background: ${t('color-border-strong')};
                }
                & .cmdbar__save-code {
                    font-family: var(--font-mono);
                    font-size: 0.72rem;
                    &:empty { display: none; }
                }
                &:not([data-state="failed"]) { pointer-events: none; cursor: default; }
                &[data-state="saving"] .cmdbar__save-dot {
                    background: ${t('color-status-caution')};
                    animation: cmdbar-save-pulse 1s ease-in-out infinite;
                }
                &[data-state="saved"] .cmdbar__save-dot { background: ${t('color-status-positive')}; }
                &[data-state="failed"] {
                    border-color: color-mix(in srgb, ${t('color-status-negative')} 40%, transparent);
                    background: color-mix(in srgb, ${t('color-status-negative')} 10%, transparent);
                    color: ${t('color-status-negative')};
                    font-weight: 600;
                    &:hover { background: color-mix(in srgb, ${t('color-status-negative')} 16%, transparent); }
                    & .cmdbar__save-dot { background: ${t('color-status-negative')}; }
                }
            }

            /* Undo/redo history buttons — ghost icon buttons that dim when
               there's nothing to undo/redo (same reactive state the draw
               palette's Edit head had). */
            & .cmdbar__hist {
                ${iconBtn()}
                &:disabled {
                    opacity: 0.35;
                    cursor: default;
                    &:hover { border-color: ${t('color-border-default')}; color: ${t('color-text-secondary')}; background: ${t('color-surface-raised')}; }
                }
            }

            /* (?) round help button — opens the contextual shortcuts modal. */
            & .cmdbar__help {
                width: 24px;
                height: 24px;
                flex: none;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                border: none;
                border-radius: 999px;
                background: transparent;
                color: ${t('color-text-tertiary')};
                cursor: pointer;
                transition: color var(--dur-fast) var(--ease-standard),
                    background var(--dur-fast) var(--ease-standard);
                &:hover { background: ${t('color-surface-sunken')}; color: ${t('color-text-primary')}; }
            }

            /* New-polygon is a TOGGLE (draw ⇄ select), so it must read as
               off/on rather than being permanently accent-filled: ghost when
               idle, accent-filled + rotated-to-× icon while drawing is armed. */
            & .cmdbar__new { ${iconBtn()} }
            & .cmdbar__new .cmdbar__new-icon {
                display: inline-flex;
                transition: transform var(--dur-fast) var(--ease-standard);
            }
            & .cmdbar__new[aria-pressed="true"] {
                border-color: transparent;
                background: ${t('color-accent-primary')};
                color: ${t('color-on-accent')};
                box-shadow: 0 6px 14px -6px color-mix(in srgb, ${t('color-accent-primary')} 60%, transparent);
                &:hover { background: ${t('color-accent-hover')}; color: ${t('color-on-accent')}; }
                & .cmdbar__new-icon { transform: rotate(45deg); }
            }
            & .cmdbar__box { ${iconBtn()} }
            /* Vegetation mode's generated-zones eye and the GSPro Update buttons. */
            & .cmdbar__plant, & .cmdbar__gspro-btn {
                ${iconBtn()}
                width: auto;
                gap: 6px;
                padding: 0 10px;
                font-size: 0.8rem;
                white-space: nowrap;
                &[aria-busy="true"] { cursor: progress; opacity: 0.75; }
                &:disabled { opacity: 0.45; cursor: default; }
            }

            /* The GSPro group: the sub-mode's Update buttons, then the board. */
            & .cmdbar__gspro {
                display: inline-flex;
                align-items: center;
                gap: ${s('sm')};
                &:empty { display: none; }
            }
            /* The number of stale targets, inside the board button's label. */
            & .cmdbar__badge {
                color: ${t('color-status-caution')};
                font-weight: 700;
            }

            /* New-path toggles like new-polygon; its width field only shows
               while a path is being drawn. */
            & .cmdbar__path { ${iconBtn()} }
            & .cmdbar__path[aria-pressed="true"] {
                border-color: transparent;
                background: ${t('color-accent-primary')};
                color: ${t('color-on-accent')};
                &:hover { background: ${t('color-accent-hover')}; color: ${t('color-on-accent')}; }
            }
            & .cmdbar__path-width {
                display: none;
                width: 3.75rem;
                height: 28px;
                padding: 0 ${s('sm')};
                border: 1px solid ${t('color-border-strong')};
                border-radius: 6px;
                background: ${t('color-surface-card')};
                color: ${t('color-text-primary')};
                font: inherit;
                font-size: 12px;
                &.show { display: inline-block; }
            }
            & .cmdbar__path-surface { width: auto; }

            /* (i) round info button. */
            & .cmdbar__info-btn {
                width: 24px;
                height: 24px;
                border-radius: 999px;
                border: 1.5px solid ${t('color-border-strong')};
                background: transparent;
                color: ${t('color-text-tertiary')};
                font-style: italic;
                font-weight: 600;
                font-size: 0.72rem;
                cursor: pointer;
                transition: border-color var(--dur-fast) var(--ease-standard),
                    color var(--dur-fast) var(--ease-standard);
                &:hover, &[aria-expanded="true"] {
                    border-color: ${t('color-accent-primary')};
                    color: ${t('color-accent-primary')};
                }
            }

            & .cmdbar__right {
                margin-left: auto;
                display: flex;
                align-items: center;
                gap: ${s('sm')};
            }
            & .cmdbar__actions-btn { ${iconBtn()} }
            & .cmdbar__avatar {
                width: 30px;
                height: 30px;
                border-radius: 999px;
                flex: none;
                background: ${t('color-accent-secondary')};
                color: ${t('overlay-text')};
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 0.75rem;
                font-weight: 700;
                cursor: pointer;
            }
        }

        /* ── popover panel content (global CSS — panels are spawned components) ── */

        .cmdbar__mode-panel { width: 244px; }
        /* Mode rows: a colour dot, a name + one-line hint stacked, check on
           the active mode. Disabled rows (Play/Review) dim. */
        .cmdbar__mode-panel .menu-item { align-items: flex-start; }
        .cmdbar__mode-panel .menu-item__label { display: flex; flex-direction: column; gap: 1px; }
        .cmdbar__mode-panel .cmd-mode__dot { width: 8px; height: 8px; border-radius: 999px; margin-top: 5px; }
        .cmdbar__mode-panel .cmd-mode__hint {
            font-size: 0.72rem;
            font-weight: 400;
            color: ${t('color-text-tertiary')};
        }
        .cmdbar__mode-panel .menu-item[disabled] .cmd-mode__dot { opacity: 0.5; }

        .cmdbar__info-panel { width: 232px; }
        .cmd-info {
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding: 8px 10px;
        }
        .cmd-info__row { display: flex; justify-content: space-between; align-items: baseline; }
        .cmd-info__k { font-size: 0.75rem; color: ${t('color-text-tertiary')}; }
        .cmd-info__v { ${metric()} font-size: 0.8rem; color: ${t('color-text-primary')}; }
        .cmd-info__div { height: 1px; background: ${t('color-border-subtle')}; }
        .cmd-info__geo--warn {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .cmd-info__geo-row {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.78rem;
            color: ${t('color-status-caution')};
        }
        .cmd-info__geo-btn {
            border: none;
            border-radius: 8px;
            padding: 8px;
            background: color-mix(in srgb, ${t('color-status-caution')} 14%, transparent);
            color: ${t('color-text-accent')};
            font-family: inherit;
            font-size: 0.78rem;
            font-weight: 600;
            text-align: left;
            cursor: pointer;
            &:hover { background: color-mix(in srgb, ${t('color-status-caution')} 22%, transparent); }
        }
        .cmd-info__geo--ok {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.78rem;
            color: ${t('color-status-positive')};
        }

        @keyframes cmdbar-save-pulse { 50% { opacity: 0.35; } }

        /* Failed-save details: message, code, Retry. */
        .cmdbar__save-panel { width: 260px; }
        .cmd-save {
            display: flex;
            flex-direction: column;
            gap: ${s('sm')};
            padding: ${s('sm')};
            font-size: 0.8rem;
            color: ${t('color-text-primary')};
        }
        .cmd-save__title { font-weight: 600; color: ${t('color-status-negative')}; }
        .cmd-save__msg { color: ${t('color-text-secondary')}; }
        .cmd-save__code {
            font-family: var(--font-mono);
            font-size: 0.75rem;
            color: ${t('color-text-tertiary')};
        }
        .cmd-save__actions { display: flex; justify-content: flex-end; gap: ${s('xs')}; }
        .cmd-save__retry { ${primaryBtn()} padding: ${s('xs')} ${s('md')}; font-size: 0.8rem; }
        .cmd-save__dismiss { ${ghostBtn()} padding: ${s('xs')} ${s('md')}; font-size: 0.8rem; }

        /* Sub-mode key hint (D, M, F, A, T): right-aligned, before the check. */
        .menu-item .cmd-key { ${keyHint()} color: ${t('color-text-tertiary')}; }

        .cmdbar__ft-panel { width: 336px; padding: 12px; }
        .cmdbar__ft-title { ${panelTitle()} margin: 2px 4px 10px; }
        .cmdbar__ft-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 3px 8px;
            max-height: 320px;
            overflow-y: auto;
        }
        /* One grid cell = a select button + an eye visibility toggle. */
        .cmd-ft-row {
            display: flex;
            align-items: center;
            gap: 2px;
            border-radius: 8px;
        }
        .cmd-ft {
            flex: 1;
            min-width: 0;
            display: flex;
            align-items: center;
            gap: ${s('sm')};
            padding: 7px 9px;
            border: none;
            border-radius: 8px;
            background: transparent;
            font-family: inherit;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};
            cursor: pointer;
            text-align: left;
            white-space: nowrap;
            &:hover { background: color-mix(in srgb, ${t('color-text-primary')} 6%, transparent); }
            &[aria-selected="true"] {
                ${selectedRow()}
                & .cmd-ft__name { font-weight: 600; }
            }
            & .cmd-ft__sw {
                width: 15px;
                height: 15px;
                flex: none;
                border-radius: 4px;
                border: 1px solid rgba(0, 0, 0, 0.25);
            }
            & .cmd-ft__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
            /* Digit key hint (1-9, 0) for the keyboard-armable types,
               right-aligned after the name (the name is flex: 1). */
            & .cmd-ft__digit {
                ${keyHint()}
                flex: none;
                color: ${t('color-text-tertiary')};
            }
        }
        /* Per-type visibility toggle: appears on row hover (always when the
           type is hidden); a hidden type dims its select row. */
        .cmd-ft-eye {
            flex: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 26px;
            height: 26px;
            padding: 0;
            border: none;
            border-radius: 6px;
            background: transparent;
            color: ${t('color-text-tertiary')};
            cursor: pointer;
            opacity: 0;
            transition: opacity var(--dur-fast) var(--ease-standard),
                color var(--dur-fast) var(--ease-standard),
                background var(--dur-fast) var(--ease-standard);
            &:hover { background: color-mix(in srgb, ${t('color-text-primary')} 8%, transparent); color: ${t('color-text-primary')}; }
        }
        .cmd-ft-row:hover .cmd-ft-eye,
        .cmd-ft-row.is-hidden .cmd-ft-eye { opacity: 1; }
        .cmd-ft-row.is-hidden .cmd-ft { opacity: 0.45; }

        /* New-shape type policy footer: keep-last-used checkbox + (when off)
           the default-type picker new shapes reset to on arm. */
        .cmd-ft-policy {
            margin-top: 10px;
            padding: 10px 4px 2px;
            border-top: 1px solid ${t('color-border-subtle')};
            display: flex;
            flex-direction: column;
            gap: 8px;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};

            & label {
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                & input { accent-color: ${t('color-accent-primary')}; }
            }
            & .cmd-ft-policy__default {
                display: flex;
                align-items: center;
                gap: 8px;
                &.hide { display: none; }
                & span { color: ${t('color-text-secondary')}; }
                & select { ${input()} flex: 1; min-width: 0; }
            }
        }
        /* Zone-type picker: footer link to the table editor, empty-table note. */
        .cmd-zt-edit {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 4px;
            border: none;
            border-radius: 6px;
            background: transparent;
            font: inherit;
            color: ${t('color-text-primary')};
            cursor: pointer;
            &:hover { background: color-mix(in srgb, ${t('color-text-primary')} 6%, transparent); }
        }
        .cmd-zt-empty {
            grid-column: 1 / -1;
            padding: 6px 4px;
            font-size: 0.8rem;
            color: ${t('color-text-secondary')};
        }

        /* Accent (Publish) menu item — clay text + a small clay swatch. */
        .menu-item.cmd-menu-accent {
            color: ${t('color-text-accent')};
            font-weight: 600;
            & .cmd-menu-accent__sw {
                width: 8px;
                height: 8px;
                border-radius: 2px;
                background: ${t('color-accent-primary')};
            }
        }
    `;

    private svc = this.inject(CourseDetailService);
    private features = this.inject(FeaturesService);
    private tool = this.inject(DrawToolService);
    private mode = this.inject(EditorModeService);
    private importSvc = this.inject(SvgImportService);
    private geojsonImportSvc = this.inject(GeojsonImportService);
    private gsproSync = this.inject(GsproSyncService);
    private zoneTypesSvc = this.inject(ZoneTypesService);
    private vegetationRulesSvc = this.inject(VegetationRulesService);
    private photoStemsSvc = this.inject(PhotoStemsService);
    /** "Open errors" when an update failed on the SVG checks. */
    private svgCheck = this.inject(SvgCheckService);
    private mapBuild = this.inject(MapBuildClientService);
    private tileset = this.inject(TilesetService);
    private mapSvc = this.inject(MapService);
    private publishVps = this.inject(PublishClientService);
    private confirm = this.inject(ConfirmService);
    private plant = this.inject(PlantVegetationService);
    private shaping = this.inject(ShapingService);
    /** The Terrain editor's own feature selection ("Shape in Blender"); built on first read. */
    private terrainTool?: TerrainEditToolService;
    private get terrain(): TerrainEditToolService {
        return (this.terrainTool ??= this.inject(TerrainEditToolService));
    }
    /** The Clean tool's pixel-save queue ("Update photo" waits for it); built on first read. */
    private cleanTool?: CleanToolService;
    private get clean(): CleanToolService {
        return (this.cleanTool ??= this.inject(CleanToolService));
    }
    /** Which GSPro action this bar started ('' = none), so its button shows the step. */
    private readonly action = new Signal<string>('');
    private helpModal = this.inject(HelpModalService);
    private serverMode = this.inject(ServerModeService);
    private auth = this.inject(AuthService);
    private router = this.inject(Router);
    // courseId/hole live in the route (the same param on both host routes).
    private params = this.router.params<{ courseId: string }>('/:host/:courseId');
    private selectedHole = this.router.query('hole');

    /** Route ?hole → its feature id (null = course level / no hole). */
    private readonly activeHoleId = new Computed<string | null>(() => {
        const number = this.selectedHole.get();
        if (!number) return null;
        return this.svc.holes.get().find(h => String(h.number) === number)?.id ?? null;
    });

    render(): DocumentFragment {
        const isCreate = this.props.mode === 'create';

        const frag = this.wire(tpl, {
            courses: {
                onclick: (e: Event) => {
                    e.preventDefault();
                    this.router.navigate('/');
                },
            },
            name: () => this.svc.course.get()?.name ?? '',
            status: {
                textContent: () => this.svc.course.get()?.status ?? '',
                className: () => `cmdbar__pill ${this.svc.course.get()?.status ?? ''}`,
            },
            // ODbL posture pill (T49) — derived live from the loaded
            // features; :empty hides it on courses without OSM-derived data.
            odbl: {
                textContent: () => this.features.hasOdblFeatures.get() ? 'ODbL map data' : '',
                title: () => this.features.hasOdblFeatures.get()
                    ? 'Contains OpenStreetMap-derived features — map data licensed ODbL, © OpenStreetMap contributors'
                    : '',
            },
            zone3Divider: { style: () => (isCreate ? '' : 'display:none') },
        });

        this.buildModes(this.ref(frag, 'modesHost'));

        // (i) info popover.
        this.spawn(PopoverComponent, this.ref(frag, 'infoHost'), {
            ariaLabel: 'Course info',
            triggerClassName: 'cmdbar__info-btn',
            panelClassName: 'cmdbar__info-panel',
            trigger: 'i',
            panel: (host, ctx) => this.buildInfoPanel(host, ctx.track),
        });

        // Zone 3 (Create only).
        if (isCreate) {
            this.buildZone3(this.ref(frag, 'zone3Host'));

            // A sidebar navigation sets the draw target. Editing a drawing
            // group's name/list must preserve the explicit Draw on choice.
            let lastDrawRoute = '';
            this.track(effect(() => {
                const number = this.selectedHole.get();
                const holes = this.svc.holes.get();
                const activeHoleId = this.activeHoleId.get();
                const route = `${this.svc.course.get()?.id ?? ''}:${number ?? ''}:${activeHoleId ?? ''}`;
                if (route === lastDrawRoute) return;
                lastDrawRoute = route;
                untrack(() => {
                    this.tool.drawLayer.set(null);
                    if (!number) {
                        this.tool.drawHoleId.set(null);
                    } else if (activeHoleId) {
                        this.tool.drawHoleId.set(activeHoleId);
                    } else if (holes.length > 0) {
                        this.tool.drawHoleId.set(null);
                    }
                });
            }));

            this.buildSaveState(this.ref(frag, 'saveHost'), this.ref(frag, 'toastHost'));

            // The GSPro group (right end): builder only — nothing on a serve
            // box pushes into Unity.
            if (this.serverMode.isBuilder()) this.buildGspro(this.ref(frag, 'gsproHost'));
        }

        // Zone 4: actions + avatar. Every entry in the actions menu authors
        // something (imports, lidar cleanup, publish revision), so serve mode
        // gets no ⋯ trigger at all rather than an empty popover.
        if (this.serverMode.isBuilder()) {
            this.spawn(PopoverComponent, this.ref(frag, 'actionsHost'), {
                align: 'right',
                ariaLabel: 'Actions',
                triggerClassName: 'cmdbar__actions-btn',
                trigger: (host) => {
                    host.dataset.testid = 'actions-menu-trigger';
                    host.innerHTML = icon('more-horizontal', 20);
                },
                lazyPanel: true, // panel body + its publish/lidar fetches wait for the first open
                panel: (host, ctx) => this.buildActionsPanel(host, ctx.track, ctx.close),
            });
        }
        this.spawn(PopoverComponent, this.ref(frag, 'avatarHost'), {
            align: 'right',
            ariaLabel: 'Account',
            triggerClassName: 'cmdbar__avatar',
            trigger: (host, ctx) => {
                ctx.track(effect(() => { host.textContent = this.userInitial(); }));
            },
            panel: (host, ctx) => this.buildAvatarPanel(host, ctx.close),
        });

        return frag;
    }

    // ── Zone 2: mode toggle (dropdown) ────────────────────────────────────

    private buildModes(host: HTMLElement): void {
        const current = MODES.find(m => m.id === this.props.mode)!;
        this.spawn(PopoverComponent, host, {
            ariaLabel: 'Editor mode',
            triggerClassName: 'cmdbar__chip',
            panelClassName: 'cmdbar__mode-panel',
            trigger: (h) => {
                h.dataset.testid = 'mode-trigger';
                h.innerHTML = `<span class="cmdbar__chip-dot" style="background:${current.dot}"></span>`
                    + `<span>${current.label}</span>`
                    + `<span class="cmdbar__chip-chev">${icon('chevron-down', 16)}</span>`;
            },
            panel: (h, ctx) => this.buildModePanel(h, ctx.close),
        });
    }

    private buildModePanel(host: HTMLElement, close: () => void): void {
        const nav = (base: string) => {
            const { courseId } = this.params.peek();
            if (!courseId) return;
            const hole = this.selectedHole.peek();
            this.router.navigate(`${base}/${courseId}`, hole !== undefined ? { query: { hole } } : undefined);
        };
        for (const m of MODES) {
            const active = m.id === this.props.mode;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'menu-item';
            btn.setAttribute('role', 'menuitemradio');
            btn.setAttribute('aria-checked', String(active));
            if (m.testid) btn.dataset.testid = m.testid;
            btn.innerHTML = `<span class="menu-item__icon"><span class="cmd-mode__dot" style="background:${m.dot}"></span></span>`
                + `<span class="menu-item__label"><span>${m.label}</span><span class="cmd-mode__hint">${m.hint}</span></span>`
                + `<span class="menu-item__check">${icon('check', 16)}</span>`;
            if (!m.enabled || !m.nav) {
                btn.disabled = true;
            } else {
                btn.onclick = () => {
                    if (m.id !== this.props.mode) nav(m.nav!);
                    close();
                };
            }
            host.appendChild(btn);
        }
    }

    // ── Zone 3: contextual toolbar (Create) ───────────────────────────────

    private buildZone3(host: HTMLElement): void {
        const frag = this.wire(zone3Tpl, {
            featWrap: { className: () => (this.isFeatureEditSubmode() ? 'cmdbar__feat-wrap show' : 'cmdbar__feat-wrap') },
            featHost: { 'data-off': () => String(this.isVegetationSubmode()) },
            zoneHost: { 'data-off': () => String(!this.isVegetationSubmode()) },
            drawTarget: {
                title: () => (this.tool.typeFollowsLast.get()
                    ? 'New shapes are added to this hole / scope. The next shape keeps the last-used type.'
                    : `New shapes are added to this hole / scope. Each new shape starts as ${FEATURE_STYLES[this.tool.defaultDrawType.get()].label}.`),
            },
            targetHole: () => `→ ${this.tool.drawLayer.get() === 'roughs' ? 'Roughs (bottom)' : this.holeLabel(this.tool.drawHoleId.get())}`,
            targetChain: () => this.chainLabel(),
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
            helpBtn: { onclick: () => this.helpModal.show() },
            newPoly: {
                innerHTML: `<span class="cmdbar__new-icon">${icon('plus', 16)}</span>`,
                title: () => (this.tool.state.isDrawing.get()
                    ? 'Drawing — click near the first point or press Enter to close; Alt-click places the final point and closes. Click this button to stop (Esc)'
                    : this.isVegetationSubmode() ? 'New zone (N)' : 'New polygon (N)'),
                'aria-label': () => (this.tool.state.isDrawing.get() ? 'Stop drawing'
                    : this.isVegetationSubmode() ? 'New zone' : 'New polygon'),
                'aria-pressed': () => this.tool.state.isDrawing.get(),
                'data-testid': 'new-polygon-btn',
                onclick: () => {
                    if (this.tool.state.isDrawing.peek()) this.tool.state.disarm();
                    else this.tool.armDraw();
                },
            },
            boxSelect: {
                innerHTML: icon('box-select', 16),
                title: () => (this.tool.state.boxSelect.get() ? 'Box-select: on (B)' : 'Box-select (B)'),
                'aria-label': 'Box-select',
                'aria-pressed': () => this.tool.state.boxSelect.get(),
                'data-testid': 'box-select-btn',
                onclick: () => this.tool.state.toggleBoxSelect(),
            },
            // Vegetation mode: the generated zones (tall rough, creek banks, woodland floor) on or
            // off, to see only what was drawn by hand.
            generatedBtn: {
                'data-off': () => String(!this.isVegetationSubmode() || this.features.generatedVegetationSources.get().length === 0),
                innerHTML: () => `${icon(this.features.generatedVegetationShown.get() ? 'eye' : 'eye-off', 16)}<span>Generated</span>`,
                title: () => this.features.generatedVegetationShown.get()
                    ? 'Hide the generated vegetation (tall rough, creek banks, woodland floor): only the zones drawn by hand stay'
                    : 'Show the generated vegetation again',
                'aria-pressed': () => String(this.features.generatedVegetationShown.get()),
                onclick: () => this.features.setGeneratedVegetationShown(!this.features.generatedVegetationShown.peek()),
            },
            newPath: {
                innerHTML: icon('route', 16),
                title: () => (this.pathArmed()
                    ? 'Drawing a road/path centerline — click to stop (Esc). Click along its centre (Shift = corner) and press Enter, or drag it freehand'
                    : 'New road/path centerline (P) — a creek centerline when Creek is the draw type: click along its centre and press Enter, or drag it freehand. Edit it later as one line with a width'),
                'aria-label': () => (this.pathArmed() ? 'Stop drawing the path' : 'New path'),
                'aria-pressed': () => this.pathArmed(),
                'data-testid': 'new-path-btn',
                'data-off': () => String(this.isVegetationSubmode()),
                onclick: () => {
                    if (this.pathArmed()) this.tool.state.disarm();
                    else this.tool.armPath();
                },
            },
            pathWidth: {
                className: () => (this.pathArmed() ? 'cmdbar__path-width show' : 'cmdbar__path-width'),
                title: 'Path width in metres',
            },
            pathSurface: {
                className: () => (this.pathArmed() ? 'cmdbar__path-width cmdbar__path-surface show' : 'cmdbar__path-width cmdbar__path-surface'),
                title: 'Surface of the paths you draw (what it looks and plays like in GSPro)',
            },
        });
        const pathWidthInput = this.ref(frag, 'pathWidth') as HTMLInputElement;
        pathWidthInput.addEventListener('change', () => this.tool.setPathWidthM(Number(pathWidthInput.value)));
        this.track(effect(() => { pathWidthInput.value = String(this.tool.pathWidthM.get()); }));
        const pathSurfaceSelect = this.ref(frag, 'pathSurface') as HTMLSelectElement;
        for (const [value, label] of [['', 'Unknown surface'] as const, ...PATH_SURFACES.map(v => [v, PATH_SURFACE_LABELS[v]] as const)]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            pathSurfaceSelect.appendChild(option);
        }
        pathSurfaceSelect.addEventListener('change', () => this.tool.setPathSurface(pathSurfaceSelect.value as PathSurface | ''));
        this.track(effect(() => { pathSurfaceSelect.value = this.tool.pathSurface.get(); }));

        // Sub-mode dropdown.
        this.spawn(PopoverComponent, this.ref(frag, 'subHost'), {
            ariaLabel: 'Editor sub-mode',
            triggerClassName: 'cmdbar__chip',
            trigger: (h, ctx) => {
                h.dataset.testid = 'submode-trigger';
                h.innerHTML = `<span class="cmdbar__chip-icon" data-k="icon"></span><span data-k="label"></span><span class="cmdbar__chip-chev">${icon('chevron-down', 16)}</span>`;
                const iconEl = h.querySelector<HTMLElement>('[data-k="icon"]')!;
                const labelEl = h.querySelector<HTMLElement>('[data-k="label"]')!;
                ctx.track(effect(() => {
                    const active = this.mode.activeTool() ?? drawTool;
                    iconEl.innerHTML = icon(active.icon, 16);
                    labelEl.textContent = active.label;
                }));
            },
            panel: (h, ctx) => this.buildSubmodePanel(h, ctx.track, ctx.close),
        });

        // Feature-type dropdown.
        this.spawn(PopoverComponent, this.ref(frag, 'featHost'), {
            ariaLabel: 'Feature type',
            triggerClassName: 'cmdbar__chip',
            panelClassName: 'cmdbar__ft-panel',
            trigger: (h, ctx) => {
                h.dataset.testid = 'feature-type-trigger';
                h.innerHTML = `<span class="cmdbar__chip-sw" data-k="sw"></span><span data-k="name"></span><span class="cmdbar__chip-chev">${icon('chevron-down', 16)}</span>`;
                const swEl = h.querySelector<HTMLElement>('[data-k="sw"]')!;
                const nameEl = h.querySelector<HTMLElement>('[data-k="name"]')!;
                ctx.track(effect(() => {
                    const style = FEATURE_STYLES[this.triggerFeatureType()];
                    swEl.style.background = style.fill;
                    swEl.style.border = `1px solid ${style.outline}`;
                    nameEl.textContent = style.label;
                }));
            },
            panel: (h, ctx) => this.buildFeaturePanel(h, ctx.track, ctx.close),
        });

        // Zone-type dropdown (Vegetation mode, in the feature type's place).
        this.spawn(PopoverComponent, this.ref(frag, 'zoneHost'), {
            ariaLabel: 'Zone type',
            triggerClassName: 'cmdbar__chip',
            panelClassName: 'cmdbar__ft-panel',
            trigger: (h, ctx) => {
                h.dataset.testid = 'zone-type-trigger';
                h.innerHTML = `<span class="cmdbar__chip-sw" data-k="sw"></span><span data-k="name"></span><span class="cmdbar__chip-chev">${icon('chevron-down', 16)}</span>`;
                const swEl = h.querySelector<HTMLElement>('[data-k="sw"]')!;
                const nameEl = h.querySelector<HTMLElement>('[data-k="name"]')!;
                ctx.track(effect(() => {
                    const key = this.triggerZoneType();
                    if (key === TREE_AREA_PICK) {
                        swEl.style.background = FEATURE_STYLES.tree_area.fill;
                        swEl.style.border = `1px solid ${FEATURE_STYLES.tree_area.outline}`;
                        nameEl.textContent = FEATURE_STYLES.tree_area.label;
                        return;
                    }
                    swEl.style.background = this.zoneTypesSvc.colorFor(key) || FEATURE_STYLES.vegetation_zone.fill;
                    swEl.style.border = `1px solid ${FEATURE_STYLES.vegetation_zone.outline}`;
                    nameEl.textContent = key ? this.zoneTypesSvc.labelFor(key) : 'Zone type';
                }));
            },
            panel: (h, ctx) => this.buildZoneTypePanel(h, ctx.track, ctx.close),
        });

        host.appendChild(frag);
    }

    // ── Zone 4: the GSPro group (Update buttons + the status board) ────────

    /**
     * The sub-mode's Update buttons and the board button. Each Update runs the
     * same chain the board's row of that name runs, and reports the job's own
     * report in the house result dialog; the board's stale count is re-read
     * when the course opens and after every run (no timer: the bar is not the
     * board).
     */
    private buildGspro(host: HTMLElement): void {
        const frag = this.wire(gsproTpl, {
            // Terrain mode: the terrain edits, both heightmaps and the files
            // that read them. The chain bakes the edits itself when they are stale.
            terrainBtn: {
                'data-off': () => String(this.subMode() !== TERRAIN_EDIT_TOOL_ID),
                innerHTML: () => this.updateLabel('terrain', 'Update terrain'),
                title: () => `${gsproTarget('terrain').description} Unapplied terrain edits are baked first.`,
                ...this.updateButton('terrain', (courseId) => this.runSyncUpdate(courseId, 'terrain')),
            },
            // One feature's meshes: the Terrain editor's selection, or a slab,
            // bunker, pond or creek selected in Draw mode.
            meshesFeatureBtn: {
                'data-off': () => String(this.meshFeatureIds().length === 0),
                // It runs a ShapingService job, so its face shows that job's phase.
                innerHTML: () => this.updateLabel('meshes-feature',
                    this.meshFeatureIds().length > 1 ? `Update meshes (${this.meshFeatureIds().length} features)` : 'Update meshes (this feature)',
                    () => this.shapingStep('Updating meshes')),
                title: () => (this.meshFeatureIds().length > 1
                    ? "Re-shape these features' meshes in Blender with their saved recipe and refresh them in the course's open Unity project"
                    : "Re-shape this feature's meshes in Blender with its saved recipe (a rock slab: cut it out of them) and refresh them in the course's open Unity project"),
                // A recipe save still in flight would be shaped from its old value.
                ...this.updateButton('meshes-feature', (courseId) => this.updateMeshesForFeatures(courseId, this.meshFeatureIds()),
                    () => this.subMode() === TERRAIN_EDIT_TOOL_ID && this.terrain.saving.get()),
            },
            meshesBtn: {
                'data-off': () => String(this.subMode() !== TERRAIN_EDIT_TOOL_ID || this.meshFeatureIds().length > 0),
                innerHTML: () => this.updateLabel('meshes', 'Update meshes'),
                title: () => gsproTarget('meshes').description,
                ...this.updateButton('meshes', (courseId) => this.runSyncUpdate(courseId, 'meshes')),
            },
            // Draw mode with a road or path selected: its surface through Blender into Unity.
            pathsBtn: {
                'data-off': () => String(this.subMode() !== DRAW_TOOL_ID || this.selectedPathCount() === 0),
                innerHTML: () => this.updateLabel('paths', 'Update paths', () => this.pathsStep()),
                title: "Update paths: take the paths' surfaces as set now (Path surface) through to the course's open Unity project. Rewrites the surfaces file of the exported SVG, lets Blender cut the roads of mixed surfaces apart (only what changed is re-shaped, with any other shaping not yet applied), re-imports those meshes and gives every path mesh its surface's material. For a changed surface only: a path that was moved or redrawn needs the SVG export and the OPCD build",
                ...this.updateButton('paths', (courseId) => this.updatePathsInUnity(courseId)),
            },
            // Draw mode: the SVG checks (Check shapes overlay), open or closed; the count is of the last check.
            checkShapesBtn: {
                'data-off': () => String(this.subMode() !== DRAW_TOOL_ID),
                'aria-pressed': () => String(!!this.svgCheck.courseId.get()),
                innerHTML: () => {
                    const course = this.svc.course.get();
                    const report = this.svgCheck.report.get();
                    const errors = course && report?.courseId === course.id ? report.findings.filter((f) => f.severity === 'error' && !f.accepted).length : 0;
                    return `${icon('triangle-alert', 16)}<span>${errors ? `Check · ${errors}` : 'Check'}</span>`;
                },
                title: 'Check shapes: what would stop the SVG export or the OPCD build (slivers, necks, hidden shapes, greens on rough), as the shapes are now. Click again to close.',
                onclick: () => {
                    const course = this.svc.course.peek();
                    if (!course) return;
                    if (this.svgCheck.courseId.peek() === course.id) this.svgCheck.close();
                    else this.svgCheck.open(course.id);
                },
            },
            shapesBtn: {
                'data-off': () => String(this.subMode() !== DRAW_TOOL_ID
                    || this.selectedPathCount() > 0 || this.meshFeatureIds().length > 0),
                innerHTML: () => this.updateLabel('shapes', 'Update shapes'),
                title: () => `${gsproTarget('shapes').description} Then: ${gsproTarget('shapes').manual}.`,
                ...this.updateButton('shapes', (courseId) => this.runSyncUpdate(courseId, 'shapes')),
            },
            plantBtn: {
                'data-off': () => String(this.subMode() !== VEGETATION_TOOL_ID),
                innerHTML: () => `${icon('sprout', 16)}<span>${this.plant.runningKind.get() === 'vegetation' ? 'Planting…' : 'Update vegetation'}</span>`,
                title: 'Update vegetation: regenerate the tall rough and the creek and pond banks from the course as drawn, export the zones, import them into the course\'s open Unity project, and write the Arborist file GSPro draws the bushes, the woodland floor and most trees from (its trees only with Unity open)',
                ...this.updateButton('vegetation', (courseId) => this.confirmPlantVegetation(courseId)),
            },
            // Vegetation mode with zones selected: just their area, into Unity and the Arborist file.
            zonesBtn: {
                'data-off': () => String(this.subMode() !== VEGETATION_TOOL_ID || this.selectedZoneIds().length === 0),
                innerHTML: () => {
                    const n = this.selectedZoneIds().length;
                    return `${icon('upload', 16)}<span>${this.plant.runningKind.get() === 'vegetation-update' ? 'Updating…' : n === 1 ? 'Update zone' : `Update ${n} zones`}</span>`;
                },
                title: "Update the selected zones: re-rasterize only their area (as drawn now and as last exported), respawn it in the course's open Unity project and write the Arborist file's lower vegetation again. The generators do not run and the trees are left; use Update vegetation after changing the zone types' items",
                ...this.updateButton('zones', (courseId) => this.updateZonesInUnity(courseId, this.selectedZoneIds())),
            },
            photoBtn: {
                'data-off': () => String(this.subMode() !== CLEAN_TOOL_ID),
                innerHTML: () => this.updateLabel('photo', 'Update photo'),
                title: () => gsproTarget('photo').description,
                ...this.updateButton('photo', (courseId) => this.updatePhoto(courseId)),
            },
            courseFileBtn: {
                'data-off': () => String(this.subMode() !== FURNITURE_TOOL_ID),
                innerHTML: () => this.updateLabel('course-file', 'Update course file'),
                title: () => gsproTarget('course-file').description,
                ...this.updateButton('course-file', (courseId) => this.runSyncUpdate(courseId, 'course-file')),
            },
            // Furniture mode is where the props belong: the spec, the Blender
            // models and the place in Unity, which keeps every prop moved by hand.
            propsBtn: {
                'data-off': () => String(this.subMode() !== FURNITURE_TOOL_ID),
                innerHTML: () => this.updateLabel('props', 'Update props'),
                title: () => `${gsproTarget('props').description}. Props moved by hand in Unity are kept;`
                    + ' only the spec (docs/gspro/<course>/*-props.gen.py) makes a hand move permanent',
                ...this.updateButton('props', (courseId) => this.runSyncUpdate(courseId, 'props')),
            },
            boardBtn: {
                innerHTML: () => {
                    const stale = this.gsproSync.staleCount.get();
                    const badge = stale > 0
                        ? `<span class="cmdbar__badge" data-testid="gspro-stale-badge"> · ${stale}</span>`
                        : '';
                    return `${icon('layers', 16)}<span>GSPro${badge}</span>`;
                },
                title: 'Open the GSPro status board',
                onclick: () => {
                    const course = this.svc.course.peek();
                    if (course) void this.gsproSync.openFor(course.id);
                },
            },
        });
        host.appendChild(frag);

        // The stale count once, when the course opens: no timer here (the
        // board polls while it is open, and every run above re-reads it).
        let read: string | null = null;
        this.track(effect(() => {
            const id = this.svc.course.get()?.id ?? null;
            if (!id || id === read) return;
            read = id;
            untrack(() => void this.gsproSync.refresh(id));
        }));
    }

    /**
     * The shared parts of an Update button: busy while its own run goes, off
     * while any GSPro job runs — and while `alsoBusy` says this one's own
     * groundwork is not finished (an unsaved recipe).
     */
    private updateButton(action: string, run: (courseId: string) => Promise<void>, alsoBusy?: () => boolean): {
        disabled: () => boolean; 'aria-busy': () => string; onclick: () => void;
    } {
        return {
            disabled: () => this.gsproBusy() || alsoBusy?.() === true,
            'aria-busy': () => String(this.action.get() === action),
            onclick: () => {
                const course = this.svc.course.peek();
                if (!course || this.gsproBusyNow() || alsoBusy?.() === true) return;
                void this.runAction(action, () => run(course.id));
            },
        };
    }

    /**
     * An Update button's face: the running job's step while it is this
     * button's run. `step` is whose job that is — the status board's by
     * default, the shaping job's for the buttons that run one themselves.
     */
    private updateLabel(action: string, label: string, step: () => string = () => this.syncStep()): string {
        return `${icon('upload', 16)}<span>${this.action.get() === action ? step() : label}</span>`;
    }

    /** The running board job's step ("Exporting the heightmaps…"). */
    private syncStep(): string {
        const job = this.gsproSync.job.get();
        return `${job?.step || 'Updating'}…`;
    }

    /**
     * The Create sub-mode the buttons follow. Nothing armed yet reads as Draw,
     * the way the drawing controls do.
     */
    private subMode(): string {
        return this.mode.activeTool()?.id ?? DRAW_TOOL_ID;
    }

    /** A GSPro job this bar can start is on its way (reactive, for the buttons). */
    private gsproBusy(): boolean {
        return this.gsproSync.running.get() || this.shaping.running.get() || this.plant.running.get();
    }

    /** The same, read without subscribing (a click guard). */
    private gsproBusyNow(): boolean {
        return this.gsproSync.running.peek() || this.shaping.running.peek() || this.plant.running.peek();
    }

    /** Run one GSPro action, with its button showing the step while it goes. */
    private async runAction(action: string, run: () => Promise<void>): Promise<void> {
        this.action.set(action);
        try {
            await run();
        } finally {
            this.action.set('');
        }
    }

    /**
     * The features a feature-scoped shaping run would re-shape in the active
     * sub-mode: the Terrain editor's "Shape in Blender" selection, or a rock
     * slab, bunker, pond or creek selected in Draw mode (a selected path has
     * its own button). Empty = the button does not show.
     */
    private meshFeatureIds(): string[] {
        const mode = this.subMode();
        if (mode === TERRAIN_EDIT_TOOL_ID) return [...this.terrain.selectedFeatureIds.get()];
        if (mode !== DRAW_TOOL_ID || this.selectedPathCount() > 0) return [];
        return this.features.selectedFeatures.get()
            .filter(f => f.type !== 'path' && MESH_FEATURE_TYPES.includes(f.type))
            .map(f => f.id);
    }

    /** Draw-target chip line 2: the new-shape type policy (DrawToolService). */
    private chainLabel(): string {
        return this.tool.typeFollowsLast.get()
            ? 'Next: same type'
            : `Next: ${FEATURE_STYLES[this.tool.defaultDrawType.get()].label}`;
    }

    /** Human label for the draw target hole (null = course level). */
    /** True while a path (centerline) is being drawn — the new-path toggle's on state. */
    private pathArmed(): boolean {
        return this.tool.state.isDrawing.get() && this.tool.pathMode.get();
    }

    private holeLabel(holeId: string | null): string {
        if (holeId === null) return 'Course level';
        const hole = this.svc.drawScopes.get().find(h => h.id === holeId);
        return hole?.drawingGroupName ?? (hole ? `Hole ${hole.number} (par ${hole.par})` : 'Selected hole');
    }

    /**
     * A draw-engine sub-mode is active — Draw or Vegetation (or none is armed
     * yet → treat as Draw). Never in serve mode: neither tool is registered
     * there, so the "nothing armed yet" fallback must not reveal the drawing
     * controls.
     */
    private isFeatureEditSubmode(): boolean {
        if (!this.serverMode.isBuilder()) return false;
        const active = this.mode.activeTool();
        return active ? active.id === DRAW_TOOL_ID || active.id === VEGETATION_TOOL_ID : true;
    }

    private isVegetationSubmode(): boolean {
        return this.mode.activeToolId.get() === VEGETATION_TOOL_ID;
    }

    /**
     * Zone type shown on the zone-type trigger (selected single zone → the next
     * zone's type), or {@link TREE_AREA_PICK} for a tree species area.
     */
    private triggerZoneType(): string {
        const selected = this.features.selectedIds.get().size === 1 ? this.features.selected.get() : null;
        if (selected && selected.type === TREE_AREA_TYPE) return TREE_AREA_PICK;
        if (selected && isVegetationType(selected.type)) return zoneTypeKeyOf(selected.attributes);
        if (!selected && this.tool.drawType.get() === TREE_AREA_TYPE) return TREE_AREA_PICK;
        return this.tool.drawZoneType.get() || (this.zoneTypesSvc.items.get()[0]?.key ?? '');
    }

    /** Feature type shown on the dropdown trigger swatch (selected single → drawType). */
    private triggerFeatureType(): FeatureType {
        const multi = this.features.selectedIds.get().size > 1;
        const selected = this.features.selected.get();
        return !multi && selected ? (selected.type as FeatureType) : this.tool.drawType.get();
    }

    private buildSubmodePanel(host: HTMLElement, track: (d: () => void) => void, close: () => void): void {
        // Serve mode drops the map-editing tools (draw, furniture, SAM,
        // terrain edit, clean) — their APIs are not mounted on the VPS.
        const tools = visibleEditorTools(this.serverMode.mode.peek());
        for (const editorTool of [...tools].sort((a, b) => a.order - b.order)) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'menu-item';
            btn.setAttribute('role', 'menuitemradio');
            btn.dataset.testid = `tool-btn-${editorTool.id}`;
            btn.dataset.toolId = editorTool.id;
            const key = SUBMODE_KEY_HINTS[editorTool.id];
            btn.innerHTML = `<span class="menu-item__icon">${icon(editorTool.icon, 16)}</span>`
                + `<span class="menu-item__label">${editorTool.label}</span>`
                + (key ? `<span class="cmd-key" aria-hidden="true" data-testid="submode-key">${key}</span>` : '')
                + `<span class="menu-item__check">${icon('check', 16)}</span>`;
            if (key) btn.setAttribute('aria-keyshortcuts', key);
            btn.onclick = () => {
                if (this.mode.activeToolId.peek() !== editorTool.id) this.mode.activate(editorTool);
                close();
            };
            track(effect(() => btn.setAttribute('aria-checked', String(this.mode.activeToolId.get() === editorTool.id))));
            host.appendChild(btn);
        }
    }

    private buildFeaturePanel(host: HTMLElement, track: (d: () => void) => void, close: () => void): void {
        host.innerHTML = `<div class="cmdbar__ft-title">Feature type</div><div class="cmdbar__ft-grid" data-k="grid"></div>`
            + `<div class="cmd-ft-policy">`
            + `<label><input type="checkbox" data-k="follow" data-testid="ft-follow-last"> New shapes keep the last-used type</label>`
            + `<div class="cmd-ft-policy__default" data-k="defaultRow"><span>Start new shapes as</span>`
            + `<select data-k="defaultSel" data-testid="ft-default-type" aria-label="Default type for new shapes"></select></div>`
            + `</div>`;
        const grid = host.querySelector<HTMLElement>('[data-k="grid"]')!;

        // New-shape type policy footer (persisted on DrawToolService).
        const follow = host.querySelector<HTMLInputElement>('[data-k="follow"]')!;
        const defaultRow = host.querySelector<HTMLElement>('[data-k="defaultRow"]')!;
        const defaultSel = host.querySelector<HTMLSelectElement>('[data-k="defaultSel"]')!;
        // The rules lines (penalties, OOB) are Furniture's, the zones Vegetation's.
        const drawTypes = FEATURE_TYPES.filter(type => !isRulesType(type) && !isVegetationType(type));
        for (const type of drawTypes) {
            const opt = document.createElement('option');
            opt.value = type;
            opt.textContent = FEATURE_STYLES[type].label;
            defaultSel.appendChild(opt);
        }
        follow.onchange = () => this.tool.setTypeFollowsLast(follow.checked);
        defaultSel.onchange = () => this.tool.setDefaultDrawType(defaultSel.value as FeatureType);
        track(effect(() => {
            follow.checked = this.tool.typeFollowsLast.get();
            defaultRow.classList.toggle('hide', this.tool.typeFollowsLast.get());
            defaultSel.value = this.tool.defaultDrawType.get();
        }));
        for (const type of drawTypes) {
            const style = FEATURE_STYLES[type];
            const row = document.createElement('div');
            row.className = 'cmd-ft-row';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cmd-ft';
            btn.title = style.label;
            const digit = digitForFeatureType(type);
            const badge = digit ? `<span class="cmd-ft__digit" aria-hidden="true" data-testid="ft-key">${digit}</span>` : '';
            btn.dataset.type = type;
            if (digit) btn.setAttribute('aria-keyshortcuts', digit);
            btn.innerHTML = `<span class="cmd-ft__sw"></span><span class="cmd-ft__name">${style.label}</span>${badge}`;
            const sw = btn.querySelector<HTMLElement>('.cmd-ft__sw')!;
            sw.style.background = style.fill;
            sw.style.borderColor = style.outline;
            // Armed → type for the next shape; else retype the selection or
            // set the draw type (DrawToolService.chooseType).
            btn.onclick = () => {
                this.tool.chooseType(type);
                close();
            };
            track(effect(() => {
                const drawing = this.tool.state.isDrawing.get();
                const multi = this.features.selectedIds.get().size > 1;
                const selected = this.features.selected.get();
                const current = drawing ? this.tool.drawType.get()
                    : multi ? null : selected ? selected.type : this.tool.drawType.get();
                btn.setAttribute('aria-selected', String(current === type));
            }));

            // Per-type visibility toggle (re-homed from the old draw panel's
            // type grid). stopPropagation so it never also selects the type;
            // hidden types render dimmed + eye-off.
            const eye = document.createElement('button');
            eye.type = 'button';
            eye.className = 'cmd-ft-eye';
            // Alt-click solos the type (a second Alt-click restores).
            eye.onclick = (e) => {
                e.stopPropagation();
                if (e.altKey) this.features.soloType(type);
                else this.features.toggleTypeVisibility(type);
            };
            track(effect(() => {
                const hidden = this.features.hiddenTypes.get().has(type);
                eye.innerHTML = icon(hidden ? 'eye-off' : 'eye', 16);
                eye.title = hidden ? `Show ${style.label}` : `Hide ${style.label}`;
                eye.setAttribute('aria-label', eye.title);
                eye.setAttribute('aria-pressed', String(hidden));
                row.classList.toggle('is-hidden', hidden);
            }));

            row.appendChild(btn);
            row.appendChild(eye);
            grid.appendChild(row);
        }
    }

    /**
     * Vegetation mode's type picker: the course's zone types. A pick sets
     * the next zone's type, or retypes the selected zones
     * (`DrawToolService.chooseZoneType`). The footer opens the zone-type
     * table editor.
     */
    private buildZoneTypePanel(host: HTMLElement, track: (d: () => void) => void, close: () => void): void {
        host.innerHTML = `<div class="cmdbar__ft-title">Zone type</div><div class="cmdbar__ft-grid" data-k="grid"></div>`
            + `<div class="cmdbar__ft-title">Trees</div><div class="cmdbar__ft-grid" data-k="trees"></div>`
            + `<div class="cmd-ft-policy"><button type="button" class="cmd-zt-edit" data-k="edit" data-testid="zone-types-edit-btn">`
            + `${icon('layers', 16)}<span>Edit zone types…</span></button>`
            + `<button type="button" class="cmd-zt-edit" data-k="rules" data-testid="planting-rules-btn" title="How the grass, ground plants and trees are planted now">`
            + `${icon('info', 16)}<span>Planting rules…</span></button>`
            + `<button type="button" class="cmd-zt-edit" data-k="photo" data-testid="photo-stems-btn" title="Young trees on open ground the lidar missed, found from their shadows in the summer photo">`
            + `${icon('tree-pine', 16)}<span>Trees in photo…</span></button></div>`;
        const grid = host.querySelector<HTMLElement>('[data-k="grid"]')!;
        // A tree species area: the species mix the Unity tree planter uses inside it.
        const treeArea = document.createElement('button');
        treeArea.type = 'button';
        treeArea.className = 'cmd-ft';
        treeArea.title = 'Draw an area whose trees take their own species mix (e.g. almost only oaks)';
        treeArea.dataset.testid = 'tree-area-pick';
        treeArea.innerHTML = `<span class="cmd-ft__sw"></span><span class="cmd-ft__name"></span>`;
        const treeSw = treeArea.querySelector<HTMLElement>('.cmd-ft__sw')!;
        treeSw.style.background = FEATURE_STYLES.tree_area.fill;
        treeSw.style.borderColor = FEATURE_STYLES.tree_area.outline;
        treeArea.querySelector<HTMLElement>('.cmd-ft__name')!.textContent = FEATURE_STYLES.tree_area.label;
        treeArea.onclick = () => {
            this.tool.chooseTreeArea();
            close();
        };
        track(effect(() => treeArea.setAttribute('aria-selected', String(this.triggerZoneType() === TREE_AREA_PICK))));
        host.querySelector<HTMLElement>('[data-k="trees"]')!.appendChild(treeArea);
        const edit = host.querySelector<HTMLButtonElement>('[data-k="edit"]')!;
        edit.onclick = () => {
            const course = this.svc.course.peek();
            close();
            if (course) void this.zoneTypesSvc.openFor(course.id);
        };
        host.querySelector<HTMLButtonElement>('[data-k="rules"]')!.onclick = () => {
            const course = this.svc.course.peek();
            close();
            if (course) void this.vegetationRulesSvc.openFor(course.id);
        };
        host.querySelector<HTMLButtonElement>('[data-k="photo"]')!.onclick = () => {
            const course = this.svc.course.peek();
            close();
            if (course) this.photoStemsSvc.open(course.id);
        };
        track(effect(() => {
            const types = this.zoneTypesSvc.items.get();
            grid.textContent = '';
            if (types.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'cmd-zt-empty';
                empty.textContent = 'No zone types yet — add them with Edit zone types.';
                grid.appendChild(empty);
                return;
            }
            for (const zoneType of types) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'cmd-ft';
                btn.title = zoneType.name;
                btn.dataset.zoneType = zoneType.key;
                btn.innerHTML = `<span class="cmd-ft__sw"></span><span class="cmd-ft__name"></span>`;
                const sw = btn.querySelector<HTMLElement>('.cmd-ft__sw')!;
                sw.style.background = zoneType.color;
                sw.style.borderColor = FEATURE_STYLES.vegetation_zone.outline;
                btn.querySelector<HTMLElement>('.cmd-ft__name')!.textContent = zoneType.name;
                btn.onclick = () => {
                    this.tool.chooseZoneType(zoneType.key);
                    close();
                };
                track(effect(() => btn.setAttribute('aria-selected', String(this.triggerZoneType() === zoneType.key))));
                grid.appendChild(btn);
            }
        }));
    }

    // ── Zone 4: autosave pill + failure toast (Create) ────────────────────

    /** Current pill state; exposed for tests through `data-state`. */
    private readonly saveState = new Signal<SaveState>('idle');
    private savedTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Derive the pill state from FeaturesService `pendingSaves` / `saveError`.
     * `pendingSaves` counts debounced patches as well as requests in flight,
     * so a geometry patch reads Saving from the edit. A failed save makes the
     * service reload, which reverts the edit; the toast says so once per
     * transition into failed.
     */
    private buildSaveState(host: HTMLElement, toastHost: HTMLElement): void {
        const toast = this.spawn(ToastComponent, toastHost);
        const clearSaved = () => {
            if (this.savedTimer) clearTimeout(this.savedTimer);
            this.savedTimer = null;
        };
        this.track(clearSaved);

        const popover = this.spawn(PopoverComponent, host, {
            align: 'right',
            ariaLabel: 'Save status',
            triggerClassName: 'cmdbar__save',
            panelClassName: 'cmdbar__save-panel',
            trigger: (h, ctx) => {
                h.dataset.testid = 'save-pill';
                h.innerHTML = '<span class="cmdbar__save-dot"></span><span data-k="label"></span>'
                    + '<span class="cmdbar__save-code" data-k="code"></span>';
                const label = h.querySelector<HTMLElement>('[data-k="label"]')!;
                const code = h.querySelector<HTMLElement>('[data-k="code"]')!;
                ctx.track(effect(() => {
                    const state = this.saveState.get();
                    const err = this.features.saveError.get();
                    h.dataset.state = state;
                    h.tabIndex = state === 'failed' ? 0 : -1;
                    h.setAttribute('aria-disabled', String(state !== 'failed'));
                    label.textContent = state === 'saving' ? 'Saving'
                        : state === 'saved' ? 'Saved'
                        : state === 'failed' ? 'Not saved' : '';
                    code.textContent = state === 'failed' && err ? err.code : '';
                    h.title = state === 'failed' ? 'Save failed. Click for details.'
                        : state === 'idle' ? 'All changes saved' : '';
                }));
            },
            panel: (h, ctx) => this.buildSavePanel(h, ctx.track, ctx.close),
        });

        this.track(effect(() => {
            const saving = this.features.pendingSaves.get() > 0;
            const err = this.features.saveError.get();
            untrack(() => {
                const prev = this.saveState.peek();
                let next: SaveState;
                if (err) next = 'failed';
                else if (saving) next = 'saving';
                else if (prev === 'saving') next = 'saved';
                else if (prev === 'failed') next = 'idle';
                else next = prev;
                if (next === prev) return;
                clearSaved();
                if (next === 'saved') {
                    this.savedTimer = setTimeout(() => {
                        this.savedTimer = null;
                        if (this.saveState.peek() === 'saved') this.saveState.set('idle');
                    }, SAVED_MS);
                }
                if (next === 'failed') {
                    toast.show({ text: 'Save failed. Latest edit was reverted.', code: err!.code, tone: 'negative' });
                } else {
                    popover.close();
                }
                this.saveState.set(next);
            });
        }));
    }

    private buildSavePanel(host: HTMLElement, track: (d: () => void) => void, close: () => void): void {
        host.innerHTML = '<div class="cmd-save">'
            + '<div class="cmd-save__title">Save failed</div>'
            + '<div class="cmd-save__msg" data-k="msg"></div>'
            + '<div class="cmd-save__code" data-k="code"></div>'
            + '<div class="cmd-save__msg">The latest edit was reverted to the server copy. Retry re-syncs features from the server.</div>'
            + '<div class="cmd-save__actions">'
            + '<button type="button" class="cmd-save__dismiss" data-testid="save-dismiss">Dismiss</button>'
            + '<button type="button" class="cmd-save__retry" data-testid="save-retry">Retry</button>'
            + '</div></div>';
        const msg = host.querySelector<HTMLElement>('[data-k="msg"]')!;
        const code = host.querySelector<HTMLElement>('[data-k="code"]')!;
        const retry = host.querySelector<HTMLButtonElement>('[data-testid="save-retry"]')!;
        const dismiss = host.querySelector<HTMLButtonElement>('[data-testid="save-dismiss"]')!;
        dismiss.onclick = () => {
            this.features.clearSaveError();
            close();
        };
        track(effect(() => {
            const err = this.features.saveError.get();
            msg.textContent = err?.message ?? '';
            code.textContent = err ? `code ${err.code}` : '';
        }));
        retry.onclick = async () => {
            retry.disabled = true;
            try {
                await this.retrySave();
            } finally {
                retry.disabled = false;
            }
            if (this.saveState.peek() !== 'failed') close();
        };
    }

    /**
     * Retry after a failed save: land anything still queued, then re-sync
     * the store from the server. `reload()` clears the failure once the
     * re-sync worked. The failed patch itself is gone (the service dropped it
     * on resync), so there is nothing to resend.
     */
    private async retrySave(): Promise<void> {
        await this.features.flush();
        await this.features.reload();
    }

    // ── Zone 1: (i) info popover ──────────────────────────────────────────

    private buildInfoPanel(host: HTMLElement, track: (d: () => void) => void): void {
        host.innerHTML = `
            <div class="cmd-info">
                <div class="cmd-info__row"><span class="cmd-info__k">Revision</span><span class="cmd-info__v" data-k="rev"></span></div>
                <div class="cmd-info__row"><span class="cmd-info__k">Holes</span><span class="cmd-info__v" data-k="holes"></span></div>
                <div class="cmd-info__row"><span class="cmd-info__k">Total par</span><span class="cmd-info__v" data-k="par"></span></div>
                <div class="cmd-info__div"></div>
                <div data-k="geo"></div>
            </div>`;
        const rev = host.querySelector<HTMLElement>('[data-k="rev"]')!;
        const holes = host.querySelector<HTMLElement>('[data-k="holes"]')!;
        const par = host.querySelector<HTMLElement>('[data-k="par"]')!;
        const geo = host.querySelector<HTMLElement>('[data-k="geo"]')!;

        track(effect(() => {
            const course = this.svc.course.get();
            rev.textContent = course ? `rev ${course.revision}` : '—';
        }));
        track(effect(() => { holes.textContent = String(this.svc.holes.get().length); }));
        track(effect(() => { par.textContent = String(this.svc.totalPar.get()); }));
        track(effect(() => {
            const course = this.svc.course.get();
            const georeferenced = !!course?.georeferenceJson;
            geo.textContent = '';
            if (georeferenced) {
                geo.className = 'cmd-info__geo--ok';
                geo.innerHTML = `${icon('check', 16)}<span>Georeferenced</span>`;
                return;
            }
            geo.className = 'cmd-info__geo--warn';
            geo.innerHTML = `<div class="cmd-info__geo-row">${icon('triangle-alert', 16)}<span>No georeference</span></div>`;
            // Setting the georeference means running the map-build wizard —
            // builder only. Serve mode states the fact without the dead end.
            if (!this.serverMode.isBuilder()) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cmd-info__geo-btn';
            btn.textContent = 'Set georeference';
            btn.onclick = () => {
                const { courseId } = this.params.peek();
                if (courseId) this.router.navigate(`/set-area/${courseId}`);
            };
            geo.appendChild(btn);
        }));
    }

    // ── Zone 4: actions + avatar ──────────────────────────────────────────

    private buildActionsPanel(host: HTMLElement, track: (d: () => void) => void, close: () => void): void {
        // Import SVG — Create only (matches today's availability), and builder
        // only: both importers author geometry, and the lidar entry below calls
        // a builder-only API that 404s on the VPS.
        if (this.props.mode === 'create' && this.serverMode.isBuilder()) {
            const importBtn = document.createElement('button');
            importBtn.type = 'button';
            importBtn.className = 'menu-item';
            importBtn.dataset.testid = 'course-import-svg-btn';
            importBtn.innerHTML = `<span class="menu-item__icon">${icon('upload', 16)}</span><span class="menu-item__label">Import SVG</span>`;
            importBtn.onclick = () => {
                const course = this.svc.course.peek();
                if (course) this.importSvc.openFor(course.id, boundsFromGeoreference(course.georeferenceJson));
                close();
            };
            host.appendChild(importBtn);

            // Import GeoJSON — the draft-import wizard for pipeline output
            // (fetch-water / fetch-osm / detect-trees), EPSG:3006 only.
            const geojsonBtn = document.createElement('button');
            geojsonBtn.type = 'button';
            geojsonBtn.className = 'menu-item';
            geojsonBtn.dataset.testid = 'course-import-geojson-btn';
            geojsonBtn.innerHTML = `<span class="menu-item__icon">${icon('upload', 16)}</span><span class="menu-item__label">Import GeoJSON</span>`;
            geojsonBtn.onclick = () => {
                const course = this.svc.course.peek();
                if (course) this.geojsonImportSvc.openFor(course.id);
                close();
            };
            host.appendChild(geojsonBtn);

            // Delete lidar files — the .laz sources kept after a map build are
            // multi-use (detect-trees/water) but large; this frees them per
            // course on explicit action. Shown only when files exist; the label
            // names the reclaimable size, and the delete is confirmed first.
            this.mountDeleteLidar(host, close);

            // Regenerate trees — re-runs the lidar canopy tiling, the stem
            // detector and the woodland-floor stands against the persisted
            // lidar + DEM (a server job, same plumbing as re-terrain). Needs
            // the lidar files to still exist.
            const treesBtn = document.createElement('button');
            treesBtn.type = 'button';
            treesBtn.className = 'menu-item';
            treesBtn.dataset.testid = 'course-regenerate-trees-btn';
            treesBtn.innerHTML = `<span class="menu-item__icon">${icon('tree-pine', 16)}</span><span class="menu-item__label">Regenerate trees</span>`;
            treesBtn.onclick = () => {
                const course = this.svc.course.peek();
                close();
                if (course) void this.confirmRegenerateTrees(course.id);
            };
            host.appendChild(treesBtn);

            // GSPro… — the status board (one row per target, every single-file
            // export behind a row's "…"). The same dialog the bar's GSPro
            // button opens; the panel bridges the two services, so opening
            // either half opens the other.
            const gsproBtn = document.createElement('button');
            gsproBtn.type = 'button';
            gsproBtn.className = 'menu-item';
            gsproBtn.dataset.testid = 'course-export-gspro-btn';
            const stale = this.gsproSync.staleCount.peek();
            gsproBtn.innerHTML = `<span class="menu-item__icon">${icon('layers', 16)}</span>`
                + `<span class="menu-item__label">GSPro…${stale > 0 ? ` (${stale} stale)` : ''}</span>`;
            gsproBtn.onclick = () => {
                const course = this.svc.course.peek();
                close();
                if (course) void this.gsproSync.openFor(course.id);
            };
            host.appendChild(gsproBtn);

            const divider = document.createElement('div');
            divider.className = 'menu-divider';
            host.appendChild(divider);
        }

        // Publish revision — same ConfirmService + publish flow as the old
        // header. Builder only: the courses API is mounted in serve mode, so
        // this button really would bump the revision on the VPS — but a
        // revision is an AUTHORING act (it tells devices to re-sync), and on a
        // serve box the authored truth arrives by publish/ingest from the
        // builder. Bumping it here would desync the two.
        if (!this.serverMode.isBuilder()) return;
        const publishBtn = document.createElement('button');
        publishBtn.type = 'button';
        publishBtn.className = 'menu-item cmd-menu-accent';
        publishBtn.innerHTML = `<span class="menu-item__icon cmd-menu-accent__sw"></span><span class="menu-item__label">Publish revision</span>`;
        publishBtn.onclick = async () => {
            const course = this.svc.course.peek();
            close();
            if (!course) return;
            // T49: ODbL is surfaced, never a publish blocker — a course with
            // any OSM-derived feature publishes its map data under ODbL.
            const odbl = this.features.hasOdblFeatures.peek();
            const ok = await this.confirm.confirm({
                title: `Publish ${course.name}?`,
                body: `Publishing bumps revision ${course.revision} to ${course.revision + 1} for device sync.`,
                detail: 'Players already on the course keep their current local copy until they refresh.'
                    + (odbl ? ' This course contains OpenStreetMap-derived features, so its map data is published under the ODbL license with "© OpenStreetMap contributors" attribution.' : ''),
                confirmLabel: 'Publish course',
                cancelLabel: 'Keep editing',
                tone: 'primary',
                layout: 'review',
            });
            if (ok) void this.svc.publish();
        };
        track(effect(() => {
            const disabled = this.svc.publishing.get() || !this.svc.course.get();
            publishBtn.disabled = disabled;
        }));
        host.appendChild(publishBtn);

        // Publish to VPS — ships the site's built bundle to the serve box
        // (tiles, content, analysis DEM), so the phone can download the
        // course. The UI face of `bun run publish` (T59); builder only, same
        // guard as Publish revision above.
        this.mountPublishToVps(host, track, close);
    }

    /**
     * "Publish to VPS" actions-menu row. Label reflects the live run state
     * (step while running); clicking when unconfigured explains the env setup
     * instead of failing. Result (success/failure + warnings) is reported via
     * ConfirmService once the run reaches a terminal state — the menu itself
     * is long closed by then.
     */
    private mountPublishToVps(host: HTMLElement, track: (d: () => void) => void, close: () => void): void {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-item';
        btn.dataset.testid = 'course-publish-vps-btn';
        host.appendChild(btn);

        // Preseed configured/running state on first menu open (the panel is
        // built lazily). Not re-run on later opens: this tab's own runs update
        // `state` through run()'s polling while the menu is closed.
        void this.publishVps.refresh();

        track(effect(() => {
            const state = this.publishVps.state.get();
            const running = state?.status === 'running';
            const label = running
                ? `Publishing to VPS — ${state?.step ? PUBLISH_STEP_LABELS[state.step] : 'finishing'}…`
                : 'Publish to VPS';
            btn.innerHTML = `<span class="menu-item__icon">${icon(running ? 'loader-circle' : 'arrow-up-to-line', 16)}</span>`
                + `<span class="menu-item__label">${label}</span>`;
            btn.disabled = running;
        }));

        btn.onclick = async () => {
            const course = this.svc.course.peek();
            close();
            if (!course) return;

            const state = this.publishVps.state.peek() ?? await this.publishVps.refresh();
            if (state && !state.configured) {
                await this.confirm.confirm({
                    title: 'Publishing is not configured',
                    body: 'This builder has no publish target.',
                    detail: 'Set PUBLISH_URL and PUBLISH_TOKEN in the server environment and restart it. See docs/reference/vps-serve-runbook.md.',
                    confirmLabel: 'OK',
                    tone: 'primary',
                });
                return;
            }

            const target = state?.targetUrl ? ` to ${state.targetUrl}` : ' to the VPS';
            const ok = await this.confirm.confirm({
                title: `Publish ${course.name}${target}?`,
                body: 'This uploads the built course bundle (map tiles, holes and features, analysis DEM) and swaps it in atomically on the serve box.',
                detail: 'User data on the VPS (rounds, plans, calibration, pins) is never touched. Devices download the update from the course list.',
                confirmLabel: 'Publish to VPS',
                cancelLabel: 'Not now',
                tone: 'primary',
                layout: 'review',
            });
            if (!ok) return;

            let result: PublishState;
            try {
                result = await this.publishVps.run(course.id);
            } catch (err) {
                await this.confirm.confirm({
                    title: 'Publish failed to start',
                    body: err instanceof Error ? err.message : String(err),
                    confirmLabel: 'OK',
                    tone: 'danger',
                });
                return;
            }
            const warnings = result.warnings.length
                ? ` Warnings: ${result.warnings.join(' — ')}`
                : '';
            if (result.status === 'succeeded') {
                const size = result.bundleBytes !== null ? formatBytes(result.bundleBytes) : 'unknown size';
                await this.confirm.confirm({
                    title: 'Published to VPS',
                    body: `${course.name} is live (bundle ${size}).`,
                    detail: `Open the course list on your phone and download (or re-download) the course.${warnings}`,
                    confirmLabel: 'Done',
                    tone: 'primary',
                });
            } else {
                await this.confirm.confirm({
                    title: 'Publish failed',
                    body: result.error ?? 'Unknown error — check the server log.',
                    detail: warnings || undefined,
                    confirmLabel: 'OK',
                    tone: 'danger',
                });
            }
        };
    }

    /**
     * "Delete lidar files (X.X GB)" — appended into the actions menu only when
     * the course has persisted .laz sources. Fetches lidar info on menu open;
     * the button lands hidden and reveals itself (or removes itself) once the
     * size is known, so it never flashes an empty/loading state.
     */
    private mountDeleteLidar(host: HTMLElement, close: () => void): void {
        const course = this.svc.course.peek();
        if (!course) return;
        const courseId = course.id;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-item';
        btn.dataset.testid = 'course-delete-lidar-btn';
        btn.style.display = 'none';
        host.appendChild(btn);

        void this.mapBuild.lidarInfo(courseId).then((info) => {
            if (info.files.length === 0) {
                btn.remove();
                return;
            }
            const size = formatBytes(info.totalBytes);
            btn.innerHTML = `<span class="menu-item__icon">${icon('trash-2', 16)}</span>`
                + `<span class="menu-item__label">Delete lidar files (${size})</span>`;
            btn.style.display = '';
            btn.onclick = () => {
                close();
                void this.confirmDeleteLidar(courseId, info.files.length, size);
            };
        }).catch(() => {
            btn.remove(); // info fetch failed — leave the menu unchanged
        });
    }

    /** Confirm, delete, then report the result as a notice (house ConfirmService). */
    private async confirmDeleteLidar(courseId: string, fileCount: number, size: string): Promise<void> {
        const ok = await this.confirm.confirm({
            title: 'Delete lidar files?',
            body: `This permanently removes the ${fileCount} downloaded lidar (.laz) file${fileCount === 1 ? '' : 's'} for this course, freeing ${size}.`,
            detail: 'The built map (terrain, hillshade, DEM) is unaffected. Re-fetching the lidar means rebuilding the map from Lantmäteriet.',
            confirmLabel: 'Delete lidar files',
            cancelLabel: 'Keep files',
            tone: 'danger',
        });
        if (!ok) return;
        try {
            const { freedBytes } = await this.mapBuild.deleteLidar(courseId);
            await this.confirm.confirm({
                title: 'Lidar files deleted',
                body: `Freed ${formatBytes(freedBytes)}.`,
                confirmLabel: 'Done',
                cancelLabel: 'Close',
                tone: 'primary',
            });
        } catch (e) {
            await this.confirm.confirm({
                title: 'Could not delete lidar files',
                body: e instanceof Error ? e.message : String(e),
                confirmLabel: 'OK',
                cancelLabel: 'Close',
                tone: 'warning',
            });
        }
    }

    /**
     * Confirm, run the tree-regeneration job, then reload the tileset so the
     * canvas re-inits against the new manifest `generatedAt` (canopy tiles
     * carry immutable cache headers; the stems asset URL carries `?v=`).
     * The camera is restored after the re-init (terrain-edit pattern).
     */
    private async confirmRegenerateTrees(courseId: string): Promise<void> {
        const ok = await this.confirm.confirm({
            title: 'Regenerate trees?',
            body: 'Rebuilds the canopy layers, the individual tree stems and the woodland-floor zones from the stored lidar and DEM.',
            detail: 'Takes a few minutes for a full course. Tree polygons are written to the site sources as trees.geojson for Import GeoJSON; existing tree features are not changed. The lidar woodland-floor zones (one per closed stand) are replaced, including any you deleted.',
            confirmLabel: 'Regenerate trees',
            cancelLabel: 'Cancel',
            tone: 'primary',
        });
        if (!ok) return;
        try {
            const job = await this.mapBuild.regenerateTrees(courseId);
            if (job.status !== 'succeeded') throw new Error(job.error ?? 'unknown error');
            await this.reloadTilesKeepingCamera(courseId);
            await this.features.reloadOrLoad(courseId);
            const count = this.tileset.manifest.peek()?.assets?.['tree-stems']?.count;
            const stands = this.features.store.items.peek().filter((f) => f.source === 'lidar-woodland').length;
            await this.confirm.confirm({
                title: 'Trees regenerated',
                body: (count !== undefined ? `${count.toLocaleString()} tree stems detected` : 'Canopy layers and tree stems rebuilt')
                    + `, ${stands} woodland-floor zone${stands === 1 ? '' : 's'}.`,
                confirmLabel: 'Done',
                cancelLabel: 'Close',
                tone: 'primary',
            });
        } catch (e) {
            await this.confirm.confirm({
                title: 'Could not regenerate trees',
                body: e instanceof Error ? e.message : String(e),
                confirmLabel: 'OK',
                cancelLabel: 'Close',
                tone: 'warning',
            });
        }
    }

    /**
     * One target's whole chain through the status board
     * (`GsproSyncService.update`: the files, both terrains and the push into
     * the open Unity editor), then what each target in the job reported. The
     * board re-reads itself at the end of the run, so the stale count follows.
     */
    private async runSyncUpdate(courseId: string, id: GsproTargetId): Promise<void> {
        const target = gsproTarget(id);
        const before = this.gsproSync.job.peek()?.id ?? null;
        const ok = await this.gsproSync.update(courseId, id);
        const job = this.gsproSync.job.peek();
        // A refused update (blocked, or another run holds the board) leaves the
        // job of that other run in hand: its results are not this dialog's.
        const mine = job !== null && (ok || job.id !== before);
        const results = mine ? job!.results : [];
        const report = results.flatMap(r => [
            ...(results.length > 1 ? [`${r.label}:`] : []),
            ...r.report,
            ...(r.error ? [`error: ${r.error}`] : []),
        ]);
        const body = ok
            ? [
                target.manual ? `Then: ${target.manual}.` : '',
                needsSceneSave(report, job?.phases ?? null) ? 'Save the scene in Unity to keep it.' : '',
            ].filter(Boolean).join(' ') || `${target.label} is up to date in GSPro.`
            : this.gsproSync.error.peek() || (mine ? job!.error : null) || 'The update failed.';
        // Stopped by the SVG checks: the dialog offers the Check shapes panel.
        const svgErrors = !ok && (isSvgCheckError(body) || results.some(r => isSvgCheckError(r.error)));
        const confirmed = await this.confirm.confirm({
            title: ok ? `${target.label} updated` : `Could not update the ${lower(target.label)}`,
            body,
            detail: report.length > 0 ? report.join('\n') : undefined,
            confirmLabel: ok ? 'Done' : svgErrors ? 'Open errors' : 'OK', cancelLabel: 'Close',
            tone: ok ? 'primary' : 'warning',
            layout: report.length > 3 ? 'review' : 'default',
        });
        if (svgErrors && confirmed) this.svgCheck.open(courseId);
    }

    /**
     * The photo, once the Clean tool's painting has reached the photo file:
     * the chain renders the cleaned photo from the file, so a stroke still in
     * the save queue would not be in it. A failed save stops the update — the
     * save has to be retried first (clean-tool.service.ts, `settled`).
     */
    private async updatePhoto(courseId: string): Promise<void> {
        await this.clean.settled();
        if (this.clean.saveState.peek() === 'error') {
            await this.confirm.confirm({
                title: 'Could not update the photo',
                body: 'Some changes are not saved yet: retry the save in the Clean panel first.',
                detail: this.clean.saveError.peek() ?? undefined,
                confirmLabel: 'OK', cancelLabel: 'Close', tone: 'warning',
            });
            return;
        }
        await this.runSyncUpdate(courseId, 'photo');
    }

    /**
     * One feature's meshes: the shaping job the Terrain editor's Shape section
     * used to run (`ShapingService.apply` with the selection as its scope —
     * the server re-shapes only the meshes whose ops changed). The Terrain
     * editor's panel shows the phases live while it runs; this is the outcome.
     */
    private async updateMeshesForFeatures(courseId: string, ids: readonly string[]): Promise<void> {
        if (ids.length === 0) return;
        const job = await this.shaping.apply(courseId, ids.join(','));
        if (!job || job.status !== 'succeeded' || !job.result) {
            await this.confirm.confirm({
                title: 'Could not update the meshes',
                body: job?.error ?? this.shaping.jobError.peek() ?? 'The job failed.',
                detail: job?.phases.filter(p => p.status !== 'pending').map(p => `${p.label}: ${p.status}${p.detail ? ` - ${p.detail}` : ''}`).join('\n'),
                confirmLabel: 'OK', cancelLabel: 'Close', tone: 'warning',
            });
            return;
        }
        const r = job.result;
        const unity = job.phases.find(p => p.id === 'unity');
        const report = [
            `Blender: ${r.changedObjects.length} object(s) re-shaped${r.removed.length ? `, ${r.removed.length} removed` : ''}`,
            ...(r.changedObjects.length > 0 ? [r.changedObjects.join(', ')] : []),
            `Unity: ${unity?.detail ?? unity?.status ?? 'not run'}`,
            ...r.warnings.map(w => (w.startsWith('warning:') ? w : `warning: ${w}`)),
        ];
        const nothing = r.changedObjects.length === 0 && r.removed.length === 0;
        await this.confirm.confirm({
            title: nothing ? 'Nothing to re-shape' : 'Meshes updated',
            body: nothing
                ? 'The meshes already match this feature\'s recipe and outline.'
                : [r.unityError ? `Unity: ${r.unityError}` : '', needsSceneSave(report, job.phases) ? 'Save the scene in Unity to keep it.' : '']
                    .filter(Boolean).join(' ') || 'Done.',
            detail: report.join('\n'),
            confirmLabel: 'Done', cancelLabel: 'Close',
            tone: !nothing && !r.unityError && r.warnings.length === 0 ? 'primary' : 'warning',
            layout: report.length > 3 ? 'review' : 'default',
        });
        await this.gsproSync.refresh(courseId);
    }

    /** The roads and paths in the selection ("Update paths" shows with one). */
    private selectedPathCount(): number {
        return this.features.selectedFeatures.get().filter(f => f.type === 'path').length;
    }

    /** The running shaping job's phase, for the buttons that run one ("Blender sync…"). */
    private shapingStep(fallback: string): string {
        const job = this.shaping.job.get();
        if (job?.queued) return 'Waiting for Blender…';
        const phase = job?.phases.find(p => p.id === job.phase);
        return `${phase?.label ?? fallback}…`;
    }

    /** The running paths job's phase for the button ("Blender sync…"). */
    private pathsStep(): string {
        return this.shapingStep('Updating paths');
    }

    /**
     * The path surfaces through Blender into Unity (ShapingService.apply with
     * `paths`), then what happened: which roads changed surface, what Blender
     * re-shaped, the surfaces Unity gave the path meshes, and the warnings.
     * No confirm first: it only carries through what the paths already say.
     */
    private async updatePathsInUnity(courseId: string): Promise<void> {
        const job: ShapingJob | null = await this.shaping.apply(courseId, null, { paths: true });
        if (!job || job.status !== 'succeeded' || !job.result) {
            await this.confirm.confirm({
                title: 'Could not update the paths',
                body: job?.error ?? this.shaping.jobError.peek() ?? 'The job failed.',
                detail: job?.phases.filter(p => p.status !== 'pending').map(p => `${p.label}: ${p.status}${p.detail ? ` - ${p.detail}` : ''}`).join('\n'),
                confirmLabel: 'OK', cancelLabel: 'Close', tone: 'warning',
            });
            return;
        }
        const r = job.result;
        const unity = job.phases.find(p => p.id === 'unity');
        const intoUnity = r.pathMaterials != null;
        const perSurface = Object.entries((r.pathMaterials as { meshesPerSurface?: Record<string, number> } | null)?.meshesPerSurface ?? {});
        const report = [
            ...r.pathSurfaces.slice(1).filter(l => !l.startsWith('warning:')),
            `Blender: ${r.changedObjects.length} object(s) re-shaped${r.removed.length ? `, ${r.removed.length} removed` : ''}`,
            `Unity: ${unity?.detail ?? unity?.status ?? 'not run'}`,
            ...(perSurface.length ? [`Path meshes: ${perSurface.map(([surface, n]) => `${surface} ${n}`).join(', ')}`] : []),
            ...r.warnings.map(w => (w.startsWith('warning:') ? w : `warning: ${w}`)),
        ];
        // What a surfaces-only update cannot carry: a moved outline, a grass track made a hard path (or back), a new road.
        const needsBuild = r.pathSurfaces.some(l => l.startsWith('warning:'));
        const save = needsSceneSave(report, job.phases) ? ' Save the scene in Unity to keep it.' : '';
        await this.confirm.confirm({
            title: !intoUnity ? 'Paths not in Unity yet' : needsBuild ? 'Paths updated, but some changes need a new build' : 'Paths updated in Unity',
            body: !intoUnity ? (r.unityError ?? 'Unity did not take them - see below.')
                : needsBuild ? `Some changes cannot reach the meshes without the SVG export and the OPCD build (see the warnings). The rest is in Unity.${save}`
                    : (save.trim() || 'The paths are in Unity.'),
            detail: report.join('\n'),
            confirmLabel: 'Done', cancelLabel: 'Close',
            tone: intoUnity && r.warnings.length === 0 ? 'primary' : 'warning',
            layout: report.length > 3 ? 'review' : 'default',
        });
        await this.gsproSync.refresh(courseId);
    }

    /** The vegetation zones in the selection (the ids "Update N zones" sends). */
    private selectedZoneIds(): string[] {
        return this.features.selectedFeatures.get().filter(f => f.type === 'vegetation_zone').map(f => f.id);
    }

    /** No confirm first: it only redoes what the selected zones already say, in their area. */
    private async updateZonesInUnity(courseId: string, zoneIds: string[]): Promise<void> {
        let job: Awaited<ReturnType<PlantVegetationService['update']>>;
        try {
            job = await this.plant.update(courseId, zoneIds);
        } catch (e) {
            await this.confirm.confirm({
                title: 'Could not update the zones',
                body: e instanceof Error ? e.message : String(e),
                confirmLabel: 'OK', cancelLabel: 'Close', tone: 'warning',
            });
            return;
        }
        const report = job.result?.report ?? [];
        const ok = job.status === 'succeeded';
        // The quick path cannot do these zones (a new zone type, a generated
        // zone gone): the server says so instead of running the whole planting
        // behind the operator's back.
        const needs = ok ? needsPlanting(job.result) : null;
        if (needs) {
            const go = await this.confirm.confirm({
                title: 'These zones need Update vegetation',
                body: `${needs} This needs Update vegetation: the generated zones are replaced (the zones you drew are kept), `
                    + 'every generator runs again and the whole masks and Arborist file are written.',
                detail: report.length > 0 ? report.join('\n') : undefined,
                confirmLabel: 'Update vegetation', cancelLabel: 'Cancel', tone: 'primary',
            });
            if (go) await this.runPlantVegetation(courseId);
            else await this.gsproSync.refresh(courseId);
            return;
        }
        const intoUnity = pushedIntoUnity(report);
        const save = needsSceneSave(report) ? ', save the scene to keep it' : '';
        await this.confirm.confirm({
            title: ok ? (intoUnity ? 'Zones updated' : 'Nothing to update') : 'Could not update the zones',
            body: ok
                ? (intoUnity ? `Unity: updated${save}. ${arboristOutcome(report)}` : 'The masks already match these zones.')
                : job.error ?? 'The job failed.',
            detail: report.join('\n'),
            confirmLabel: ok ? 'Done' : 'OK', cancelLabel: 'Close',
            tone: ok && !report.some(l => l.includes(': skipped - ') || l.startsWith('warning:')) ? 'primary' : 'warning',
            layout: report.length > 3 ? 'review' : 'default',
        });
        await this.gsproSync.refresh(courseId);
    }

    /**
     * Confirm, run the planting job (PlantVegetationService), reload the
     * features so the regenerated zones show, and put the job's report up:
     * what each generator planted, the zones export, what Unity did and what
     * went into the Arborist file.
     */
    private async confirmPlantVegetation(courseId: string): Promise<void> {
        const ok = await this.confirm.confirm({
            title: 'Update the vegetation?',
            body: "Regenerates the tall rough and the creek and pond banks from the course as drawn now (your zones, the creeks and ponds with bank vegetation), exports the zones, imports them into the course's open Unity project and writes the Arborist file in the GSPro course folder.",
            detail: 'Takes a minute or two. Generated zones are replaced; the zones you drew are kept. Without Unity open the zones are exported and the Arborist file gets its lower vegetation only: its trees come from the Unity scene.',
            confirmLabel: 'Update vegetation',
            cancelLabel: 'Cancel',
            tone: 'primary',
        });
        if (!ok) return;
        await this.runPlantVegetation(courseId);
    }

    /**
     * The planting itself, without the question: also what "Update N zones"
     * falls back to when the quick path cannot do those zones.
     */
    private async runPlantVegetation(courseId: string): Promise<void> {
        let job: Awaited<ReturnType<PlantVegetationService['plant']>>;
        try {
            job = await this.plant.plant(courseId);
        } catch (e) {
            await this.confirm.confirm({
                title: 'Could not update the vegetation',
                body: e instanceof Error ? e.message : String(e),
                confirmLabel: 'OK', cancelLabel: 'Close', tone: 'warning',
            });
            return;
        }
        await this.features.reloadOrLoad(courseId);
        const report = job.result?.report ?? [];
        const intoUnity = pushedIntoUnity(report);
        const save = needsSceneSave(report) ? ', save the scene to keep it' : '';
        await this.confirm.confirm({
            title: job.status === 'succeeded' ? 'Vegetation updated' : 'Could not update the vegetation',
            body: job.status === 'succeeded'
                ? `${intoUnity ? `Unity: planted${save}.` : 'Unity: not open, zones exported only.'} ${arboristOutcome(report)}`
                : job.error ?? 'The job failed.',
            detail: report.join('\n'),
            confirmLabel: 'Done', cancelLabel: 'Close',
            tone: job.status === 'succeeded' && !report.some(l => /warning|not planted|Unity: not open|Arborist trees: skipped/.test(l)) ? 'primary' : 'warning',
            layout: report.length > 3 ? 'review' : 'default',
        });
        await this.gsproSync.refresh(courseId);
    }

    private async reloadTilesKeepingCamera(courseId: string): Promise<void> {
        const map = this.mapSvc.map.peek();
        const camera = map
            ? { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }
            : null;
        await this.tileset.reload(courseId);
        if (!camera) return;
        let restored = false;
        const stop = effect(() => {
            if (restored || !this.mapSvc.ready.get()) return;
            restored = true;
            this.mapSvc.map.peek()?.jumpTo(camera);
            queueMicrotask(() => stop());
        });
        setTimeout(() => { if (!restored) stop(); }, 15_000);
    }

    private buildAvatarPanel(host: HTMLElement, close: () => void): void {
        const player = document.createElement('button');
        player.type = 'button';
        player.className = 'menu-item';
        player.innerHTML = `<span class="menu-item__icon">${icon('map-pin', 16)}</span><span class="menu-item__label">Player settings</span>`;
        player.onclick = () => { this.router.navigate('/player'); close(); };
        host.appendChild(player);

        const logout = document.createElement('button');
        logout.type = 'button';
        logout.className = 'menu-item';
        logout.innerHTML = `<span class="menu-item__label">Log out</span>`;
        logout.onclick = async () => {
            close();
            await this.auth.logout();
            this.router.navigate('/login', true);
        };
        host.appendChild(logout);
    }

    private userInitial(): string {
        return (this.auth.currentUser.get()?.username ?? '?').charAt(0).toUpperCase();
    }
}
