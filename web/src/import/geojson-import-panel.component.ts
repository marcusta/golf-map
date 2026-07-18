// Floating wizard panel for GeoJSON draft import (T43). Mirrors
// SvgImportPanelComponent: spawned once by CourseDetailComponent; hidden
// until the command bar's "Import GeoJSON" calls GeojsonImportService
// .openFor(). Docked to the right edge so the map stays visible for the
// preview overlay (dashed styling, id `geojson-import-preview`) rendered
// from `svc.built`. No georeference section — files are EPSG:3006 already
// (the service rejects anything else).

import { Component, effect, template } from '@basics/core/client/core';
import type { Feature, FeatureCollection } from 'geojson';
import { t } from '../theme';
import { s, btn, primaryBtn, glassPanel, panelTitle, metric, OVERLAY_W, OVERLAY_INSET } from '../css';
import { MapService } from '../map/map.service';
import { FeaturesService, geometryToWgs84Rings } from '../draw/features.service';
import { FEATURE_TYPES, FEATURE_STYLES, typeColorExpression } from '../draw/feature-palette';
import { GeojsonImportService } from './geojson-import.service';
import type { BuildResult } from './svg-import.service';
import type { GeojsonBucket } from './geojson-parse';
import { icon } from '../ui/icons';

/** Overlay id for the temporary import preview. */
export const PREVIEW_OVERLAY_ID = 'geojson-import-preview';

/** Dashed magenta preview styling — unmistakably "not real features yet". */
const PREVIEW_OUTLINE = '#d63384';

const tpl = template(`
    <div bind="root" class="geojson-import">
        <div class="geojson-import__header">
            <h3>Import GeoJSON</h3>
            <button bind="close" type="button" aria-label="Close" title="Close">${icon('x')}</button>
        </div>

        <div class="geojson-import__section">
            <h4 class="section-title">1 &middot; GeoJSON file (EPSG:3006)</h4>
            <input bind="file" type="file" accept=".geojson,.json,application/geo+json" />
            <div bind="fileInfo" class="hint"></div>
            <div bind="parseError" class="error"></div>
        </div>

        <div bind="mappingSection" class="geojson-import__section">
            <h4 class="section-title">2 &middot; Map values to feature types</h4>
            <label class="prop-field">Bucket by property
                <select bind="property"></select>
            </label>
            <div bind="buckets" class="bucket-list"></div>
        </div>

        <div bind="actionsSection" class="geojson-import__section actions">
            <button bind="preview" type="button" class="secondary"></button>
            <button bind="confirm" type="button" class="primary"></button>
        </div>

        <div bind="summarySection" class="geojson-import__section">
            <h4 class="section-title">Result</h4>
            <div bind="summaryText" class="summary"></div>
            <div bind="warnings" class="warnings"></div>
        </div>
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

function builtToGeojson(built: BuildResult | null): FeatureCollection {
    const features: Feature[] = (built?.features ?? []).map((f, i) => ({
        type: 'Feature',
        id: i,
        properties: { type: f.type },
        geometry: { type: 'Polygon', coordinates: geometryToWgs84Rings(f.geometry) },
    }));
    return { type: 'FeatureCollection', features };
}

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
            & .error { font-size: 0.75rem; color: ${t('color-status-negative')}; &:empty { display: none; } }

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

            & .actions {
                flex-direction: row;
                gap: ${s('sm')};
                & .secondary { flex: 1; padding: ${s('xs')} ${s('sm')}; font-size: 0.78rem; ${btn()} }
                & .primary { flex: 1; padding: ${s('xs')} ${s('sm')}; font-size: 0.78rem; ${primaryBtn()}
                    &:disabled { opacity: 0.5; cursor: default; }
                }
            }

            & .summary { font-size: 0.75rem; white-space: pre-line; }
            & .warnings { font-size: 0.7rem; color: ${t('color-text-secondary')}; white-space: pre-line; }
        }
    `;

    private svc = this.inject(GeojsonImportService);
    private mapSvc = this.inject(MapService);
    private features = this.inject(FeaturesService);
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
            fileInfo: () => {
                const p = parsed();
                if (!p) return this.svc.fileName.get() ?? 'Choose a pipeline draft (fetch-water / fetch-osm / detect-trees output).';
                const skipped = p.skipped.length > 0 ? ` (${p.skipped.join('; ')})` : '';
                return `${this.svc.fileName.get()} — ${p.features.length} importable features${skipped}`;
            },
            parseError: () => this.svc.parseError.get() ?? '',
            mappingSection: { className: () => parsed() ? 'geojson-import__section' : 'geojson-import__section hidden' },
            property: {
                onchange: (e: Event) => {
                    const v = (e.target as HTMLSelectElement).value;
                    this.svc.setPropertyKey(v === '' ? null : v);
                },
            },
            actionsSection: { className: () => parsed() ? 'geojson-import__section actions' : 'geojson-import__section actions hidden' },
            preview: {
                textContent: () => this.svc.built.get() ? 'Refresh preview' : 'Preview on map',
                onclick: () => this.svc.build(),
            },
            confirm: {
                textContent: () => {
                    const progress = this.svc.progress.get();
                    if (this.svc.importing.get() && progress) return `Importing ${progress.done}/${progress.total}…`;
                    return `Import ${this.svc.assignedFeatureCount.get()} features`;
                },
                disabled: () => this.svc.importing.get() || this.svc.assignedFeatureCount.get() === 0,
                onclick: async () => {
                    const summary = await this.svc.confirmImport();
                    if (summary) await this.features.reload();
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
        // re-added when the map is ready again).
        this.track(effect(() => {
            const ready = this.mapSvc.ready.get();
            const built = this.svc.built.get();
            if (!ready) {
                this.previewAdded = false;
                return;
            }
            if (built && !this.previewAdded) {
                this.mapSvc.addOverlayLayer(PREVIEW_OVERLAY_ID, builtToGeojson(built), [
                    {
                        id: 'geojson-import-preview-fill',
                        type: 'fill',
                        paint: {
                            'fill-color': typeColorExpression('fill') as never,
                            'fill-opacity': 0.3,
                        },
                    },
                    {
                        id: 'geojson-import-preview-outline',
                        type: 'line',
                        paint: {
                            'line-color': PREVIEW_OUTLINE,
                            'line-width': 1.5,
                            'line-dasharray': [2, 2],
                        },
                    },
                ]);
                this.previewAdded = true;
            } else if (built && this.previewAdded) {
                this.mapSvc.updateOverlayData(PREVIEW_OVERLAY_ID, builtToGeojson(built));
            } else if (!built && this.previewAdded) {
                this.mapSvc.removeOverlayLayer(PREVIEW_OVERLAY_ID);
                this.previewAdded = false;
            }
        }));
        this.track(() => {
            if (this.previewAdded) this.mapSvc.removeOverlayLayer(PREVIEW_OVERLAY_ID);
        });
    }
}
