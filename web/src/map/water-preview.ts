import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { WaterLayer } from './water-layer';
import type { FeatureCollection } from 'geojson';

// Constant 100 m DEM exercises the real custom-layer projection and terrain queries.
const tile = document.createElement('canvas');
tile.width = tile.height = 256;
const ctx = tile.getContext('2d')!;
ctx.fillStyle = 'rgb(1,138,136)';
ctx.fillRect(0, 0, 256, 256);
const center: [number, number] = [18, 59];
const ring = (cx: number, cy: number, rx: number, ry: number, count = 64): number[][] =>
    Array.from({ length: count + 1 }, (_, i) => {
        const angle = (i % count) / count * Math.PI * 2;
        const irregular = 1 + 0.08 * Math.sin(angle * 5);
        return [cx + Math.cos(angle) * rx * irregular, cy + Math.sin(angle) * ry * irregular];
    });
const data: FeatureCollection = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { type: 'water' }, geometry: { type: 'Polygon', coordinates: [ring(18, 59, 0.0011, 0.0005), ring(18.00035, 59.0001, 0.00018, 0.00009).reverse()] } },
    { type: 'Feature', properties: { type: 'water_creek' }, geometry: { type: 'Polygon', coordinates: [[
        [17.99896, 59.00005], [17.9985, 59.00012], [17.9981, 59.0004], [17.9976, 59.0005],
        [17.9976, 59.00054], [17.99814, 59.00044], [17.99854, 59.00016], [17.99896, 59.00009], [17.99896, 59.00005],
    ]] } },
] };
const copies = Math.min(100, Number(new URLSearchParams(location.search).get('copies') ?? 1));
const originals = [...data.features];
for (let i = 1; i < copies; i++) data.features.push(...originals);
let water: WaterLayer | null = null;
const map = new maplibregl.Map({ container: 'map', center, zoom: 17.5, pitch: 0, bearing: -25, maxPitch: 85,
    style: { version: 8, sources: {
        'course-terrain': { type: 'raster-dem', tiles: [tile.toDataURL()], tileSize: 256, maxzoom: 16, encoding: 'mapbox' },
        water: { type: 'geojson', data },
    }, layers: [
        { id: 'ground', type: 'background', paint: { 'background-color': '#718259' } },
        { id: 'water-fill', type: 'fill', source: 'water', paint: { 'fill-color': '#4c8fbe' } },
    ] },
});
map.on('load', () => {
    map.setTerrain({ source: 'course-terrain', exaggeration: 1 });
    water = new WaterLayer();
    map.addLayer(water);
    water.setData(data);
});
map.on('render', () => {
    document.querySelector('#status')!.textContent = `Pitch ${map.getPitch().toFixed(0)}° · terrain ${map.queryTerrainElevation(center)?.toFixed(1) ?? 'loading'} m`;
    const stats = water?.stats;
    document.querySelector('#performance')!.textContent = stats ? `${data.features.length} surfaces · ${stats.pending ? 'Sampling' : 'Ready'} · max sampling batch ${stats.maxDrapeMs.toFixed(1)} ms · ${stats.samples} terrain queries · ${stats.verticesProcessed} vertices` : 'Waiting for water';
});
map.on('error', e => console.error(e.error));
document.querySelector('#tilt')!.addEventListener('click', () => {
    const flat = map.getPitch() > 5;
    map.easeTo({ pitch: flat ? 0 : 60 });
    document.querySelector('#tilt')!.textContent = flat ? '3D view' : 'Top-down';
});
document.querySelector('#sun')!.addEventListener('click', () => map.easeTo({ pitch: 78, bearing: 55, zoom: 18 }));
