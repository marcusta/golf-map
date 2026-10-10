// Reachability of the local assist sidecar (tools/sam-server), as the SAM
// tool gates on it and its panel shows it.
//
// The tool keeps its own client seam (SamClient.health returns a boolean),
// so the probe is a constructor argument. `check()` runs on activation and
// from the panel's retry button.

import { Signal } from '@basics/core/client/core';

export type SidecarStatus = 'checking' | 'online' | 'offline';

/** What one /health probe found. */
export interface SidecarProbeResult {
    /** The sidecar answered /health with status "healthy". */
    online: boolean;
}

export class SidecarHealth {
    readonly status = new Signal<SidecarStatus>('checking');

    constructor(private probe: () => Promise<SidecarProbeResult>) {}

    /** Probe /health. The probe must not throw; the clients return offline. */
    async check(): Promise<void> {
        this.status.set('checking');
        const result = await this.probe();
        this.status.set(result.online ? 'online' : 'offline');
    }
}
