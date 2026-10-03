import type { CustomLayerInterface, Map as LibreMap } from 'maplibre-gl';

/**
 * A custom layer whose code arrives through a dynamic import().
 *
 * `reserve` adds a no-op custom layer under the real layer's id at the slot the
 * real layer would take right now. Every later overlay is slotted against it
 * exactly as against the real layer (MapService.overlayLayerSlot sees a
 * non-draped layer at the same index), so the order is fixed at reserve time.
 * When the chunk resolves, the placeholder is replaced in place: the real layer
 * goes before whatever layer sits directly above the placeholder at that moment.
 *
 * `request` and `cancel` follow a toggle:
 * - `request` while a load is in flight starts no second load and adds nothing twice;
 * - `cancel` before the load resolves drops the result, the placeholder stays;
 * - `release` removes the placeholder or the layer and drops any in-flight result.
 *
 * Once added, the real layer stays until `release`; a later `cancel` is the
 * caller's to apply (the layers carry an `enabled` flag).
 */
export class LazyCustomLayer<L extends CustomLayerInterface> {
    private current: L | null = null;
    private wanted = false;
    /** Generation of the load in flight, or null. */
    private loading: number | null = null;
    private generation = 0;

    constructor(
        private readonly map: LibreMap,
        readonly id: string,
        private readonly create: () => Promise<L>,
        private readonly onReady: (layer: L) => void = () => {},
    ) {}

    /** The real layer once its chunk resolved and it replaced the placeholder. */
    get layer(): L | null { return this.current; }

    /** True while a placeholder or the real layer holds the slot. */
    get reserved(): boolean { return !!this.map.getLayer(this.id); }

    /** Add the placeholder before `beforeId` (undefined: on top). No-op when the slot is held. */
    reserve(beforeId?: string): void {
        if (this.reserved) return;
        this.generation++;
        this.current = null;
        this.loading = null;
        this.map.addLayer(placeholderLayer(this.id), beforeId);
    }

    /** Load the real layer (once) and swap it into the reserved slot. */
    request(): Promise<void> {
        this.wanted = true;
        if (this.current || this.loading === this.generation) return Promise.resolve();
        const generation = this.generation;
        this.loading = generation;
        return this.create().then(layer => {
            if (generation !== this.generation) return;
            this.loading = null;
            if (!this.wanted || this.current || !this.reserved) return;
            const order = this.map.getLayersOrder();
            const before = order[order.indexOf(this.id) + 1];
            this.map.removeLayer(this.id);
            this.map.addLayer(layer, before);
            this.current = layer;
            this.onReady(layer);
        }, error => {
            if (generation === this.generation) this.loading = null;
            console.error(`[map] loading layer ${this.id} failed`, error);
        });
    }

    /** The toggle went off: a load in flight resolves without adding the layer. */
    cancel(): void {
        this.wanted = false;
    }

    /** Remove the placeholder or the layer; drop any in-flight result. */
    release(): void {
        this.generation++;
        this.wanted = false;
        this.loading = null;
        this.current = null;
        if (this.map.getLayer(this.id)) this.map.removeLayer(this.id);
    }
}

function placeholderLayer(id: string): CustomLayerInterface {
    return { id, type: 'custom', renderingMode: '3d', render() {} };
}
