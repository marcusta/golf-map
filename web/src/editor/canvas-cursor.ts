// Tool-owned CSS cursor on the map canvas.
//
// While the map is ready, the canvas cursor follows `cursor()` (re-run on
// every signal it reads). The disposer resets the cursor on the live map.

import { effect } from '@basics/core/client/core';
import type { MapService } from '../map/map.service';

export function canvasCursor(
    map: Pick<MapService, 'ready' | 'map'>,
    cursor: () => string,
): () => void {
    const disposeEffect = effect(() => {
        if (!map.ready.get()) return;
        const value = cursor();
        const canvas = map.map.get()?.getCanvas();
        if (canvas) canvas.style.cursor = value;
    });
    return () => {
        disposeEffect();
        const canvas = map.map.peek()?.getCanvas();
        if (canvas) canvas.style.cursor = '';
    };
}
