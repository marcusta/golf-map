import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, iconBtn } from '../css';
import { icon } from '../ui/icons';
import { CHANNEL_COLORS, PAINT_CHANNELS, PaintToolService, type StrokeGeometry } from './paint-tool.service';
import type { PaintStroke } from '../../../shared/api/paint.gen';

// The Terrain editor's Paint section (hosted by TerrainEditPanelComponent): paint mode on/off, the stroke's shape,
// channel, width, feather and strength, Preview / Save / Undo, and the course's strokes with Remove. Little text:
// the explanations are tooltips.

const GEOMETRIES: Array<{ id: StrokeGeometry; icon: Parameters<typeof icon>[0]; title: string }> = [
    { id: 'line', icon: 'route', title: 'Line: click points, Enter saves' },
    { id: 'polygon', icon: 'diamond', title: 'Area: click its corners, Enter saves' },
    { id: 'circle', icon: 'circle', title: 'Circle: click the centre, then the rim' },
];

const CHANNEL_TITLES: Record<string, string> = {
    black: 'Black: dirt / bare ground (no Stix grass)',
    red: 'Red: grass (Stix blades grow)',
    green: 'Green: the material\'s green layer',
    blue: 'Blue: the material\'s blue layer',
};

const tpl = template(`
    <div class="section paint" data-testid="terrain-paint">
        <div class="paint__head">
            <h4 class="section-title" title="Vertex paint on the course meshes, kept in paint.json and painted by Blender on the next mesh update. Unity shows a preview at once, until that mesh's next FBX.">Paint</h4>
            <button bind="toggleBtn" type="button" class="paint__toggle" data-testid="terrain-paint-toggle"></button>
        </div>
        <div bind="body" class="paint__body">
            <div class="paint__row">
                <span bind="geometryHost" class="paint__seg"></span>
                <span bind="channelHost" class="paint__seg"></span>
            </div>
            <div class="paint__row">
                <label bind="widthField" class="paint__num" title="Line width (m)">W<input bind="widthInput" class="input" type="number" min="0.1" step="0.5" data-testid="terrain-paint-width" /></label>
                <label class="paint__num" title="Feather: fade outside the shape (m), 0 = hard edge">F<input bind="featherInput" class="input" type="number" min="0" step="0.25" data-testid="terrain-paint-feather" /></label>
                <label class="paint__num" title="Strength 0-1">S<input bind="strengthInput" class="input" type="number" min="0" max="1" step="0.1" data-testid="terrain-paint-strength" /></label>
            </div>
            <div class="paint__row">
                <button bind="previewBtn" type="button" title="Show the drawn stroke in Unity; nothing saved" data-testid="terrain-paint-preview">${icon('eye', 16)} Preview</button>
                <button bind="saveBtn" type="button" title="Save to paint.json (Enter); Blender paints it on the next mesh update" data-testid="terrain-paint-save">${icon('check', 16)} Save</button>
                <button bind="undoBtn" type="button" class="paint__icon" aria-label="Undo" title="Remove the last stroke saved here" data-testid="terrain-paint-undo">${icon('undo', 16)}</button>
            </div>
            <div bind="notice" class="paint__notice" data-testid="terrain-paint-notice"></div>
            <div bind="list" class="paint__list" data-testid="terrain-paint-list"></div>
        </div>
    </div>
`);

/** One line per stroke: "stroke-3 · line 12 m" and so on. */
export function strokeLabel(st: PaintStroke): string {
    if (st.geometry === 'circle') return `${st.id} · ○ ${st.radiusM ?? 0} m`;
    const pts = st.points3006 ?? [];
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    return st.geometry === 'line' ? `${st.id} · ${Math.round(len)} m` : `${st.id} · area ${pts.length} pts`;
}

export class PaintPanelComponent extends Component {
    static styles = `
        .paint {
            & .paint__head { display: flex; align-items: center; justify-content: space-between; }
            & .paint__toggle {
                ${iconBtn()}
                width: auto; padding: 0 ${s('sm')};
                &.on { background: ${t('color-surface-sunken')}; color: ${t('color-text-primary')}; }
            }
            & .paint__body { display: flex; flex-direction: column; gap: ${s('xs')}; &.hidden { display: none; } }
            & .paint__row { display: flex; align-items: center; gap: ${s('xs')}; flex-wrap: wrap; }
            & .paint__seg { display: inline-flex; gap: 2px; }
            & .paint__seg button {
                ${iconBtn()}
                &.on { outline: 2px solid ${t('color-text-primary')}; outline-offset: -2px; }
            }
            & .paint__swatch { display: inline-block; width: 12px; height: 12px; border-radius: 2px; border: 1px solid ${t('color-border-default')}; }
            & .paint__num {
                display: inline-flex; align-items: center; gap: 2px; color: ${t('color-text-secondary')};
                & .input { width: 52px; text-align: right; }
                &.hidden { display: none; }
            }
            & .paint__icon { ${iconBtn()} }
            & .paint__notice { color: ${t('color-text-secondary')}; &:empty { display: none; } }
            & .paint__list { display: flex; flex-direction: column; }
            & .paint__item {
                display: flex; align-items: center; gap: ${s('xs')};
                & .paint__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                & button { ${iconBtn()} flex: none; }
                &.off .paint__name { opacity: 0.5; }
            }
        }
    `;

    private paint = this.inject(PaintToolService);

    render(): DocumentFragment {
        const p = this.paint;
        const frag = this.wire(tpl, {
            toggleBtn: {
                textContent: () => p.active.get() ? 'On' : 'Off',
                className: () => p.active.get() ? 'paint__toggle on' : 'paint__toggle',
                title: () => p.active.get() ? 'Paint mode on: map clicks draw strokes' : 'Turn paint mode on (map clicks draw strokes)',
                onclick: () => p.setActive(!p.active.peek()),
            },
            body: { className: () => p.active.get() ? 'paint__body' : 'paint__body hidden' },
            widthField: { className: () => p.geometry.get() === 'line' ? 'paint__num' : 'paint__num hidden' },
            previewBtn: {
                disabled: () => !p.pending.get() || p.busy.get() !== null,
                onclick: () => void p.preview(),
            },
            saveBtn: {
                disabled: () => !p.pending.get() || p.busy.get() !== null,
                onclick: () => void p.save(),
            },
            undoBtn: {
                disabled: () => !p.canUndo.get() || p.busy.get() !== null,
                onclick: () => void p.undo(),
            },
            notice: {
                textContent: () => p.busy.get() && p.busy.get() !== 'load' ? `${p.busy.get()}…` : p.notice.get() ?? '',
                title: () => [...p.warnings.get(), ...(p.layerLive.get() ? [] : ['Blender paint layer not live yet'])].join('\n'),
            },
        });

        const geometryHost = this.ref(frag, 'geometryHost');
        for (const g of GEOMETRIES) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.title = g.title;
            btn.setAttribute('aria-label', g.id);
            btn.dataset.testid = `terrain-paint-${g.id}`;
            btn.innerHTML = icon(g.icon, 16);
            btn.addEventListener('click', () => p.setGeometry(g.id));
            this.track(effect(() => { btn.className = p.geometry.get() === g.id ? 'on' : ''; }));
            geometryHost.append(btn);
        }
        const channelHost = this.ref(frag, 'channelHost');
        for (const c of PAINT_CHANNELS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.title = CHANNEL_TITLES[c] ?? c;
            btn.setAttribute('aria-label', c);
            btn.dataset.testid = `terrain-paint-${c}`;
            btn.innerHTML = `<span class="paint__swatch" style="background:${CHANNEL_COLORS[c]}"></span>`;
            btn.addEventListener('click', () => p.channel.set(c));
            this.track(effect(() => { btn.className = p.channel.get() === c ? 'on' : ''; }));
            channelHost.append(btn);
        }

        const numberInput = (name: string, signal: { get(): number; set(v: number): void }, ok: (v: number) => boolean) => {
            const el = this.ref(frag, name) as HTMLInputElement;
            el.addEventListener('input', () => {
                const v = Number(el.value);
                if (el.value !== '' && Number.isFinite(v) && ok(v)) signal.set(v);
            });
            this.track(effect(() => { el.value = String(signal.get()); }));
        };
        numberInput('widthInput', p.widthM, v => v > 0);
        numberInput('featherInput', p.featherM, v => v >= 0);
        numberInput('strengthInput', p.strength, v => v >= 0 && v <= 1);

        const list = this.ref(frag, 'list');
        this.track(effect(() => {
            const strokes = p.strokes.get();
            list.replaceChildren(...strokes.map(st => {
                const row = document.createElement('div');
                row.className = st.enabled === false ? 'paint__item off' : 'paint__item';
                row.dataset.testid = 'terrain-paint-stroke';
                const swatch = document.createElement('span');
                swatch.className = 'paint__swatch';
                swatch.style.background = CHANNEL_COLORS[st.channel];
                swatch.title = st.channel;
                const name = document.createElement('span');
                name.className = 'paint__name';
                name.textContent = strokeLabel(st);
                name.title = `feather ${st.featherM ?? 0.5} m · strength ${st.strength ?? 1}${st.mode === 'overlay' ? ' · overlay' : ''}${st.surfaces ? ` · ${st.surfaces.join(', ')}` : ''}`;
                const del = document.createElement('button');
                del.type = 'button';
                del.title = 'Remove';
                del.setAttribute('aria-label', `Remove ${st.id}`);
                del.innerHTML = icon('trash-2', 16);
                del.addEventListener('click', () => void p.remove(st.id));
                row.append(swatch, name, del);
                return row;
            }));
        }));
        return frag;
    }
}
