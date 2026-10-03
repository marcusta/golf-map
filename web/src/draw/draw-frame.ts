import { Signal, batch } from '@basics/core/client/core';

// Per-frame coalescing for the draw tool's preview state. Pointer moves write
// through `FrameSignal.setLater`; `FrameBatch` applies every pending write
// once per frame inside one `batch`, so the preview overlay rebuilds at most
// once per frame however many mousemove events arrive.

/** Runs `cb` once before the next paint. */
export type FrameScheduler = (cb: () => void) => void;

/** requestAnimationFrame when the page has it, else a microtask (headless tests). */
export const defaultFrameScheduler: FrameScheduler = cb => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb());
    else queueMicrotask(cb);
};

/**
 * Collects FrameSignal writes and applies them together, once per frame,
 * inside one `batch` so the preview effect runs once per frame.
 */
export class FrameBatch {
    private dirty = new Set<FrameSignal<unknown>>();
    private scheduled = false;

    constructor(private readonly schedule: FrameScheduler) {}

    request(sig: FrameSignal<unknown>): void {
        this.dirty.add(sig);
        if (this.scheduled) return;
        this.scheduled = true;
        this.schedule(() => this.flush());
    }

    private flush(): void {
        this.scheduled = false;
        const dirty = [...this.dirty];
        this.dirty.clear();
        batch(() => { for (const sig of dirty) sig.flush(); });
    }
}

/**
 * A Signal with a frame-coalesced write path for pointer-move updates.
 * `setLater(compute)` keeps only the latest pending value and computes it at
 * the next frame flush; `set` writes now and drops any pending value, so a
 * mouseup or Esc that clears the state is never overwritten by a stale
 * frame. `peek` sees the pending value without writing it.
 */
export class FrameSignal<T> {
    private readonly sig: Signal<T>;
    private pending: { compute: () => T; value?: { v: T } } | null = null;

    constructor(initial: T, private readonly frames: FrameBatch) {
        this.sig = new Signal(initial);
    }

    get(): T { return this.sig.get(); }

    peek(): T {
        const pending = this.pending;
        if (!pending) return this.sig.peek();
        pending.value ??= { v: pending.compute() };
        return pending.value.v;
    }

    set(next: T): void {
        this.pending = null;
        this.sig.set(next);
    }

    setLater(compute: () => T): void {
        this.pending = { compute };
        this.frames.request(this as FrameSignal<unknown>);
    }

    /** Apply the pending value, if any (frame flush). */
    flush(): void {
        const pending = this.pending;
        if (!pending) return;
        this.pending = null;
        this.sig.set(pending.value ? pending.value.v : pending.compute());
    }
}
