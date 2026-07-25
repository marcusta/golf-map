import { describe, expect, test } from 'bun:test';
import { GeolocationService, STALE_AFTER_MS, type GeoProvider } from '../src/mobile/gps/geolocation.service';
import { wgs84ToSweref99tm } from '../src/geo/transform';

/** A hand-driven geolocation source: tests push fixes/errors on demand. */
function fakeProvider(): GeoProvider & {
    emit(pos: { latitude: number; longitude: number; accuracy: number; timestamp: number }): void;
    fail(code: number): void;
    cleared: number[];
} {
    let success: ((pos: GeolocationPosition) => void) | null = null;
    let error: ((err: GeolocationPositionError) => void) | null = null;
    const cleared: number[] = [];
    return {
        cleared,
        watchPosition(onSuccess, onError) {
            success = onSuccess;
            error = onError;
            return 42;
        },
        clearWatch(id) {
            cleared.push(id);
        },
        emit(pos) {
            success?.({
                coords: {
                    latitude: pos.latitude,
                    longitude: pos.longitude,
                    accuracy: pos.accuracy,
                } as GeolocationCoordinates,
                timestamp: pos.timestamp,
            } as GeolocationPosition);
        },
        fail(code) {
            error?.({ code, message: `code ${code}` } as GeolocationPositionError);
        },
    };
}

describe('GeolocationService', () => {
    test('refuses to start outside a secure context', () => {
        const svc = new GeolocationService({ provider: fakeProvider(), secureContext: false, now: () => 0 });
        svc.start();
        expect(svc.status.get()).toBe('insecure');
        expect(svc.message.get()).toContain('secure');
    });

    test('reports unsupported when there is no provider', () => {
        const svc = new GeolocationService({ provider: null, secureContext: true, now: () => 0 });
        svc.start();
        expect(svc.status.get()).toBe('unsupported');
    });

    test('maps a position to a projected fix (WGS84 → SWEREF)', () => {
        const provider = fakeProvider();
        const svc = new GeolocationService({ provider, secureContext: true, now: () => 1000 });
        svc.start();
        expect(svc.status.get()).toBe('watching');

        provider.emit({ latitude: 58.1, longitude: 15.2, accuracy: 4.5, timestamp: 1234 });
        const fix = svc.fix.get()!;
        expect(fix.lat).toBe(58.1);
        expect(fix.lng).toBe(15.2);
        expect(fix.accuracyM).toBe(4.5);
        expect(fix.timestamp).toBe(1234);
        const expected = wgs84ToSweref99tm(58.1, 15.2);
        expect(fix.sweref.x).toBeCloseTo(expected.x, 3);
        expect(fix.sweref.y).toBeCloseTo(expected.y, 3);
    });

    test('staleness flips once the clock passes the fix age', () => {
        const provider = fakeProvider();
        let now = 10_000;
        const svc = new GeolocationService({ provider, secureContext: true, now: () => now });
        svc.start();
        provider.emit({ latitude: 58, longitude: 15, accuracy: 5, timestamp: 10_000 });
        expect(svc.stale.get()).toBe(false);

        now = 10_000 + STALE_AFTER_MS + 1;
        svc.now.set(now);
        expect(svc.stale.get()).toBe(true);
        svc.stop();
    });

    test('permission-denied is terminal and clears the watch', () => {
        const provider = fakeProvider();
        const svc = new GeolocationService({ provider, secureContext: true, now: () => 0 });
        svc.start();
        provider.fail(1); // PERMISSION_DENIED
        expect(svc.status.get()).toBe('denied');
        expect(provider.cleared).toEqual([42]);
    });

    test('a timeout is transient — message set, watch kept', () => {
        const provider = fakeProvider();
        const svc = new GeolocationService({ provider, secureContext: true, now: () => 0 });
        svc.start();
        provider.fail(3); // TIMEOUT
        expect(svc.status.get()).toBe('error');
        expect(svc.message.get()).toContain('GPS');
        expect(provider.cleared).toEqual([]); // still watching
        svc.stop();
    });
});
