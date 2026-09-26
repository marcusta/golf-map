// Nice-mode surface resolution (shared/render/resolved-surface-stack.ts) off
// the UI thread. A cold resolve of a full course is seconds of polygon
// clipping; here it only delays the resolved fills, never a mode switch.
//
// The worker owns one memoized resolver, so a re-resolve after an edit only
// clips the features around the edited one again.

import type { FeatureCollection } from 'geojson';
import { createSurfaceStackResolver } from '../../../shared/render/resolved-surface-stack';
import type { SurfaceStackRequest, SurfaceStackResponse } from './surface-stack-client';

const resolve = createSurfaceStackResolver();

const post = (message: SurfaceStackResponse): void => {
    (self as unknown as Worker).postMessage(message);
};

self.onmessage = (event: MessageEvent<SurfaceStackRequest>): void => {
    const { id, source } = event.data;
    try {
        const result: FeatureCollection = resolve(source);
        post({ id, ok: true, result });
    } catch (error) {
        post({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
};
