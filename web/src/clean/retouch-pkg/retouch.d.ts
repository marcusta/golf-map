/* tslint:disable */
/* eslint-disable */

/**
 * The engine as JavaScript sees it: params and results cross as JSON text, pixels as bytes.
 */
export class Retouch {
    free(): void;
    begin(cmd: string, params: string): string;
    cancel(): string;
    end(): string;
    loadRgbRows(y: number, rgb: Uint8Array): void;
    loaded(): void;
    constructor(width: number, height: number);
    push(points: string): string;
    read(x: number, y: number, w: number, h: number, only_changed: boolean): Uint8Array;
    redo(): string;
    run(cmd: string, params: string): string;
    undo(): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_retouch_free: (a: number, b: number) => void;
    readonly retouch_begin: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly retouch_cancel: (a: number, b: number) => void;
    readonly retouch_end: (a: number, b: number) => void;
    readonly retouch_loadRgbRows: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly retouch_loaded: (a: number) => void;
    readonly retouch_new: (a: number, b: number) => number;
    readonly retouch_push: (a: number, b: number, c: number, d: number) => void;
    readonly retouch_read: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly retouch_redo: (a: number, b: number) => void;
    readonly retouch_run: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly retouch_undo: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
