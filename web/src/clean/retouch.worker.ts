// Worker side of the Clean tool's pixel engine (see retouch-engine.ts).
//
// Holds the cleaned photo in the PhotoCraft wasm module and answers the
// main thread's calls one at a time, in the order they were posted. Pixel
// buffers go back as transferables.

import init, { Retouch } from './retouch-pkg/retouch';
import type { Changed, CommandResult, PhotoRect } from './retouch-engine';

let ready: Promise<unknown> | null = null;
let photo: Retouch | null = null;

/** Rows per strip while loading: the wasm side copies each strip once. */
const LOAD_ROWS = 256;

function need(): Retouch {
    if (!photo) throw new Error('The photo is not loaded');
    return photo;
}

/** A `[x, y, w, h]` rectangle (or null) from the engine, with its pixels. */
function changed(json: string): Changed | null {
    const r = JSON.parse(json) as [number, number, number, number] | null;
    return r ? read({ x: r[0], y: r[1], w: r[2], h: r[3] }) : null;
}

function read(rect: PhotoRect): Changed {
    const bytes = need().read(rect.x, rect.y, rect.w, rect.h, true);
    return { rect, rgba: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

function command(json: string): CommandResult {
    const out = JSON.parse(json) as { damage: [number, number, number, number] | null; offset?: [number, number] };
    const d = out.damage;
    return { changed: d ? read({ x: d[0], y: d[1], w: d[2], h: d[3] }) : null, offset: out.offset };
}

async function load(id: number, url: string): Promise<{ size: number }> {
    ready ??= init();
    await ready;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok || !res.body) {
        let message = `HTTP ${res.status}`;
        try {
            message = ((await res.json()) as { error?: string }).error ?? message;
        } catch {
            // Not a JSON error body.
        }
        throw new Error(message);
    }
    const size = Number(res.headers.get('x-photo-size'));
    if (!Number.isInteger(size) || size <= 0) throw new Error('The server did not say how large the photo is');
    photo?.free();
    photo = new Retouch(size, size);
    const stripBytes = size * 3 * LOAD_ROWS;
    const strip = new Uint8Array(stripBytes);
    let filled = 0;
    let row = 0;
    const reader = res.body.getReader();
    const flush = (bytes: number) => {
        photo!.loadRgbRows(row, strip.subarray(0, bytes));
        row += bytes / (size * 3);
        filled = 0;
        postMessage({ id, progress: row / size });
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let at = 0;
        while (at < value.length) {
            const n = Math.min(value.length - at, stripBytes - filled);
            strip.set(value.subarray(at, at + n), filled);
            filled += n;
            at += n;
            if (filled === stripBytes) flush(stripBytes);
        }
    }
    if (filled % (size * 3) !== 0 || row + filled / (size * 3) !== size) {
        throw new Error('The photo arrived incomplete');
    }
    if (filled > 0) flush(filled);
    photo.loaded();
    return { size };
}

type Call = { id: number; op: string; args: unknown[] };

async function handle({ id, op, args }: Call): Promise<[unknown, Transferable[]]> {
    const pixels = (c: Changed | null): [Changed | null, Transferable[]] => [c, c ? [c.rgba.buffer] : []];
    switch (op) {
        case 'load': return [await load(id, args[0] as string), []];
        case 'begin': return pixels(changed(need().begin(args[0] as string, JSON.stringify(args[1]))));
        case 'push': return pixels(changed(need().push(JSON.stringify(args[0]))));
        case 'cancel': return pixels(changed(need().cancel()));
        case 'undo': return pixels(changed(need().undo()));
        case 'redo': return pixels(changed(need().redo()));
        case 'end':
        case 'run': {
            const out = command(op === 'end' ? need().end() : need().run(args[0] as string, JSON.stringify(args[1])));
            return [out, out.changed ? [out.changed.rgba.buffer] : []];
        }
        case 'read': {
            const c = read(args[0] as PhotoRect);
            return [c.rgba, [c.rgba.buffer]];
        }
        default: throw new Error(`unknown call ${op}`);
    }
}

// One call at a time: a load awaits the network while later calls wait.
let chain: Promise<void> = Promise.resolve();
onmessage = (e: MessageEvent<Call>) => {
    chain = chain.then(async () => {
        try {
            const [ok, transfer] = await handle(e.data);
            postMessage({ id: e.data.id, ok }, { transfer });
        } catch (err) {
            postMessage({ id: e.data.id, error: err instanceof Error ? err.message : String(err) });
        }
    });
};
