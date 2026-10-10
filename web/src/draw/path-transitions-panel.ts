import { effect } from '@basics/core/client/core';
import maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import { pathSurfaceOf } from '../../../shared/features/path-surface';
import { centerlineStations, centerlinePointAtStation, projectCenterlineStation, pathTransitionDefaults, transitionRange, transitionFootprint, pathTransitionsError, type PathTransition } from '../../../shared/features/path-transitions';
import { bufferCenterlinePolyline, type FeatureCenterline } from '../../../shared/features/centerline';
import { sweref99tmToWgs84, lngLatToSweref99tm } from '../geo/transform';
import type { MapService } from '../map/map.service';
import { attributesPatchOf, type FeaturesService } from './features.service';
import type { DrawToolService } from './draw-tool.service';

const labels = { 'soft-fade': 'Soft fade', 'overgrown-gravel': 'Overgrown gravel', 'wheel-tracks': 'Wheel tracks' };
const overlayId = 'path-transition-preview';
const coords = (p: {x: number; y: number}): [number, number] => { const q = sweref99tmToWgs84(p.x, p.y); return [q.lon, q.lat]; };

/** Ground-colour schematic follows the same station curve as the handles. */
export function transitionPreview(line: FeatureCenterline, t: PathTransition): FeatureCollection {
    const length = centerlineStations(line.points).lengthM, r = transitionRange(t, length);
    const end = t.ending === 'continue' ? (r.direction === 1 ? length : 0) : r.endM;
    const total = Math.abs(end - r.startM), count = Math.min(400, Math.max(2, Math.ceil(total / 0.5)));
    const data: FeatureCollection = {type: 'FeatureCollection', features: []};
    const strip = (points: {x:number; y:number}[], half: number, color: string) => {
        if (half < 0.005) return;
        for (const ring of bufferCenterlinePolyline(points, half) ?? []) data.features.push({type: 'Feature', properties: {color}, geometry: {type: 'Polygon', coordinates: [ring.map(([x,y]) => coords({x,y}))]}});
    };
    const final = r.direction === 1 ? length : 0;
    if (t.ending === 'grass' && Math.abs(final - r.endM) > .001) {
        const n = Math.max(2, Math.ceil(Math.abs(final - r.endM)));
        strip(Array.from({length:n+1}, (_, i) => centerlinePointAtStation(line.points, r.endM + (final-r.endM)*i/n)), line.widthM/2, '#739451');
    }
    for (let i = 0; i < count; i++) {
        const d = total * (i + 0.5) / count;
        const points = [i, i + 1].map(n => centerlinePointAtStation(line.points, r.startM + r.direction * total * n / count));
        const progress = Math.min(1, d / t.transitionLengthM);
        const fade = t.ending === 'continue' ? 1 : Math.max(0, Math.min(1, (total - d) / (t.fadeLengthM || 0.001)));
        const noise = Math.sin((i + t.seed) * 12.9898) * t.edgeIrregularity * 0.13;
        strip(points, line.widthM / 2, '#739451');
        const half = line.widthM / 2 * Math.max(0, (1 - progress * (t.pattern === 'soft-fade' ? 1 : 0.35)) * fade + noise);
        strip(points, half, '#b8a685');
        if (t.pattern !== 'soft-fade' && progress > 0) {
            const dx = points[1].x - points[0].x, dy = points[1].y - points[0].y, norm = Math.hypot(dx,dy) || 1;
            if (t.pattern === 'wheel-tracks') {
                strip(points, Math.min(half, Math.max(0, (t.trackSpacingM - t.trackWidthM) / 2) * progress), '#739451');
                for (const side of [-1, 1]) {
                    const offset = side * t.trackSpacingM / 2 * (1 + t.variation * Math.sin(i + t.seed) * .1);
                    strip(points.map(p => ({x:p.x - dy / norm * offset, y:p.y + dx / norm * offset})), t.trackWidthM / 2 * fade, t.dirtAmount > .5 ? '#92704c' : '#b8a685');
                }
            } else {
                strip(points, half * .35 * progress * fade, '#739451');
                if (Math.sin(i * 6.7 + t.seed) < t.dirtAmount - .5) strip(points, half * .7, '#92704c');
            }
        } else if (t.dirtAmount > 0 && Math.sin(i + t.seed) < t.dirtAmount - .5) strip(points, half * .7, '#92704c');
    }
    if (t.centerGrassReachM > 0) {
        const steps = Math.max(2, Math.ceil(t.centerGrassReachM / .5));
        for (let i = 0; i < steps; i++) {
            const points = [i, i + 1].map(n => centerlinePointAtStation(line.points, r.startM - r.direction * t.centerGrassReachM * n / steps));
            strip(points, line.widthM * .2 * (1 - (i + .5) / steps), '#739451');
        }
    }
    return data;
}

/** One bounded transition editor; values always remain inside the curved road. */
export function fitTransition(t: PathTransition, length: number, width = 60): PathTransition {
    const next = { ...t };
    const minimum = Math.min(.1, length);
    next.startM = Math.max(next.direction === -1 ? minimum : 0, Math.min(length - (next.direction === 1 ? minimum : 0), next.startM));
    const available = next.placement === 'section' ? (next.direction === 1 ? length - next.startM : next.startM) : length;
    next.transitionLengthM = Math.max(minimum, Math.min(available, next.transitionLengthM));
    next.holdLengthM = Math.max(0, Math.min(available - next.transitionLengthM, next.holdLengthM));
    next.fadeLengthM = Math.max(0, Math.min(available - next.transitionLengthM - next.holdLengthM, next.fadeLengthM));
    const range = transitionRange(next, length);
    next.centerGrassReachM = Math.min(range.direction === 1 ? range.startM : length - range.startM, next.centerGrassReachM);
    next.trackWidthM = Math.max(0.01, Math.min(width - 0.01, next.trackWidthM));
    next.trackSpacingM = Math.max(0.01, Math.min(width - next.trackWidthM, next.trackSpacingM));
    return next;
}

export function markerTransition(t: PathTransition, length: number, index: number, station: number): PathTransition {
    const r = transitionRange(t, length);
    const base = {...t, placement: 'section' as const, direction: r.direction as 1 | -1, startM: r.startM};
    if (index === 0) base.startM = station;
    if (index === 1) base.transitionLengthM = Math.max(.1, (station - r.startM) * r.direction);
    if (index === 2) base.fadeLengthM = Math.max(0, (station - r.startM) * r.direction - t.transitionLengthM - t.holdLengthM);
    return base;
}

export function transitionGap(items: PathTransition[], length: number): [number, number] | undefined {
    const occupied = items.map(x => { const r = transitionFootprint(x, length); return [r.minM, r.maxM]; }).sort((a,b) => a[0]-b[0]);
    let cursor = 0; const gaps: [number, number][] = [];
    for (const [a,b] of occupied) { if (a > cursor) gaps.push([cursor,a]); cursor = Math.max(cursor,b); }
    if (cursor < length) gaps.push([cursor,length]);
    return gaps.filter(g => g[0] === 0 || g[1] === length).sort((a,b) => (b[1]-b[0])-(a[1]-a[0]))[0];
}

export function mountPathTransitions(host: HTMLElement, features: FeaturesService, tool: DrawToolService, map: MapService): () => void {
    let current: CourseFeature | null = null;
    let activeId = '';
    let markers: maplibregl.Marker[] = [];
    let overlay = false;
    let dragging = false;
    let cancelled = false;
    let signature = '';
    const cancel = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || !dragging || !current?.geometry.centerline) return;
        cancelled = true;
        const t = read().find(t => t.id === activeId);
        if (t) map.updateOverlayData(overlayId, transitionPreview(current.geometry.centerline, t));
    };
    document.addEventListener('keydown', cancel);
    const clearMap = () => { markers.forEach(m => m.remove()); markers = []; if (overlay) map.removeOverlayLayer(overlayId); overlay = false; };
    const read = (): PathTransition[] => {
        const value = (current?.attributes as unknown as {pathTransitions?: PathTransition[]})?.pathTransitions;
        return Array.isArray(value) ? value : [];
    };
    const save = (items: PathTransition[]) => {
        if (!current?.geometry.centerline) return;
        const length = centerlineStations(current.geometry.centerline.points).lengthM;
        const fitted = items.map(t => fitTransition(t, length, current!.geometry.centerline!.widthM));
        const error = pathTransitionsError(fitted, current.geometry.centerline, 'path', pathSurfaceOf(current.attributes));
        if (error) { const warning = document.createElement('p'); warning.dataset.testid = 'path-transition-error'; warning.textContent = 'Transitions must fit separate sections of the path. Move the start or shorten the transition before extending it.'; host.querySelector('[data-testid="path-transition-error"]')?.remove(); host.append(warning); return; }
        const attrs = { ...(current.attributes ?? {}), pathTransitions: fitted };
        tool.commitAttributes(current.id, attributesPatchOf(attrs));
    };
    const button = (text: string, action: () => void, test: string) => {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.className = 'transition-button'; b.dataset.testid = test; b.onclick = action; return b;
    };
    const dispose = effect(() => {
        const selected = features.selected.get();
        const count = features.selectedIds.get().size;
        const ready = map.ready.get();
        if (dragging) return;
        const nextSignature = JSON.stringify([selected?.id, selected?.geometry, selected?.attributes, count, ready, activeId]);
        current = selected ?? null;
        if (nextSignature === signature) return;
        signature = nextSignature;
        clearMap(); host.replaceChildren(); current = selected ?? null;
        const surface = pathSurfaceOf(current?.attributes);
        if (!current || current.type !== 'path') { host.hidden = true; return; }
        host.hidden = false;
        const heading = document.createElement('h4'); heading.className = 'section-title'; heading.textContent = 'Transitions'; host.append(heading);
        if (count !== 1 || !current.geometry.centerline || (surface !== 'gravel' && surface !== 'dirt')) {
            const hint = document.createElement('p'); hint.textContent = 'Select one gravel or dirt centerline path to edit its transitions.'; host.append(hint); return;
        }
        const line = current.geometry.centerline;
        const length = centerlineStations(line.points).lengthM;
        const items = read();
        const freeGap = transitionGap(items, length);
        const t = items.find(t => t.id === activeId) ?? items[0];
        if (!t) { const hint = document.createElement('p'); hint.textContent = 'Crisp edges · no transition'; host.append(hint); }
        const add = button('Add transition', () => {
            let value: PathTransition = { ...pathTransitionDefaults('soft-fade'), id: crypto.randomUUID() };
            if (items.length) {
                const gap = freeGap;
                if (!gap || gap[1]-gap[0] < .2) return;
                const gapLength = gap[1]-gap[0], direction = gap[0] === 0 ? -1 as const : 1 as const;
                value = {...fitTransition({...value, placement: 'section', startM: direction === -1 ? gapLength : 0, direction}, gapLength, line.widthM), startM: direction === -1 ? gap[1] : gap[0]};
            }
            activeId = value.id; save([...read(), value]);
        }, 'path-transition-add'); add.disabled = items.length >= 32 || !freeGap || freeGap[1] - freeGap[0] < .2; host.append(add);
        if (add.disabled) { const message = document.createElement('p'); message.textContent = 'No free section remains. Shorten or remove a transition to add another.'; host.append(message); }
        if (!t) return;
        activeId = t.id;
        signature = JSON.stringify([selected?.id, selected?.geometry, selected?.attributes, count, ready, activeId]);
        const update = (patch: Partial<PathTransition>) => save(read().map(x => x.id === t.id ? { ...x, ...patch } : x));
        const select = (label: string, key: string, value: string, options: [string, string][], change: (value: string) => void) => {
            const row = document.createElement('label'); row.className = 'zone-field'; row.append(label);
            const input = document.createElement('select'); input.dataset.testid = `path-transition-${key}`;
            for (const [v, title] of options) { const o = document.createElement('option'); o.value = v; o.textContent = title; input.append(o); }
            input.value = value; input.onchange = () => change(input.value); row.append(input); host.append(row);
        };
        if (items.length > 1) select('Edit transition', 'active', t.id, items.map((x, i) => [x.id, `${i + 1}. ${labels[x.pattern]}`]), value => { activeId = value; features.selectedIds.set(new Set(features.selectedIds.peek())); });
        select('Pattern', 'pattern', t.pattern, Object.entries(labels), value => update({ ...pathTransitionDefaults(value as PathTransition['pattern']), id: t.id, pattern: value as PathTransition['pattern'], placement: t.placement, startM: t.startM, direction: t.direction, transitionLengthM: t.transitionLengthM, holdLengthM: t.holdLengthM, fadeLengthM: t.fadeLengthM, ending: t.ending, seed: t.seed }));
        select('Placement', 'placement', t.placement, [['start', 'At path start'], ['end', 'At path end'], ['section', 'Along section']], value => update({ placement: value as PathTransition['placement'], startM: length / 3, direction: 1 }));
        select('Ending', 'ending', t.ending, [['grass', 'Fade to grass'], ['continue', 'Continue pattern to path end']], value => update({ ending: value as PathTransition['ending'] }));
        const number = (label: string, key: keyof PathTransition, max: number, parent = host) => {
            const row = document.createElement('label'); row.className = 'zone-field'; row.append(label);
            const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = String(max); input.step = '0.1'; input.value = String(Math.round(Number(t[key]) * 100) / 100); input.dataset.testid = `path-transition-${key}`;
            input.onchange = () => { const n = Number(input.value); if (Number.isFinite(n)) update({ [key]: Math.max(0, Math.min(max, n)) }); }; row.append(input); parent.append(row);
        };
        if (t.placement === 'section') { number('Start station (m)', 'startM', length); select('Direction', 'direction', String(t.direction), [['1', 'Toward path end'], ['-1', 'Toward path start']], value => update({ direction: Number(value) as 1 | -1 })); }
        number('Transition length (m)', 'transitionLengthM', length);
        if (t.ending === 'grass') { number('Hold pattern (m)', 'holdLengthM', length); number('Final fade (m)', 'fadeLengthM', length); }
        number('Edge irregularity', 'edgeIrregularity', 1); number('Dirt amount', 'dirtAmount', 1);
        const advanced = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Advanced pattern'; advanced.append(summary); host.append(advanced);
        const extent = transitionRange(t, length);
        number('Grass tongue reach (m)', 'centerGrassReachM', extent.direction === 1 ? extent.startM : length - extent.startM, advanced);
        number('Track width (m)', 'trackWidthM', line.widthM, advanced); number('Track spacing (m)', 'trackSpacingM', line.widthM, advanced); number('Asymmetry', 'variation', 1, advanced);
        host.append(button('Shuffle variation', () => update({ seed: Math.floor(Math.random() * 2147483647) }), 'path-transition-shuffle'));
        host.append(button('Remove transition', () => save(read().filter(x => x.id !== t.id)), 'path-transition-remove'));
        const hint = document.createElement('p'); hint.textContent = 'Schematic: gravel · dirt · grass. Drag markers or edit metres; Escape cancels a drag. Each transition belongs to this path. Adjacent paths are edited separately.'; host.append(hint);
        if (!ready) return;
        const raw = map.map.peek(); if (!raw) return;
        const range = transitionRange(t, length);
        const stations = [range.startM, range.startM + range.direction * t.transitionLengthM, t.ending === 'continue' ? (range.direction === 1 ? length : 0) : range.endM];
        const collection = transitionPreview(line, t);
        map.addOverlayLayer(overlayId, collection, [{id: `${overlayId}-fill`, type: 'fill', paint: {'fill-color': ['get', 'color'], 'fill-opacity': 0.65}}]); overlay = true;
        stations.forEach((station, index) => {
            const el = document.createElement('button'); el.type = 'button'; el.textContent = String(index + 1); el.title = ['Transition starts', 'Pattern established', t.ending === 'continue' ? 'Pattern continues to path end' : 'Fade complete'][index]; el.dataset.testid = `path-transition-marker-${index}`;
            el.style.cssText = 'border-radius:50%;width:28px;height:28px;background:#fff;color:#222;border:2px solid #566c38;cursor:grab';
            const marker = new maplibregl.Marker({element: el, draggable: !(t.ending === 'continue' && index === 2)}).setLngLat(coords(centerlinePointAtStation(line.points, station))).addTo(raw);
            marker.on('dragstart', () => { dragging = true; cancelled = false; });
            marker.on('drag', () => {
                if (cancelled) return;
                const stationM = projectCenterlineStation(line.points, lngLatToSweref99tm(marker.getLngLat())).stationM;
                map.updateOverlayData(overlayId, transitionPreview(line, fitTransition(markerTransition(t, length, index, stationM), length, line.widthM)));
            });
            marker.on('dragend', () => { dragging = false; if (cancelled) { marker.setLngLat(coords(centerlinePointAtStation(line.points, station))); return; } const stationM = projectCenterlineStation(line.points, lngLatToSweref99tm(marker.getLngLat())).stationM; update(markerTransition(t, length, index, stationM)); });
            markers.push(marker);
        });
    });
    return () => { document.removeEventListener('keydown', cancel); dispose(); clearMap(); };
}
