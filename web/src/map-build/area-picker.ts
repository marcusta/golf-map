import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import type { GeoJSONSource, IControl, MapMouseEvent, StyleSpecification } from 'maplibre-gl';
import { Signal } from '@basics/core/client/core';
import type { Bbox } from '../../../shared/api/map-build.gen';
import { squareBox } from './bbox-math';

export type { Bbox };
export { bboxMetrics, formatBboxSize } from './bbox-math';

/**
 * Esri World Imagery satellite basemap — lets you see the actual course
 * grounds while drawing the area. Tiles are {z}/{y}/{x} (row before column).
 */
const SATELLITE_STYLE: StyleSpecification = {
    version: 8,
    sources: {
        satellite: {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            maxzoom: 19,
            attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
        },
    },
    layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
};

// Center ≈ Sweden so the user starts near the courses they're mapping.
const SWEDEN_CENTER: [number, number] = [15.0, 62.0];
const HANDLE_HIT_PX = 12; // grab radius for corner-drag

export type PickerMode = 'navigate' | 'draw';

// --- Geocoding (Photon) ---

interface PhotonFeature {
    geometry: { coordinates: [number, number] }; // [lon, lat]
    properties: {
        name?: string;
        street?: string;
        city?: string;
        county?: string;
        state?: string;
        country?: string;
        /** [west, north, east, south] — present for areas, absent for points. */
        extent?: [number, number, number, number];
    };
}

/** Compose a readable one-line label from Photon's structured fields. */
function photonLabel(f: PhotonFeature): string {
    const p = f.properties;
    const parts = [p.name, p.street, p.city ?? p.county, p.state, p.country].filter(Boolean) as string[];
    return [...new Set(parts)].join(', ');
}

function boxFeature(bbox: Bbox): GeoJSON.Feature {
    const { west: w, south: s, east: e, north: n } = bbox;
    return {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    };
}

function handleFeatures(bbox: Bbox): GeoJSON.Feature[] {
    return [
        { type: 'Feature', properties: { corner: 'sw' }, geometry: { type: 'Point', coordinates: [bbox.west, bbox.south] } },
        { type: 'Feature', properties: { corner: 'ne' }, geometry: { type: 'Point', coordinates: [bbox.east, bbox.north] } },
    ];
}

export interface AreaPickerOptions {
    initialBounds?: Bbox | null;
    /**
     * Optional externally-owned bbox signal. Pass one so a parent component can
     * read it in reactive bindings that are created BEFORE the picker exists —
     * otherwise the binding never subscribes to the picker's own signal.
     */
    bbox?: Signal<Bbox | null>;
}

/**
 * A self-contained satellite map with place search, two interaction modes
 * (navigate vs. draw), and a drag-to-draw square bounding box. Shared by the
 * new-course wizard and the set-map-area page. Not a framework Component:
 * parents own an instance, read its `bbox` / `mode` signals for reactive UI,
 * and call `destroy()` on teardown.
 */
export class AreaPicker {
    readonly bbox: Signal<Bbox | null>;
    readonly mode = new Signal<PickerMode>('navigate');

    private readonly map: maplibregl.Map;
    private anchor: maplibregl.LngLat | null = null; // fixed corner during a drag
    private dragging = false;
    private modeButtons: Record<PickerMode, HTMLButtonElement> | null = null;
    private searchSeq = 0; // guards against out-of-order geocoder responses

    constructor(container: HTMLElement, opts: AreaPickerOptions = {}) {
        const initial = opts.initialBounds ?? null;
        this.bbox = opts.bbox ?? new Signal<Bbox | null>(initial);
        if (opts.bbox) opts.bbox.set(initial);

        this.map = new maplibregl.Map({
            container,
            style: SATELLITE_STYLE,
            center: SWEDEN_CENTER,
            zoom: 4,
            attributionControl: { compact: true },
        });
        this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        // Mode toggle first so it sits ABOVE the search box — the search results
        // dropdown then opens over the map, never over the toggle.
        this.map.addControl(this.buildModeControl(), 'top-left');
        this.map.addControl(this.buildSearchControl(), 'top-left');

        this.map.on('load', () => {
            this.map.addSource('aoi', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            this.map.addSource('aoi-handles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            this.map.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#ffd400', 'fill-opacity': 0.12 } });
            this.map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#ffd400', 'line-width': 2 } });
            this.map.addLayer({
                id: 'aoi-handle', type: 'circle', source: 'aoi-handles',
                paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': '#ffd400', 'circle-stroke-width': 2 },
            });

            if (initial) {
                this.render(initial);
                this.map.fitBounds([initial.west, initial.south, initial.east, initial.north], { padding: 48, duration: 0 });
            }
        });

        this.map.on('mousedown', (e) => this.onDown(e));
        this.map.on('mousemove', (e) => this.onMove(e));
        this.map.on('mouseup', () => this.onUp());

        this.applyMode('navigate');
    }

    // --- Modes ---

    setMode(mode: PickerMode): void {
        this.applyMode(mode);
    }

    private applyMode(mode: PickerMode): void {
        this.mode.set(mode);
        if (mode === 'navigate') {
            this.map.dragPan.enable();
            this.map.getCanvas().style.cursor = '';
        } else {
            this.map.dragPan.disable(); // any drag draws the box
            this.map.getCanvas().style.cursor = 'crosshair';
        }
        if (this.modeButtons) {
            for (const m of ['navigate', 'draw'] as PickerMode[]) {
                this.modeButtons[m].style.background = m === mode ? '#2f7d4f' : '#fff';
                this.modeButtons[m].style.color = m === mode ? '#fff' : '#333';
            }
        }
    }

    // --- Box drawing ---

    /** Fixed corner opposite the grabbed handle, or null if not grabbing one. */
    private grabbedOpposite(e: MapMouseEvent): maplibregl.LngLat | null {
        const box = this.bbox.get();
        if (!box) return null;
        const p = e.point;
        const sw = this.map.project([box.west, box.south]);
        const ne = this.map.project([box.east, box.north]);
        const near = (q: { x: number; y: number }) => Math.hypot(q.x - p.x, q.y - p.y) <= HANDLE_HIT_PX;
        if (near(sw)) return new maplibregl.LngLat(box.east, box.north); // dragging SW ⇒ NE fixed
        if (near(ne)) return new maplibregl.LngLat(box.west, box.south); // dragging NE ⇒ SW fixed
        return null;
    }

    private onDown(e: MapMouseEvent): void {
        if (this.mode.get() !== 'draw') return; // navigate mode: let the map pan
        const opposite = this.grabbedOpposite(e);
        this.anchor = opposite ?? e.lngLat; // adjust a corner, or start fresh from here
        this.dragging = true;
        if (opposite) this.update(e.lngLat); // corner-drag updates immediately
        e.preventDefault();
    }

    private onMove(e: MapMouseEvent): void {
        if (this.dragging && this.anchor) {
            this.update(e.lngLat);
            return;
        }
        if (this.mode.get() === 'draw') {
            const overHandle = this.bbox.get() !== null && this.grabbedOpposite(e) !== null;
            this.map.getCanvas().style.cursor = overHandle ? 'pointer' : 'crosshair';
        }
    }

    private onUp(): void {
        this.dragging = false;
        this.anchor = null;
    }

    private update(cursor: maplibregl.LngLat): void {
        if (!this.anchor) return;
        const box = squareBox(this.anchor.lng, this.anchor.lat, cursor.lng, cursor.lat);
        this.bbox.set(box);
        this.render(box);
    }

    private render(box: Bbox): void {
        (this.map.getSource('aoi') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [boxFeature(box)] });
        (this.map.getSource('aoi-handles') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: handleFeatures(box) });
    }

    // --- Controls ---

    private buildModeControl(): IControl {
        const container = document.createElement('div');
        container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        container.style.cssText = 'display:flex;overflow:hidden;font-family:inherit;';

        const make = (mode: PickerMode, label: string, divider: boolean): HTMLButtonElement => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.style.cssText = [
                'display:block',
                'height:30px',
                'padding:0 14px',
                'font-size:12px',
                'font-weight:600',
                'line-height:30px',
                'white-space:nowrap',
                'width:auto',
                'border:none',
                divider ? 'border-left:1px solid rgba(0,0,0,.12)' : '',
                'cursor:pointer',
                'background:#fff',
                'color:#333',
            ].join(';');
            b.onclick = () => this.setMode(mode);
            container.appendChild(b);
            return b;
        };

        this.modeButtons = {
            navigate: make('navigate', 'Navigate', false),
            draw: make('draw', 'Draw area', true),
        };
        return {
            onAdd: () => container,
            onRemove: () => container.remove(),
        };
    }

    private buildSearchControl(): IControl {
        const container = document.createElement('div');
        container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        container.style.cssText = 'position:relative;padding:2px;';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Search place…';
        input.style.cssText = 'width:200px;border:none;outline:none;padding:4px 6px;font-size:13px;';

        const results = document.createElement('div');
        results.style.cssText = 'position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.25);border-radius:4px;overflow:hidden;display:none;z-index:20;';

        const clear = () => { results.innerHTML = ''; results.style.display = 'none'; };

        let debounce: ReturnType<typeof setTimeout> | null = null;
        input.addEventListener('input', () => {
            if (debounce !== null) clearTimeout(debounce);
            const q = input.value;
            debounce = setTimeout(() => void this.search(q, results, clear), 300);
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (debounce !== null) clearTimeout(debounce); void this.search(input.value, results, clear); }
            if (e.key === 'Escape') clear();
        });

        container.appendChild(input);
        container.appendChild(results);
        return {
            onAdd: () => container,
            onRemove: () => container.remove(),
        };
    }

    /**
     * Geocode via Photon (Komoot's OSM geocoder) — unlike Nominatim it is
     * typo-tolerant / fuzzy and prefix-based, so partial and misspelled course
     * names still resolve. Results are biased toward Sweden.
     */
    private async search(query: string, results: HTMLElement, clear: () => void): Promise<void> {
        const q = query.trim();
        if (q.length < 2) { clear(); return; }

        const note = (text: string) => {
            results.innerHTML = '';
            const div = document.createElement('div');
            div.textContent = text;
            div.style.cssText = 'padding:6px 8px;font-size:12px;color:#666;';
            results.appendChild(div);
            results.style.display = 'block';
        };
        note('Searching…');

        const seq = ++this.searchSeq;
        let features: PhotonFeature[];
        try {
            // lat/lon bias toward central Sweden (soft ranking hint, not a hard filter).
            const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lat=62&lon=15`;
            const resp = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!resp.ok) { if (seq === this.searchSeq) note(`Search failed (${resp.status})`); return; }
            features = (await resp.json()).features ?? [];
        } catch {
            if (seq === this.searchSeq) note('Search failed — check your connection.');
            return;
        }
        if (seq !== this.searchSeq) return; // a newer keystroke superseded this response

        results.innerHTML = '';
        if (!features.length) { note('No matches — try fewer words.'); return; }
        for (const f of features) {
            const item = document.createElement('button');
            item.type = 'button';
            item.textContent = photonLabel(f);
            item.style.cssText = 'display:block;width:100%;text-align:left;border:none;background:#fff;padding:6px 8px;font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            item.onmouseenter = () => { item.style.background = '#eee'; };
            item.onmouseleave = () => { item.style.background = '#fff'; };
            item.onclick = () => {
                this.gotoFeature(f);
                clear();
            };
            results.appendChild(item);
        }
        results.style.display = 'block';
    }

    private gotoFeature(f: PhotonFeature): void {
        const e = f.properties.extent; // [west, north, east, south]
        if (e && e.length === 4) {
            this.map.fitBounds([[e[0], e[3]], [e[2], e[1]]], { padding: 40, maxZoom: 17, duration: 600 });
        } else {
            const [lon, lat] = f.geometry.coordinates;
            this.map.flyTo({ center: [lon, lat], zoom: 15, duration: 600 });
        }
    }

    destroy(): void {
        this.map.remove();
    }
}
