// Reachability of the local assist sidecar (tools/sam-server), as the SAM
// and clean tools gate on it and their panels show it.
//
// One class, one instance per tool: each tool keeps its own client seam
// (SamClient.health returns a boolean, CleanClient.health also reports
// LaMa readiness), so the probe is a constructor argument. `check()` runs on
// activation and from the panel's retry button.

import { Signal } from '@basics/core/client/core';

export type SidecarStatus = 'checking' | 'online' | 'offline';

/** What one /health probe found. */
export interface SidecarProbeResult {
    /** The sidecar answered /health with status "healthy". */
    online: boolean;
    /** LaMa weights and torch present: /inpaint will work. */
    inpaintAvailable?: boolean;
    /** Reason from the sidecar when inpainting is unavailable. */
    detail?: string | null;
}

export class SidecarHealth {
    readonly status = new Signal<SidecarStatus>('checking');
    readonly inpaintReady = new Signal(false);
    readonly detail = new Signal<string | null>(null);

    constructor(private probe: () => Promise<SidecarProbeResult>) {}

    /** Probe /health. The probe must not throw; the clients return offline. */
    async check(): Promise<void> {
        this.status.set('checking');
        const result = await this.probe();
        this.status.set(result.online ? 'online' : 'offline');
        this.inpaintReady.set(result.inpaintAvailable ?? false);
        this.detail.set(result.detail ?? null);
    }
}
