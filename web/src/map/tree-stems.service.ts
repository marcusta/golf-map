import { Signal, batch } from '@basics/core/client/core';
import { parseTreeStemsAsset, type TreeStem } from '../../../shared/strategy/tree-stems';

/** One validated, versioned asset shared by rendering and shot clearance. */
export class TreeStemsService {
    readonly stems = new Signal<readonly TreeStem[] | null>(null);
    readonly loading = new Signal(false);
    readonly error = new Signal<string | null>(null);
    private request: AbortController | null = null;

    configure(url: string | null): void {
        this.request?.abort();
        const request = new AbortController();
        this.request = request;
        batch(() => {
            this.stems.set(null);
            this.error.set(null);
            this.loading.set(url !== null);
        });
        if (url === null) return;
        void fetch(url, { signal: request.signal }).then(async response => {
            if (!response.ok) throw new Error(`Tree asset unavailable (${response.status})`);
            const stems = parseTreeStemsAsset(await response.json());
            if (this.request === request) this.stems.set(stems);
        }).catch(error => {
            if (this.request === request && !request.signal.aborted) this.error.set(String(error));
        }).finally(() => {
            if (this.request === request) this.loading.set(false);
        });
    }
}
