import type { MetaService } from '../services/meta.service';

export function createMetaApi(svc: MetaService) {
    return {
        get: { method: 'GET' as const, path: '/meta', fn: () => svc.get() },
    };
}
