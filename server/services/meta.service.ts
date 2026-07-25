import { type ServerMode, serverMode } from '../mode';

// --- Output types ---

export interface Meta {
    name: string;
    version: string;
    /** Run mode of this box — `builder` (full local stack) or `serve` (lean VPS). */
    mode: ServerMode;
}

export class MetaService {
    constructor(private mode: ServerMode = serverMode()) {}

    async get(): Promise<Meta> {
        return { name: 'golf-map', version: '0.1.0', mode: this.mode };
    }
}
