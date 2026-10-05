import { expect, test } from 'bun:test';
import { Component } from '@basics/core/client/core';
import { lazy } from '../src/app/lazy-route';

// Lazy route components (review item 33): $swap mounts a constructor
// synchronously; the wrapper spawns the real component when its chunk lands.

class Page extends Component {
    static mounted = 0;
    static destroyed = 0;
    render(): HTMLElement {
        const el = document.createElement('section');
        el.className = 'page';
        return el;
    }
    onMount(): void { Page.mounted++; }
    onDestroy(): void { Page.destroyed++; }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function deferredLoad() {
    let resolve!: (ctor: typeof Page) => void;
    let calls = 0;
    const promise = new Promise<typeof Page>(r => { resolve = r; });
    return { load: () => { calls++; return promise; }, resolve: (c: typeof Page) => resolve(c), calls: () => calls };
}

test('mounts nothing until the chunk lands, then the real component in the same host', async () => {
    Page.mounted = 0;
    const d = deferredLoad();
    const Route = lazy(d.load);
    const host = document.createElement('main');
    const route = new Route();
    route.mount(host);
    expect(host.children).toHaveLength(0);
    d.resolve(Page);
    await tick();
    expect(host.querySelector('section.page')).not.toBeNull();
    expect(Page.mounted).toBe(1);

    // A later visit spawns synchronously from the cached constructor.
    const again = document.createElement('main');
    new Route().mount(again);
    expect(again.querySelector('section.page')).not.toBeNull();
    expect(d.calls()).toBe(1);

    Page.destroyed = 0;
    route.destroy();
    expect(Page.destroyed).toBe(1);
});

test('leaving the route before the chunk lands mounts nothing', async () => {
    Page.mounted = 0;
    const d = deferredLoad();
    const Route = lazy(d.load);
    const host = document.createElement('main');
    const route = new Route();
    route.mount(host);
    route.destroy();
    d.resolve(Page);
    await tick();
    expect(host.children).toHaveLength(0);
    expect(Page.mounted).toBe(0);
});

test('a failed load retries on the next visit', async () => {
    let calls = 0;
    const Route = lazy(() => (++calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(Page)));
    const errors = console.error;
    console.error = () => {};
    try {
        new Route().mount(document.createElement('main'));
        await tick();
    } finally {
        console.error = errors;
    }
    const host = document.createElement('main');
    new Route().mount(host);
    await tick();
    expect(calls).toBe(2);
    expect(host.querySelector('section.page')).not.toBeNull();
});
