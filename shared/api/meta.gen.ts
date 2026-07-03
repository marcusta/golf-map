// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface Meta {
    name: string;
    version: string;
}

export interface MetaApi {
    get(): Promise<Meta>;
}

export function createMetaClient(baseUrl: string): MetaApi {
    return {
        async get() {
            return apiFetch({ method: 'GET', url: `${baseUrl}/meta` });
        },
    };
}
