// Raw mousedown/mouseup binding for editor tools that drag on the map.
//
// MapService's onClick/onMouseMove cover clicks and hover, but a drag must
// call `preventDefault()` on MapLibre's own mousedown event to stop the
// native drag-pan for that gesture. So each dragging tool binds
// `map.on('mousedown' | 'mouseup')` on the live map instance. This module
// owns that binding and the bookkeeping every such tool repeated:
//
// - Rebinding. An effect binds the handlers whenever `ctx.map.ready` turns
//   true, and unbinds the previous set first, so a recreated map or a style
//   reload never leaves a stale or doubled handler.
// - The claim gate. `onDown` runs only while the tool holds
//   `interactionMode`, for the left button, and outside the pan escape below.
//   `onUp` is ungated: a gesture that started under the claim must always
//   end, even if the claim moved mid-drag.
// - `claim(e, map)` takes the gesture (preventDefault + dragPan off) and
//   `release()` hands it back (dragPan on).
// - Click suppression. MapLibre synthesizes a click after a mouseup. A tool
//   that consumed the gesture as a drag calls `suppressNextClick()` and its
//   onClick checks `clickSuppressed`. The flag clears on the next macrotask,
//   after the synthesized click.
// - Dispose (run by `ctx.track`) unbinds, re-enables dragPan if a claim is
//   open, and clears the click suppression.
//
// Pan escape rule (draw, furniture and clean):
//   A left press with Cmd or Ctrl held never starts a tool drag. The binding
//   returns before `onDown` without preventDefault, so MapLibre's native
//   dragPan takes the gesture and the map pans, even from a marker or a
//   vertex. MapLibre's pan accepts meta; Ctrl-drag is its rotate gesture.
//   The middle-button pan in map.service.ts is the second escape. A
//   stationary Cmd/Ctrl-click still reaches the tool's onClick (draw uses it
//   to toggle selection), because a click is not a drag.

import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import { effect, untrack } from '@basics/core/client/core';
import type { ToolContext } from './tool';

export interface DragBindingSpec {
    /** Tool id; `onDown` runs only while `interactionMode` equals it. */
    toolId: string;
    /** Gated left press. Call `claim()` to take the gesture. */
    onDown(e: MapMouseEvent, map: MaplibreMap): void;
    /** Ungated release. Call `release()` if the tool claimed. */
    onUp(e: MapMouseEvent, map: MaplibreMap): void;
    /**
     * Further raw handlers bound with the same lifecycle (draw's dblclick,
     * contextmenu and camera listeners). Returns their unbind.
     */
    bindExtra?(map: MaplibreMap): () => void;
}

export interface DragBinding {
    /** Take the gesture: preventDefault, then dragPan off. */
    claim(e: MapMouseEvent, map: MaplibreMap): void;
    /** Hand the gesture back: dragPan on (the given map, else the live one). */
    release(map?: MaplibreMap | null): void;
    /** Swallow the click MapLibre synthesizes after this mouseup. */
    suppressNextClick(): void;
    /** True between `suppressNextClick()` and the next macrotask. */
    readonly clickSuppressed: boolean;
    /** Unbind, restore dragPan if claimed, clear suppression. Idempotent. */
    dispose(): void;
}

/** True when the press is the Cmd/Ctrl pan escape (see the header). */
export function isPanEscape(e: { originalEvent: MouseEvent }): boolean {
    return e.originalEvent.metaKey || e.originalEvent.ctrlKey;
}

export function bindDrag(ctx: Pick<ToolContext, 'map' | 'track'>, spec: DragBindingSpec): DragBinding {
    let unbind: (() => void) | null = null;
    let claimed: MaplibreMap | null = null;
    let suppressed = false;
    let suppressTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const bind = (map: MaplibreMap): void => {
        const onDown = (e: MapMouseEvent): void => {
            if (ctx.map.interactionMode.peek() !== spec.toolId) return;
            if (e.originalEvent.button !== 0) return;
            if (isPanEscape(e)) return;
            spec.onDown(e, map);
        };
        const onUp = (e: MapMouseEvent): void => spec.onUp(e, map);
        map.on('mousedown', onDown);
        map.on('mouseup', onUp);
        const unbindExtra = spec.bindExtra?.(map);
        unbind = () => {
            map.off('mousedown', onDown);
            map.off('mouseup', onUp);
            unbindExtra?.();
        };
    };

    const disposeEffect = effect(() => {
        if (!ctx.map.ready.get()) return;
        const map = ctx.map.map.get();
        if (!map) return;
        untrack(() => {
            unbind?.();
            bind(map as MaplibreMap);
        });
    });

    const binding: DragBinding = {
        claim(e, map) {
            e.preventDefault();
            map.dragPan.disable();
            claimed = map;
        },
        release(map) {
            const m = map ?? claimed ?? (ctx.map.map.peek() as MaplibreMap | null);
            claimed = null;
            m?.dragPan.enable();
        },
        suppressNextClick() {
            suppressed = true;
            if (suppressTimer !== null) clearTimeout(suppressTimer);
            suppressTimer = setTimeout(() => {
                suppressed = false;
                suppressTimer = null;
            }, 0);
        },
        get clickSuppressed() {
            return suppressed;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            disposeEffect();
            unbind?.();
            unbind = null;
            if (claimed) {
                claimed.dragPan.enable();
                claimed = null;
            }
            if (suppressTimer !== null) clearTimeout(suppressTimer);
            suppressTimer = null;
            suppressed = false;
        },
    };
    ctx.track(() => binding.dispose());
    return binding;
}
