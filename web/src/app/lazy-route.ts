import { Component } from '@basics/core/client/core';

type RouteCtor = new () => Component<any>;

/**
 * A route component whose module loads through import().
 *
 * The router's $swap takes component constructors and mounts them
 * synchronously, so this returns a constructor. It renders nothing while the
 * chunk loads, then spawns the real component into the same host, so the real
 * component's render() lands where $swap would have put it. The first mount
 * starts the load; later mounts reuse the resolved constructor and spawn
 * synchronously. A route left before the chunk resolves spawns nothing. A
 * failed load is logged and clears the cache, so the next visit retries.
 */
export function lazy(load: () => Promise<RouteCtor>): RouteCtor {
    let resolved: RouteCtor | null = null;
    let pending: Promise<RouteCtor> | null = null;
    const get = (): Promise<RouteCtor> => {
        pending ??= load().then(ctor => (resolved = ctor), error => {
            pending = null;
            throw error;
        });
        return pending;
    };

    return class LazyRoute extends Component {
        private host: HTMLElement | null = null;
        private destroyed = false;

        render(): DocumentFragment {
            return document.createDocumentFragment();
        }

        mount(target: HTMLElement): void {
            this.host = target;
            super.mount(target);
        }

        onMount(): void {
            if (resolved) {
                this.spawn(resolved, this.host!);
                return;
            }
            get().then(ctor => {
                if (!this.destroyed) this.spawn(ctor, this.host!);
            }, error => console.error('[route] loading the route component failed', error));
        }

        onDestroy(): void {
            this.destroyed = true;
        }
    };
}
