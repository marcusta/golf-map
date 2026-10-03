// A GeoJSON overlay whose data follows a reactive builder and whose life
// follows the caller's disposer.
//
// Tools repeated one effect: read `ready`, build the data, mark the overlay
// gone when the map is not ready (overlays die with the map), add it on the
// first ready run, update it on later runs, and remove it on teardown. This
// is that effect. MapService stays unchanged; the helper takes it as an
// argument.
//
// The builder runs on every effect pass, ready or not, so its signal reads
// stay subscribed while the map is down.

import { effect } from '@basics/core/client/core';
import type { GeoJSON } from 'geojson';
import type { MapService, OverlayLayerSpec } from '../map/map.service';

export type OwnedOverlayOptions = NonNullable<Parameters<MapService['addOverlayLayer']>[3]>;

type OverlayHost = Pick<MapService, 'ready' | 'addOverlayLayer' | 'updateOverlayData' | 'removeOverlayLayer'>;

/**
 * Keep overlay `id` in sync with `data()`. `layers()` runs on each (re)add.
 * Returns the disposer: it stops the effect and removes the overlay.
 */
export function ownedOverlay(
    map: OverlayHost,
    id: string,
    data: () => GeoJSON,
    layers: () => OverlayLayerSpec[],
    opts?: OwnedOverlayOptions,
): () => void {
    let added = false;
    const disposeEffect = effect(() => {
        const ready = map.ready.get();
        const next = data();
        if (!ready) {
            added = false; // the overlay died with the map
            return;
        }
        if (!added) {
            map.addOverlayLayer(id, next, layers(), opts);
            added = true;
        } else {
            map.updateOverlayData(id, next);
        }
    });
    return () => {
        disposeEffect();
        if (added) {
            map.removeOverlayLayer(id);
            added = false;
        }
    };
}
