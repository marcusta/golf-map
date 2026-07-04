import { GlobalWindow } from 'happy-dom';

const window = new GlobalWindow();

for (const key of Object.getOwnPropertyNames(window)) {
    if (!(key in globalThis)) {
        Object.defineProperty(globalThis, key, {
            value: (window as any)[key],
            writable: true,
            configurable: true,
        });
    }
}

Object.defineProperty(globalThis, 'document', {
    value: window.document,
    writable: true,
    configurable: true,
});
