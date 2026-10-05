import type { BufferGeometry } from 'three';

/** Incremental DEM draping. Geometry changes only reach the GPU after a whole surface completes. */
export class WaterElevationQueue {
    private geometryIndex = 0;
    private vertexIndex = 0;
    private sample: ((x: number, y: number) => number) | null = null;
    private only: ReadonlySet<BufferGeometry> | null = null;
    private readonly heights = new Map<string, number>();

    constructor(private readonly geometries: readonly BufferGeometry[]) {}

    get pending(): boolean {
        return this.sample !== null && this.geometryIndex < this.geometries.length;
    }

    /**
     * Start a fresh pass, discarding samples from the previous DEM/zoom/exaggeration.
     * `only` limits the pass to those geometries (new water after an edit); the
     * others keep the heights they already have.
     */
    start(sample: (x: number, y: number) => number, only?: ReadonlySet<BufferGeometry>): void {
        this.sample = sample;
        this.only = only ?? null;
        this.geometryIndex = this.vertexIndex = 0;
        this.heights.clear();
        this.skipExcluded();
    }

    private skipExcluded(): void {
        while (this.only && this.geometryIndex < this.geometries.length && !this.only.has(this.geometries[this.geometryIndex])) {
            this.geometryIndex++;
        }
    }

    step(): { processed: number; sampled: number; completed: BufferGeometry[] } {
        const completed: BufferGeometry[] = [];
        let processed = 0, sampled = 0;
        const deadline = performance.now() + 2;
        while (this.pending && processed < 512 && performance.now() < deadline) {
            const geometry = this.geometries[this.geometryIndex];
            const positions = geometry.getAttribute('position');
            if (!positions || this.vertexIndex >= positions.count) {
                if (positions) {
                    positions.needsUpdate = true;
                    geometry.computeBoundingSphere();
                    completed.push(geometry);
                }
                this.geometryIndex++;
                this.vertexIndex = 0;
                this.skipExcluded();
                continue;
            }
            const x = positions.getX(this.vertexIndex), y = positions.getY(this.vertexIndex);
            const key = `${x},${y}`;
            let height = this.heights.get(key);
            if (height === undefined) {
                height = this.sample!(x, y);
                this.heights.set(key, height);
                sampled++;
            }
            positions.setZ(this.vertexIndex++, height);
            processed++;
        }
        return { processed, sampled, completed };
    }
}
