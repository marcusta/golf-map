// Floating panel for the GSPro/OPCD exports: the course SVG, the square
// orthophoto JPEGs (8192 px, quality 92), the square DEM GeoTIFFs + Unity
// .raw heightmaps and the hillshade JPEGs for the two GSPro terrains — the
// INNER one the map was built over and the 5 km OUTER one centred on it.
// Spawned once by CourseDetailComponent; hidden
// until the command bar's ⋯ menu calls GsproExportService.openFor(). Docks
// at the map's right edge like the import wizards.
//
// The folder is a typed path, not an OS picker: the file is written by the
// SERVER (which runs the pipeline), and a browser folder chooser would name a
// place in the browser's sandbox instead. Blank means the server default —
// the OS Downloads folder — and the placeholder shows what that resolves to.

import { Component, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn, primaryBtn, field, glassPanel, panelTitle, OVERLAY_W, OVERLAY_INSET } from '../css';
import { GsproExportService, orthoSourceLabel, terrainLabel, jobLabel } from './gspro-export.service';
import { icon } from '../ui/icons';

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
            <div class="gspro-export__terrain"><b>Inner terrain</b> <span bind="innerTerrain"></span></div>
            <div class="gspro-export__terrain"><b>Outer terrain</b> <span bind="outerTerrain"></span></div>
            <div bind="terrainHint" class="hint"></div>
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
            <button bind="run" type="button" class="gspro-export__run"></button>
            <div class="hint">The course's drawn features as a layered OPCD SVG over the inner terrain.</div>
        </div>

        <div class="gspro-export__section actions">
            <label bind="orthoField" class="gspro-export__field">Orthophoto
                <select bind="orthoSource"></select>
            </label>
            <div bind="orthoHint" class="hint"></div>
            <label class="gspro-export__field">Terrain texture brightness
                <input bind="terrainDarken" type="text" inputmode="decimal" spellcheck="false" autocomplete="off" />
            </label>
            <div class="hint">Light multiplier for the -terrain twin, in linear light: 1 keeps the photo as-is, 0.4 (the default when blank) brings a sun-lit photo down to about the reflectance of real grass so Unity's own lighting does the rest. Try 0.3–0.6 and compare in Unity.</div>
            <button bind="runOrtho" type="button" class="gspro-export__run gspro-export__run-ortho"></button>
            <button bind="runOuterOrtho" type="button" class="gspro-export__run gspro-export__run-outer-ortho"></button>
            <div bind="outerOrthoHint" class="hint"></div>
        </div>

        <div class="gspro-export__section actions">
            <button bind="runInnerDem" type="button" class="gspro-export__run gspro-export__run-inner-dem"></button>
            <button bind="runOuterDem" type="button" class="gspro-export__run gspro-export__run-outer-dem"></button>
            <div bind="demHint" class="hint"></div>
        </div>

        <div class="gspro-export__section actions">
            <button bind="runInnerHillshade" type="button" class="gspro-export__run gspro-export__run-inner-hillshade"></button>
            <button bind="runOuterHillshade" type="button" class="gspro-export__run gspro-export__run-outer-hillshade"></button>
            <div class="hint">An 8192 × 8192 px hillshade of the terrain's DEM, for checking an overlay against the relief (bunkers, tees) in Unity or an image editor.</div>
        </div>

        <div class="gspro-export__section actions">
            <button bind="runInnerTrees" type="button" class="gspro-export__run gspro-export__run-inner-trees"></button>
            <button bind="runOuterTrees" type="button" class="gspro-export__run gspro-export__run-outer-trees"></button>
            <div class="hint">The terrain's lidar tree stems as a unity-trees file for the Unity Tree Planter. Inner: from the map's regenerated trees. Outer: detected the first time from the outer lidar, without the stems on the inner square; the planter puts them in billboard mode. Export the terrain's heightmap first — the trees take its height range.</div>
        </div>
    </div>
`);

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

            & .gspro-export__terrain {
                font-size: 0.72rem;
                line-height: 1.4;
                color: ${t('color-text-secondary')};
                & b { color: ${t('color-text-primary')}; margin-right: ${s('xs')}; }
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
            }

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

            & .gspro-export__run { ${primaryBtn()} padding: ${s('sm')} ${s('md')}; }
        }
    `;

    private svc = this.inject(GsproExportService);

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
            terrainHint: () => {
                const note = this.svc.terrainNote.get();
                if (note) return `Terrains unavailable: ${note}`;
                return 'The inner square is the map area the course was built over, its side on a 10 m step; '
                    + 'the outer square is the background scenery, centred on it. Every export below renders over one of the two.';
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
                textContent: () => (busy() ? 'Exporting…' : 'Export SVG'),
                disabled: busy,
                onclick: () => { void this.svc.run(); },
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
            orthoHint: () => {
                const sources = this.svc.orthoSources.get();
                if (!sources) return 'Loading…';
                if (sources.length === 0) {
                    return 'No orthophoto on this machine for this course — build its map first.';
                }
                return 'Two square 8192 × 8192 px JPEGs (quality 92) over the inner terrain, the same square as the SVG: '
                    + 'the photo as-is, and a -terrain twin dimmed for the Unity terrain (its shader lights the photo again).';
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
            outerOrthoHint: () => {
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
            runOuterDem: {
                textContent: () => (busy() ? 'Exporting…' : 'Export outer heightmap (RAW + GeoTIFF)'),
                disabled: () => busy() || noTerrain(),
                onclick: () => { void this.svc.runDem('outer'); },
            },
            demHint: () => 'The Unity heightmap (4097 × 4097 px 16-bit .raw — OPCD\'s TIF → RAW step, done), the square '
                + 'EPSG:3006 GeoTIFF it came from, and a .json sidecar with the height range and the Unity terrain settings. '
                + 'Inner: the build\'s DEM at 0.5 m (terrain edits applied). Outer: gridded at 1 m from Laserdata Skog lidar, '
                + 'fetched the first time. Export the inner first: the outer\'s sidecar then carries its Unity position.',
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
        });

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
