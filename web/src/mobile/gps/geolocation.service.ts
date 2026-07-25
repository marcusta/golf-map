import { Signal, Computed } from '@basics/core/client/core';
import { wgs84ToSweref99tm } from '../../geo/transform';

/** A resolved GPS fix, projected into the course CRS for distance math. */
export interface GpsFix {
    /** WGS84 latitude / longitude. */
    lat: number;
    lng: number;
    /** Horizontal accuracy in metres (the accuracy-ring radius). */
    accuracyM: number;
    /** EPSG:3006 easting/northing — the origin for feature-distances. */
    sweref: { x: number; y: number };
    /** Fix time, ms since epoch (from the Position, not our clock). */
    timestamp: number;
}

/**
 * Watch state. `insecure`/`unsupported` are terminal-until-reload; `denied`
 * means the user rejected the permission; `error` is a transient failure
 * (timeout / position unavailable) that may still recover on a later tick.
 */
export type GeoStatus =
    | 'idle'
    | 'watching'
    | 'denied'
    | 'unsupported'
    | 'insecure'
    | 'error';

/** The slice of the Geolocation API this service uses (for test injection). */
export interface GeoProvider {
    watchPosition(
        success: (pos: GeolocationPosition) => void,
        error: (err: GeolocationPositionError) => void,
        options?: PositionOptions,
    ): number;
    clearWatch(id: number): void;
}

export interface GeoDeps {
    /** The geolocation source; null when the platform has none. */
    provider: GeoProvider | null;
    /** Secure-context flag — Safari only exposes geolocation over HTTPS. */
    secureContext: boolean;
    /** Injectable clock for staleness (defaults to Date.now). */
    now: () => number;
}

/** A fix older than this reads as stale (GPS dropped or backgrounded). */
export const STALE_AFTER_MS = 5000;

function defaultDeps(): GeoDeps {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    return {
        provider: nav && 'geolocation' in nav ? nav.geolocation : null,
        secureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
        now: () => Date.now(),
    };
}

/**
 * Wraps `watchPosition` into a reactive `GpsFix` signal (WGS84 → SWEREF via
 * the shared transform, so it stays numerically identical to the server).
 * Surfaces accuracy and staleness, and refuses to start outside a secure
 * context with a clear status the UI can explain (Safari gives no geolocation
 * over plain HTTP — see feature-mobile-companion.md §5).
 *
 * DI singleton; constructor deps are injectable so the service tests without a
 * real browser geolocation stack (happy-dom has none).
 */
export class GeolocationService {
    readonly fix = new Signal<GpsFix | null>(null);
    readonly status = new Signal<GeoStatus>('idle');
    /** Human-readable last error, or null. */
    readonly message = new Signal<string | null>(null);
    /** Ticks while watching so staleness stays live without GPS movement. */
    readonly now = new Signal<number>(0);

    /** True when we have a fix but it has aged past STALE_AFTER_MS. */
    readonly stale = new Computed<boolean>(() => {
        const f = this.fix.get();
        if (!f) return false;
        return this.now.get() - f.timestamp > STALE_AFTER_MS;
    });

    private deps: GeoDeps;
    private watchId: number | null = null;
    private clockTimer: ReturnType<typeof setInterval> | null = null;

    constructor(deps?: Partial<GeoDeps>) {
        this.deps = { ...defaultDeps(), ...deps };
    }

    /** Begin watching. Idempotent — a second call while watching is a no-op. */
    start(): void {
        if (this.watchId !== null) return;
        if (!this.deps.provider) {
            this.status.set('unsupported');
            this.message.set('This device has no location sensor.');
            return;
        }
        if (!this.deps.secureContext) {
            this.status.set('insecure');
            this.message.set('Location needs a secure (HTTPS) connection.');
            return;
        }
        this.status.set('watching');
        this.message.set(null);
        this.now.set(this.deps.now());
        this.watchId = this.deps.provider.watchPosition(
            (pos) => this.onPosition(pos),
            (err) => this.onError(err),
            { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
        );
        this.clockTimer = setInterval(() => this.now.set(this.deps.now()), 1000);
    }

    /** Stop watching and release the clock. Keeps the last fix for reference. */
    stop(): void {
        if (this.watchId !== null && this.deps.provider) {
            this.deps.provider.clearWatch(this.watchId);
        }
        this.watchId = null;
        if (this.clockTimer !== null) {
            clearInterval(this.clockTimer);
            this.clockTimer = null;
        }
        if (this.status.peek() === 'watching') this.status.set('idle');
    }

    private onPosition(pos: GeolocationPosition): void {
        const { latitude, longitude, accuracy } = pos.coords;
        const sweref = wgs84ToSweref99tm(latitude, longitude);
        this.now.set(this.deps.now());
        this.fix.set({
            lat: latitude,
            lng: longitude,
            accuracyM: accuracy,
            sweref,
            timestamp: pos.timestamp,
        });
        this.status.set('watching');
        this.message.set(null);
    }

    private onError(err: GeolocationPositionError): void {
        // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT.
        if (err.code === 1) {
            this.status.set('denied');
            this.message.set('Location permission was denied.');
            this.stop();
            return;
        }
        // Transient: stay in 'watching' (the watch is still live and may
        // recover) but surface the reason.
        this.status.set('error');
        this.message.set(err.code === 3 ? 'Waiting for a GPS fix...' : 'Location unavailable.');
    }
}
