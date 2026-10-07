// GSPro/OPCD export state (one course at a time): the course SVG, the
// square orthophoto JPEGs, the square DEM GeoTIFFs + Unity .raw heightmaps
// and the hillshade JPEGs for the two GSPro terrains — the INNER one the map
// was built over (side on a 10 m step) and the 5 km OUTER one centred on it.
//
// The exports themselves happen on the server (GsproExportService shells out
// to `pipeline/gspro.py svg` / `ortho` / `dem` / `hillshade` / `trees`) as JOBS:
// `start` returns at once and this service polls `job` until it finishes —
// an outer orthophoto or outer trees export runs for minutes, far past a
// request timeout, and the panel must say so rather than go quiet. Opening
// the panel resumes the course's running job (or shows its last result), and
// a start refused because one is already running re-attaches to that one.
// This holds the panel's state: which course is open, the folder it writes
// to, the two terrain squares, the picked orthophoto vintage, the job in
// flight and the last run's report or error.
//
// The folder is TYPED, not picked: the browser cannot show an OS folder
// chooser for a path the SERVER writes to, and the server is the one holding
// the pen. It is per course, persisted server-side; blank means the server
// default (the OS Downloads folder). The GreenKeeper `.GKD` goes elsewhere —
// into the course's own folder under GSPro's Courses — which is a second
// typed, per-course folder with no default.
//
// DI singleton; the panel component is the only UI. Testable headlessly —
// the constructor takes the API client.

import { Signal } from '@basics/core/client/core';
import { api } from '../api';
import type {
    GsproExportApi, GsproExportSettings, GsproOrthoSource, CourseTerrain, TerrainSquare, GsproExportJob,
} from '../../../shared/api/gspro-export.gen';
import { browserStorage, loadExclusions, saveExclusions, type ExclusionStorage } from './svg-exclusions';
import {
    startBisect, answerBisect, undoBisect, bisectExclusions, bisectVariant, type SvgBisect,
} from './svg-bisect';

/** What `start` takes besides the course: the kind and the fields it needs. */
type GsproExportRequest = Omit<Parameters<GsproExportApi['start']>[0], 'courseId'>;

export type TerrainKind = 'inner' | 'outer';
export type { GsproExportJob };

/** How often a running job is polled (ms); tests pass something tiny. */
export const DEFAULT_POLL_MS = 1500;

/** The pipeline's default forest-floor colour (golfpipe/woodland_floor.py DEFAULT_FLOOR_RGB), shown in the picker. */
export const DEFAULT_FLOOR_COLOR = '#505834';

export class GsproExportService {
    /** Course the panel is open for; null = closed. */
    readonly courseId = new Signal<string | null>(null);
    readonly courseName = new Signal<string>('');
    /** Server-side settings for that course (null while loading). */
    readonly settings = new Signal<GsproExportSettings | null>(null);
    /** Folder text being edited; empty means "use the default". */
    readonly dirDraft = new Signal<string>('');
    /** GSPro course folder text being edited (where the .GKD goes); empty = not set. */
    readonly courseDirDraft = new Signal<string>('');
    readonly busy = new Signal<boolean>(false);
    /** Lines the exporter printed on the last successful run (SVG or ortho). */
    readonly report = new Signal<string[]>([]);
    /** Path written by the last successful run (SVG or ortho). */
    readonly lastPath = new Signal<string | null>(null);
    readonly error = new Signal<string>('');
    /**
     * Orthophoto GeoTIFFs the map build persisted for the course's site
     * (null while loading; empty when the course was never built here).
     */
    readonly orthoSources = new Signal<GsproOrthoSource[] | null>(null);
    /** `source` of the vintage picked for the JPEG export ('' = none). */
    readonly orthoSource = new Signal<string>('');
    /**
     * Brightness of the `-terrain` texture twin as typed: a light multiplier
     * in linear light, 1 = the photo as-is. Blank means the server default.
     */
    readonly terrainDarken = new Signal<string>('');
    /**
     * Also write the `-meshes` variant for the course meshes: the darkened texture with the
     * course's grass surfaces tinted from its own drawn features — the
     * Photoshop overlay step OPCD builders do by hand from the SVG.
     */
    readonly tintTerrain = new Signal<boolean>(true);
    /** Opacity of that tint layer as typed, 0..1. Blank means the server default (0.5). */
    readonly tintOpacity = new Signal<string>('');
    /**
     * Paint the course's woodland-floor zones (the lidar stands Regenerate
     * trees makes, D-VZ10) as forest floor on every orthophoto file, so the
     * terrain under the planted trees is ground, not photographed crowns.
     */
    readonly forestFloor = new Signal<boolean>(true);
    /** Palette floor colour `#rrggbb` as picked. */
    readonly floorColor = new Signal<string>(DEFAULT_FLOOR_COLOR);
    /** Share of each stand's photo-sampled colour as typed, 0..1. Blank means the server default (0.5). */
    readonly floorMix = new Signal<string>('');
    /**
     * Fill the roofs (lidar roof heights from Regenerate trees, plus the
     * building survey from Generate building pads) and their shadows from
     * the ground round them, since Unity puts a prefab on each pad.
     */
    readonly removeBuildings = new Signal<boolean>(true);
    /** The course's inner + outer terrain squares (null while loading or unavailable). */
    readonly terrain = new Signal<CourseTerrain | null>(null);
    /** Why the terrains are unavailable (no map area yet) — '' when they loaded. */
    readonly terrainNote = new Signal<string>('');
    /** The export job being followed (running, or the one that just finished); null when none. */
    readonly job = new Signal<GsproExportJob | null>(null);
    /** Bumped on every poll so elapsed-time text re-renders. */
    readonly tick = new Signal<number>(0);
    /**
     * Features the next SVG export leaves out — a test variant for the
     * Blender build (svg-exclusions.ts). Per course, kept in this browser.
     */
    readonly svgExcluded = new Signal<ReadonlySet<string>>(new Set());
    /** The variant's name: the SVG becomes `<course>-<variant>.svg`; blank = the full `<course>.svg`. */
    readonly svgVariant = new Signal<string>('');
    /** A bisect for the shape the Blender build chokes on (svg-bisect.ts); null when none runs. */
    readonly svgBisect = new Signal<SvgBisect | null>(null);

    constructor(
        private readonly client: GsproExportApi = api.gsproExport,
        private readonly pollMs = DEFAULT_POLL_MS,
        private readonly storage: ExclusionStorage | null = browserStorage(),
    ) {}

    get isOpen(): boolean {
        return this.courseId.peek() !== null;
    }

    /** Open the panel for a course and load its folder setting. */
    async openFor(courseId: string, courseName: string): Promise<void> {
        this.courseId.set(courseId);
        this.courseName.set(courseName);
        this.settings.set(null);
        this.report.set([]);
        this.lastPath.set(null);
        this.error.set('');
        this.orthoSources.set(null);
        this.orthoSource.set('');
        this.terrain.set(null);
        this.terrainNote.set('');
        this.job.set(null);
        const saved = loadExclusions(this.storage, courseId);
        this.svgExcluded.set(new Set(saved.ids));
        this.svgVariant.set(saved.variant);
        this.svgBisect.set(saved.bisect);
        await this.reload();
        await this.resume();
    }

    /**
     * Pick up the course's job: keep following a running one (the panel was
     * closed, or the page reloaded, while an export ran), or show the last
     * finished one's outcome so the operator sees what the folder holds.
     */
    private async resume(): Promise<void> {
        const courseId = this.courseId.peek();
        if (!courseId) return;
        let current: GsproExportJob | null;
        try {
            current = await this.client.current({ courseId });
        } catch {
            return;  // an older server without jobs: nothing to resume
        }
        // No job yet: the server's null arrives as the framework's bare `{ ok: true }`.
        if (!current?.status || this.courseId.peek() !== courseId) return;
        if (current.status === 'running') {
            void this.follow(current);
        } else {
            this.showOutcome(current);
        }
    }

    /** The collection of the picked vintage — what the outer orthophoto is fetched as. */
    get pickedCollection(): string {
        const source = this.orthoSource.peek();
        return this.orthoSources.peek()?.find(s => s.source === source)?.collection ?? '';
    }

    close(): void {
        this.courseId.set(null);
        this.busy.set(false);
    }

    private async reload(): Promise<void> {
        const courseId = this.courseId.peek();
        if (!courseId) return;
        this.busy.set(true);
        // The terrains 409 for a course with no map area yet; that is a note
        // on the panel, not a failure of the whole panel.
        const terrain = this.client.terrain({ courseId }).then(
            t => { this.terrain.set(t); this.terrainNote.set(''); },
            e => { this.terrain.set(null); this.terrainNote.set(messageOf(e)); },
        );
        try {
            const [settings, sources] = await Promise.all([
                this.client.settings({ courseId }),
                this.client.orthoSources({ courseId }),
                terrain,
            ]);
            this.settings.set(settings);
            // Show the default as placeholder-ish emptiness rather than a
            // path the user did not choose — saving blank means "default".
            this.dirDraft.set(settings.isDefault ? '' : settings.dir);
            this.courseDirDraft.set(settings.courseDir ?? '');
            this.orthoSources.set(sources);
            // Preselect what the map is showing (the pristine copy), else the
            // newest vintage — the list is newest first.
            const preferred = sources.find(s => s.active && !s.patched) ?? sources[0];
            this.orthoSource.set(preferred?.source ?? '');
        } catch (e) {
            this.error.set(messageOf(e));
        } finally {
            this.busy.set(false);
        }
    }

    /**
     * Persist the typed folder for this course (blank resets to default).
     * `quiet` leaves `busy` alone: the panel saves when the field loses focus,
     * and that blur is often the operator clicking an export button, which a
     * busy flag would disable under the click.
     */
    async saveDir(opts: { quiet?: boolean } = {}): Promise<boolean> {
        const courseId = this.courseId.peek();
        if (!courseId) return false;
        if (!opts.quiet) this.busy.set(true);
        this.error.set('');
        try {
            const dir = this.dirDraft.peek().trim();
            const settings = await this.client.setDir({ courseId, dir: dir || null });
            this.settings.set(settings);
            this.dirDraft.set(settings.isDefault ? '' : settings.dir);
            return true;
        } catch (e) {
            this.error.set(messageOf(e));
            return false;
        } finally {
            if (!opts.quiet) this.busy.set(false);
        }
    }

    /**
     * Persist the typed GSPro course folder (blank clears it). The server
     * refuses a folder that does not exist — building the course in Unity is
     * what makes it. `quiet` as for `saveDir`.
     */
    async saveCourseDir(opts: { quiet?: boolean } = {}): Promise<boolean> {
        const courseId = this.courseId.peek();
        if (!courseId) return false;
        if (!opts.quiet) this.busy.set(true);
        this.error.set('');
        try {
            const dir = this.courseDirDraft.peek().trim();
            const settings = await this.client.setCourseDir({ courseId, dir: dir || null });
            this.settings.set(settings);
            this.courseDirDraft.set(settings.courseDir ?? '');
            return true;
        } catch (e) {
            this.error.set(messageOf(e));
            return false;
        } finally {
            if (!opts.quiet) this.busy.set(false);
        }
    }

    /**
     * Save the GSPro course folder, then write GreenKeeper's course file into
     * it: tees, pins, green centres, aim points, water hazards and the OOB
     * ring, merged into the `.GKD` already there. Needs the inner heightmap
     * exported first.
     */
    async runGkd(): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        if (!this.courseDirDraft.peek().trim()) {
            this.error.set('Set the GSPro course folder first — the course\'s folder under GSPro\'s Courses, where its .gspcrse is');
            return false;
        }
        if (!(await this.saveCourseDir())) return false;
        return this.runExport({ kind: 'gkd' });
    }

    /**
     * Save the folder, then export the SVG — without the excluded features,
     * under the variant's name when one is typed. Reports where the file landed.
     */
    async run(): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        const ids = [...this.svgExcluded.peek()];
        const variant = this.svgVariant.peek().trim();
        const ok = await this.runExport({
            kind: 'svg',
            ...(ids.length ? { excludeFeatureIds: ids } : {}),
            ...(variant ? { variant } : {}),
        });
        const bisect = this.svgBisect.peek();
        if (ok && bisect && !bisect.result) this.setBisect({ ...bisect, exported: true });
        return ok;
    }

    /**
     * Start bisecting `suspects` (in the order the halves split, see
     * `spatialOrder`): everything else excluded now stays out, and the first
     * step's exclusions and variant name are set. Export it next.
     */
    startSvgBisect(suspects: readonly string[]): void {
        if (suspects.length === 0) return;
        this.applyBisectStep(startBisect(suspects, this.svgExcluded.peek()));
    }

    /**
     * The operator's answer about the current step's Blender build; narrows
     * the suspects and exports the next step (nothing more to export once the
     * confirming step is answered). True when that export succeeded or none was due.
     */
    async answerSvgBisect(built: boolean): Promise<boolean> {
        const bisect = this.svgBisect.peek();
        if (!bisect?.exported) return false;
        const next = answerBisect(bisect, built);
        if (next.result) {
            this.setBisect(next);
            return true;
        }
        this.applyBisectStep(next);
        return this.run();
    }

    /** Take back the last answer (the step it answered has to be exported again). */
    undoSvgBisect(): void {
        const bisect = this.svgBisect.peek();
        if (bisect) this.applyBisectStep(undoBisect(bisect));
    }

    /** End the bisect; the exclusions stay as they are, the variant name is cleared. */
    stopSvgBisect(): void {
        this.svgBisect.set(null);
        this.svgVariant.set('');
        this.persistExclusions();
    }

    private applyBisectStep(bisect: SvgBisect): void {
        this.svgBisect.set(bisect);
        this.svgExcluded.set(bisectExclusions(bisect));
        this.svgVariant.set(bisectVariant(bisect));
        this.persistExclusions();
    }

    private setBisect(bisect: SvgBisect): void {
        this.svgBisect.set(bisect);
        this.persistExclusions();
    }

    /** Leave these features out of the next SVG export. */
    excludeFromSvg(ids: Iterable<string>): void {
        const next = new Set(this.svgExcluded.peek());
        for (const id of ids) next.add(id);
        this.setSvgExcluded(next);
    }

    /** Put these features back into the next SVG export. */
    includeInSvg(ids: Iterable<string>): void {
        const next = new Set(this.svgExcluded.peek());
        for (const id of ids) next.delete(id);
        this.setSvgExcluded(next);
    }

    /** Flip one feature in or out of the next SVG export. */
    toggleSvgExcluded(id: string): void {
        if (this.svgExcluded.peek().has(id)) this.includeInSvg([id]);
        else this.excludeFromSvg([id]);
    }

    clearSvgExclusions(): void {
        this.setSvgExcluded(new Set());
    }

    setSvgVariant(variant: string): void {
        this.svgVariant.set(variant);
        this.persistExclusions();
    }

    private setSvgExcluded(ids: ReadonlySet<string>): void {
        this.svgExcluded.set(ids);
        this.persistExclusions();
    }

    private persistExclusions(): void {
        const courseId = this.courseId.peek();
        if (!courseId) return;
        saveExclusions(this.storage, courseId, {
            ids: [...this.svgExcluded.peek()], variant: this.svgVariant.peek(), bisect: this.svgBisect.peek(),
        });
    }

    /**
     * Save the folder, then render the picked orthophoto vintage as the
     * square 8192 px JPEG texture. Reports where the file landed. Plain by
     * default (the photo, its darkened -terrain twin and the tinted -meshes
     * variant); `clean` is the separate cleaned export — buildings removed
     * and/or forest floor painted, per the two boxes — into `-clean` files.
     */
    async runOrtho(clean = false): Promise<boolean> {
        const courseId = this.courseId.peek();
        const source = this.orthoSource.peek();
        if (!courseId || !source) return false;
        const darken = this.darkenValue();
        if (darken === false) return false;
        const tint = this.tintValue();
        if (tint === false) return false;
        const cleaning = this.cleanValue(clean);
        if (cleaning === false) return false;
        return this.runExport({ kind: 'ortho', source, darken, ...tint, ...cleaning });
    }

    /**
     * The whole way in one go: render the picked vintage (its PATCHED copy
     * when there is one, since that is where the Clean tool's baked edits
     * are) with the cleaned section's boxes as ticked, then put its -meshes
     * file onto the course meshes in the open Unity editor. With both boxes
     * off it is the patched photo alone. Unity must be open.
     */
    async runUnityOrtho(): Promise<boolean> {
        const courseId = this.courseId.peek();
        const source = this.unityOrthoSource;
        if (!courseId || !source) return false;
        const darken = this.darkenValue();
        if (darken === false) return false;
        const tint = this.tintValue();
        if (tint === false) return false;
        const floor = this.floorValue();
        if (floor === false) return false;
        return this.runExport({ kind: 'unity-ortho', source, darken, ...tint, ...floor, ...this.buildingsValue() });
    }

    /** The source `runUnityOrtho` renders: the picked vintage's patched copy when the site has one, else the picked file. */
    get unityOrthoSource(): string {
        const picked = this.orthoSource.peek();
        const collection = this.pickedCollection;
        return this.orthoSources.peek()?.find(s => s.patched && s.collection === collection)?.source ?? picked;
    }

    /** The cleaned export's fields (nothing for the plain one); false with the error set when it has nothing to do or a bad mix. */
    private cleanValue(clean: boolean): ({ removeBuildings?: boolean } & Exclude<ReturnType<GsproExportService['floorValue']>, false>) | false {
        if (!clean) return {};
        if (!this.removeBuildings.peek() && !this.forestFloor.peek()) {
            this.error.set('Tick "Remove buildings" and/or "Forest floor" for a cleaned orthophoto (the plain export is the button above)');
            return false;
        }
        const floor = this.floorValue();
        if (floor === false) return false;
        return { ...floor, ...this.buildingsValue() };
    }

    /** The typed brightness as a number, undefined when blank, false (with the error set) when not a usable number. */
    private darkenValue(): number | undefined | false {
        const text = this.terrainDarken.peek().trim().replace(',', '.');
        if (!text) return undefined;
        const n = Number(text);
        if (!Number.isFinite(n) || n < 0.05 || n > 1) {
            this.error.set('Terrain texture brightness must be a number between 0.05 and 1 (1 = the photo as-is)');
            return false;
        }
        return n;
    }

    /**
     * Save the folder, then fetch (once) and render the picked vintage over
     * the 5 km OUTER square as its 8192 px JPEG. The vintage is named by its
     * collection: the outer area is fetched fresh, not cut from the inner copy.
     */
    async runOuterOrtho(clean = false): Promise<boolean> {
        const courseId = this.courseId.peek();
        const collection = this.pickedCollection;
        if (!courseId || !collection) return false;
        const darken = this.darkenValue();
        if (darken === false) return false;
        const tint = this.tintValue();
        if (tint === false) return false;
        const cleaning = this.cleanValue(clean);
        if (cleaning === false) return false;
        return this.runExport({ kind: 'outer-ortho', collection, darken, ...tint, ...cleaning });
    }

    /** The building-removal request field: nothing with the box off. */
    private buildingsValue(): { removeBuildings?: boolean } {
        return this.removeBuildings.peek() ? { removeBuildings: true } : {};
    }

    /** The forest-floor request fields: nothing with the box off, false (with the error set) when the mix is not a usable number. */
    private floorValue(): { forestFloor?: boolean; floorColor?: string; floorMix?: number } | false {
        if (!this.forestFloor.peek()) return {};
        const color = this.floorColor.peek();
        const out: { forestFloor: boolean; floorColor?: string; floorMix?: number } = { forestFloor: true };
        if (/^#[0-9a-fA-F]{6}$/.test(color)) out.floorColor = color;
        const text = this.floorMix.peek().trim().replace(',', '.');
        if (!text) return out;
        const n = Number(text);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
            this.error.set('Forest floor photo mix must be a number between 0 and 1 (0 = the colour as picked, 1 = each stand\'s colour from the photo)');
            return false;
        }
        return { ...out, floorMix: n };
    }

    /** The tint request fields: nothing with the box off, false (with the error set) when the opacity is not a usable number. */
    private tintValue(): { tint?: boolean; tintOpacity?: number } | false {
        if (!this.tintTerrain.peek()) return {};
        const text = this.tintOpacity.peek().trim().replace(',', '.');
        if (!text) return { tint: true };
        const n = Number(text);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
            this.error.set('Surface tint opacity must be a number between 0 and 1 (0.5 = the photo at half strength over green)');
            return false;
        }
        return { tint: true, tintOpacity: n };
    }

    /**
     * Save the folder, then export one terrain's DEM as a square EPSG:3006
     * GeoTIFF, its Unity .raw heightmap and the .json sidecar (height range
     * + Unity settings) — OPCD's TIF→RAW step done.
     */
    async runDem(terrain: TerrainKind): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        return this.runExport({ kind: 'dem', terrain });
    }

    /**
     * Save the folder, export one terrain's heightmap and put it straight into
     * the open Unity editor whose GolfMap course imports from the folder (its
     * terrain updated in place, backed up first). Unity must be open.
     */
    async runUnityTerrain(terrain: TerrainKind): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        return this.runExport({ kind: 'unity-terrain', terrain });
    }

    /**
     * Capture what was sculpted on one terrain in Unity since golf-map's
     * heights went in, and store it as that terrain's sculpt layer (one
     * additive terrain edit). Unity must be open; Apply to terrain after.
     */
    async runUnitySculpt(terrain: TerrainKind): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        return this.runExport({ kind: 'unity-sculpt', terrain });
    }

    /**
     * Save the folder, then render one terrain's DEM as an 8192 px hillshade
     * JPEG — OPCD's aid for checking an overlay against the terrain.
     */
    async runHillshade(terrain: TerrainKind): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        return this.runExport({ kind: 'hillshade', terrain });
    }

    /**
     * Save the folder, then write one terrain's lidar tree stems as the
     * unity-trees-v1 file the Unity Tree Planter reads. Needs that
     * terrain's heightmap export in the folder (the height range).
     */
    async runTrees(terrain: TerrainKind): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        return this.runExport({ kind: 'trees', terrain });
    }

    /**
     * Save the folder, then write one terrain's buildings as the
     * unity-buildings file the Unity building planter reads — from the
     * survey "Generate building pads" made; the heightmap (with the pads)
     * must be exported first.
     */
    async runBuildings(terrain: TerrainKind): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        return this.runExport({ kind: 'buildings', terrain });
    }

    /**
     * Save the folder, then rasterize one terrain's vegetation zones into
     * the VSPro texture masks + unity-zones-v2 JSON the Unity Vegetation
     * Zones window imports. Needs that terrain's heightmap export in the
     * folder (the height range).
     */
    async runZones(terrain: TerrainKind): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        return this.runExport({ kind: 'zones', terrain });
    }

    /**
     * Save the folder, then write the creeks as R.A.M. splines at their water
     * surface (unity-creeks-v1) for GolfMap › Creeks. Needs the inner
     * heightmap export in the folder (the terrain's zero).
     */
    async runCreeks(): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        return this.runExport({ kind: 'creeks' });
    }

    /**
     * Save the folder, start the export as a job and follow it to the end.
     * True when it succeeded. A start refused because a job is already
     * running for the course re-attaches to that job instead.
     */
    private async runExport(request: GsproExportRequest): Promise<boolean> {
        const courseId = this.courseId.peek();
        if (!courseId) return false;
        if (!(await this.saveDir())) return false;
        this.busy.set(true);
        this.error.set('');
        this.report.set([]);
        this.lastPath.set(null);
        let job: GsproExportJob;
        try {
            job = await this.client.start({ courseId, ...request });
        } catch (e) {
            const message = messageOf(e);
            if (/already running/i.test(message)) {
                const running = await this.client.current({ courseId }).catch(() => null);
                if (running?.status === 'running') return this.follow(running);
            }
            this.error.set(message);
            this.busy.set(false);
            return false;
        }
        return this.follow(job);
    }

    /** Poll a job until it finishes, then show its outcome. True when it succeeded. */
    private async follow(job: GsproExportJob): Promise<boolean> {
        this.job.set(job);
        this.busy.set(true);
        this.error.set('');
        try {
            while (job.status === 'running') {
                await new Promise(r => setTimeout(r, this.pollMs));
                if (this.courseId.peek() !== job.courseId) return false;  // the panel moved on
                job = await this.client.job({ jobId: job.id });
                this.job.set(job);
                this.tick.set(this.tick.peek() + 1);
            }
            return this.showOutcome(job);
        } catch (e) {
            this.error.set(messageOf(e));
            return false;
        } finally {
            if (this.courseId.peek() === job.courseId) this.busy.set(false);
        }
    }

    /** Put a finished job's result or error on the panel. True when it succeeded. */
    private showOutcome(job: GsproExportJob): boolean {
        this.job.set(job);
        if (job.status === 'succeeded' && job.result) {
            this.lastPath.set(job.result.path);
            this.report.set(job.result.report);
            this.error.set('');
            return true;
        }
        this.lastPath.set(null);
        this.report.set([]);
        this.error.set(job.error || `${job.label} export failed`);
        return false;
    }
}

/** `Running: outer orthophoto — 1 min 12 s` / `Last export: inner heightmap, done in 8 s`. */
export function jobLabel(job: GsproExportJob | null, now = Date.now()): string {
    if (!job) return '';
    const started = Date.parse(job.startedAt);
    const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
    const secs = Number.isFinite(started) && Number.isFinite(end) ? Math.max(0, Math.round((end - started) / 1000)) : 0;
    const elapsed = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
    if (job.status === 'running') return `Running: ${job.label} — ${elapsed}. The server keeps going if you close this panel.`;
    return job.status === 'succeeded' ? `Last export: ${job.label}, done in ${elapsed}` : `Last export: ${job.label} failed after ${elapsed}`;
}

/** Label for a vintage in the picker: `orto-l2-2025 (shown on map)`, `orto-l2-2025, patched`. */
export function orthoSourceLabel(s: GsproOrthoSource): string {
    const notes = [s.patched ? 'patched' : '', s.active && !s.patched ? 'shown on map' : ''].filter(Boolean);
    return notes.length ? `${s.collection} (${notes.join(', ')})` : s.collection;
}

/** `2010 m × 2010 m, centre 530 035 E 6 487 675 N (EPSG:3006)`. */
export function terrainLabel(t: TerrainSquare): string {
    const m = (n: number) => Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
    return `${t.sideM} m × ${t.sideM} m, centre ${m(t.centre.x)} E ${m(t.centre.y)} N (EPSG:3006)`;
}

function messageOf(e: unknown): string {
    return e instanceof Error && e.message ? e.message : 'Export failed';
}
