// "Check shapes" in the Draw mode: the GSPro SVG export's checks run on the course as it is now (server
// GsproExportService.svgCheck, `gspro.py svg --check-only`; nothing is written). The findings list in a floating
// panel and show on the map; a click on one selects its shapes and takes the map there; Accept marks a finding as
// known (it then no longer stops the export) and Undo takes that back. Opened from the Draw stack panel and from a
// failed export / Update shapes whose error starts with `SVG check:`.

import { Signal, di } from '@basics/core/client/core';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { api } from '../api';
import { flattenRing } from '../geo/bezier';
import { sweref99tmToWgs84 } from '../geo/transform';
import { MapService } from '../map/map.service';
import { FeaturesService } from './features.service';
import { ROUGHS_LAYER } from '../../../shared/render/stack-key';
import type { SvgCheckFinding, SvgCheckReport } from '../../../shared/api/gspro-export.gen';

/** What a finding carries on the map. */
export interface SvgCheckMapProps {
    key: string;
    severity: SvgCheckFinding['severity'];
    /** `area` = polygon fill + outline, `line` = a line, `pin` = the finding's point. */
    shape: 'area' | 'line' | 'pin';
    focused: boolean;
}

/** An export error that comes from the SVG checks (`SVG check: 5 error(s), nothing written - …`). */
export function isSvgCheckError(text: string | null | undefined): boolean {
    return !!text && text.includes('SVG check:');
}

const CODE_LABELS: Record<string, string> = {
    'overlap-sliver': 'sliver',
    'narrow-neck': 'neck',
    'hidden-shape': 'hidden',
    'green-border': 'green edge',
    'tiny-shape': 'tiny',
    'sharp-corner': 'corner',
    'creek-left-out': 'creek left out',
};

/** Short label for a finding's code. */
export function codeLabel(code: string): string {
    return CODE_LABELS[code] ?? code.replace(/-/g, ' ');
}

/** The shapes a finding names, `hole_8_253 → hole_8_233` for a pair. */
export function shapesLabel(f: SvgCheckFinding): string {
    const names = f.shapes.map((s) => s.name);
    if (names.length === 0) return '(no shape)';
    if (names.length === 2) return `${names[0]} → ${names[1]}`;
    return names.join(', ');
}

/** The check code of a shape the ones above it cover (its first shape is the hidden one). */
export const HIDDEN_SHAPE = 'hidden-shape';

export class SvgCheckService {
    /** Course the panel is open for; null = closed. */
    readonly courseId = new Signal<string | null>(null);
    readonly report = new Signal<SvgCheckReport | null>(null);
    /** '' idle, `run` while the check runs, else the key of the finding being accepted. */
    readonly busy = new Signal('');
    readonly error = new Signal('');
    /** Key of the finding last clicked (drawn thicker on the map). */
    readonly focused = new Signal<string | null>(null);
    /** Bumped on every open, so the panel can switch to the Draw mode. */
    readonly opened = new Signal(0);

    private features = di.get(FeaturesService);
    private mapSvc = di.get(MapService);

    open(courseId: string): void {
        if (this.courseId.peek() !== courseId) this.discard();
        this.courseId.set(courseId);
        this.opened.set(this.opened.peek() + 1);
        void this.run();
    }

    close(): void {
        this.discard();
        this.courseId.set(null);
    }

    async run(): Promise<void> {
        const courseId = this.courseId.peek();
        if (!courseId || this.busy.peek()) return;
        this.busy.set('run');
        this.error.set('');
        try {
            const res = await api.gsproExport.svgCheck({ courseId });
            if (this.courseId.peek() !== courseId) return;
            this.report.set(res);
            if (this.focused.peek() && !res.findings.some((f) => f.key === this.focused.peek())) this.focused.set(null);
        } catch (e) {
            if (this.courseId.peek() === courseId) this.error.set(e instanceof Error ? e.message : String(e));
        } finally {
            this.busy.set('');
        }
    }

    /** Accept a finding (it no longer stops the export) or take that back; patched locally, no re-run. */
    async accept(finding: SvgCheckFinding, accepted: boolean): Promise<void> {
        const courseId = this.courseId.peek();
        if (!courseId || this.busy.peek()) return;
        this.busy.set(finding.key);
        this.error.set('');
        try {
            await api.gsproExport.acceptSvgFinding({ courseId, key: finding.key, accepted });
            const report = this.report.peek();
            if (report && this.courseId.peek() === courseId) {
                const findings = report.findings.map((f) => f.key === finding.key ? { ...f, accepted } : f);
                this.report.set({ ...report, findings, ...counts(findings) });
            }
        } catch (e) {
            this.error.set(e instanceof Error ? e.message : String(e));
        } finally {
            this.busy.set('');
        }
    }

    /**
     * Lift a hidden shape just above the shapes covering it (into their group when they are higher), then
     * reload the shapes and check again: the server's CourseFeaturesService.raiseAbove.
     */
    async lift(finding: SvgCheckFinding): Promise<void> {
        const courseId = this.courseId.peek();
        const [hidden, ...covers] = finding.shapes;
        if (!courseId || !hidden?.featureIds[0] || this.busy.peek()) return;
        this.busy.set(finding.key);
        this.error.set('');
        try {
            const res = await api.courseFeatures.raiseAbove({
                courseId, featureId: hidden.featureIds[0], coverIds: covers.flatMap((s) => s.featureIds),
            });
            if (!res.moved) this.error.set(`${hidden.name} is not under ${covers.map((s) => s.name).join(', ')} in the stack; a road, or its shape, covers it`);
            await this.features.reload();
        } catch (e) {
            this.error.set(e instanceof Error ? e.message : String(e));
        } finally {
            this.busy.set('');
        }
        await this.run();
        this.features.setSelection(hidden.featureIds.filter((id) => this.features.featureIdSet.peek().has(id)));
    }

    /**
     * Select the finding's shapes (showing them if an eye hid them) and take the map there. A hidden shape
     * selects only itself: it is the one to lift or reshape, the ones over it are just named.
     */
    focus(finding: SvgCheckFinding): void {
        this.focused.set(finding.key);
        const shapes = finding.code === HIDDEN_SHAPE ? finding.shapes.slice(0, 1) : finding.shapes;
        const ids = [...new Set(shapes.flatMap((s) => s.featureIds))].filter((id) => this.features.featureIdSet.peek().has(id));
        this.reveal(ids);
        this.features.setSelection(ids);
        const box = this.bounds(finding, ids);
        if (box) this.mapSvc.fitBounds(box, { padding: 120, maxZoom: 20 });
    }

    /** One line: `5 errors · 2 warnings`, `OK` when nothing stops the export or warns. */
    summary(): string {
        const r = this.report.get();
        if (!r) return '';
        const c = counts(r.findings);
        const parts = [
            c.errors ? `${c.errors} error${c.errors === 1 ? '' : 's'}` : '',
            c.warnings ? `${c.warnings} warning${c.warnings === 1 ? '' : 's'}` : '',
        ].filter(Boolean);
        return parts.length ? parts.join(' · ') : 'OK';
    }

    /** Every finding's geometry (lon/lat) plus a pin at its point, for the map. Accepted and notes only when focused. */
    layer(): FeatureCollection<Geometry, SvgCheckMapProps> {
        const out: Feature<Geometry, SvgCheckMapProps>[] = [];
        const focusedKey = this.focused.get();
        for (const f of this.report.get()?.findings ?? []) {
            const focused = f.key === focusedKey;
            if (!focused && (f.accepted || f.severity === 'note')) continue;
            const base = { key: f.key, severity: f.severity, focused };
            const g = f.geometry ? toLngLat(f.geometry) : null;
            if (g) {
                const shape = g.type === 'Polygon' || g.type === 'MultiPolygon' ? 'area' : g.type === 'Point' || g.type === 'MultiPoint' ? 'pin' : 'line';
                out.push({ type: 'Feature', properties: { ...base, shape }, geometry: g });
            }
            if (f.at) {
                const { lat, lon } = sweref99tmToWgs84(f.at[0], f.at[1]);
                out.push({ type: 'Feature', properties: { ...base, shape: 'pin' }, geometry: { type: 'Point', coordinates: [lon, lat] } });
            }
        }
        return { type: 'FeatureCollection', features: out };
    }

    private discard(): void {
        this.report.set(null);
        this.error.set('');
        this.focused.set(null);
    }

    /** Clear the eyes (type, shape, hole, generated source, Roughs layer) that would keep these shapes off the map. */
    private reveal(ids: string[]): void {
        const fs = this.features;
        for (const id of ids) {
            const f = fs.store.item(id).peek();
            if (fs.hiddenTypes.peek().has(f.type)) fs.toggleTypeVisibility(f.type);
            if (fs.hiddenIds.peek().has(id)) fs.toggleFeatureVisibility(id);
            if (f.holeId && fs.hiddenHoleIds.peek().has(f.holeId)) fs.toggleHoleVisibility(f.holeId);
            if (f.source && fs.hiddenSources.peek().has(f.source)) fs.toggleSourceVisibility(f.source);
            if (f.layer === ROUGHS_LAYER && fs.roughsLayerHidden.peek()) fs.toggleRoughsLayerVisibility();
        }
    }

    /** [west, south, east, north] of the finding's geometry, else its point, else its shapes. */
    private bounds(finding: SvgCheckFinding, ids: string[]): [number, number, number, number] | null {
        const pts: [number, number][] = [];
        if (finding.geometry) collect(finding.geometry.coordinates, pts);
        if (!pts.length && finding.at) pts.push(finding.at);
        if (!pts.length) {
            for (const id of ids) {
                const f = this.features.store.item(id).peek();
                for (const ring of f.geometry.rings) pts.push(...flattenRing(ring, 1, f.geometry.curveType));
            }
        }
        if (!pts.length) return null;
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const [x, y] of pts) {
            const { lat, lon } = sweref99tmToWgs84(x, y);
            w = Math.min(w, lon); e = Math.max(e, lon);
            s = Math.min(s, lat); n = Math.max(n, lat);
        }
        return [w, s, e, n];
    }
}

function counts(findings: SvgCheckFinding[]): Pick<SvgCheckReport, 'errors' | 'warnings' | 'notes' | 'accepted'> {
    const open = findings.filter((f) => !f.accepted);
    return {
        errors: open.filter((f) => f.severity === 'error').length,
        warnings: open.filter((f) => f.severity === 'warning').length,
        notes: open.filter((f) => f.severity === 'note').length,
        accepted: findings.length - open.length,
    };
}

/** Every [x, y] in a GeoJSON coordinates tree. */
function collect(c: unknown, out: [number, number][]): void {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
        out.push([c[0], c[1]]);
        return;
    }
    for (const sub of c) collect(sub, out);
}

/** A GeoJSON geometry in EPSG:3006 metres to lon/lat; null for an unknown type. */
function toLngLat(g: { type: string; coordinates: unknown }): Geometry | null {
    const map = (c: unknown): unknown => {
        if (!Array.isArray(c)) return c;
        if (typeof c[0] === 'number' && typeof c[1] === 'number') {
            const { lat, lon } = sweref99tmToWgs84(c[0], c[1]);
            return [lon, lat];
        }
        return c.map(map);
    };
    const types = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];
    if (!types.includes(g.type) || !Array.isArray(g.coordinates)) return null;
    return { type: g.type, coordinates: map(g.coordinates) } as Geometry;
}
