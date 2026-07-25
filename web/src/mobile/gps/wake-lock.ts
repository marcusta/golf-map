/**
 * Screen wake lock (iOS 16.4+ / `navigator.wakeLock`). On the course the
 * screen must stay on — Safari kills GPS when it sleeps. The lock is dropped
 * by the OS whenever the page is hidden (tab switch, screen off), so we
 * re-acquire on `visibilitychange`. All calls are guarded: platforms without
 * the API (older iOS, non-secure contexts) simply no-op.
 *
 * Usage: `const wl = new WakeLock(); wl.enable();` then `wl.release()` on
 * teardown. Pure DOM, no framework coupling — verified behaviourally via the
 * component that owns it.
 */
export class WakeLock {
    private sentinel: WakeLockSentinel | null = null;
    private enabled = false;
    private readonly onVisibility = () => {
        if (this.enabled && document.visibilityState === 'visible') void this.acquire();
    };

    /** Request the lock now and keep it re-acquired across visibility changes. */
    enable(): void {
        if (this.enabled) return;
        this.enabled = true;
        document.addEventListener('visibilitychange', this.onVisibility);
        void this.acquire();
    }

    /** Release the lock and stop re-acquiring. */
    release(): void {
        this.enabled = false;
        document.removeEventListener('visibilitychange', this.onVisibility);
        void this.sentinel?.release().catch(() => { /* already gone */ });
        this.sentinel = null;
    }

    private async acquire(): Promise<void> {
        // `wakeLock` is typed on Navigator but may be absent at runtime on
        // older Safari / insecure contexts — probe before use.
        const wl = (navigator as Navigator).wakeLock as Navigator['wakeLock'] | undefined;
        if (!wl || this.sentinel) return;
        try {
            this.sentinel = await wl.request('screen');
            // The OS may drop it silently; forget the sentinel so the next
            // visibility tick re-acquires.
            this.sentinel.addEventListener('release', () => { this.sentinel = null; });
        } catch {
            // Permission/edge failures are non-fatal — the screen just isn't
            // pinned. Nothing else in the app depends on it.
            this.sentinel = null;
        }
    }
}
