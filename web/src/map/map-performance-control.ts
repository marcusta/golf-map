import type { IControl, Map as LibreMap } from 'maplibre-gl';
import type { WaterLayer } from './water-layer';
import './map-performance-control.css';

/** Counts completed map renders. Only a benchmark requests additional frames. */
export class MapPerformanceControl implements IControl {
    private map!: LibreMap;
    private root!: HTMLDetailsElement;
    private timer: ReturnType<typeof setInterval> | null = null;
    private renders = 0;
    private since = 0;
    private run: { start: number; last: number; intervals: number[]; water: boolean } | null = null;

    constructor(private readonly waterEnabled: () => boolean, private readonly setWaterEnabled: (enabled: boolean) => void,
        private readonly getWater: () => WaterLayer | null) {}

    onAdd(map: LibreMap): HTMLElement {
        this.map = map;
        this.root = document.createElement('details');
        this.root.className = 'maplibregl-ctrl map-performance';
        this.root.innerHTML = `<summary>FPS</summary><div class="map-performance-body">
            <output data-live>Waiting for frames</output>
            <label><input type="checkbox" data-water> Water shader</label>
            <div data-water-status></div>
            <button type="button" data-run>Run 10-second benchmark</button>
            <output data-progress>Ready</output>
            <div data-on>Water on: no result</div><div data-off>Water off: no result</div>
            <p>Keep the same view for both runs. Benchmark forces continuous map rendering. Moving the camera cancels the run.</p>
            <p>Live rate counts map renders, including idle time. Results measure frame intervals, not GPU time.</p>
        </div>`;
        const water = this.root.querySelector<HTMLInputElement>('[data-water]')!;
        water.checked = this.waterEnabled();
        water.onchange = () => {
            this.cancel('Water changed; run again');
            this.setWaterEnabled(water.checked);
            this.tick();
            map.triggerRepaint();
        };
        this.root.querySelector<HTMLButtonElement>('[data-run]')!.onclick = () => {
            if (this.run) { this.cancel('Cancelled'); return; }
            if (document.hidden) return;
            if (map.isMoving()) { this.cancel('Wait for the camera to stop'); return; }
            const now = performance.now();
            this.run = { start: now, last: now, intervals: [], water: this.waterEnabled() };
            this.text('[data-progress]', 'Running…');
            this.text('[data-run]', 'Cancel benchmark');
            map.triggerRepaint();
        };
        this.root.ontoggle = () => {
            if (this.root.open) {
                this.since = performance.now();
                this.renders = 0;
                this.timer ??= setInterval(this.tick, 500);
                this.tick();
            } else {
                this.cancel('Ready');
                if (this.timer !== null) clearInterval(this.timer);
                this.timer = null;
            }
        };
        map.on('render', this.render);
        map.on('movestart', this.move);
        document.addEventListener('visibilitychange', this.visibility);
        return this.root;
    }

    private text(selector: string, text: string): void {
        this.root.querySelector(selector)!.textContent = text;
    }

    private readonly render = (): void => {
        if (!this.root.open || document.hidden) return;
        this.renders++;
        const run = this.run;
        if (!run) return;
        const now = performance.now();
        run.intervals.push(now - run.last);
        run.last = now;
        if (now - run.start >= 10_000) {
            const sorted = [...run.intervals].sort((a, b) => a - b);
            const fps = run.intervals.length * 1000 / (now - run.start);
            const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
            this.text(run.water ? '[data-on]' : '[data-off]',
                `Water ${run.water ? 'on' : 'off'}: ${fps.toFixed(1)} FPS · p95 ${p95.toFixed(1)} ms · ${sorted.length} frames`);
            this.cancel('Complete');
        } else this.map.triggerRepaint();
    };

    private readonly tick = (): void => {
        const now = performance.now();
        const elapsed = now - this.since;
        if (elapsed >= 450) {
            this.text('[data-live]', document.hidden ? 'Paused: tab hidden' : `Live: ${(this.renders * 1000 / elapsed).toFixed(1)} map renders/s`);
            this.renders = 0;
            this.since = now;
        }
        const water = this.getWater();
        this.text('[data-water-status]', !this.waterEnabled() ? 'Shader off' : !water ? 'No water layer in this view'
            : !this.map.getTerrain() || this.map.getPitch() <= 5 ? 'Shader needs terrain and a tilted view'
            : water.stats.pending ? 'Sampling water elevations…' : 'Shader enabled; visible water contributes work');
        if (this.run) this.text('[data-progress]', `Running: ${Math.min(10, (now - this.run.start) / 1000).toFixed(1)} / 10 s`);
    };

    private cancel(message: string): void {
        this.run = null;
        this.text('[data-progress]', message);
        this.text('[data-run]', 'Run 10-second benchmark');
    }

    private readonly move = (): void => { if (this.run) this.cancel('Camera moved; run again'); };
    private readonly visibility = (): void => {
        if (document.hidden && this.run) this.cancel('Tab hidden; run again');
        this.renders = 0;
        this.since = performance.now();
    };

    onRemove(): void {
        if (this.timer !== null) clearInterval(this.timer);
        this.run = null;
        this.map.off('render', this.render);
        this.map.off('movestart', this.move);
        document.removeEventListener('visibilitychange', this.visibility);
        this.root.remove();
    }
}
