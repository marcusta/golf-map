// Floating wizard panel for SVG course-feature import (Phase 3 / roadmap
// 2.4). Spawned once by CourseDetailComponent; hidden until the header's
// "Import SVG" button calls SvgImportService.openFor(). Docked to the right
// edge so the map stays visible for the georeferenced preview overlay
// (dashed styling, id `svg-import-preview`) rendered from `svc.built`.

import { Component, effect, template } from '@basics/core/client/core';
import type { Feature, FeatureCollection } from 'geojson';
import { t } from '../theme';
import { s, btn, primaryBtn, field } from '../css';
import { MapService } from '../map/map.service';
import { FeaturesService, geometryToWgs84Rings } from '../draw/features.service';
import { FEATURE_TYPES, FEATURE_STYLES, typeColorExpression } from '../draw/feature-palette';
import { SvgImportService, type BuildResult } from './svg-import.service';
import type { SvgBucket } from './svg-parse';

/** Overlay id for the temporary import preview. */
export const PREVIEW_OVERLAY_ID = 'svg-import-preview';

/** Dashed magenta preview styling — unmistakably "not real features yet". */
const PREVIEW_OUTLINE = '#d63384';

const tpl = template(`
    <div bind="root" class="svg-import">
        <div class="svg-import__header">
            <h3>Import SVG</h3>
            <button bind="close" type="button" title="Close">&#10005;</button>
        </div>

        <div class="svg-import__section">
            <h4 class="section-title">1 &middot; SVG file</h4>
            <input bind="file" type="file" accept=".svg,image/svg+xml" />
            <div bind="fileInfo" class="hint"></div>
            <div bind="parseError" class="error"></div>
        </div>

        <div bind="mappingSection" class="svg-import__section">
            <h4 class="section-title">2 &middot; Map groups to feature types</h4>
            <div bind="buckets" class="bucket-list"></div>
        </div>

        <div bind="boundsSection" class="svg-import__section">
            <h4 class="section-title">3 &middot; Georeference (EPSG:3006 m)</h4>
            <div bind="boundsHint" class="hint"></div>
            <div class="bounds-grid">
                <label class="bounds-field">West (min E)<input bind="minX" type="number" step="any" /></label>
                <label class="bounds-field">East (max E)<input bind="maxX" type="number" step="any" /></label>
                <label class="bounds-field">South (min N)<input bind="minY" type="number" step="any" /></label>
                <label class="bounds-field">North (max N)<input bind="maxY" type="number" step="any" /></label>
            </div>
            <div class="hint">SVG top edge maps to the north bound (y-axis flipped).</div>
        </div>

        <div bind="actionsSection" class="svg-import__section actions">
            <button bind="preview" type="button" class="secondary"></button>
            <button bind="confirm" type="button" class="primary"></button>
        </div>

        <div bind="summarySection" class="svg-import__section">
            <h4 class="section-title">Result</h4>
            <div bind="summaryText" class="summary"></div>
            <div bind="warnings" class="warnings"></div>
        </div>
    </div>
`);

const bucketGroupTpl = template(`
    <div bind="group" class="bucket-group">
        <div class="bucket-group__head">
            <span bind="layerName" class="layer-name"></span>
            <span class="layer-actions">
                <button bind="all" type="button">map</button>
                <button bind="none" type="button">skip</button>
            </span>
        </div>
        <div bind="rows"></div>
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

export class SvgImportPanelComponent extends Component {
    static styles = `
        .svg-import {
            position: absolute;
            top: ${s('md')};
            right: ${s('md')};
            bottom: ${s('md')};
            width: 340px;
            z-index: 6;
            display: none;
            flex-direction: column;
            overflow-y: auto;
            border: 1px solid ${t('border')};
            border-radius: ${t('radius-sm')};
            background: ${t('surface')};
            box-shadow: ${t('shadow-elevated')};
            font-size: 0.8rem;
            color: ${t('text')};
            &.show { display: flex; }

            & .svg-import__header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: ${s('sm')} ${s('md')};
                border-bottom: 1px solid ${t('border')};
                & h3 { margin: 0; font-size: 0.9rem; }
                & button { padding: 2px ${s('sm')}; font-size: 0.8rem; ${btn()} }
            }

            & .svg-import__section {
                padding: ${s('sm')} ${s('md')};
                border-bottom: 1px solid ${t('border')};
                display: flex;
                flex-direction: column;
                gap: ${s('xs')};
                &.hidden { display: none; }
            }

            & .section-title {
                margin: 0;
                font-size: 0.7rem;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                color: ${t('text-muted')};
            }

            & .hint { font-size: 0.72rem; color: ${t('text-muted')}; }
            & .error { font-size: 0.75rem; color: ${t('error')}; &:empty { display: none; } }

            & .bucket-group__head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-top: ${s('xs')};
                & .layer-name { font-weight: 600; font-size: 0.75rem; }
                & .layer-actions button {
                    padding: 0 ${s('xs')};
                    font-size: 0.68rem;
                    ${btn()}
                }
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
                & .bucket-label {
                    font-size: 0.72rem;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                & .bucket-count { font-size: 0.7rem; color: ${t('text-muted')}; }
                & select { font-size: 0.72rem; padding: 1px 2px; max-width: 110px; }
            }

            & .bounds-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: ${s('xs')};
            }
            & .bounds-field {
                ${field()}
                font-size: 0.7rem;
                & input { padding: ${s('xs')} ${s('sm')}; font-size: 0.75rem; }
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
            & .warnings { font-size: 0.7rem; color: ${t('text-muted')}; white-space: pre-line; }
        }
    `;

    private svc = this.inject(SvgImportService);
    private mapSvc = this.inject(MapService);
    private features = this.inject(FeaturesService);
    /** True while the dashed preview overlay is on the live map. */
    private previewAdded = false;

    render(): DocumentFragment {
        const parsed = () => this.svc.parsed.get();

        const frag = this.wire(tpl, {
            root: { className: () => this.svc.open.get() ? 'svg-import show' : 'svg-import' },
            close: { onclick: () => this.svc.close() },
            file: {
                onchange: async (e: Event) => {
                    const input = e.target as HTMLInputElement;
                    const file = input.files?.[0];
                    if (!file) return;
                    this.svc.loadSvgText(await file.text(), file.name);
                },
            },
            fileInfo: () => {
                const p = parsed();
                if (!p) return this.svc.fileName.get() ?? 'Choose the traced course SVG.';
                const vb = p.viewBox;
                return `${this.svc.fileName.get()} — ${p.totalPaths} paths, viewBox ${vb.minX} ${vb.minY} ${vb.width} ${vb.height}`;
            },
            parseError: () => this.svc.parseError.get() ?? '',
            mappingSection: { className: () => parsed() ? 'svg-import__section' : 'svg-import__section hidden' },
            boundsSection: { className: () => parsed() ? 'svg-import__section' : 'svg-import__section hidden' },
            boundsHint: () => 'Prefilled from the course georeference — adjust if the preview is offset.',
            minX: this.boundsField('minX'),
            minY: this.boundsField('minY'),
            maxX: this.boundsField('maxX'),
            maxY: this.boundsField('maxY'),
            actionsSection: { className: () => parsed() ? 'svg-import__section actions' : 'svg-import__section actions hidden' },
            preview: {
                textContent: () => this.svc.built.get() ? 'Refresh preview' : 'Preview on map',
                onclick: () => this.svc.build(),
            },
            confirm: {
                textContent: () => {
                    const progress = this.svc.progress.get();
                    if (this.svc.importing.get() && progress) return `Importing ${progress.done}/${progress.total}…`;
                    return `Import ${this.svc.assignedPathCount.get()} paths`;
                },
                disabled: () => this.svc.importing.get() || this.svc.assignedPathCount.get() === 0,
                onclick: async () => {
                    const summary = await this.svc.confirmImport();
                    if (summary) await this.features.reload();
                },
            },
            summarySection: { className: () => this.svc.summary.get() ? 'svg-import__section' : 'svg-import__section hidden' },
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
                return `Skipped degenerate rings:\n${shown.join('\n')}${more > 0 ? `\n… +${more} more` : ''}`;
            },
        });

        // Bucket mapping rows, grouped by layer. Buckets are static per
        // parse, so key rows by file+layer.
        const layers = () => {
            const p = this.svc.parsed.get();
            if (!p) return [] as Array<{ layer: string; buckets: SvgBucket[] }>;
            const byLayer = new Map<string, SvgBucket[]>();
            for (const bucket of p.buckets) {
                (byLayer.get(bucket.layer) ?? byLayer.set(bucket.layer, []).get(bucket.layer)!).push(bucket);
            }
            return Array.from(byLayer, ([layer, buckets]) => ({ layer, buckets }));
        };
        this.$each(this.ref(frag, 'buckets'), layers, (group, _i, track) => {
            const el = this.wireEl(bucketGroupTpl, {
                layerName: () => group.layer || '(root)',
                all: { onclick: () => this.svc.assignLayer(group.layer, 'suggested') },
                none: { onclick: () => this.svc.assignLayer(group.layer, 'skip') },
            }, track);
            const rows = el.querySelector('[bind="rows"]') as HTMLElement;
            for (const bucket of group.buckets) {
                rows.appendChild(this.bucketRow(bucket, track));
            }
            return el;
        }, group => `${this.svc.fileName.peek()}∷${group.layer}`);

        return frag;
    }

    private boundsField(key: 'minX' | 'minY' | 'maxX' | 'maxY'): Record<string, unknown> {
        return {
            value: () => String(this.svc.bounds.get()[key]),
            onchange: (e: Event) => {
                const v = parseFloat((e.target as HTMLInputElement).value);
                if (Number.isFinite(v)) this.svc.setBounds({ ...this.svc.bounds.peek(), [key]: v });
            },
        };
    }

    private bucketRow(bucket: SvgBucket, track: (d: () => void) => void): HTMLElement {
        const el = this.wireEl(bucketRowTpl, {
            swatch: { style: `background:${bucket.fill ?? '#ffffff'}` },
            label: {
                textContent: bucket.fill ?? bucket.className ?? '(no fill/class)',
                title: `${bucket.layer || '(root)'} — ${bucket.fill ?? bucket.className ?? 'untyped'}`,
            },
            count: { textContent: `×${bucket.paths.length}` },
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
                        id: 'svg-import-preview-fill',
                        type: 'fill',
                        paint: {
                            'fill-color': typeColorExpression('fill') as never,
                            'fill-opacity': 0.3,
                        },
                    },
                    {
                        id: 'svg-import-preview-outline',
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
