// The GSPro dialog: a STATUS BOARD over the course's GSPro build, one row per
// target — the thing you changed in the editor (terrain, photo, course shapes,
// meshes, vegetation, trees, buildings, creeks, course file) — with "last
// updated / what changed since / Update". One verb per row: Update runs that
// target's whole chain on the server (both terrains, every file on the way and
// the push into the open Unity editor), and the header's "Update all stale"
// does every stale, runnable row in board order. See
// docs/gspro/export.md "The GSPro status board".
//
// The files themselves have not gone anywhere: every legacy export button
// (heightmaps, orthophoto JPEGs, hillshades, trees/buildings/zones/creeks
// files, the SVG, GreenKeeper's .GKD) lives behind its row's "…" details
// toggle and still runs through `GsproExportService`, for the times one file
// is what you want. The export folder stays in the dialog header, since every
// row writes into it.
//
// Two surfaces, one at a time (`view`):
// - the dialog, over the whole page: folder, the Unity chip and the shaping
//   worker in its head, the update job with its phases, then the board;
// - the SVG test-variant panel (leave features out, bisect a failing Blender
//   build), docked at the map's right edge like the import wizards: it picks
//   features from the map and marks them on it, so it cannot cover it. The
//   Course shapes row opens it and it leads back.
//
// The folder is a typed path, not an OS picker: the file is written by the
// SERVER (which runs the pipeline), and a browser folder chooser would name a
// place in the browser's sandbox instead. Blank means the server default —
// the OS Downloads folder — and the placeholder shows what that resolves to.

import { Component, template, effect, Signal, Computed } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, field, glassPanel, panelTitle, OVERLAY_W, OVERLAY_INSET } from '../css';
import { GsproExportService, orthoSourceLabel, terrainLabel, jobLabel } from './gspro-export.service';
import {
    GsproSyncService, aboutLabel, rowStatusLabel, secsLabel, whenLabel,
} from './gspro-sync.service';
import { JobPhasesComponent } from './job-phases.component';
import {
    SVG_FEATURE_TYPES, COURSE_WIDE, NO_FILTER, svgFeatures, matchSvgFilter, variantFileName, landmarksOf, nearLabel, shapeName,
    type SvgExclusionFilter, type SvgStatusFilter,
} from './svg-exclusions';
import { bisectTesting, bisectBuildsLeft, spatialOrder } from './svg-bisect';
import { FeaturesService, geometryToWgs84Rings } from '../draw/features.service';
import { FEATURE_STYLES, type FeatureType } from '../draw/feature-palette';
import { CourseDetailService } from '../course-detail/course-detail.service';
import { MapService } from '../map/map.service';
import { pathSurfaceOf } from '../../../shared/features/path-surface';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import { GKD_KEYWORDS, type GsproCourseMeta } from '../../../shared/gspro-course-meta';
import { GKD_TEE_TYPES, gkdRating, type GkdTeeType } from '../../../shared/tee-sets';
import { GSPRO_TARGETS, type GsproTargetId } from '../../../shared/gspro-targets';
import type { GsproTargetStatus } from '../../../shared/api/gspro-sync.gen';
import { FurnitureService } from '../furniture/furniture.service';
import { teeFill } from '../furniture/furniture-overlay';
import { icon } from '../ui/icons';
import { infoTip, infoTipStyles, attachInfoTips } from '../ui/info-tip';

// The longer explanations sit behind (i) tips (ui/info-tip.ts); what stays in
// view is only what the operator must act on — a missing map, what is stale,
// where the next file goes.
const TIP = {
    board: 'One row per thing you change in the editor. Update runs that row\'s whole chain on the server: both '
        + 'terrains, every file on the way and the push into the open Unity editor (no editor open is a skipped step, '
        + 'not a failure). "Changed since" counts the edits made since that row was last updated.',
    stale: 'Runs every row that is stale and not blocked, in board order.',
    unity: 'The open Unity editor whose GolfMap course imports from this course\'s export folder — the one an Update '
        + 'can push into. Hover for every editor that answered.',
    files: 'The single files behind this row, for when one of them is what you want. Update does all of them, in order.',
    terrains: 'The inner square is the map area the course was built over, its side on a 10 m step; '
        + 'the outer square is the background scenery, centred on it. Every export below renders over one of the two.',
    svg: 'The course\'s drawn features as a layered OPCD SVG over the inner terrain.',
    variant: 'Name a test variant to write it as <course>-<name>.svg next to the full SVG instead of over it, '
        + 'for narrowing down what the Blender build chokes on. Blank writes the full <course>.svg, minus whatever is excluded below.',
    exclude: 'Leave features out of the next SVG export without touching the course: untick them in the list (filter by '
        + 'type, hole or text, then exclude everything shown), or select them on the map in Draw and use "Exclude '
        + 'selected". Excluded features are marked red and dashed on the map while this panel is open. A road\'s kerb '
        + 'fillets go with it. Kept per course in this browser.',
    bisect: 'Finds the feature the Blender build chokes on in about log2(n) + 1 builds. The features the list shows now '
        + '(e.g. Type: Path) become the suspects; everything else goes back into the SVG, apart from what is excluded '
        + 'besides them. Each step leaves half of the remaining suspects out (red on the map) of a bisect-N variant: build '
        + 'it in Blender and answer. Built OK = the culprit is in the half left out, failed = in the half still in; the '
        + 'answer exports the next step. The halves are compact patches of the course, so road pieces the SVG merges into '
        + 'one shape mostly stay together. A last step leaves out only the one found, to confirm it.',
    ortho: 'Square 8192 × 8192 px JPEGs (quality 92) over the inner terrain, the same square as the SVG: '
        + 'the photo as-is, a -terrain twin dimmed for the Unity terrain (its shader lights the photo again) '
        + 'and, with the mesh texture on, a softened, green-tinted -meshes variant for the course meshes.',
    brightness: 'Light multiplier for the -terrain twin, in linear light: 1 keeps the photo as-is, 0.4 (the default when blank) '
        + 'brings a sun-lit photo down to about the reflectance of real grass so Unity\'s own lighting does the rest. '
        + 'Try 0.3–0.6 and compare in Unity.',
    tint: 'Adds a -meshes variant for the course meshes (8192 px): the darkened texture, softened to about 1 m of detail so it '
        + 'doesn\'t read as a satellite photo in game, with an olive-green layer over the fairways, greens, tees, rough and '
        + 'everything that isn\'t drawn, masked by the course\'s own drawn features — the Photoshop step OPCD builders do by '
        + 'hand from the SVG. Water bodies and creeks get a darker brown layer instead, fading into the green over about 4 m '
        + 'of shoreline; bunkers and paths are cut out and stay sharp. Opacity 0.5 (the default when blank) is the grass '
        + 'layer\'s: it looks very green as a file and blends believably under Unity\'s lighting; adjust overall colour in '
        + 'the post-processing volume.',
    clean: 'The same orthophoto files (vintage, brightness and mesh tint from above) with buildings and/or woodland painted '
        + 'out, written as separate -clean files next to the plain ones so neither overwrites the other. Needs "Regenerate '
        + 'trees" (roofs, woodland stands) and optionally "Generate building pads" (the building survey) first.',
    buildings: 'Fills every roof and the shadow it casts from the ground round it, on every file, since Unity puts a building '
        + 'prefab on each pad. Roofs come from the lidar ("Regenerate trees") and, for buildings newer than the lidar, the '
        + 'building survey ("Generate building pads"); the shadow direction and length are measured from the photo. '
        + 'Car parks, roads and paths stay.',
    floor: 'Repaints the course\'s woodland-floor zones (one per closed stand, made from lidar by "Regenerate trees") as moss '
        + 'and needle-litter ground on every file, so the terrain under the planted trees is forest floor instead of '
        + 'photographed crowns. Drawn fairways, semi rough, rough, tees, greens, bunkers, paths and water stay as photographed. '
        + 'Photo mix is how much of each stand\'s own colour, sampled from the photo\'s tracks and clearings, goes into the '
        + 'picked colour: 0 = the colour as picked, 0.5 (the default when blank) = half each.',
    dem: 'The Unity heightmap (4097 × 4097 px 16-bit .raw — OPCD\'s TIF → RAW step, done), the square EPSG:3006 GeoTIFF it '
        + 'came from, and a .json sidecar with the height range and the Unity terrain settings. Inner: the build\'s DEM at '
        + '0.5 m (terrain edits applied). Outer: gridded at 1 m from Laserdata Skog lidar, fetched the first time. Export '
        + 'the inner first: the outer\'s sidecar then carries its Unity position.',
    hillshade: 'An 8192 × 8192 px hillshade of the terrain\'s DEM, for checking an overlay against the relief (bunkers, tees) '
        + 'in Unity or an image editor.',
    trees: 'The terrain\'s lidar tree stems as a unity-trees file for the Unity Tree Planter. Inner: from the map\'s regenerated '
        + 'trees. Outer: detected the first time from the outer lidar, without the stems on the inner square; the planter '
        + 'puts them in billboard mode. Export the terrain\'s heightmap first — the trees take its height range.',
    buildingsFile: 'The terrain\'s buildings (footprints, rectangle, lidar roof heights) as a unity-buildings file for the Unity '
        + 'building planter, from the survey "Generate building pads" made in the terrain tool. Export the heightmap first, '
        + 'with the pads applied — the buildings take its height range and stand on those pads.',
    zones: 'The terrain\'s vegetation zones (shrubs, ferns, woodland floor, …) as VSPro texture masks — one PNG per four zone '
        + 'types — plus a unity-zones file for GolfMap › Vegetation Zones in Unity, which binds the items named in Vegetation '
        + 'zone types to their channels. Export the heightmap first — the zones take its height range.',
    unityOrtho: 'Renders the inner photo with the Clean tool\'s baked edits (the picked vintage\'s cleaned photo when there is '
        + 'one) and the two boxes above as ticked, then puts its -meshes file onto the texture the course meshes sample in the '
        + 'open Unity editor whose GolfMap course imports from this folder. The old texture is backed up in the project\'s '
        + 'GolfMapSpelunk/ortho-backups first. Bake pending Clean edits before this: unbaked ones are not in the photo. Unity '
        + 'must be open with the course active; save the project to keep it.',
    unityTerrain: 'Exports that heightmap, then puts it onto the terrain in the open Unity editor whose GolfMap course imports '
        + 'from this folder: heights, size and (outer) position, on the same Terrain objects and data, so vegetation and '
        + 'references stay. Each terrain is backed up in the course\'s Backups folder first. One terrain on its own — the row\'s '
        + 'Update does both and re-exports what reads the heightmap. Unity must be open with the course active; save the scene '
        + 'to keep it.',
    unitySculpt: 'Captures what you sculpted on that terrain in Unity since golf-map\'s heightmap went in (the terrain conform '
        + 'left out) and keeps it as the terrain\'s one "Unity sculpt" edit: heights added on top of every other edit, so the '
        + 'map, the analysis and every later export carry it. A new capture replaces the layer with the whole sculpt; nothing '
        + 'sculpted removes it. Unity must be open with the course active. Then Apply to terrain, and Update this row.',
    props: 'Buildings, cars, signs, benches and the rest: the course\'s props spec (hand-written Python under '
        + 'docs/gspro/<course>/, one file per group) run into its JSON, built into FBX and a manifest by Blender, and placed '
        + 'in the open Unity editor. A prop moved or rotated by hand there is KEPT by every update — Unity records what it '
        + 'placed in <course>/Props/placed.json and compares — but only a place(...) call in the *-props.gen.py makes a hand '
        + 'move permanent: another machine, or a rebuilt spec, reads the spec and not the record (docs/workflows.md, '
        + 'workflow 4). The first update of a scene from before that record existed writes it before placing anything.',
    creeks: 'The creeks as NatureManufacture R.A.M. splines for GolfMap › Creeks in Unity: each creek\'s line (drawn, or found '
        + 'down its polygon) with control points at its water surface, which only falls downstream — the surface "Dig creeks" '
        + 'digs the bed below. Inner terrain. Export the inner heightmap first — the heights are measured from its zero.',
    gkd: 'GreenKeeper\'s course file, which GSPro reads for tee boxes (by tee colour), pins, green centres, aim points, water '
        + 'hazards and the out-of-bounds line, as positions on the inner terrain. Water is staked at least 0.5 m outside the '
        + 'water and out to where its bank ends (up to 3 m); drawn penalty areas go in as drawn. It is merged into the .GKD '
        + 'already in the folder, so the range, wind and green speed you set in GreenKeeper stay; the first '
        + 'run keeps the original as .GKD.bak. Export the inner heightmap first, and close the course in GreenKeeper while '
        + 'exporting or it will save its own copy over this one.',
    meta: 'What GSPro shows for the course: name, location, designer, description and keywords. The same fields as in '
        + 'GreenKeeper, kept with the course here and written into the .GKD by the export. A course with none kept shows the '
        + 'ones in the .GKD, and the export leaves those alone until you change one here. After editing them in GreenKeeper, '
        + 'read them in from the .GKD before the next export or it writes these over them. Each tee set\'s course rating and '
        + 'slope are not here: they are the course\'s tee sets\' (Furniture › Tee sets), and the export writes the one each '
        + 'set says GSPro shows.',
    tees: 'GSPro has eight tee types and one rating for each. Pick which one each of the course\'s tee sets is exported '
        + 'as, whatever the club calls it, and which of its two ratings GSPro shows; a set left at "Not in GSPro" is not '
        + 'exported. A type goes to one set only: picking it moves it from the set that had it. The sets, their ratings '
        + 'and the sets that exist for GSPro alone (Junior, Par3) are made in Furniture › Tee sets.',
    courseDir: 'The course\'s folder under GSPro\'s Courses (e.g. C:\\GSProV1\\Core\\GSP\\Courses\\<scene>), the one holding '
        + 'its .gspcrse — not the export folder. Saved with the course.',
};

/** The one-line text fields of the course details, in form order. */
const META_TEXT: [keyof GsproCourseMeta & string, string][] = [
    ['courseName', 'Course name'], ['city', 'City / town'], ['state', 'State / county / province'],
    ['country', 'Country'], ['designer', 'Designer'], ['homage', 'Homage'],
];

/** `BeginnerFriendly` -> `Beginner friendly`. */
const spaced = (name: string) => name.replace(/(?<=[a-z])(?=[A-Z])/g, ' ').replace(/ ./g, c => c.toLowerCase());

/** An export button; its text and long name (title) come from the wiring. */
const runBtn = (bind: string, cls: string, testid = '') =>
    `<button bind="${bind}" type="button" class="gspro-export__run gspro-export__run-${cls}"${testid ? ` data-testid="${testid}"` : ''}></button>`;

/** One row of an export matrix: what it is, then the inner terrain's cell and the outer's. */
const matrixRow = (label: string, tip: string, inner: string, outer = '<span></span>') => `
    <div class="gspro-export__mlabel">${label} ${infoTip({ text: tip })}</div>
    ${inner}
    ${outer}`;

const MATRIX_HEAD = `
    <span></span>
    <div class="gspro-export__mhead">Inner terrain</div>
    <div class="gspro-export__mhead">Outer terrain</div>`;

const matrix = (rows: string) => `<div class="gspro-export__matrix">${MATRIX_HEAD}${rows}</div>`;

/** A row's details: its own settings, then the single files behind it. */
const filesHead = `<div class="gspro-export__head">Files ${infoTip({ text: TIP.files })}</div>`;

/**
 * What each row's "…" opens: everything the old tabbed dialog offered for that
 * target, unchanged in behaviour — the same binds, so the same wiring runs it.
 */
const DETAILS: Record<GsproTargetId, string> = {
    terrain: `
        <div class="gspro-export__group">
            <div class="gspro-export__head">Terrains ${infoTip({ text: TIP.terrains })}</div>
            <div class="gspro-export__terrain"><b>Inner terrain</b> <span bind="innerTerrain"></span></div>
            <div class="gspro-export__terrain"><b>Outer terrain</b> <span bind="outerTerrain"></span></div>
            <div bind="terrainNote" class="hint gspro-export__warn"></div>
        </div>
        ${filesHead}
        ${matrix(`
            ${matrixRow('Heightmap (RAW + GeoTIFF)', TIP.dem, runBtn('runInnerDem', 'inner-dem'), runBtn('runOuterDem', 'outer-dem'))}
            ${matrixRow('Heightmap → Unity', TIP.unityTerrain, runBtn('runInnerUnity', 'inner-unity', 'gspro-inner-unity'), runBtn('runOuterUnity', 'outer-unity', 'gspro-outer-unity'))}
            ${matrixRow('Pull sculpt from Unity', TIP.unitySculpt, runBtn('runInnerSculpt', 'inner-sculpt', 'gspro-inner-sculpt'), runBtn('runOuterSculpt', 'outer-sculpt', 'gspro-outer-sculpt'))}
            ${matrixRow('Hillshade JPEG', TIP.hillshade, runBtn('runInnerHillshade', 'inner-hillshade'), runBtn('runOuterHillshade', 'outer-hillshade'))}`)}`,

    photo: `
        <div class="gspro-export__cols">
            <div class="gspro-export__group">
                <div class="gspro-export__head">Photo ${infoTip({ text: TIP.ortho })}</div>
                <label bind="orthoField" class="gspro-export__field">Orthophoto
                    <select bind="orthoSource" data-testid="gspro-ortho-source"></select>
                </label>
                <div bind="orthoNote" class="hint gspro-export__warn"></div>
                <label class="gspro-export__field"><span class="gspro-export__label">Terrain texture brightness ${infoTip({ text: TIP.brightness })}</span>
                    <input bind="terrainDarken" type="text" inputmode="decimal" spellcheck="false" autocomplete="off" />
                </label>
                <div class="gspro-export__option">
                    <label class="gspro-export__check"><input bind="tintTerrain" type="checkbox" /> Mesh texture (grass surfaces tinted)</label>
                    ${infoTip({ text: TIP.tint })}
                </div>
                <label bind="tintOpacityField" class="gspro-export__field">Surface tint opacity
                    <input bind="tintOpacity" type="text" inputmode="decimal" spellcheck="false" autocomplete="off" />
                </label>
            </div>
            <div class="gspro-export__group">
                <div class="gspro-export__head">Cleaning ${infoTip({ text: TIP.clean })}</div>
                <div class="gspro-export__option">
                    <label class="gspro-export__check"><input bind="removeBuildings" type="checkbox" /> Remove buildings</label>
                    ${infoTip({ text: TIP.buildings })}
                </div>
                <div class="gspro-export__option">
                    <label class="gspro-export__check"><input bind="forestFloor" type="checkbox" /> Forest floor under woodland stands</label>
                    ${infoTip({ text: TIP.floor })}
                </div>
                <div bind="floorFields" class="gspro-export__floor">
                    <label class="gspro-export__field">Floor colour
                        <input bind="floorColor" type="color" />
                    </label>
                    <label class="gspro-export__field">Photo mix
                        <input bind="floorMix" type="text" inputmode="decimal" spellcheck="false" autocomplete="off" />
                    </label>
                </div>
            </div>
        </div>
        ${filesHead}
        ${matrix(`
            ${matrixRow('Orthophoto JPEG', TIP.ortho, runBtn('runOrtho', 'ortho'), `<div class="gspro-export__row">
                ${runBtn('runOuterOrtho', 'outer-ortho')}
                ${infoTip({ bind: 'outerOrthoTip' })}
            </div>`)}
            ${matrixRow('Cleaned orthophoto', TIP.clean, runBtn('runCleanOrtho', 'clean-ortho'), runBtn('runCleanOuterOrtho', 'clean-outer-ortho'))}
            ${matrixRow('→ Unity meshes', TIP.unityOrtho, runBtn('runUnityOrtho', 'unity-ortho', 'gspro-unity-ortho'))}`)}`,

    shapes: `
        ${filesHead}
        ${matrix(`
            ${matrixRow('Course SVG', TIP.svg, '<button bind="run" type="button" class="gspro-export__run" data-testid="gspro-run-svg"></button>')}
            <div class="gspro-export__mnote">
                <span bind="svgFileHint" class="hint"></span>
                <button bind="openSvg" type="button" class="gspro-export__link" data-testid="gspro-open-svg"><span bind="excludeSummary"></span></button>
            </div>`)}`,

    meshes: `<div bind="meshesHint" class="hint"></div>`,

    vegetation: `
        ${filesHead}
        ${matrix(matrixRow('Vegetation zones', TIP.zones, runBtn('runInnerZones', 'inner-zones'), runBtn('runOuterZones', 'outer-zones')))}`,

    trees: `
        ${filesHead}
        ${matrix(matrixRow('Trees', TIP.trees, runBtn('runInnerTrees', 'inner-trees'), runBtn('runOuterTrees', 'outer-trees')))}`,

    buildings: `
        ${filesHead}
        ${matrix(matrixRow('Buildings', TIP.buildingsFile, runBtn('runInnerBuildings', 'inner-buildings'), runBtn('runOuterBuildings', 'outer-buildings')))}`,

    props: `
        <div class="gspro-export__group">
            <div class="gspro-export__head">Props ${infoTip({ text: TIP.props })}</div>
            <div bind="propsHint" class="hint"></div>
        </div>`,

    creeks: `
        ${filesHead}
        ${matrix(matrixRow('Creeks', TIP.creeks, runBtn('runCreeks', 'creeks')))}`,

    'course-file': `
        <div class="gspro-export__group">
            <div class="gspro-export__head">GreenKeeper course file (.GKD) ${infoTip({ text: TIP.gkd })}</div>
            <label class="gspro-export__field"><span class="gspro-export__label">GSPro course folder ${infoTip({ text: TIP.courseDir })}</span>
                <input bind="courseDir" type="text" spellcheck="false" autocomplete="off" placeholder="C:\\GSProV1\\Core\\GSP\\Courses\\<scene>" />
            </label>
            <div bind="gkdHint" class="hint"></div>
            <button bind="runGkd" type="button" class="gspro-export__run gspro-export__run-gkd gspro-export__fit"></button>
        </div>
        <div class="gspro-export__group" data-testid="gspro-tees">
            <div class="gspro-export__head">Tee sets in GSPro ${infoTip({ text: TIP.tees })}</div>
            <div class="gspro-export__tees gspro-export__tees-head">
                <span>Tee set</span><span>GSPro tee</span><span>Rating GSPro shows</span>
            </div>
            <div bind="teeRows" class="gspro-export__tees" data-testid="gspro-tee-sets"></div>
            <div bind="teeHint" class="hint"></div>
            <div bind="ratingsHint" class="hint gspro-export__warn" data-testid="gspro-ratings-hint"></div>
            <button bind="readGkdRatings" type="button" class="gspro-export__small gspro-export__fit" data-testid="gspro-ratings-read">Read the ratings from the .GKD</button>
        </div>
        <div class="gspro-export__group gspro-export__meta" data-testid="gspro-meta">
            <div class="gspro-export__head">Course details ${infoTip({ text: TIP.meta })}</div>
            <div bind="metaHint" class="hint gspro-export__warn" data-testid="gspro-meta-hint"></div>
            <button bind="readGkdMeta" type="button" class="gspro-export__link" data-testid="gspro-meta-read">Read the course details from the .GKD</button>
            <div class="gspro-export__cols">
                ${META_TEXT.map(([key, label]) => `<label class="gspro-export__field">${label}
                    <input bind="meta_${key}" type="text" autocomplete="off" data-testid="gspro-meta-${key}" />
                </label>`).join('')}
            </div>
            <label class="gspro-export__field">Description
                <textarea bind="meta_description" rows="5" data-testid="gspro-meta-description"></textarea>
            </label>
            <label class="gspro-export__field gspro-export__narrow">Difficulty
                <input bind="meta_difficulty" type="text" inputmode="decimal" autocomplete="off" />
            </label>
            <div class="gspro-export__head">Keywords</div>
            <div class="gspro-export__keywords">
                ${GKD_KEYWORDS.map(k => `<label class="gspro-export__check"><input bind="kw_${k}" type="checkbox" /> ${spaced(k)}</label>`).join('')}
            </div>
        </div>`,
};

/** One board row: the stale marker, the label, the status line, the details toggle and Update. */
const boardRow = (id: GsproTargetId, label: string, description: string) => `
    <div bind="row_${id}" class="gspro-export__brow" data-testid="gspro-row-${id}">
        <div class="gspro-export__bmain">
            <span bind="dot_${id}" class="gspro-export__dot"></span>
            <div class="gspro-export__blabel">${label} ${infoTip({ text: description })}</div>
            <div bind="status_${id}" class="gspro-export__bstatus" data-testid="gspro-status-${id}"></div>
            <button bind="toggle_${id}" type="button" class="gspro-export__more" data-testid="gspro-details-${id}"
                aria-label="Files and settings for ${label}" title="Files and settings">…</button>
            <button bind="update_${id}" type="button" class="gspro-export__update gspro-export__primary"
                data-testid="gspro-update-${id}">Update</button>
        </div>
        <div bind="note_${id}" class="hint gspro-export__note" data-testid="gspro-note-${id}"></div>
        <div bind="manual_${id}" class="hint gspro-export__manual" data-testid="gspro-manual-${id}"></div>
        <div bind="blocked_${id}" class="hint gspro-export__blocked" data-testid="gspro-blocked-${id}"></div>
        <div bind="details_${id}" class="gspro-export__details hidden" data-testid="gspro-panel-${id}">${DETAILS[id]}</div>
    </div>`;

const tpl = template(`
    <div bind="root" class="gspro-export">
        <div bind="modal" class="gspro-export__modal">
            <div bind="backdrop" class="gspro-export__backdrop"></div>
            <div class="gspro-export__dialog" role="dialog" aria-modal="true" aria-label="GSPro" data-testid="gspro-dialog">
                <div class="gspro-export__header">
                    <h3>GSPro</h3>
                    <div class="gspro-export__chips">
                        <span bind="unityChip" class="gspro-export__chip" data-testid="gspro-unity-chip"></span>
                        <span bind="workerChip" class="gspro-export__chip" data-testid="gspro-worker-chip"></span>
                        ${infoTip({ text: TIP.unity })}
                    </div>
                    <button bind="close" type="button" aria-label="Close" title="Close">${icon('x')}</button>
                </div>

                <div class="gspro-export__top">
                    <div class="gspro-export__top-col">
                        <label class="gspro-export__field">Folder on this machine
                            <input bind="dir" type="text" spellcheck="false" autocomplete="off" data-testid="gspro-dir" />
                        </label>
                        <div bind="dirHint" class="hint"></div>
                        <button bind="reset" type="button" class="gspro-export__link">Use the default folder</button>
                    </div>
                    <div class="gspro-export__top-col gspro-export__top-right">
                        <div class="gspro-export__option">
                            <button bind="updateStale" type="button" class="gspro-export__primary gspro-export__fit"
                                data-testid="gspro-update-stale"></button>
                            ${infoTip({ text: TIP.stale })}
                        </div>
                        <div bind="boardNote" class="hint"></div>
                    </div>
                </div>

                <div bind="syncSection" class="gspro-export__sync" data-testid="gspro-job">
                    <div bind="syncStatus" class="gspro-export__job" data-testid="gspro-job-status"></div>
                    <div bind="phasesHost"></div>
                    <div bind="syncResults" class="gspro-export__results" data-testid="gspro-job-results"></div>
                    <div bind="syncError" class="gspro-export__fail" data-testid="gspro-job-error"></div>
                </div>

                <div class="gspro-export__body">
                    <div class="gspro-export__board" data-testid="gspro-board">
                        <div class="gspro-export__head">What is out of date in GSPro ${infoTip({ text: TIP.board })}</div>
                        ${GSPRO_TARGETS.map(target => boardRow(target.id, target.label, target.description)).join('')}
                    </div>
                </div>

                <div class="gspro-export__footer" data-testid="gspro-status">
                    <div bind="idleNote" class="hint">Nothing exported since the dialog opened.</div>
                    <div bind="jobSection" class="gspro-export__section">
                        <div bind="jobNote" class="gspro-export__job"></div>
                    </div>
                    <div bind="resultSection" class="gspro-export__section">
                        <div bind="resultPath" class="gspro-export__path"></div>
                        <ul bind="report" class="gspro-export__report"></ul>
                    </div>
                    <div bind="errorSection" class="gspro-export__section">
                        <div bind="error" class="error"></div>
                    </div>
                </div>
            </div>
        </div>

        <div bind="side" class="gspro-export__side" data-testid="gspro-svg-panel">
            <div class="gspro-export__side-header">
                <button bind="backToDialog" type="button" class="gspro-export__link" data-testid="gspro-svg-back">‹ GSPro</button>
                <button bind="closeSide" type="button" class="gspro-export__x" aria-label="Close" title="Close">${icon('x')}</button>
            </div>
            <div class="gspro-export__section">
                <div class="gspro-export__head">SVG test variants ${infoTip({ text: TIP.exclude })}</div>
                <label class="gspro-export__field"><span class="gspro-export__label">Variant name ${infoTip({ text: TIP.variant })}</span>
                    <input bind="svgVariant" type="text" spellcheck="false" autocomplete="off" placeholder="blank = the full SVG" data-testid="gspro-svg-variant" />
                </label>
                <div bind="svgFileHintSide" class="hint"></div>
                <button bind="runSide" type="button" class="gspro-export__run gspro-export__primary"></button>
                <div bind="sideStatus" class="gspro-export__job" data-testid="gspro-svg-status"></div>
            </div>
            <div class="gspro-export__section gspro-export__exclude">
                <div class="gspro-export__row">
                    <button bind="excludeSelected" type="button" class="gspro-export__small" data-testid="gspro-exclude-selected"></button>
                    <button bind="includeSelected" type="button" class="gspro-export__small"></button>
                </div>
                <div class="gspro-export__filters">
                    <select bind="filterType" aria-label="Type"></select>
                    <select bind="filterHole" aria-label="Hole"></select>
                    <select bind="filterStatus" aria-label="Status">
                        <option value="all">All</option>
                        <option value="excluded">Excluded</option>
                        <option value="included">In SVG</option>
                        <option value="suspects">Bisect suspects</option>
                    </select>
                </div>
                <input bind="filterText" type="search" class="gspro-export__search" spellcheck="false" autocomplete="off" placeholder="Search id or source" />
                <div class="gspro-export__row">
                    <button bind="excludeShown" type="button" class="gspro-export__small" data-testid="gspro-exclude-shown"></button>
                    <button bind="includeShown" type="button" class="gspro-export__small"></button>
                </div>
                <div bind="bisectStartRow" class="gspro-export__option">
                    <button bind="bisectStart" type="button" class="gspro-export__small" data-testid="gspro-bisect-start"></button>
                    ${infoTip({ text: TIP.bisect })}
                </div>
                <div bind="bisectBox" class="gspro-export__bisect" data-testid="gspro-bisect">
                    <div bind="bisectStatus" class="gspro-export__bisect-status"></div>
                    <div bind="bisectAnswers" class="gspro-export__row">
                        <button bind="bisectOk" type="button" class="gspro-export__small" data-testid="gspro-bisect-ok">Built OK</button>
                        <button bind="bisectFailed" type="button" class="gspro-export__small" data-testid="gspro-bisect-failed">Build failed</button>
                    </div>
                    <div class="gspro-export__links">
                        <button bind="bisectCulprit" type="button" class="gspro-export__link">Show it on the map</button>
                        <button bind="bisectSuspects" type="button" class="gspro-export__link">List the suspects</button>
                        <button bind="bisectUndo" type="button" class="gspro-export__link">Undo last answer</button>
                        <button bind="bisectStop" type="button" class="gspro-export__link">Stop bisecting</button>
                    </div>
                </div>
                <ul bind="featureList" class="gspro-export__features" data-testid="gspro-svg-features"></ul>
                <div bind="listMore" class="hint"></div>
                <button bind="clearExclusions" type="button" class="gspro-export__link">Clear all exclusions</button>
            </div>
        </div>
    </div>
`);

/** One feature in the exclusion list: ticked = in the SVG. */
const rowTpl = template(`
    <li bind="row" class="gspro-export__feature">
        <input bind="check" type="checkbox" title="In the SVG" />
        <span bind="swatch" class="gspro-export__swatch"></span>
        <button bind="name" type="button" class="gspro-export__feature-name"></button>
        <span bind="where" class="gspro-export__feature-where"></span>
        <button bind="locate" type="button" class="gspro-export__locate" title="Show it on the map" aria-label="Show it on the map">${icon('crosshair')}</button>
    </li>
`);

/** Rows the list renders at most; the rest are counted, not drawn (a course can have thousands of canopy trees). */
const LIST_LIMIT = 200;

export class GsproExportPanelComponent extends Component {
    static styles = `
        .gspro-export {
            display: none;
            font-size: 0.8rem;
            color: ${t('color-text-primary')};
            &.show { display: block; }

            /* ── The dialog: header (Unity, worker), folder + Update all
               stale, the running job, the board (the only part that scrolls),
               the legacy status footer. ── */
            & .gspro-export__modal {
                position: fixed;
                inset: 0;
                z-index: 900;
                display: flex;
                align-items: center;
                justify-content: center;
                &.hidden { display: none; }
            }
            & .gspro-export__backdrop {
                position: absolute;
                inset: 0;
                background: ${t('overlay-scrim')};
            }
            & .gspro-export__dialog {
                position: relative;
                display: flex;
                flex-direction: column;
                width: min(920px, calc(100vw - 48px));
                height: min(760px, calc(100vh - 48px));
                border: 1px solid ${t('color-border-subtle')};
                border-radius: var(--radius-lg);
                background: ${t('color-surface-card')};
                box-shadow: var(--elev-3);
                overflow: hidden;
            }

            & .gspro-export__header, & .gspro-export__side-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-3);
                padding: var(--space-3) var(--space-5);
                border-bottom: 1px solid ${t('color-border-default')};
                & h3 { margin: 0; ${panelTitle()} }
                & > button:not(.gspro-export__link) {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 2px ${s('sm')};
                    font-size: 0.8rem;
                    ${btn()}
                }
            }
            & .gspro-export__chips {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                margin-left: auto;
                min-width: 0;
            }
            & .gspro-export__chip {
                padding: 2px ${s('sm')};
                border: 1px solid ${t('color-border-subtle')};
                border-radius: var(--radius-pill, 999px);
                background: ${t('color-surface-sunken')};
                color: ${t('color-text-secondary')};
                font-size: 0.68rem;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                max-width: 22rem;
                &:empty { display: none; }
                &.matched { color: ${t('color-text-primary')}; border-color: ${t('color-status-positive')}; }
            }

            & .gspro-export__top {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: var(--space-5);
                padding: var(--space-3) var(--space-5);
                border-bottom: 1px solid ${t('color-border-default')};
            }
            & .gspro-export__top-col { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
            & .gspro-export__top-right { align-items: flex-start; justify-content: flex-start; }

            & .gspro-export__body { flex: 1; min-height: 0; overflow-y: auto; }
            & .gspro-export__board {
                display: flex;
                flex-direction: column;
                gap: var(--space-2);
                padding: var(--space-4) var(--space-5);
            }

            /* ── A board row: marker, label, status, "…", Update. ── */
            & .gspro-export__brow {
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                padding-bottom: var(--space-2);
                border-bottom: 1px solid ${t('color-border-subtle')};
                &:last-child { border-bottom: none; }
            }
            & .gspro-export__bmain {
                display: grid;
                grid-template-columns: 10px minmax(7rem, 11rem) minmax(0, 1fr) auto auto;
                align-items: center;
                gap: ${s('sm')};
            }
            & .gspro-export__dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: ${t('color-border-default')};
                &.stale { background: ${t('color-status-caution')}; }
                &.fresh { background: ${t('color-status-positive')}; }
                &.blocked { background: ${t('color-text-tertiary')}; }
            }
            & .gspro-export__blabel { display: flex; align-items: center; gap: ${s('xs')}; font-size: 0.82rem; font-weight: 600; }
            & .gspro-export__bstatus {
                min-width: 0;
                font-size: 0.72rem;
                line-height: 1.4;
                color: ${t('color-text-secondary')};
            }
            & .gspro-export__more {
                ${btn()}
                padding: 0 ${s('sm')};
                font-size: 0.85rem;
                line-height: 1.6;
                &[aria-expanded="true"] { color: ${t('color-text-primary')}; }
            }
            & .gspro-export__update { min-width: 6rem; }
            & .gspro-export__note, & .gspro-export__manual, & .gspro-export__blocked { padding-left: calc(10px + ${s('sm')}); }
            & .gspro-export__details {
                display: flex;
                flex-direction: column;
                gap: var(--space-3);
                margin: ${s('xs')} 0 var(--space-2) calc(10px + ${s('sm')});
                padding: var(--space-3);
                border: 1px solid ${t('color-border-subtle')};
                border-radius: var(--radius-sm, 4px);
                background: ${t('color-surface-sunken')};
                &.hidden { display: none; }
            }

            /* The update job: one line, its phases, each target's report. */
            & .gspro-export__sync {
                display: flex;
                flex-direction: column;
                gap: var(--space-2);
                padding: var(--space-3) var(--space-5);
                border-bottom: 1px solid ${t('color-border-default')};
                background: ${t('color-surface-sunken')};
                max-height: 34%;
                overflow-y: auto;
                &.hidden { display: none; }
            }
            & .gspro-export__results {
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                &:empty { display: none; }
                & summary { cursor: pointer; font-size: 0.72rem; color: ${t('color-text-secondary')}; }
                & ul {
                    margin: ${s('xs')} 0 0;
                    padding-left: var(--space-4);
                    font-size: 0.7rem;
                    line-height: 1.5;
                    color: ${t('color-text-secondary')};
                }
            }
            & .gspro-export__fail {
                color: ${t('color-status-negative')};
                font-size: 0.72rem;
                line-height: 1.4;
                &:empty { display: none; }
            }

            /* An export matrix: one row per file, a column per terrain. */
            & .gspro-export__matrix {
                display: grid;
                grid-template-columns: minmax(0, 1fr) 11rem 11rem;
                align-items: center;
                gap: var(--space-2) var(--space-3);
                & .gspro-export__run { width: 100%; }
            }
            & .gspro-export__mhead {
                font-size: 0.72rem;
                font-weight: 600;
                color: ${t('color-text-secondary')};
                text-align: center;
            }
            & .gspro-export__mlabel { display: flex; align-items: center; gap: ${s('xs')}; font-size: 0.82rem; }
            & .gspro-export__mnote {
                grid-column: 1 / -1;
                display: flex;
                flex-wrap: wrap;
                align-items: baseline;
                gap: ${s('xs')} ${s('md')};
                margin-top: calc(-1 * var(--space-1));
            }

            /* Settings side by side, each group under its own head. */
            & .gspro-export__cols { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3) var(--space-5); }
            & .gspro-export__group { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
            & .gspro-export__narrow { max-width: 10rem; }
            & .gspro-export__fit { align-self: flex-start; flex: none; }

            & .gspro-export__footer {
                max-height: 30%;
                overflow-y: auto;
                padding: var(--space-3) var(--space-5);
                border-top: 1px solid ${t('color-border-default')};
                background: ${t('color-surface-sunken')};
                display: flex;
                flex-direction: column;
                gap: var(--space-2);
                & .gspro-export__section { padding: 0; border: none; }
            }

            /* ── The SVG test-variant panel: narrow, docked at the map's
               right edge, so the features it lists stay visible on the map. ── */
            & .gspro-export__side {
                /* Layout laws 01+02: self-positioned overlay at the top-right
                   corner inset, standard bucket, height hugs content. */
                position: absolute;
                top: ${OVERLAY_INSET};
                right: ${OVERLAY_INSET};
                width: ${OVERLAY_W.standard};
                max-height: calc(100% - 2 * ${OVERLAY_INSET});
                z-index: 6;
                display: none;
                flex-direction: column;
                overflow-y: auto;
                ${glassPanel()}
                padding: 0;
                &.show { display: flex; }
                & .gspro-export__side-header { padding: var(--space-3) var(--space-4); }
                & .gspro-export__section { padding: var(--space-3) var(--space-4); border-bottom: 1px solid ${t('color-border-default')}; }
                & .gspro-export__section:last-child { border-bottom: none; }
            }

            & .gspro-export__section {
                display: flex;
                flex-direction: column;
                gap: var(--space-2);
                &.hidden { display: none; }
            }

            & .gspro-export__check {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 12px;
            }

            /* A group's name with its (i), and option rows that carry one. */
            & .gspro-export__head {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                font-size: 0.72rem;
                font-weight: 600;
                color: ${t('color-text-secondary')};
            }
            & .gspro-export__option, & .gspro-export__row, & .gspro-export__label {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
            }
            & .gspro-export__label { gap: ${s('xs')}; }
            & .gspro-export__row .gspro-export__run { flex: 1; }
            ${infoTipStyles()}

            & .gspro-export__terrain {
                font-size: 0.72rem;
                line-height: 1.4;
                color: ${t('color-text-secondary')};
                & b { color: ${t('color-text-primary')}; margin-right: ${s('xs')}; }
            }

            & .gspro-export__floor {
                display: flex; gap: ${s('sm')};
                & .gspro-export__field { flex: 1; }
                & input[type=color] { width: 100%; height: 34px; padding: 2px; }
                &.hidden { display: none; }
            }
            & .gspro-export__field {
                ${field()}
                & input, & select { font-family: var(--font-mono); font-size: 0.75rem; }
                &.hidden { display: none; }
            }

            & .hint {
                color: ${t('color-text-tertiary')};
                font-size: 0.7rem;
                line-height: 1.4;
                &:empty { display: none; }
                &.hidden { display: none; }
            }
            & .gspro-export__warn { color: ${t('color-text-secondary')}; }

            & .error {
                color: ${t('color-status-negative')};
                font-size: 0.72rem;
                line-height: 1.4;
            }

            & .gspro-export__link {
                align-self: flex-start;
                padding: 0;
                background: none;
                border: none;
                color: ${t('color-text-secondary')};
                font: inherit;
                font-size: 0.7rem;
                cursor: pointer;
                text-decoration: underline;
                &:disabled { opacity: 0.5; cursor: default; text-decoration: none; }
            }

            & .gspro-export__job {
                font-size: 0.72rem;
                line-height: 1.4;
                color: ${t('color-text-secondary')};
                &:empty { display: none; }
                &.error { color: ${t('color-status-negative')}; }
            }

            & .gspro-export__path {
                font-family: var(--font-mono);
                font-size: 0.72rem;
                word-break: break-all;
                color: ${t('color-text-primary')};
            }

            & .gspro-export__report {
                margin: 0;
                padding-left: var(--space-4);
                color: ${t('color-text-secondary')};
                font-size: 0.7rem;
                line-height: 1.5;
                & li { word-break: break-word; }
            }

            & .gspro-export__exclude { display: flex; flex-direction: column; gap: var(--space-2); }
            & .gspro-export__meta textarea { font: inherit; font-weight: 400; font-size: 0.75rem; line-height: 1.4; resize: vertical; }
            /* One line per tee set: what the club calls it, GSPro's tee type, the rating GSPro shows. */
            & .gspro-export__tees {
                display: grid;
                grid-template-columns: minmax(0, 1fr) 11rem 13rem;
                align-items: center;
                gap: ${s('xs')} ${s('md')};
                font-size: 0.8rem;
                &:empty { display: none; }
                & select { min-width: 0; font-size: 0.78rem; padding: 3px ${s('xs')}; }
            }
            & .gspro-export__tees-head { font-size: 0.72rem; font-weight: 600; color: ${t('color-text-secondary')}; }
            & .gspro-export__tee-row { display: contents; }
            & .gspro-export__tee-name {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                min-width: 0;
                /* The name wins the room; the "GSPro only" tag is what gets cut. */
                & b { flex: 0 1 auto; min-width: 2.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
                & i { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: normal; font-size: 0.7rem; color: ${t('color-text-tertiary')}; }
            }
            & .gspro-export__tee-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; border: 1px solid ${t('color-border-default')}; }
            & .gspro-export__keywords {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: ${s('xs')} ${s('sm')};
            }
            & .gspro-export__small {
                flex: 1;
                ${btn()}
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.7rem;
                &:disabled { opacity: 0.45; cursor: default; }
                &.hidden { display: none; }
            }
            & .gspro-export__filters {
                display: flex;
                gap: ${s('xs')};
                & select { flex: 1; min-width: 0; font-size: 0.72rem; }
            }
            & .gspro-export__search { width: 100%; box-sizing: border-box; font-size: 0.72rem; }
            & .gspro-export__features {
                list-style: none;
                margin: 0;
                padding: 0;
                max-height: 260px;
                overflow-y: auto;
                border: 1px solid ${t('color-border-default')};
                border-radius: 4px;
                &:empty { display: none; }
            }
            & .gspro-export__feature {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                padding: 2px ${s('xs')};
                font-size: 0.7rem;
                &.excluded .gspro-export__feature-name { text-decoration: line-through; color: ${t('color-text-tertiary')}; }
            }
            & .gspro-export__swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
            & .gspro-export__feature-name {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                text-align: left;
                padding: 0;
                background: none;
                border: none;
                color: ${t('color-text-primary')};
                font: inherit;
                cursor: pointer;
                &:hover { text-decoration: underline; }
            }
            & .gspro-export__feature-where { color: ${t('color-text-tertiary')}; flex: none; font-family: var(--font-mono); font-size: 0.65rem; }
            & .gspro-export__locate {
                flex: none;
                display: inline-flex;
                padding: 2px;
                background: none;
                border: none;
                color: ${t('color-text-secondary')};
                cursor: pointer;
                & svg { width: 13px; height: 13px; }
                &:hover { color: ${t('color-text-primary')}; }
            }
            & .gspro-export__option.hidden, & .gspro-export__row.hidden, & .gspro-export__link.hidden { display: none; }
            & .gspro-export__bisect {
                display: flex;
                flex-direction: column;
                gap: var(--space-2);
                padding: var(--space-2) var(--space-3);
                border: 1px solid ${t('color-border-default')};
                border-radius: 4px;
                &.hidden { display: none; }
            }
            & .gspro-export__bisect-status { font-size: 0.72rem; line-height: 1.4; }
            & .gspro-export__links { display: flex; flex-wrap: wrap; gap: ${s('xs')} ${s('md')}; }

            /* A single-file export button is quiet: a row's details hold
               several, and the status footer says which one is running. The
               board's own verb — Update — takes the accent. */
            & .gspro-export__run {
                ${btn()}
                padding: ${s('sm')} ${s('md')};
                font-size: 0.78rem;
                &:disabled { opacity: 0.45; cursor: default; }
            }
            & .gspro-export__primary { ${primaryBtn()} padding: ${s('sm')} ${s('md')}; }
            /* The recipe has no disabled look; a button waiting for its input must not read as ready. */
            & .gspro-export__primary:disabled { opacity: 0.45; cursor: default; }
        }
    `;

    private svc = this.inject(GsproExportService);
    /** The board itself: what is stale, the Unity editor, the update jobs. */
    private sync = this.inject(GsproSyncService);
    private features = this.inject(FeaturesService);
    private courseDetail = this.inject(CourseDetailService);
    private mapSvc = this.inject(MapService);
    /** The course's tee sets live with the furniture; this panel only says what GSPro makes of them. */
    private furniture = this.inject(FurnitureService);
    /** The SVG panel's element, measured so a located feature is framed clear of it. */
    private sideEl: HTMLElement | null = null;
    /**
     * What is on screen: the dialog, or the narrow SVG test-variant panel
     * (the one part of the export that works against the map, so it must not
     * cover it).
     */
    private view = new Signal<'dialog' | 'svg'>('dialog');
    /** Rows whose "…" details are open; kept while the page lives. */
    private open = new Signal<ReadonlySet<GsproTargetId>>(new Set());

    /** The exclusion list's filter (panel-local view state). */
    private filter = new Signal<SvgExclusionFilter>(NO_FILTER);
    /** The course's features the SVG writes. */
    private svgItems = new Computed<CourseFeature[]>(() => svgFeatures(this.features.store.items.get()));
    /** A running bisect's remaining suspects. */
    private suspects = new Computed<ReadonlySet<string>>(() => new Set(this.svc.svgBisect.get()?.candidates ?? []));
    /** Those matching the filter. */
    private shown = new Computed<CourseFeature[]>(() =>
        matchSvgFilter(this.svgItems.get(), this.filter.get(), this.svc.svgExcluded.get(), this.suspects.get()));

    /** The holes' greens, tees and fairways: what a feature is described as near. */
    private landmarks = new Computed(() => landmarksOf(
        this.features.store.items.get(),
        new Map(this.courseDetail.holes.get().map(h => [h.id, h.number])),
    ));

    /** `Path · gravel · near hole 13 green`: what it is and where, since an id finds nothing on the map. */
    private describe(f: CourseFeature): string {
        const surface = f.type === 'path' ? pathSurfaceOf(f.attributes) ?? '' : '';
        const near = nearLabel(f, this.landmarks.peek());
        return [FEATURE_STYLES[f.type as FeatureType]?.label ?? f.type, surface, near].filter(Boolean).join(' · ');
    }

    /** `describe` plus the shape name, for a feature id (the id alone once it is gone from the course). */
    private featureLabel(id: string): string {
        const f = this.features.store.items.peek().find(x => x.id === id);
        return f ? `${this.describe(f)} (${shapeName(f, this.holeNumber(f))})` : `Feature ${id.slice(0, 8)}`;
    }

    private holeNumber(f: CourseFeature): number | undefined {
        return f.holeId ? this.courseDetail.holes.peek().find(h => h.id === f.holeId)?.number : undefined;
    }

    /** What the bisect box says about the current step. */
    private bisectStatus(): string {
        const b = this.svc.svgBisect.get();
        if (!b) return '';
        const file = variantFileName(this.svc.courseName.get(), this.svc.svgVariant.get());
        const next = b.exported ? 'Build it in Blender, then answer.' : 'Export it, then build it in Blender.';
        if (b.candidates.length === 1) {
            const it = this.featureLabel(b.candidates[0]);
            if (b.result === 'confirmed') return `Found it: ${it}. The build works without only this one.`;
            if (b.result === 'not-alone') {
                return `The build still fails without only ${it}: it breaks together with other features (the road `
                    + 'merge joins neighbouring pieces). Undo, or bisect again from a wider set.';
            }
            return `Down to ${it}. To confirm, ${file} leaves out only it. ${next}`;
        }
        const left = bisectBuildsLeft(b);
        return `Step ${b.step}: ${b.candidates.length} suspects, about ${left} builds to go. ${file} leaves out `
            + `${bisectTesting(b).length} of them (red on the map). ${next}`;
    }


    private setFilter(patch: Partial<SvgExclusionFilter>): void {
        this.filter.set({ ...this.filter.peek(), ...patch });
    }

    /** Select a feature on the map and frame it, clear of this panel (it covers the map's right edge). */
    private showOnMap(f: CourseFeature): void {
        this.features.select(f.id);
        let w = Infinity, south = Infinity, e = -Infinity, n = -Infinity;
        for (const ring of geometryToWgs84Rings(f.geometry)) {
            for (const [lng, lat] of ring) {
                w = Math.min(w, lng); e = Math.max(e, lng);
                south = Math.min(south, lat); n = Math.max(n, lat);
            }
        }
        const panel = this.sideEl?.offsetWidth ?? 0;
        const padding = { top: 96, bottom: 96, left: 96, right: panel + 48 };
        if (Number.isFinite(w)) this.mapSvc.fitBounds([w, south, e, n], { maxZoom: 19, padding });
    }

    /** Close the whole thing: the board and the file exports go together. */
    private closeDialog(): void {
        this.svc.close();
        this.sync.close();
    }

    /** The course the dialog is open for, whichever half was opened first. */
    private openCourseId(): string | null {
        return this.svc.courseId.get() ?? this.sync.courseId.get();
    }

    /** One target's row as the server last reported it. */
    private row(id: GsproTargetId): GsproTargetStatus | null {
        return this.sync.status.get()?.targets.find(x => x.id === id) ?? null;
    }

    /** No Update may run while another one, or a single-file export, is going. */
    private updatesBusy(): boolean {
        return this.sync.running.get() || this.svc.busy.get();
    }

    /** The board's one line about the update job in flight, or the one that just finished. */
    private jobStatusText(): string {
        this.sync.tick.get();
        const job = this.sync.job.get();
        if (!job) return '';
        const what = job.targets.length
            ? job.results.length === job.targets.length && job.status === 'succeeded'
                ? job.results.map(r => r.label).join(', ')
                : job.targets.map(id => this.row(id)?.label ?? id).join(', ')
            : 'nothing stale';
        if (job.status === 'queued') {
            const behind = this.sync.queuedBehind();
            return behind ? `Queued behind ${behind}: ${what}` : `Queued: ${what}`;
        }
        if (job.status === 'running') {
            return `Updating ${what} — ${job.step || 'starting…'} (${secsLabel(job.seconds)}). `
                + 'The server keeps going if you close this dialog.';
        }
        if (job.status === 'failed') return `Update of ${what} failed after ${secsLabel(job.seconds)}.`;
        return job.targets.length === 0
            ? 'Nothing was stale — nothing to update.'
            : `Updated ${what} in ${secsLabel(job.seconds)}.`;
    }

    /** Run a target (or every stale one) and keep the board's own status fresh. */
    private runUpdate(target: GsproTargetId | 'stale'): void {
        const courseId = this.openCourseId();
        if (!courseId) return;
        void this.sync.update(courseId, target);
    }

    /** The per-row bindings: marker, status line, note, manual step, blocked reason, "…" and Update. */
    private rowBindings(): Record<string, (() => unknown) | Record<string, unknown>> {
        const out: Record<string, (() => unknown) | Record<string, unknown>> = {};
        for (const target of GSPRO_TARGETS) {
            const id = target.id;
            const row = () => this.row(id);
            out[`dot_${id}`] = {
                className: () => {
                    const r = row();
                    if (!r) return 'gspro-export__dot';
                    if (r.blocked) return 'gspro-export__dot blocked';
                    return r.stale ? 'gspro-export__dot stale' : 'gspro-export__dot fresh';
                },
                title: () => {
                    const r = row();
                    if (!r) return '';
                    return r.blocked ? 'Cannot be updated now' : r.stale ? 'Out of date' : 'Up to date';
                },
            };
            out[`status_${id}`] = {
                textContent: () => {
                    this.sync.tick.get();
                    const r = row();
                    if (!r) return this.sync.loading.get() ? 'Loading…' : '';
                    return rowStatusLabel(r);
                },
                title: () => {
                    const r = row();
                    return r ? `Last updated: ${whenLabel(r.lastRun)}` : '';
                },
            };
            out[`note_${id}`] = () => row()?.note ?? '';
            out[`manual_${id}`] = () => (row()?.manual ? `then: ${row()!.manual}` : '');
            out[`blocked_${id}`] = () => row()?.blocked ?? '';
            out[`update_${id}`] = {
                title: () => {
                    const r = row();
                    if (r?.blocked) return r.blocked;
                    const about = aboutLabel(r?.seconds ?? null);
                    return `${target.description}${about ? ` Last time: ${about}.` : ''}`;
                },
                disabled: () => {
                    const r = row();
                    return this.updatesBusy() || r === null || r.blocked !== null;
                },
                onclick: () => this.runUpdate(id),
            };
            out[`toggle_${id}`] = {
                'aria-expanded': () => String(this.open.get().has(id)),
                onclick: () => this.open.update(set => {
                    const next = new Set(set);
                    if (!next.delete(id)) next.add(id);
                    return next;
                }),
            };
            out[`details_${id}`] = {
                className: () => (this.open.get().has(id) ? 'gspro-export__details' : 'gspro-export__details hidden'),
            };
        }
        return out;
    }

    render(): DocumentFragment {
        const busy = () => this.svc.busy.get();
        const noTerrain = () => this.svc.terrain.get() === null;
        const terrainText = (kind: 'inner' | 'outer') => {
            const terrain = this.svc.terrain.get();
            if (terrain) return terrainLabel(terrain[kind]);
            return this.svc.terrainNote.get() ? '—' : 'Loading…';
        };
        // The SVG export's button and file line, shown in the Course shapes row and in the SVG panel.
        const svgRunLabel = () => {
            const n = this.svc.svgExcluded.get().size;
            return n ? `Export SVG without ${n} feature${n === 1 ? '' : 's'}` : 'Export SVG';
        };
        const svgFileHint = () => {
            const file = variantFileName(this.svc.courseName.get(), this.svc.svgVariant.get());
            if (!this.svc.svgVariant.get().trim() && this.svc.svgExcluded.get().size) {
                return `Writes ${file}, over the full SVG. Name a variant to keep both.`;
            }
            return `Writes ${file}`;
        };
        const frag = this.wire(tpl, {
            root: { className: () => (this.openCourseId() ? 'gspro-export show' : 'gspro-export') },
            close: { onclick: () => this.closeDialog() },
            modal: { className: () => (this.view.get() === 'dialog' ? 'gspro-export__modal' : 'gspro-export__modal hidden') },
            backdrop: { onclick: () => this.closeDialog() },
            side: { className: () => (this.view.get() === 'svg' ? 'gspro-export__side show' : 'gspro-export__side') },
            openSvg: { onclick: () => this.view.set('svg') },
            backToDialog: { onclick: () => this.view.set('dialog') },
            closeSide: { onclick: () => this.closeDialog() },
            ...this.rowBindings(),
            // --- The board's head: Unity, the shaping worker, Update all stale ---
            unityChip: {
                textContent: () => this.sync.unityLabel(),
                title: () => this.sync.unityTitle(),
                className: () => (this.sync.status.get()?.unity.matched
                    ? 'gspro-export__chip matched' : 'gspro-export__chip'),
            },
            workerChip: {
                textContent: () => {
                    const worker = this.sync.status.get()?.worker;
                    if (!worker) return '';
                    if (!worker.reachable) return this.open.get().has('meshes') ? 'Blender: off' : '';
                    return worker.state ? `Blender: ${worker.state}` : '';
                },
                title: () => {
                    const worker = this.sync.status.get()?.worker;
                    if (!worker) return '';
                    return worker.reachable
                        ? [worker.url, worker.phase, worker.blend].filter(Boolean).join(' · ')
                        : `The Blender shaping worker is not running (${worker.error ?? worker.url}); Update meshes starts it.`;
                },
            },
            updateStale: {
                textContent: () => {
                    const n = this.sync.staleCount.get();
                    return n ? `Update all stale (${n})` : 'Update all stale';
                },
                disabled: () => this.updatesBusy() || this.sync.staleCount.get() === 0,
                onclick: () => this.runUpdate('stale'),
            },
            boardNote: () => {
                if (this.sync.status.get() === null) return this.sync.loading.get() ? 'Reading the board…' : '';
                const n = this.sync.staleCount.get();
                return n === 0 ? 'Everything that can be updated is up to date.' : `${n} row${n === 1 ? '' : 's'} out of date.`;
            },
            // --- The update job ---
            syncSection: {
                className: () => (this.sync.job.get() || this.sync.error.get()
                    ? 'gspro-export__sync' : 'gspro-export__sync hidden'),
            },
            syncStatus: () => this.jobStatusText(),
            syncError: () => this.sync.error.get(),
            // --- The folder ---
            idleNote: {
                className: () => (this.svc.job.get() || this.svc.lastPath.get() || this.svc.error.get() ? 'hint hidden' : 'hint'),
            },
            svgFileHintSide: () => svgFileHint(),
            runSide: {
                textContent: () => svgRunLabel(),
                disabled: busy,
                onclick: () => { void this.svc.run(); },
            },
            // The dialog's footer, in one line: the panel has no room for the report.
            sideStatus: {
                textContent: () => {
                    this.svc.tick.get();
                    const path = this.svc.lastPath.get();
                    return this.svc.error.get() || (this.svc.job.get()?.status === 'running' ? jobLabel(this.svc.job.get()) : path ? `Wrote ${path}` : '');
                },
                className: () => (this.svc.error.get() ? 'gspro-export__job error' : 'gspro-export__job'),
            },
            ratingsHint: () => {
                const ratings = this.svc.settings.get()?.gkdRatings ?? [];
                return ratings.length ? `The .GKD rates ${ratings.join(', ')}, which the course's tee sets do not.` : '';
            },
            readGkdRatings: {
                className: () => ((this.svc.settings.get()?.gkdRatings.length ?? 0) > 0
                    ? 'gspro-export__small gspro-export__fit' : 'gspro-export__small gspro-export__fit hidden'),
                disabled: busy,
                onclick: () => { void this.svc.readGkdRatings().then(ok => { if (ok) void this.furniture.reloadTeeSets(); }); },
            },
            dir: {
                value: () => this.svc.dirDraft.get(),
                placeholder: () => this.svc.settings.get()?.defaultDir ?? 'Downloads',
                disabled: busy,
                oninput: (e: Event) => this.svc.dirDraft.set((e.target as HTMLInputElement).value),
                // Saved as soon as the field is left, not only with an export.
                onchange: () => { void this.svc.saveDir({ quiet: true }); },
            },
            dirHint: () => {
                const settings = this.svc.settings.get();
                if (!settings) return 'Loading…';
                return this.svc.dirDraft.get().trim()
                    ? 'Saved with the course — used every time you export it.'
                    : `Leave blank for the default: ${settings.defaultDir}`;
            },
            reset: {
                disabled: () => busy() || !this.svc.dirDraft.get().trim(),
                onclick: () => {
                    this.svc.dirDraft.set('');
                    void this.svc.saveDir();
                },
            },
            innerTerrain: () => terrainText('inner'),
            outerTerrain: () => terrainText('outer'),
            terrainNote: () => {
                const note = this.svc.terrainNote.get();
                return note ? `Terrains unavailable: ${note}` : '';
            },
            meshesHint: () => `Layers under docs/gspro/${this.svc.courseName.get() || '<course>'}/shaping; `
                + 'Update does layers, Blender and Unity.',
            // The long version — what keeps a hand move — is the (i) tip above it (TIP.props).
            propsHint: () => `Spec in docs/gspro/${(this.svc.courseName.get() || '<course>').toLowerCase()}/*-props.gen.py; `
                + 'Update runs it, Blender and Unity.',
            jobSection: {
                className: () => (this.svc.job.get()
                    ? 'gspro-export__section' : 'gspro-export__section hidden'),
            },
            jobNote: () => {
                this.svc.tick.get();  // re-render the elapsed time on every poll
                return jobLabel(this.svc.job.get());
            },
            resultSection: {
                className: () => (this.svc.lastPath.get()
                    ? 'gspro-export__section' : 'gspro-export__section hidden'),
            },
            resultPath: () => {
                const path = this.svc.lastPath.get();
                return path ? `Wrote ${path}` : '';
            },
            errorSection: {
                className: () => (this.svc.error.get()
                    ? 'gspro-export__section' : 'gspro-export__section hidden'),
            },
            error: () => this.svc.error.get(),
            run: {
                textContent: () => svgRunLabel(),
                disabled: busy,
                onclick: () => { void this.svc.run(); },
            },
            svgVariant: {
                value: () => this.svc.svgVariant.get(),
                disabled: busy,
                oninput: (e: Event) => this.svc.setSvgVariant((e.target as HTMLInputElement).value),
            },
            svgFileHint: () => svgFileHint(),
            // The way into the SVG panel, from the Course shapes row.
            excludeSummary: () => {
                const n = this.svc.svgExcluded.get().size;
                if (this.svc.svgBisect.get()) return 'Bisect in progress: open the SVG test variants…';
                return n ? `${n} feature${n === 1 ? '' : 's'} left out: SVG test variants…` : 'Leave features out, find what breaks a build: SVG test variants…';
            },
            excludeSelected: {
                textContent: () => `Exclude selected (${this.features.selectedIds.get().size})`,
                title: 'Leave out the features selected on the map',
                disabled: () => busy() || this.features.selectedIds.get().size === 0,
                onclick: () => this.svc.excludeFromSvg(this.features.selectedIds.peek()),
            },
            includeSelected: {
                textContent: () => `Include selected (${this.features.selectedIds.get().size})`,
                title: 'Put the features selected on the map back in',
                disabled: () => busy() || this.features.selectedIds.get().size === 0,
                onclick: () => this.svc.includeInSvg(this.features.selectedIds.peek()),
            },
            filterStatus: {
                value: () => this.filter.get().status,
                onchange: (e: Event) => this.setFilter({ status: (e.target as HTMLSelectElement).value as SvgStatusFilter }),
            },
            filterText: {
                value: () => this.filter.get().text,
                oninput: (e: Event) => this.setFilter({ text: (e.target as HTMLInputElement).value }),
            },
            excludeShown: {
                textContent: () => `Exclude ${this.shown.get().length} shown`,
                disabled: () => busy() || this.shown.get().length === 0,
                onclick: () => this.svc.excludeFromSvg(this.shown.peek().map(f => f.id)),
            },
            includeShown: {
                textContent: () => `Include ${this.shown.get().length} shown`,
                disabled: () => busy() || this.shown.get().length === 0,
                onclick: () => this.svc.includeInSvg(this.shown.peek().map(f => f.id)),
            },
            listMore: () => {
                const n = this.shown.get().length;
                if (this.svgItems.get().length === 0) return 'No features the SVG writes on this course yet.';
                if (n === 0) return 'Nothing matches the filter.';
                return n > LIST_LIMIT ? `Showing ${LIST_LIMIT} of ${n}; narrow the filter to see the rest.` : '';
            },
            bisectStartRow: {
                className: () => (this.svc.svgBisect.get() ? 'gspro-export__option hidden' : 'gspro-export__option'),
            },
            bisectStart: {
                textContent: () => `Bisect the ${this.shown.get().length} shown`,
                disabled: () => busy() || this.shown.get().length < 2,
                onclick: () => {
                    this.svc.startSvgBisect(spatialOrder(this.shown.peek()));
                    void this.svc.run();
                },
            },
            bisectBox: {
                className: () => (this.svc.svgBisect.get() ? 'gspro-export__bisect' : 'gspro-export__bisect hidden'),
            },
            bisectStatus: () => this.bisectStatus(),
            bisectAnswers: {
                className: () => (this.svc.svgBisect.get()?.result ? 'gspro-export__row hidden' : 'gspro-export__row'),
            },
            bisectOk: {
                disabled: () => busy() || !this.svc.svgBisect.get()?.exported,
                onclick: () => { void this.svc.answerSvgBisect(true); },
            },
            bisectFailed: {
                disabled: () => busy() || !this.svc.svgBisect.get()?.exported,
                onclick: () => { void this.svc.answerSvgBisect(false); },
            },
            bisectCulprit: {
                className: () => (this.svc.svgBisect.get()?.candidates.length === 1
                    ? 'gspro-export__link' : 'gspro-export__link hidden'),
                onclick: () => {
                    const id = this.svc.svgBisect.peek()?.candidates[0];
                    const f = id ? this.features.store.items.peek().find(x => x.id === id) : undefined;
                    if (f) this.showOnMap(f);
                },
            },
            bisectSuspects: {
                onclick: () => this.filter.set({ ...NO_FILTER, status: 'suspects' }),
            },
            bisectUndo: {
                disabled: () => busy() || !(this.svc.svgBisect.get()?.history.length || this.svc.svgBisect.get()?.result),
                onclick: () => this.svc.undoSvgBisect(),
            },
            bisectStop: {
                disabled: busy,
                onclick: () => this.svc.stopSvgBisect(),
            },
            clearExclusions: {
                disabled: () => busy() || this.svc.svgExcluded.get().size === 0,
                onclick: () => this.svc.clearSvgExclusions(),
            },
            orthoField: {
                className: () => ((this.svc.orthoSources.get()?.length ?? 0) > 0
                    ? 'gspro-export__field' : 'gspro-export__field hidden'),
            },
            orthoSource: {
                value: () => this.svc.orthoSource.get(),
                disabled: busy,
                onchange: (e: Event) => this.svc.orthoSource.set((e.target as HTMLSelectElement).value),
            },
            terrainDarken: {
                value: () => this.svc.terrainDarken.get(),
                placeholder: () => '0.4',
                disabled: busy,
                oninput: (e: Event) => this.svc.terrainDarken.set((e.target as HTMLInputElement).value),
            },
            orthoNote: () => {
                const sources = this.svc.orthoSources.get();
                if (!sources) return 'Loading…';
                return sources.length === 0 ? 'No orthophoto on this machine for this course — build its map first.' : '';
            },
            tintTerrain: {
                checked: () => this.svc.tintTerrain.get(),
                disabled: busy,
                onchange: (e: Event) => this.svc.tintTerrain.set((e.target as HTMLInputElement).checked),
            },
            tintOpacityField: {
                className: () => (this.svc.tintTerrain.get() ? 'gspro-export__field' : 'gspro-export__field hidden'),
            },
            tintOpacity: {
                value: () => this.svc.tintOpacity.get(),
                placeholder: () => '0.5',
                disabled: busy,
                oninput: (e: Event) => this.svc.tintOpacity.set((e.target as HTMLInputElement).value),
            },
            removeBuildings: {
                checked: () => this.svc.removeBuildings.get(),
                disabled: busy,
                onchange: (e: Event) => this.svc.removeBuildings.set((e.target as HTMLInputElement).checked),
            },
            forestFloor: {
                checked: () => this.svc.forestFloor.get(),
                disabled: busy,
                onchange: (e: Event) => this.svc.forestFloor.set((e.target as HTMLInputElement).checked),
            },
            floorFields: {
                className: () => (this.svc.forestFloor.get() ? 'gspro-export__floor' : 'gspro-export__floor hidden'),
            },
            floorColor: {
                value: () => this.svc.floorColor.get(),
                disabled: busy,
                oninput: (e: Event) => this.svc.floorColor.set((e.target as HTMLInputElement).value),
            },
            floorMix: {
                value: () => this.svc.floorMix.get(),
                placeholder: () => '0.5',
                disabled: busy,
                oninput: (e: Event) => this.svc.floorMix.set((e.target as HTMLInputElement).value),
            },
            runOrtho: {
                textContent: 'Export',
                title: 'Export inner orthophoto JPEG',
                disabled: () => busy() || !this.svc.orthoSource.get(),
                onclick: () => { void this.svc.runOrtho(); },
            },
            runOuterOrtho: {
                textContent: 'Export',
                title: 'Export outer orthophoto JPEG',
                disabled: () => busy() || !this.svc.orthoSource.get() || noTerrain(),
                onclick: () => { void this.svc.runOuterOrtho(); },
            },
            runCleanOrtho: {
                textContent: 'Export',
                title: 'Export inner cleaned orthophoto',
                disabled: () => busy() || !this.svc.orthoSource.get(),
                onclick: () => { void this.svc.runOrtho(true); },
            },
            runCleanOuterOrtho: {
                textContent: 'Export',
                title: 'Export outer cleaned orthophoto',
                disabled: () => busy() || !this.svc.orthoSource.get() || noTerrain(),
                onclick: () => { void this.svc.runOuterOrtho(true); },
            },
            runUnityOrtho: {
                textContent: '→ Unity',
                title: 'Inner cleaned photo → Unity meshes',
                disabled: () => busy() || !this.svc.orthoSource.get(),
                onclick: () => { void this.svc.runUnityOrtho(); },
            },
            outerOrthoTip: () => {
                const terrain = this.svc.terrain.get();
                const side = terrain ? `${terrain.outer.sideM} m` : 'the';
                return `The picked vintage over ${side} outer square, 8192 × 8192 px, plain and -terrain twin. `
                    + 'Fetched from Lantmäteriet the first time and kept with the course\'s map sources.';
            },
            runInnerDem: {
                textContent: 'Export',
                title: 'Export inner heightmap (RAW + GeoTIFF)',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runDem('inner'); },
            },
            runInnerUnity: {
                textContent: '→ Unity',
                title: 'Inner heightmap → Unity',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runUnityTerrain('inner'); },
            },
            runOuterUnity: {
                textContent: '→ Unity',
                title: 'Outer heightmap → Unity',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runUnityTerrain('outer'); },
            },
            runInnerSculpt: {
                textContent: 'Pull from Unity',
                title: 'Pull the inner terrain\'s sculpt from Unity',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runUnitySculpt('inner'); },
            },
            runOuterSculpt: {
                textContent: 'Pull from Unity',
                title: 'Pull the outer terrain\'s sculpt from Unity',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runUnitySculpt('outer'); },
            },
            runOuterDem: {
                textContent: 'Export',
                title: 'Export outer heightmap (RAW + GeoTIFF)',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runDem('outer'); },
            },
            courseDir: {
                value: () => this.svc.courseDirDraft.get(),
                disabled: busy,
                oninput: (e: Event) => this.svc.courseDirDraft.set((e.target as HTMLInputElement).value),
                onchange: () => { void this.svc.saveCourseDir({ quiet: true }); },
            },
            teeHint: () => {
                const sets = this.furniture.teeSets.get();
                if (sets.length === 0) return 'No tee sets yet: add them in Furniture › Tee sets.';
                const out = sets.filter(set => !set.gsproTee).map(set => set.name);
                return out.length ? `Not exported: ${out.join(', ')}.` : '';
            },
            gkdHint: () => {
                const settings = this.svc.settings.get();
                const draft = this.svc.courseDirDraft.get().trim();
                if (!settings || !draft) return '';
                if (settings.courseDir === draft && settings.gkdFile) return `Writes ${settings.gkdFile} there.`;
                return 'Saved with the course when you export.';
            },
            ...Object.fromEntries(META_TEXT.map(([key]) => [`meta_${key}`, {
                value: () => this.svc.metaDraft.get()[key] as string,
                disabled: busy,
                onchange: (e: Event) => { void this.svc.editMeta({ [key]: (e.target as HTMLInputElement).value }); },
            }])),
            meta_description: {
                value: () => this.svc.metaDraft.get().description,
                disabled: busy,
                onchange: (e: Event) => { void this.svc.editMeta({ description: (e.target as HTMLTextAreaElement).value }); },
            },
            meta_difficulty: {
                value: () => String(this.svc.metaDraft.get().difficulty),
                disabled: busy,
                onchange: (e: Event) => {
                    const n = Number((e.target as HTMLInputElement).value.trim().replace(',', '.'));
                    if (Number.isFinite(n) && n >= 0) void this.svc.editMeta({ difficulty: n });
                    else this.svc.error.set('Difficulty must be a number, 0 or more');
                },
            },
            ...Object.fromEntries(GKD_KEYWORDS.map(k => [`kw_${k}`, {
                checked: () => this.svc.metaDraft.get().keywords.includes(k),
                disabled: busy,
                onchange: (e: Event) => {
                    const on = new Set(this.svc.metaDraft.peek().keywords);
                    if ((e.target as HTMLInputElement).checked) on.add(k); else on.delete(k);
                    void this.svc.editMeta({ keywords: GKD_KEYWORDS.filter(x => on.has(x)) });
                },
            }])),
            metaHint: () => {
                const settings = this.svc.settings.get();
                if (!settings?.gkdMeta) return '';
                // Ratings are the tee sets': the file's differ until read in (or until the export writes the sets').
                const ratings = settings.gkdRatings.length
                    ? ` The .GKD rates ${settings.gkdRatings.join(', ')}, which the course's tee sets do not.`
                    : '';
                if (!settings.meta) return 'Course details shown from the .GKD. Change one, or read them in, to keep them with the course.' + ratings;
                const diff = this.svc.gkdMetaDiff;
                return (diff.length
                    ? `The .GKD has a different ${diff.join(', ')} (saved in GreenKeeper?). The export writes the ones here over it.`
                    : '') + ratings;
            },
            readGkdMeta: {
                className: () => {
                    const settings = this.svc.settings.get();
                    const offer = !!settings?.gkdMeta
                        && (!settings.meta || this.svc.gkdMetaDiff.length > 0 || settings.gkdRatings.length > 0);
                    return offer ? 'gspro-export__link' : 'gspro-export__link hidden';
                },
                disabled: busy,
                // The file's ratings went onto the tee sets too.
                onclick: () => { void this.svc.readGkdMeta().then(ok => { if (ok) void this.furniture.reloadTeeSets(); }); },
            },
            runGkd: {
                textContent: () => (busy() ? 'Exporting…' : 'Export GreenKeeper course file'),
                disabled: () => busy() || noTerrain() || !this.svc.courseDirDraft.get().trim(),
                onclick: () => { void this.svc.runGkd(); },
            },
            runInnerHillshade: {
                textContent: 'Export',
                title: 'Export inner hillshade JPEG',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runHillshade('inner'); },
            },
            runOuterHillshade: {
                textContent: 'Export',
                title: 'Export outer hillshade JPEG',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runHillshade('outer'); },
            },
            runInnerTrees: {
                textContent: 'Export',
                title: 'Export inner trees',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runTrees('inner'); },
            },
            runOuterTrees: {
                textContent: 'Export',
                title: 'Export outer trees',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runTrees('outer'); },
            },
            runInnerBuildings: {
                textContent: 'Export',
                title: 'Export inner buildings',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runBuildings('inner'); },
            },
            runOuterBuildings: {
                textContent: 'Export',
                title: 'Export outer buildings',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runBuildings('outer'); },
            },
            runInnerZones: {
                textContent: 'Export',
                title: 'Export inner vegetation zones',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runZones('inner'); },
            },
            runOuterZones: {
                textContent: 'Export',
                title: 'Export outer vegetation zones',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runZones('outer'); },
            },
            runCreeks: {
                textContent: 'Export',
                title: 'Export creeks',
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runCreeks(); },
            },
        });

        const root = this.ref(frag, 'root') as HTMLElement;
        this.sideEl = this.ref(frag, 'side') as HTMLElement;
        this.track(attachInfoTips(root));

        // The job's phases, drawn the way the Terrain editor draws a shaping job's.
        this.spawn(JobPhasesComponent, this.ref(frag, 'phasesHost'), {
            phases: () => this.sync.job.get()?.phases ?? [],
            testid: 'gspro-job-phases',
        });

        // Each finished target's report, collapsed; the last one open, since
        // that is the one the operator just watched.
        const results = this.ref(frag, 'syncResults');
        this.track(effect(() => {
            const job = this.sync.job.get();
            const rows = job && job.status !== 'queued' ? job.results : [];
            results.replaceChildren();
            rows.forEach((result, i) => {
                const box = document.createElement('details');
                box.dataset.target = result.target;
                if (i === rows.length - 1) box.open = true;
                const head = document.createElement('summary');
                head.textContent = `${result.label} — ${result.error ? 'failed' : 'done'} in ${secsLabel(result.seconds)}`;
                box.append(head);
                const list = document.createElement('ul');
                for (const line of result.error ? [result.error, ...result.report] : result.report) {
                    const li = document.createElement('li');
                    li.textContent = line;
                    list.append(li);
                }
                box.append(list);
                results.append(box);
            });
        }));

        // The two halves of the dialog open and close together: the board can
        // be opened from the command bar (GsproSyncService) and the file
        // exports from here (GsproExportService).
        this.track(effect(() => {
            const id = this.svc.courseId.get();
            if (id) {
                if (this.sync.courseId.peek() !== id) void this.sync.openFor(id);
            } else if (this.sync.courseId.peek() !== null) {
                this.sync.close();
            }
        }));
        this.track(effect(() => {
            const id = this.sync.courseId.get();
            if (id && this.svc.courseId.peek() !== id) {
                void this.svc.openFor(id, this.courseDetail.course.peek()?.name ?? '');
            }
        }));

        // Opening shows the dialog, or the SVG panel while a bisect is waiting for its answer.
        this.track(effect(() => {
            if (this.svc.courseId.get()) this.view.set(this.svc.svgBisect.peek() ? 'svg' : 'dialog');
        }));

        // Esc closes the dialog, and only the dialog: with the SVG panel up
        // the map's tools own the key.
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || !this.svc.courseId.peek() || this.view.peek() !== 'dialog') return;
            // An open (i) popup takes the key first: Esc closes that, not the dialog under it.
            if (document.getElementById('info-tip-popup')?.style.display === 'block') return;
            e.stopPropagation();
            this.closeDialog();
        };
        window.addEventListener('keydown', onKeyDown, true);
        this.track(() => window.removeEventListener('keydown', onKeyDown, true));

        // The exclusions are marked on the map while the panel is open, and
        // the list needs the course's features even when Draw never loaded them.
        this.track(effect(() => {
            const courseId = this.svc.courseId.get();
            const excluded = this.svc.svgExcluded.get();
            this.features.exportExcludedIds.set(courseId ? excluded : new Set());
            if (courseId) void this.features.load(courseId);
        }));

        // Filter selects: every SVG type the course has (with its count), and
        // the holes plus "No hole" (the SVG's Others and Roads layers).
        const optionsOf = (
            bind: string,
            options: () => { value: string; label: string }[],
            current: () => string,
            onPick: (value: string) => void,
        ) => {
            const select = this.ref(frag, bind) as HTMLSelectElement;
            select.onchange = () => onPick(select.value);
            this.$each(select, options, (opt, _i, track) => {
                const option = document.createElement('option');
                option.value = opt.value;
                // Keyed by value, so a reused option updates its count here.
                track(effect(() => {
                    option.textContent = options().find(o => o.value === opt.value)?.label ?? opt.label;
                }));
                return option;
            }, opt => opt.value);
            // After the options are in: a re-render must not leave the select showing another value.
            this.track(effect(() => {
                options();
                select.value = current();
            }));
        };
        optionsOf('filterType', () => {
            const counts = new Map<string, number>();
            for (const f of this.svgItems.get()) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
            return [
                { value: '', label: `All types (${this.svgItems.get().length})` },
                ...SVG_FEATURE_TYPES.filter(type => counts.has(type)).map(type => ({
                    value: type, label: `${FEATURE_STYLES[type as FeatureType]?.label ?? type} (${counts.get(type)})`,
                })),
            ];
        }, () => this.filter.get().type, type => this.setFilter({ type }));
        optionsOf('filterHole', () => [
            { value: '', label: 'All holes' },
            { value: COURSE_WIDE, label: 'No hole' },
            ...[...this.courseDetail.holes.get()].sort((a, b) => a.number - b.number)
                .map(h => ({ value: h.id, label: `Hole ${h.number}` })),
        ], () => this.filter.get().hole, hole => this.setFilter({ hole }));

        this.$each(
            this.ref(frag, 'featureList'),
            () => this.shown.get().slice(0, LIST_LIMIT),
            (f, _i, track) => {
                const excluded = () => this.svc.svgExcluded.get().has(f.id);
                const hole = f.holeId ? this.courseDetail.holes.peek().find(h => h.id === f.holeId) : undefined;
                const style = FEATURE_STYLES[f.type as FeatureType];
                return this.wireEl(rowTpl, {
                    row: { className: () => (excluded() ? 'gspro-export__feature excluded' : 'gspro-export__feature') },
                    check: {
                        checked: () => !excluded(),
                        onchange: () => this.svc.toggleSvgExcluded(f.id),
                    },
                    swatch: { style: `background: ${style?.draw ?? '#888'}` },
                    name: {
                        textContent: () => this.describe(f) + (f.source ? ` · ${f.source}` : ''),
                        // The SVG's layer: roads get their own, whatever hole they are on.
                        title: `Show it on the map. Id ${f.id}, in the SVG's `
                            + `${f.type === 'path' ? 'Roads' : hole ? `Hole${hole.number}` : 'Others'} layer.`,
                        onclick: () => this.showOnMap(f),
                    },
                    where: () => shapeName(f, hole?.number),
                    locate: { onclick: () => this.showOnMap(f) },
                }, track);
            },
            f => f.id,
        );

        // The course's tee sets: which of GSPro's eight each is exported as,
        // and which of its two ratings GSPro shows. Rows are kept per set.
        this.$each(
            this.ref(frag, 'teeRows'),
            () => this.furniture.teeSets.get(),
            (first, _i, track) => {
                const row = document.createElement('div');
                row.className = 'gspro-export__tee-row';
                row.dataset.testid = 'gspro-tee-set';
                row.innerHTML = '<span class="gspro-export__tee-name"><span class="gspro-export__tee-dot"></span><b></b><i></i></span>'
                    + '<select aria-label="GSPro tee"></select><select aria-label="Rating GSPro shows"></select>';
                const dot = row.querySelector('.gspro-export__tee-dot') as HTMLElement;
                const [tee, rating] = [...row.querySelectorAll('select')];
                tee.append(new Option('Not in GSPro', ''), ...GKD_TEE_TYPES.map(type => new Option(type, type)));
                rating.append(new Option('', 'men'), new Option('', 'women'));
                tee.onchange = () => { void this.furniture.updateTeeSet(first.id, { gsproTee: (tee.value || null) as GkdTeeType | null }); };
                rating.onchange = () => { void this.furniture.updateTeeSet(first.id, { gsproRating: rating.value as 'men' | 'women' }); };
                track(effect(() => {
                    const set = this.furniture.teeSets.get().find(s => s.id === first.id) ?? first;
                    dot.style.background = teeFill(set.color);
                    row.querySelector('b')!.textContent = set.name;
                    row.querySelector('i')!.textContent = set.gsproOnly ? 'GSPro only' : '';
                    tee.value = set.gsproTee ?? '';
                    rating.options[0].textContent = `Men ${gkdRating(set.ratingMen, set.slopeMen) ?? '–'}`;
                    rating.options[1].textContent = `Women ${gkdRating(set.ratingWomen, set.slopeWomen) ?? '–'}`;
                    rating.value = set.gsproRating;
                    tee.disabled = rating.disabled = this.svc.busy.get();
                }));
                return row;
            },
            set => set.id,
        );

        // One <option> per persisted vintage; the value is the server's
        // `source` handle, the label the collection plus what it is.
        const select = this.ref(frag, 'orthoSource') as HTMLSelectElement;
        this.$each(
            select,
            () => this.svc.orthoSources.get() ?? [],
            (source, _i, track) => {
                const option = document.createElement('option');
                option.value = source.source;
                option.textContent = orthoSourceLabel(source);
                track;
                return option;
            },
        );

        // The exporter's own report lines (counts, skipped types, warnings) —
        // the "Wrote …" line is shown above as the path.
        this.$each(
            this.ref(frag, 'report'),
            () => this.svc.report.get().filter(line => !line.startsWith('Wrote ')),
            (line, _i, track) => {
                const li = document.createElement('li');
                li.textContent = line;
                track;
                return li;
            },
        );

        return frag;
    }
}
