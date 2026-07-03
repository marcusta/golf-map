// --- Output types ---

export interface Meta {
    name: string;
    version: string;
}

export class MetaService {
    async get(): Promise<Meta> {
        return { name: 'golf-map', version: '0.1.0' };
    }
}
