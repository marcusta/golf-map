// Floating panel for the GSPro/OPCD exports: the course SVG, the square
// orthophoto JPEGs (8192 px, quality 92), the square DEM GeoTIFFs + Unity
// .raw heightmaps and the hillshade JPEGs for the two GSPro terrains — the
// INNER one the map was built over and the 5 km OUTER one centred on it —
// and GreenKeeper's .GKD, written into the course's own GSPro folder.
// Spawned once by CourseDetailComponent; hidden
// until the command bar's ⋯ menu calls GsproExportService.openFor(). Docks
// at the map's right edge like the import wizards.
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
import { icon } from '../ui/icons';
import { infoTip, infoTipStyles, attachInfoTips } from '../ui/info-tip';

// The longer explanations sit behind (i) tips (ui/info-tip.ts); what stays in
// view is only what the operator must act on — a missing map, unavailable
// terrains, where the next file goes.
const TIP = {
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
    unityOrtho: 'Renders the inner photo with the Clean tool\'s baked edits (the picked vintage\'s patched copy when there is '
        + 'one) and the two boxes above as ticked, then puts its -meshes file onto the texture the course meshes sample in the '
        + 'open Unity editor whose GolfMap course imports from this folder. The old texture is backed up in the project\'s '
        + 'GolfMapSpelunk/ortho-backups first. Bake pending Clean edits before this: unbaked ones are not in the photo. Unity '
        + 'must be open with the course active; save the project to keep it.',
    unityTerrain: 'Exports the heightmap, then puts it onto the terrain in the open Unity editor whose GolfMap course imports '
        + 'from this folder: heights, size and (outer) position, on the same Terrain objects and data, so vegetation and '
        + 'references stay. Each terrain is backed up in the course\'s Backups folder first. Unity must be open with the course '
        + 'active. Then Terrain › Export To OBJ in Unity for Blender; save the scene to keep it.',
    unitySculpt: 'Captures what you sculpted on that terrain in Unity since golf-map\'s heightmap went in (the terrain conform '
        + 'left out) and keeps it as the terrain\'s one "Unity sculpt" edit: heights added on top of every other edit, so the '
        + 'map, the analysis and every later export carry it. A new capture replaces the layer with the whole sculpt; nothing '
        + 'sculpted removes it. Unity must be open with the course active. Then Apply to terrain, and the heightmap → Unity.',
    creeks: 'The creeks as NatureManufacture R.A.M. splines for GolfMap › Creeks in Unity: each creek\'s line (drawn, or found '
        + 'down its polygon) with control points at its water surface, which only falls downstream — the surface "Dig creeks" '
        + 'digs the bed below. Inner terrain. Export the inner heightmap first — the heights are measured from its zero.',
    gkd: 'GreenKeeper\'s course file, which GSPro reads for tee boxes (by tee colour), pins, green centres, aim points, water '
        + 'hazards and the out-of-bounds line, as positions on the inner terrain. Water is staked at least 0.5 m outside the '
        + 'water and out to where its bank ends (up to 3 m); drawn penalty areas go in as drawn. It is merged into the .GKD '
        + 'already in the folder, so the course name, location, ratings and range you set in GreenKeeper stay; the first '
        + 'run keeps the original as .GKD.bak. Export the inner heightmap first, and close the course in GreenKeeper while '
        + 'exporting or it will save its own copy over this one.',
    courseDir: 'The course\'s folder under GSPro\'s Courses (e.g. C:\\GSProV1\\Core\\GSP\\Courses\\<scene>), the one holding '
        + 'its .gspcrse — not the export folder. Saved with the course.',
};

const tpl = template(`
    <div bind="root" class="gspro-export">
        <div class="gspro-export__header">
            <h3>Export to GSPro</h3>
            <button bind="close" type="button" aria-label="Close" title="Close">${icon('x')}</button>
        </div>

        <div class="gspro-export__section">
            <label class="gspro-export__field">Folder on this machine
                <input bind="dir" type="text" spellcheck="false" autocomplete="off" />
            </label>
            <div bind="dirHint" class="hint"></div>
            <button bind="reset" type="button" class="gspro-export__link">Use the default folder</button>
        </div>

        <div class="gspro-export__section gspro-export__terrains">
            <div class="gspro-export__head">Terrains ${infoTip({ text: TIP.terrains })}</div>
            <div class="gspro-export__terrain"><b>Inner terrain</b> <span bind="innerTerrain"></span></div>
            <div class="gspro-export__terrain"><b>Outer terrain</b> <span bind="outerTerrain"></span></div>
            <div bind="terrainNote" class="hint gspro-export__warn"></div>
        </div>

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

        <div class="gspro-export__section actions">
            <div class="gspro-export__head">Course SVG ${infoTip({ text: TIP.svg })}</div>
            <label class="gspro-export__field"><span class="gspro-export__label">Variant name ${infoTip({ text: TIP.variant })}</span>
                <input bind="svgVariant" type="text" spellcheck="false" autocomplete="off" placeholder="blank = the full SVG" data-testid="gspro-svg-variant" />
            </label>
            <div bind="svgFileHint" class="hint"></div>
            <button bind="run" type="button" class="gspro-export__run"></button>
            <details class="gspro-export__exclude">
                <summary><span bind="excludeSummary"></span> ${infoTip({ text: TIP.exclude })}</summary>
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
            </details>
        </div>

        <div class="gspro-export__section actions">
            <div class="gspro-export__head">Orthophoto textures ${infoTip({ text: TIP.ortho })}</div>
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
            <button bind="runOrtho" type="button" class="gspro-export__run gspro-export__run-ortho"></button>
            <div class="gspro-export__row">
                <button bind="runOuterOrtho" type="button" class="gspro-export__run gspro-export__run-outer-ortho"></button>
                ${infoTip({ bind: 'outerOrthoTip' })}
            </div>
        </div>

        <div class="gspro-export__section actions">
            <div class="gspro-export__head">Cleaned orthophoto textures ${infoTip({ text: TIP.clean })}</div>
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
            <button bind="runCleanOrtho" type="button" class="gspro-export__run gspro-export__run-clean-ortho"></button>
            <button bind="runCleanOuterOrtho" type="button" class="gspro-export__run gspro-export__run-clean-outer-ortho"></button>
            <div class="gspro-export__head">Cleaned photo into Unity ${infoTip({ text: TIP.unityOrtho })}</div>
            <button bind="runUnityOrtho" type="button" class="gspro-export__run gspro-export__run-unity-ortho" data-testid="gspro-unity-ortho"></button>
        </div>

        <div class="gspro-export__section actions">
            <div class="gspro-export__head">Heightmaps ${infoTip({ text: TIP.dem })}</div>
            <button bind="runInnerDem" type="button" class="gspro-export__run gspro-export__run-inner-dem"></button>
            <button bind="runOuterDem" type="button" class="gspro-export__run gspro-export__run-outer-dem"></button>
            <div class="gspro-export__head">Heightmap into Unity ${infoTip({ text: TIP.unityTerrain })}</div>
            <button bind="runInnerUnity" type="button" class="gspro-export__run gspro-export__run-inner-unity" data-testid="gspro-inner-unity"></button>
            <button bind="runOuterUnity" type="button" class="gspro-export__run gspro-export__run-outer-unity" data-testid="gspro-outer-unity"></button>
            <div class="gspro-export__head">Unity sculpt back to golf-map ${infoTip({ text: TIP.unitySculpt })}</div>
            <button bind="runInnerSculpt" type="button" class="gspro-export__run gspro-export__run-inner-sculpt" data-testid="gspro-inner-sculpt"></button>
            <button bind="runOuterSculpt" type="button" class="gspro-export__run gspro-export__run-outer-sculpt" data-testid="gspro-outer-sculpt"></button>
        </div>

        <div class="gspro-export__section actions">
            <div class="gspro-export__head">GreenKeeper course file (.GKD) ${infoTip({ text: TIP.gkd })}</div>
            <label class="gspro-export__field"><span class="gspro-export__label">GSPro course folder ${infoTip({ text: TIP.courseDir })}</span>
                <input bind="courseDir" type="text" spellcheck="false" autocomplete="off" placeholder="C:\\GSProV1\\Core\\GSP\\Courses\\<scene>" />
            </label>
            <div bind="gkdHint" class="hint"></div>
            <button bind="runGkd" type="button" class="gspro-export__run gspro-export__run-gkd"></button>
        </div>

        <div class="gspro-export__section actions">
            <div class="gspro-export__head">Hillshades ${infoTip({ text: TIP.hillshade })}</div>
            <button bind="runInnerHillshade" type="button" class="gspro-export__run gspro-export__run-inner-hillshade"></button>
            <button bind="runOuterHillshade" type="button" class="gspro-export__run gspro-export__run-outer-hillshade"></button>
        </div>

        <div class="gspro-export__section actions">
            <div class="gspro-export__head">Trees ${infoTip({ text: TIP.trees })}</div>
            <button bind="runInnerTrees" type="button" class="gspro-export__run gspro-export__run-inner-trees"></button>
            <button bind="runOuterTrees" type="button" class="gspro-export__run gspro-export__run-outer-trees"></button>
        </div>

        <div class="gspro-export__section actions">
            <div class="gspro-export__head">Buildings ${infoTip({ text: TIP.buildingsFile })}</div>
            <button bind="runInnerBuildings" type="button" class="gspro-export__run gspro-export__run-inner-buildings"></button>
            <button bind="runOuterBuildings" type="button" class="gspro-export__run gspro-export__run-outer-buildings"></button>
        </div>

        <div class="gspro-export__section actions">
            <div class="gspro-export__head">Vegetation zones ${infoTip({ text: TIP.zones })}</div>
            <button bind="runInnerZones" type="button" class="gspro-export__run gspro-export__run-inner-zones"></button>
            <button bind="runOuterZones" type="button" class="gspro-export__run gspro-export__run-outer-zones"></button>
        </div>

        <div class="gspro-export__section actions">
            <div class="gspro-export__head">Creeks ${infoTip({ text: TIP.creeks })}</div>
            <button bind="runCreeks" type="button" class="gspro-export__run gspro-export__run-creeks"></button>
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
            font-size: 0.8rem;
            color: ${t('color-text-primary')};
            &.show { display: flex; }

            & .gspro-export__header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: var(--space-3) var(--space-4);
                border-bottom: 1px solid ${t('color-border-default')};
                & h3 { margin: 0; ${panelTitle()} }
                & button {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 2px ${s('sm')};
                    font-size: 0.8rem;
                    ${btn()}
                }
            }

            & .gspro-export__section {
                padding: var(--space-3) var(--space-4);
                border-bottom: 1px solid ${t('color-border-default')};
                display: flex;
                flex-direction: column;
                gap: var(--space-2);
                &.hidden { display: none; }
                &.actions:last-child { border-bottom: none; }
            }

            & .gspro-export__check {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 12px;
            }

            /* A section's name with its (i), and option rows that carry one. */
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

            & .gspro-export__exclude {
                & > summary {
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: ${s('xs')};
                    font-size: 0.72rem;
                    color: ${t('color-text-secondary')};
                }
                &[open] {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-2);
                }
            }
            & .gspro-export__small {
                flex: 1;
                ${btn()}
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.7rem;
                &:disabled { opacity: 0.45; cursor: default; }
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

            & .gspro-export__run { ${primaryBtn()} padding: ${s('sm')} ${s('md')}; }
            /* The recipe has no disabled look; a button waiting for its input must not read as ready. */
            & .gspro-export__run:disabled { opacity: 0.45; cursor: default; }
        }
    `;

    private svc = this.inject(GsproExportService);
    private features = this.inject(FeaturesService);
    private courseDetail = this.inject(CourseDetailService);
    private mapSvc = this.inject(MapService);
    /** The panel element, measured so a located feature is framed clear of it. */
    private root: HTMLElement | null = null;

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
        const panel = this.root?.offsetWidth ?? 0;
        const padding = { top: 96, bottom: 96, left: 96, right: panel + 48 };
        if (Number.isFinite(w)) this.mapSvc.fitBounds([w, south, e, n], { maxZoom: 19, padding });
    }

    render(): DocumentFragment {
        const busy = () => this.svc.busy.get();
        const noTerrain = () => this.svc.terrain.get() === null;
        const terrainText = (kind: 'inner' | 'outer') => {
            const terrain = this.svc.terrain.get();
            if (terrain) return terrainLabel(terrain[kind]);
            return this.svc.terrainNote.get() ? '—' : 'Loading…';
        };
        const frag = this.wire(tpl, {
            root: { className: () => (this.svc.courseId.get() ? 'gspro-export show' : 'gspro-export') },
            close: { onclick: () => this.svc.close() },
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
                textContent: () => {
                    if (busy()) return 'Exporting…';
                    const n = this.svc.svgExcluded.get().size;
                    return n ? `Export SVG without ${n} feature${n === 1 ? '' : 's'}` : 'Export SVG';
                },
                disabled: busy,
                onclick: () => { void this.svc.run(); },
            },
            svgVariant: {
                value: () => this.svc.svgVariant.get(),
                disabled: busy,
                oninput: (e: Event) => this.svc.setSvgVariant((e.target as HTMLInputElement).value),
            },
            svgFileHint: () => {
                const file = variantFileName(this.svc.courseName.get(), this.svc.svgVariant.get());
                if (!this.svc.svgVariant.get().trim() && this.svc.svgExcluded.get().size) {
                    return `Writes ${file}, over the full SVG. Name a variant to keep both.`;
                }
                return `Writes ${file}`;
            },
            excludeSummary: () => {
                const n = this.svc.svgExcluded.get().size;
                return n ? `Leave features out: ${n} excluded` : 'Leave features out (test variants)';
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
                textContent: () => (busy() ? 'Exporting…' : 'Export inner orthophoto JPEG'),
                disabled: () => busy() || !this.svc.orthoSource.get(),
                onclick: () => { void this.svc.runOrtho(); },
            },
            runOuterOrtho: {
                textContent: () => (busy() ? 'Exporting…' : 'Export outer orthophoto JPEG'),
                disabled: () => busy() || !this.svc.orthoSource.get() || noTerrain(),
                onclick: () => { void this.svc.runOuterOrtho(); },
            },
            runCleanOrtho: {
                textContent: () => (busy() ? 'Exporting…' : 'Export inner cleaned orthophoto'),
                disabled: () => busy() || !this.svc.orthoSource.get(),
                onclick: () => { void this.svc.runOrtho(true); },
            },
            runCleanOuterOrtho: {
                textContent: () => (busy() ? 'Exporting…' : 'Export outer cleaned orthophoto'),
                disabled: () => busy() || !this.svc.orthoSource.get() || noTerrain(),
                onclick: () => { void this.svc.runOuterOrtho(true); },
            },
            runUnityOrtho: {
                textContent: () => (busy() ? 'Exporting…' : 'Inner cleaned photo → Unity meshes'),
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
                textContent: () => (busy() ? 'Exporting…' : 'Export inner heightmap (RAW + GeoTIFF)'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runDem('inner'); },
            },
            runInnerUnity: {
                textContent: () => (busy() ? 'Exporting…' : 'Inner heightmap → Unity'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runUnityTerrain('inner'); },
            },
            runInnerSculpt: {
                textContent: () => (busy() ? 'Capturing…' : 'Inner Unity sculpt → golf-map'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runUnitySculpt('inner'); },
            },
            runOuterSculpt: {
                textContent: () => (busy() ? 'Capturing…' : 'Outer Unity sculpt → golf-map'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runUnitySculpt('outer'); },
            },
            runOuterUnity: {
                textContent: () => (busy() ? 'Exporting…' : 'Outer heightmap → Unity'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runUnityTerrain('outer'); },
            },
            runOuterDem: {
                textContent: () => (busy() ? 'Exporting…' : 'Export outer heightmap (RAW + GeoTIFF)'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runDem('outer'); },
            },
            courseDir: {
                value: () => this.svc.courseDirDraft.get(),
                disabled: busy,
                oninput: (e: Event) => this.svc.courseDirDraft.set((e.target as HTMLInputElement).value),
                onchange: () => { void this.svc.saveCourseDir({ quiet: true }); },
            },
            gkdHint: () => {
                const settings = this.svc.settings.get();
                const draft = this.svc.courseDirDraft.get().trim();
                if (!settings || !draft) return '';
                if (settings.courseDir === draft && settings.gkdFile) return `Writes ${settings.gkdFile} there.`;
                return 'Saved with the course when you export.';
            },
            runGkd: {
                textContent: () => (busy() ? 'Exporting…' : 'Export GreenKeeper course file'),
                disabled: () => busy() || noTerrain() || !this.svc.courseDirDraft.get().trim(),
                onclick: () => { void this.svc.runGkd(); },
            },
            runInnerHillshade: {
                textContent: () => (busy() ? 'Exporting…' : 'Export inner hillshade JPEG'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runHillshade('inner'); },
            },
            runOuterHillshade: {
                textContent: () => (busy() ? 'Exporting…' : 'Export outer hillshade JPEG'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runHillshade('outer'); },
            },
            runInnerTrees: {
                textContent: () => (busy() ? 'Exporting…' : 'Export inner trees'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runTrees('inner'); },
            },
            runOuterTrees: {
                textContent: () => (busy() ? 'Exporting…' : 'Export outer trees'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runTrees('outer'); },
            },
            runInnerBuildings: {
                textContent: () => (busy() ? 'Exporting…' : 'Export inner buildings'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runBuildings('inner'); },
            },
            runOuterBuildings: {
                textContent: () => (busy() ? 'Exporting…' : 'Export outer buildings'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runBuildings('outer'); },
            },
            runInnerZones: {
                textContent: () => (busy() ? 'Exporting…' : 'Export inner vegetation zones'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runZones('inner'); },
            },
            runOuterZones: {
                textContent: () => (busy() ? 'Exporting…' : 'Export outer vegetation zones'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runZones('outer'); },
            },
            runCreeks: {
                textContent: () => (busy() ? 'Exporting…' : 'Export creeks'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runCreeks(); },
            },
        });

        this.root = this.ref(frag, 'root') as HTMLElement;
        this.track(attachInfoTips(this.root));

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

        // The job, result and error sit at the top of the panel; an export
        // started from the bottom sections must not succeed or fail out of
        // sight. Scroll whichever just changed into view.
        const sections = {
            error: this.ref(frag, 'errorSection') as HTMLElement,
            result: this.ref(frag, 'resultSection') as HTMLElement,
            job: this.ref(frag, 'jobSection') as HTMLElement,
        };
        this.track(effect(() => {
            const error = this.svc.error.get();
            const path = this.svc.lastPath.get();
            const status = this.svc.job.get()?.status;
            const target = error ? sections.error : path ? sections.result : status === 'running' ? sections.job : null;
            if (target) queueMicrotask(() => target.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
        }));

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
