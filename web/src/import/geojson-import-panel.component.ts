// Floating wizard panel for GeoJSON draft import (T43). Mirrors
// SvgImportPanelComponent: spawned once by CourseDetailComponent; hidden
// until the command bar's "Import GeoJSON" calls GeojsonImportService
// .openFor(). Docked to the right edge so the map stays visible for the
// preview overlay (dashed styling, id `geojson-import-preview`) rendered
// from `svc.built`. No georeference section — files are EPSG:3006 already
// (the service rejects anything else).

import { TerrainEditToolService } from '../terrain-edit/terrain-edit-tool.service';
import { terrainEditTool } from '../terrain-edit/terrain-edit-tool';
import { EditorModeService } from '../editor/editor-mode.service';
import type { EditorTool } from '../editor/tool';
import { Component, effect, template, untrack } from '@basics/core/client/core';
import type { Feature, FeatureCollection } from 'geojson';
import { t } from '../theme';
import { s, btn, primaryBtn, glassPanel, panelTitle, metric, OVERLAY_W, OVERLAY_INSET } from '../css';
import { MapService } from '../map/map.service';
import { FeaturesService, geometryToWgs84Rings } from '../draw/features.service';
import { FEATURE_TYPES, FEATURE_STYLES, typeColorExpression } from '../draw/feature-palette';
import { GeojsonImportService, OSM_FETCH_FILENAME, ROADS_FETCH_FILENAME, type ImportGroup } from './geojson-import.service';
import { ConfirmService } from '../app/confirm-dialog.component';
import type { BuildResult, BuiltFeature } from './svg-import.service';
import { shapeAt } from './geojson-build';
import type { GeojsonBucket } from './geojson-parse';
import { icon } from '../ui/icons';

/** Overlay id for the temporary import preview. */
export const PREVIEW_OVERLAY_ID = 'geojson-import-preview';

/** Dashed magenta preview styling — unmistakably "not real features yet". */
const PREVIEW_OUTLINE = '#d63384';
/** A dropped or already-imported shape: grey, so the picked ones stand out. */
const DROPPED_OUTLINE = '#8a8f98';
const DROPPED_FILL = '#c8ccd2';

const tpl = template(`
    <div bind="root" class="geojson-import">
        <div class="geojson-import__header">
            <h3>Import GeoJSON</h3>
            <button bind="close" type="button" aria-label="Close" title="Close">${icon('x')}</button>
        </div>

        <div class="geojson-import__section">
            <h4 class="section-title">1 &middot; Source (EPSG:3006)</h4>
            <input bind="file" type="file" accept=".geojson,.json,application/geo+json" />
            <button bind="fetchHydro" type="button" class="fetch-btn" data-testid="geojson-fetch-hydro-btn"></button>
            <button bind="fetchOsm" type="button" class="fetch-btn" data-testid="geojson-fetch-osm-btn"></button>
            <button bind="fetchRoads" type="button" class="fetch-btn" data-testid="geojson-fetch-roads-btn"></button>
            <div bind="odblNote" class="license-note"></div>
            <div bind="fetchError" class="error"></div>
            <div bind="fileInfo" class="hint"></div>
            <div bind="generatedNote" class="license-note" data-testid="geojson-generated-note"></div>
            <div bind="parseError" class="error"></div>
        </div>

        <div bind="mappingSection" class="geojson-import__section">
            <h4 class="section-title">2 &middot; Map values to feature types</h4>
            <label class="prop-field">Bucket by property
                <select bind="property"></select>
            </label>
            <div bind="buckets" class="bucket-list"></div>
        </div>

        <div bind="actionsSection" class="geojson-import__section">
            <div class="pick-row">
                <span bind="pickInfo" class="pick-info" data-testid="geojson-pick-info"></span>
                <button bind="pickAll" type="button" class="secondary" data-testid="geojson-pick-all">All</button>
                <button bind="pickNone" type="button" class="secondary" data-testid="geojson-pick-none">None</button>
            </div>
            <div class="actions">
                <button bind="confirm" type="button" class="primary" data-testid="geojson-import-confirm"></button>
            </div>
        </div>

        <div bind="summarySection" class="geojson-import__section">
            <h4 class="section-title">Result</h4>
            <div bind="summaryText" class="summary"></div>
            <div bind="pondsNext" class="ponds-next hidden" data-testid="geojson-import-ponds-next">
                <span bind="pondsNextText"></span>
                <button bind="pondsNextBtn" type="button" data-testid="geojson-import-fit-edges">Fit edges</button>
            </div>
            <div bind="warnings" class="warnings"></div>
        </div>

        <div bind="importedSection" class="geojson-import__section" data-testid="geojson-imported">
            <h4 class="section-title">Imported on this course</h4>
            <div class="hint">Remove an earlier import to import it again. Hand-drawn features are kept.</div>
            <div bind="importedList" class="imported-list"></div>
            <div bind="clearError" class="error"></div>
        </div>
    </div>
`);

const importedRowTpl = template(`
    <div bind="row" class="imported-row">
        <span bind="label" class="imported-label"></span>
        <span bind="count" class="bucket-count"></span>
        <button bind="remove" type="button" class="fetch-btn"></button>
        <span bind="types" class="imported-types"></span>
    </div>
`);

const bucketRowTpl = template(`
    <div bind="row" class="bucket-row">
        <span bind="swatch" class="bucket-swatch"></span>
        <span bind="label" class="bucket-label"></span>
        <span bind="count" class="bucket-count"></span>
        <select bind="type"></select>
    </div>
`);

/** How a built shape shows on the map: to be imported, left out, or already on the course. */
type PickState = 'picked' | 'dropped' | 'on-course';

function builtToGeojson(built: BuildResult | null, stateOf: (f: BuiltFeature) => PickState): FeatureCollection {
    const features: Feature[] = (built?.features ?? []).map((f, i) => ({
        type: 'Feature',
        id: i,
        properties: { type: f.type, state: stateOf(f) },
        geometry: { type: 'Polygon', coordinates: geometryToWgs84Rings(f.geometry) },
    }));
    return { type: 'FeatureCollection', features };
}

/** The map mode the wizard claims while its shapes are on the map (clicks pick them). */
const PICK_MODE = 'geojson-import-pick';

export class GeojsonImportPanelComponent extends Component {
    static styles = `
        .geojson-import {
            /* Layout laws 01+02: self-positioned overlay at the top-right
               corner inset, standard bucket, height hugs content (max-height
               bound + inner scroll — never full-height). */
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

            & .geojson-import__header {
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

            & .geojson-import__section {
                padding: var(--space-3) var(--space-4);
                border-bottom: 1px solid ${t('color-border-default')};
                display: flex;
                flex-direction: column;
                gap: var(--space-2);
                &.hidden { display: none; }
            }

            & .section-title {
                margin: 0;
                ${panelTitle()}
            }

            & .hint { font-size: 0.72rem; color: ${t('color-text-secondary')}; }
            & .license-note { font-size: 0.72rem; color: ${t('color-text-secondary')}; &:empty { display: none; } }
            & .error { font-size: 0.75rem; color: ${t('color-status-negative')}; &:empty { display: none; } }

            & .fetch-btn {
                padding: ${s('xs')} ${s('sm')};
                font-size: 0.78rem;
                ${btn()}
                &:disabled { opacity: 0.5; cursor: default; }
            }

            & .prop-field {
                display: flex;
                align-items: center;
                gap: ${s('sm')};
                font-size: 0.72rem;
                color: ${t('color-text-secondary')};
                & select { font-size: 0.72rem; padding: 1px 2px; }
            }

            & .bucket-row {
                display: grid;
                grid-template-columns: 12px 1fr auto 110px;
                align-items: center;
                gap: ${s('xs')};
                padding: 2px 0;

                & .bucket-swatch {
                    width: 12px; height: 12px;
                    border-radius: 3px;
                    border: 1px solid rgba(0,0,0,0.25);
                }
                /* Law 05: labels never truncate — arbitrary property values
                   wrap instead of ellipsizing. */
                & .bucket-label {
                    font-size: 0.72rem;
                    min-width: 0;
                    overflow-wrap: anywhere;
                }
                & .bucket-count {
                    font-size: 0.7rem;
                    color: ${t('color-text-tertiary')};
                    ${metric()}
                }
                & select { font-size: 0.72rem; padding: 1px 2px; max-width: 110px; }
            }

            & .pick-row {
                display: flex;
                align-items: center;
                gap: ${s('xs')};
                & .pick-info { flex: 1; font-size: 0.72rem; color: ${t('color-text-secondary')}; ${metric()} }
                & .secondary { padding: 1px ${s('sm')}; font-size: 0.72rem; ${btn()} }
            }

            & .actions {
                display: flex;
                flex-direction: row;
                gap: ${s('sm')};
                & .secondary { flex: 1; padding: ${s('xs')} ${s('sm')}; font-size: 0.78rem; ${btn()} }
                & .primary { flex: 1; padding: ${s('xs')} ${s('sm')}; font-size: 0.78rem; ${primaryBtn()}
                    &:disabled { opacity: 0.5; cursor: default; }
                }
            }

            & .imported-row {
                display: grid;
                grid-template-columns: 1fr auto auto;
                align-items: center;
                gap: ${s('xs')} ${s('sm')};
                padding: 2px 0;
                & .imported-label { font-size: 0.75rem; min-width: 0; overflow-wrap: anywhere; }
                & .bucket-count { font-size: 0.7rem; color: ${t('color-text-tertiary')}; ${metric()} }
                & .imported-types { grid-column: 1 / -1; font-size: 0.68rem; color: ${t('color-text-secondary')}; }
            }

            & .summary { font-size: 0.75rem; white-space: pre-line; }
            & .ponds-next { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.75rem; &.hidden { display: none; } }
            & .warnings { font-size: 0.7rem; color: ${t('color-text-secondary')}; white-space: pre-line; }
        }
    `;

    private svc = this.inject(GeojsonImportService);
    private mapSvc = this.inject(MapService);
    private features = this.inject(FeaturesService);
    private confirmDialog = this.inject(ConfirmService);
    private terrainEdit = this.inject(TerrainEditToolService);
    private editorMode = this.inject(EditorModeService);
    /** True while the dashed preview overlay is on the live map. */
    private previewAdded = false;

    render(): DocumentFragment {
        const parsed = () => this.svc.parsed.get();

        const frag = this.wire(tpl, {
            root: { className: () => this.svc.open.get() ? 'geojson-import show' : 'geojson-import' },
            close: { onclick: () => this.svc.close() },
            file: {
                onchange: async (e: Event) => {
                    const input = e.target as HTMLInputElement;
                    const file = input.files?.[0];
                    if (!file) return;
                    this.svc.loadGeojsonText(await file.text(), file.name);
                },
            },
            // One-click variants: server-proxied Hydrografi Direkt (T50)
            // and OSM/Overpass (T53) fetches for the course map area — no
            // manual file step. One fetch at a time; the in-flight
            // variant's button carries the progress label.
            fetchHydro: {
                textContent: () => this.svc.fetching.get() && this.svc.fetchSource.get() === 'lantmateriet'
                    ? 'Fetching from Lantmäteriet…'
                    : 'Fetch from Lantmäteriet (water + creeks)',
                disabled: () => this.svc.fetching.get(),
                onclick: () => void this.svc.fetchFromLantmateriet(),
            },
            fetchOsm: {
                textContent: () => this.svc.fetching.get() && this.svc.fetchSource.get() === 'osm'
                    ? 'Fetching from OpenStreetMap…'
                    : 'Fetch from OpenStreetMap',
                disabled: () => this.svc.fetching.get(),
                onclick: () => void this.svc.fetchFromOsm(),
            },
            fetchRoads: {
                textContent: () => this.svc.fetching.get() && this.svc.fetchSource.get() === 'roads'
                    ? 'Fetching roads (OSM + NVDB)…'
                    : 'Fetch roads (OSM + NVDB)',
                title: 'Every road within 200 m of the course as a corridor polygon (path): OSM, with NVDB widths, paved/gravel and the roads OSM lacks — bucket on road_class to keep roads and drop footpaths',
                disabled: () => this.svc.fetching.get(),
                onclick: () => void this.svc.fetchFromRoads(),
            },
            // ODbL notice (T49 posture) — shown while an OSM fetch (features
            // or roads) is the wizard's loaded source.
            odblNote: () => [OSM_FETCH_FILENAME, ROADS_FETCH_FILENAME].includes(this.svc.fileName.get() ?? '')
                ? 'OSM data is ODbL — imported features mark this course\'s map data ODbL until removed.'
                : '',
            fetchError: () => this.svc.fetchError.get() ?? '',
            fileInfo: () => {
                const p = parsed();
                if (!p) return this.svc.fileName.get() ?? 'Choose a pipeline draft (fetch-water / fetch-osm / detect-trees output), or fetch directly from Lantmäteriet or OpenStreetMap.';
                const skipped = p.skipped.length > 0 ? ` (${p.skipped.join('; ')})` : '';
                return `${this.svc.fileName.get()} — ${p.features.length} importable features${skipped}`;
            },
            generatedNote: () => this.svc.generatedSourceNote.get() ?? '',
            parseError: () => this.svc.parseError.get() ?? '',
            mappingSection: { className: () => parsed() ? 'geojson-import__section' : 'geojson-import__section hidden' },
            property: {
                onchange: (e: Event) => {
                    const v = (e.target as HTMLSelectElement).value;
                    this.svc.setPropertyKey(v === '' ? null : v);
                },
            },
            actionsSection: { className: () => parsed() ? 'geojson-import__section' : 'geojson-import__section hidden' },
            // One line: what the import takes; the map is where shapes are picked.
            pickInfo: {
                textContent: () => {
                    const total = this.svc.built.get()?.features.length ?? 0;
                    const onCourse = this.svc.onCourseCount.get();
                    const picked = this.svc.pickedFeatures.get().length;
                    return `${picked} of ${total - onCourse} picked${onCourse > 0 ? ` · ${onCourse} on the course` : ''}`;
                },
                title: 'Click a shape on the map to pick or drop it. Shapes the course already has are grey and stay out.',
            },
            pickAll: { onclick: () => this.svc.pickAll(true), disabled: () => this.svc.importing.get() },
            pickNone: { onclick: () => this.svc.pickAll(false), disabled: () => this.svc.importing.get() },
            confirm: {
                textContent: () => {
                    const progress = this.svc.progress.get();
                    if (this.svc.importing.get() && progress) return `Importing ${progress.done}/${progress.total}…`;
                    const n = this.svc.pickedFeatures.get().length;
                    return `Import ${n} feature${n === 1 ? '' : 's'}`;
                },
                disabled: () => this.svc.importing.get() || this.svc.pickedFeatures.get().length === 0,
                onclick: async () => {
                    const summary = await this.svc.confirmImport();
                    // reloadOrLoad, not reload(): the store may never have
                    // loaded (import before the draw tool ever activated) —
                    // reload() would no-op and nothing would render.
                    const courseId = this.svc.targetCourseId;
                    if (summary && courseId) await this.features.reloadOrLoad(courseId);
                },
            },
            summarySection: { className: () => this.svc.summary.get() ? 'geojson-import__section' : 'geojson-import__section hidden' },
            summaryText: () => {
                const summary = this.svc.summary.get();
                if (!summary) return '';
                const lines = Object.entries(summary.created)
                    .sort((a, b) => b[1] - a[1])
                    .map(([type, n]) => `${FEATURE_STYLES[type as keyof typeof FEATURE_STYLES]?.label ?? type}: ${n}`);
                const total = Object.values(summary.created).reduce((a, b) => a + b, 0);
                let text = `Created ${total} features\n${lines.join('\n')}`;
                if (summary.error) text += `\nFAILED: ${summary.error} (import stopped — already-created features kept)`;
                return text;
            },
            // Water came in: one line pointing at the next step (Terrain edit › Ponds), and the button that takes it.
            pondsNext: { className: () => (this.svc.summary.get()?.created.water ?? 0) > 0 ? 'ponds-next' : 'ponds-next hidden' },
            pondsNextText: { textContent: () => `${this.svc.summary.get()?.created.water ?? 0} pond(s) in. Next: fit their edges to the water.` },
            pondsNextBtn: {
                title: "Opens Terrain edit › Ponds and shows each pond's edge found on the photo between the lidar's water and the imported line, to Accept or Skip",
                onclick: () => {
                    this.svc.close();
                    this.terrainEdit.requestPondFit();
                    this.editorMode.activate(terrainEditTool);
                },
            },
            importedSection: { className: () => this.svc.imported.get().length > 0 ? 'geojson-import__section' : 'geojson-import__section hidden' },
            clearError: () => this.svc.clearError.get() ?? '',
            warnings: () => {
                const summary = this.svc.summary.get();
                const warnings = summary?.warnings ?? this.svc.built.get()?.warnings ?? [];
                if (warnings.length === 0) return '';
                const shown = warnings.slice(0, 6);
                const more = warnings.length - shown.length;
                return `Skipped:\n${shown.join('\n')}${more > 0 ? `\n… +${more} more` : ''}`;
            },
        });

        // Property-key options follow the parsed file.
        const propertySelect = this.ref(frag, 'property') as HTMLSelectElement;
        this.track(effect(() => {
            const p = this.svc.parsed.get();
            const current = this.svc.propertyKey.get();
            propertySelect.innerHTML = '';
            if (!p) return;
            for (const key of p.propertyKeys) {
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = key;
                propertySelect.appendChild(opt);
            }
            const none = document.createElement('option');
            none.value = '';
            none.textContent = '— all in one bucket —';
            propertySelect.appendChild(none);
            propertySelect.value = current ?? '';
        }));

        // Earlier imports, clearable per group.
        this.$each(
            this.ref(frag, 'importedList'),
            () => this.svc.imported.get(),
            (group, _i, track) => this.importedRow(group, track),
            group => `${group.key}∷${group.count}`,
        );

        // Bucket mapping rows. Bucket identity is (file, property, value);
        // the row's select stays live via the assignments signal.
        this.$each(
            this.ref(frag, 'buckets'),
            () => this.svc.buckets.get(),
            (bucket, _i, track) => this.bucketRow(bucket, track),
            bucket => `${this.svc.fileName.peek()}∷${this.svc.propertyKey.peek() ?? ''}∷${bucket.key}`,
        );

        return frag;
    }

    private importedRow(group: ImportGroup, track: (d: () => void) => void): HTMLElement {
        const typeLabel = (type: string) => FEATURE_STYLES[type as keyof typeof FEATURE_STYLES]?.label ?? type;
        return this.wireEl(importedRowTpl, {
            label: { textContent: group.label },
            count: { textContent: `×${group.count}` },
            types: { textContent: group.types.map(t => `${typeLabel(t.type)} ${t.count}`).join(' · ') },
            remove: {
                textContent: () => this.svc.clearing.get() === group.key ? 'Removing…' : 'Remove',
                disabled: () => this.svc.clearing.get() !== null || this.svc.importing.get(),
                onclick: async () => {
                    const ok = await this.confirmDialog.confirm({
                        title: `Remove ${group.count} imported feature${group.count === 1 ? '' : 's'}?`,
                        body: `${group.label}: every feature this import created on the course, including any you have edited since.`,
                        detail: 'Hand-drawn features and generated layers (lidar trees, grass zones) are kept. This cannot be undone — fetch and import again to get them back. '
                            + (group.key === 'roads' ? 'The road grading (terrain edits) stays until you grade roads again.' : ''),
                        confirmLabel: 'Remove',
                        tone: 'danger',
                    });
                    if (!ok) return;
                    const removed = await this.svc.clearImported(group);
                    const courseId = this.svc.targetCourseId;
                    if (removed !== null && courseId) await this.features.reloadOrLoad(courseId);
                },
            },
        }, track);
    }

    private bucketRow(bucket: GeojsonBucket, track: (d: () => void) => void): HTMLElement {
        const assignedFill = () => {
            const a = this.svc.assignments.get()[bucket.key];
            return a && a !== 'skip' ? FEATURE_STYLES[a].fill : '#ffffff';
        };
        const el = this.wireEl(bucketRowTpl, {
            swatch: { style: () => `background:${assignedFill()}` },
            label: {
                textContent: bucket.value,
                title: `${this.svc.propertyKey.peek() ?? '(no property)'} = ${bucket.value}`,
            },
            count: { textContent: `×${bucket.polygonCount}` },
            type: {
                onchange: (e: Event) => {
                    const v = (e.target as HTMLSelectElement).value;
                    this.svc.assign(bucket.key, v as never);
                },
                value: () => this.svc.assignments.get()[bucket.key] ?? 'skip',
            },
        }, track);
        const select = el.querySelector('select') as HTMLSelectElement;
        const skip = document.createElement('option');
        skip.value = 'skip';
        skip.textContent = '— skip —';
        select.appendChild(skip);
        for (const type of FEATURE_TYPES) {
            const opt = document.createElement('option');
            opt.value = type;
            opt.textContent = FEATURE_STYLES[type].label;
            select.appendChild(opt);
        }
        select.value = this.svc.assignments.peek()[bucket.key] ?? 'skip';
        return el;
    }

    onMount(): void {
        // Dashed preview overlay driven by `built` (dies with the map;
        // re-added when the map is ready again). The shapes carry their pick
        // state, so the overlay follows every pick.
        const stateOf = (f: BuiltFeature): PickState =>
            this.svc.isOnCourse(f) ? 'on-course' : this.svc.isPicked(f) ? 'picked' : 'dropped';
        this.track(effect(() => {
            const ready = this.mapSvc.ready.get();
            const built = this.svc.built.get();
            const data = builtToGeojson(built, stateOf);
            if (!ready) {
                this.previewAdded = false;
                return;
            }
            if (built && !this.previewAdded) {
                this.mapSvc.addOverlayLayer(PREVIEW_OVERLAY_ID, data, [
                    {
                        id: 'geojson-import-preview-fill',
                        type: 'fill',
                        paint: {
                            'fill-color': ['case', ['==', ['get', 'state'], 'picked'], typeColorExpression('fill'), DROPPED_FILL] as never,
                            'fill-opacity': ['match', ['get', 'state'], 'picked', 0.35, 'dropped', 0.12, 0] as never,
                        },
                    },
                    {
                        id: 'geojson-import-preview-outline',
                        type: 'line',
                        paint: {
                            'line-color': ['match', ['get', 'state'], 'picked', PREVIEW_OUTLINE, DROPPED_OUTLINE] as never,
                            'line-width': ['match', ['get', 'state'], 'picked', 2, 1.2] as never,
                            'line-dasharray': [2, 2],
                        },
                    },
                ]);
                this.previewAdded = true;
            } else if (built && this.previewAdded) {
                this.mapSvc.updateOverlayData(PREVIEW_OVERLAY_ID, data);
            } else if (!built && this.previewAdded) {
                this.mapSvc.removeOverlayLayer(PREVIEW_OVERLAY_ID);
                this.previewAdded = false;
            }
        }));
        this.track(() => {
            if (this.previewAdded) this.mapSvc.removeOverlayLayer(PREVIEW_OVERLAY_ID);
        });

        // While the wizard's shapes are on the map, a click picks or drops
        // the one under it: the wizard takes the map's clicks from the tool,
        // and gives them back to that tool when it closes.
        let release: (() => void) | null = null;
        let toolBefore: EditorTool | null = null;
        this.track(effect(() => {
            const picking = this.svc.open.get() && this.svc.built.get() !== null;
            untrack(() => {
                if (picking && !release) {
                    toolBefore = this.editorMode.peekActiveTool();
                    this.editorMode.deactivate();
                    release = this.mapSvc.claimInteraction(PICK_MODE);
                } else if (!picking && release) {
                    const stillMine = this.mapSvc.interactionMode.peek() === PICK_MODE;
                    release();
                    release = null;
                    if (stillMine && toolBefore) this.editorMode.activate(toolBefore);
                    toolBefore = null;
                }
            });
        }));
        this.track(() => release?.());
        this.track(this.mapSvc.onClick(e => {
            if (this.mapSvc.interactionMode.peek() !== PICK_MODE || this.svc.importing.peek()) return;
            const features = this.svc.built.peek()?.features ?? [];
            const hit = shapeAt(features.map(f => geometryToWgs84Rings(f.geometry)), { x: e.lngLat.lng, y: e.lngLat.lat });
            const key = hit >= 0 ? features[hit].key : undefined;
            if (key !== undefined) this.svc.togglePick(key);
        }));
    }
}
