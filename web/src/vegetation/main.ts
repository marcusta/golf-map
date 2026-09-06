import { ATLAS_NAMES, CAMERA_PRESETS_M, defaultState, LOD_MODES, presetState, SUN_PRESETS, VegetationScene, type LodMode, type SceneState } from './vegetation-scene';

/**
 * Vegetation test scene, dev only (web/dev/vegetation.html, served by `vite dev` at
 * /dev/vegetation; not part of the production build unless WEB_DEV_PAGES=1).
 * Every asset the tree layer draws, without the course map: a lineup of all
 * species and variants, a size ladder, a 200-stem stand and a shrub strip, with a
 * controls panel for camera, sun, LOD, sway, wireframe and the atlases.
 *
 * Query flags (the e2e spec uses them, they override the stored state):
 *   ?lod=auto|full|half|impostor   ?preset=<m>   ?sway=0|1   ?labels=0|1
 */

const STORAGE_KEY = 'vegetation-scene';

function loadState(): SceneState {
    const state = defaultState();
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) Object.assign(state, JSON.parse(raw));
    } catch { /* no storage: defaults */ }
    const query = new URLSearchParams(location.search);
    const lod = query.get('lod');
    if (lod && (LOD_MODES as readonly string[]).includes(lod)) state.lod = lod as LodMode;
    const preset = Number(query.get('preset'));
    if (preset > 0) Object.assign(state, presetState(state, preset));
    const sway = query.get('sway');
    if (sway !== null) state.sway = sway !== '0';
    const labels = query.get('labels');
    if (labels !== null) state.labels = labels !== '0';
    return state;
}

function saveState(state: SceneState): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const panel = document.getElementById('panel')!;
const labelLayer = document.getElementById('labels')!;
const scene = new VegetationScene(canvas, loadState());

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text) node.textContent = text;
    return node;
};
const row = (label: string, ...children: HTMLElement[]) => {
    const container = el('div', { class: 'row' });
    container.append(el('span', { class: 'label' }, label), ...children);
    panel.append(container);
    return container;
};

function commit(): void {
    scene.applyState();
    saveState(scene.state);
    refreshPanel();
}

// Camera presets and readout.
const distanceReadout = el('span', { class: 'value', 'data-testid': 'camera-distance' });
row('Camera', distanceReadout);
const presetRow = el('div', { class: 'row' });
for (const distance of CAMERA_PRESETS_M) {
    const button = el('button', { 'data-testid': `preset-${distance}`, 'data-preset': String(distance) }, `${distance} m`);
    button.onclick = () => { scene.state = presetState(scene.state, distance); commit(); };
    presetRow.append(button);
}
panel.append(presetRow);

// Sun.
const sunAz = el('input', { type: 'range', min: '0', max: '360', step: '1', 'data-testid': 'sun-azimuth' });
const sunEl = el('input', { type: 'range', min: '2', max: '90', step: '1', 'data-testid': 'sun-elevation' });
const sunReadout = el('span', { class: 'value' });
sunAz.oninput = () => { scene.state.sunAzimuthDeg = Number(sunAz.value); commit(); };
sunEl.oninput = () => { scene.state.sunElevationDeg = Number(sunEl.value); commit(); };
row('Sun az', sunAz);
row('Sun el', sunEl, sunReadout);
const sunRow = el('div', { class: 'row' });
for (const preset of SUN_PRESETS) {
    const button = el('button', { 'data-testid': `sun-${preset.label.split(' ')[0].toLowerCase()}` }, preset.label);
    button.onclick = () => { scene.state.sunAzimuthDeg = preset.azimuthDeg; scene.state.sunElevationDeg = preset.elevationDeg; commit(); };
    sunRow.append(button);
}
panel.append(sunRow);

// LOD, sway, wireframe, atlas.
const lodSelect = el('select', { 'data-testid': 'lod-select' });
for (const mode of LOD_MODES) lodSelect.append(el('option', { value: mode }, mode));
lodSelect.onchange = () => { scene.state.lod = lodSelect.value as LodMode; commit(); };
row('LOD', lodSelect);
const swayBox = el('input', { type: 'checkbox', 'data-testid': 'sway-toggle' });
swayBox.onchange = () => { scene.state.sway = swayBox.checked; commit(); };
const wireBox = el('input', { type: 'checkbox', 'data-testid': 'wireframe-toggle' });
wireBox.onchange = () => { scene.state.wireframe = wireBox.checked; commit(); };
row('Sway', swayBox);
row('Wireframe', wireBox);
const labelsBox = el('input', { type: 'checkbox', 'data-testid': 'labels-toggle' });
labelsBox.onchange = () => { scene.state.labels = labelsBox.checked; commit(); };
row('Labels', labelsBox);
const atlasSelect = el('select', { 'data-testid': 'atlas-select' });
for (const name of ATLAS_NAMES) atlasSelect.append(el('option', { value: name }, name));
atlasSelect.onchange = () => { scene.state.atlas = atlasSelect.value as SceneState['atlas']; commit(); };
const atlasReadout = el('span', { class: 'value' });
row('Atlas 1:1', atlasSelect, atlasReadout);

// Stats.
const statsOut = el('pre', { class: 'stats', 'data-testid': 'frame-stats' });
panel.append(statsOut);
const reset = el('button', {}, 'Reset controls');
reset.onclick = () => { scene.state = defaultState(); commit(); };
panel.append(reset);

function refreshPanel(): void {
    const s = scene.state;
    sunAz.value = String(s.sunAzimuthDeg);
    sunEl.value = String(s.sunElevationDeg);
    sunReadout.textContent = `${s.sunAzimuthDeg} / ${s.sunElevationDeg} deg`;
    lodSelect.value = s.lod;
    swayBox.checked = s.sway;
    wireBox.checked = s.wireframe;
    labelsBox.checked = s.labels;
    labelLayer.hidden = !s.labels;
    atlasSelect.value = s.atlas;
    const size = scene.atlasSize();
    atlasReadout.textContent = size.width ? `${size.width} x ${size.height}` : '';
}
refreshPanel();

function refreshStats(): void {
    const f = scene.frame, t = scene.stats;
    distanceReadout.textContent = `${f.distanceM.toFixed(1)} m   yaw ${scene.state.yawDeg.toFixed(0)}  pitch ${scene.state.pitchDeg.toFixed(0)}`;
    statsOut.textContent = [
        `frame  ${f.frameMedianMs.toFixed(1)} ms median (60)`,
        `tris   ${f.triangles}`,
        `calls  ${f.drawCalls}`,
        `visible ${f.visible} (full ${t.detailed}, half ${t.half}, impostor ${t.impostors}, shrubs ${t.visibleShrubs})`,
        `textures ${t.texturesReady ? 'ready' : 'loading'}`,
    ].join('\n');
    panel.dataset.stats = JSON.stringify({ ...t, ...f });
}
setInterval(refreshStats, 250);

// ---------------------------------------------------------------------------
// Labels: one tag per lineup and ladder stem, pinned above the crown. HTML, so
// the draw-call and triangle counts stay those of the trees.
// ---------------------------------------------------------------------------
const labelled = scene.stems.filter(stem => stem.group === 'lineup' || stem.group === 'ladder');
const tags = labelled.map(stem => {
    const tag = el('div', { class: 'tag', 'data-testid': 'stem-label', 'data-group': stem.group }, stem.label);
    labelLayer.append(tag);
    return { stem, tag };
});
function placeLabels(): void {
    requestAnimationFrame(placeLabels);
    if (!scene.state.labels) return;
    for (const { stem, tag } of tags) {
        const point = scene.project(stem.x, stem.y, stem.ground + stem.height + 1);
        tag.hidden = !point.visible;
        if (point.visible) tag.style.transform = `translate(${point.x.toFixed(0)}px, ${point.y.toFixed(0)}px) translate(-50%, -100%)`;
    }
}
placeLabels();

// ---------------------------------------------------------------------------
// Orbit: drag rotates, shift-drag or right-drag pans, wheel zooms.
// ---------------------------------------------------------------------------
let drag: { x: number; y: number; button: number; shift: boolean } | null = null;
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('pointerdown', event => {
    drag = { x: event.clientX, y: event.clientY, button: event.button, shift: event.shiftKey };
    canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.x = event.clientX; drag.y = event.clientY;
    const s = scene.state;
    if (drag.button === 2 || drag.shift) {
        const step = s.distanceM * 0.002;
        const yaw = s.yawDeg * Math.PI / 180;
        s.targetX -= (dx * Math.cos(yaw)) * step;
        s.targetY += (dx * Math.sin(yaw)) * step;
        s.targetZ = Math.max(0, s.targetZ + dy * step);
    } else {
        s.yawDeg = (s.yawDeg - dx * 0.4 + 360) % 360;
        s.pitchDeg = Math.min(89, Math.max(-5, s.pitchDeg + dy * 0.3));
    }
    saveState(s);
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const s = scene.state;
    s.distanceM = Math.min(1500, Math.max(1, s.distanceM * Math.exp(event.deltaY * 0.0015)));
    saveState(s);
}, { passive: false });

scene.start();
// QA hook for the e2e spec.
(window as any).__vegetation = scene;
