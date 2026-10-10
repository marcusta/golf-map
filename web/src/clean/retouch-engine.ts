// The Clean tool's pixel engine, as the tool sees it.
//
// The cleaned photo lives in a PhotoCraft document inside a WebAssembly
// module (web/retouch-wasm, built into ./retouch-pkg), which runs in a worker
// (retouch.worker.ts) so a long fill never blocks the map. This file is the
// main-thread side: the `RetouchEngine` interface the tool service talks to,
// and its worker-backed implementation. Tests inject their own engine.
//
// Coordinates are photo pixels: (0, 0) is the photo's north-west corner.

/** A rectangle of the photo, in pixels. */
export interface PhotoRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * Pixels an operation changed: the rectangle and its RGBA bytes as the photo
 * shows now. Alpha is 255 where the pixel differs from the photo as loaded
 * and 0 where it does not, so the same bytes draw the change on the map and,
 * alpha ignored, are what gets written into the photo file.
 */
export interface Changed {
    rect: PhotoRect;
    rgba: Uint8ClampedArray;
}

/** A finished command: what changed and PhotoCraft's own result. */
export interface CommandResult {
    changed: Changed | null;
    /** Clone Stamp / Healing Brush: the source offset the stroke used. */
    offset?: [number, number];
}

export interface RetouchEngine {
    /** Fetch the photo's raw RGB pixels from `url` and open them. */
    load(url: string, onProgress: (fraction: number) => void): Promise<{ size: number }>;
    /** Start a stroke with a live preview (`paint.cloneStamp`, `paint.healingBrush`). */
    begin(cmd: string, params: Record<string, unknown>): Promise<Changed | null>;
    /** More points (`[x, y]`) of the live stroke. */
    push(points: number[][]): Promise<Changed | null>;
    /** Finish the live stroke: one undo step. */
    end(): Promise<CommandResult>;
    /** Drop the live stroke. */
    cancel(): Promise<Changed | null>;
    /** Run a whole command (`paint.spotHealing`, `paint.remove`): one undo step. */
    run(cmd: string, params: Record<string, unknown>): Promise<CommandResult>;
    undo(): Promise<Changed | null>;
    redo(): Promise<Changed | null>;
    /** The pixels of `rect`, alpha as in `Changed`. */
    read(rect: PhotoRect): Promise<Uint8ClampedArray>;
    dispose(): void;
}

export type RetouchEngineFactory = () => RetouchEngine;

interface Reply {
    id: number;
    ok?: unknown;
    error?: string;
    progress?: number;
}

/** The real engine: PhotoCraft's retouching in a worker. */
export const workerRetouchEngine: RetouchEngineFactory = () => {
    const worker = new Worker(new URL('./retouch.worker.ts', import.meta.url), { type: 'module' });
    let seq = 0;
    const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (f: number) => void }>();
    const fail = (message: string) => {
        for (const w of waiting.values()) w.reject(new Error(message));
        waiting.clear();
    };
    worker.onmessage = (e: MessageEvent<Reply>) => {
        const w = waiting.get(e.data.id);
        if (!w) return;
        if (e.data.progress !== undefined) {
            w.onProgress?.(e.data.progress);
            return;
        }
        waiting.delete(e.data.id);
        if (e.data.error !== undefined) w.reject(new Error(e.data.error));
        else w.resolve(e.data.ok);
    };
    worker.onerror = e => fail(e.message || 'The pixel engine stopped');
    const call = <T>(op: string, args: unknown[], onProgress?: (f: number) => void): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            const id = ++seq;
            waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
            worker.postMessage({ id, op, args });
        });
    return {
        load: (url, onProgress) => call('load', [url], onProgress),
        begin: (cmd, params) => call('begin', [cmd, params]),
        push: points => call('push', [points]),
        end: () => call('end', []),
        cancel: () => call('cancel', []),
        run: (cmd, params) => call('run', [cmd, params]),
        undo: () => call('undo', []),
        redo: () => call('redo', []),
        read: rect => call('read', [rect]),
        dispose: () => {
            worker.terminate();
            fail('The pixel engine was closed');
        },
    };
};
