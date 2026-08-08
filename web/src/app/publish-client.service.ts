import { Signal } from '@basics/core/client/core';
import { api } from '../api';
import type { PublishApi, PublishState } from '../../../shared/api/publish.gen';

export type { PublishState };

const POLL_MS = 2000;

/** Ordered publish steps — drives the progress label in the actions menu. */
export const PUBLISH_STEP_LABELS: Record<NonNullable<PublishState['step']>, string> = {
    preflight: 'Checking site',
    bundle: 'Assembling bundle',
    pack: 'Packing bundle',
    upload: 'Uploading to VPS',
};

/**
 * Drives a builder-side publish-to-VPS run (the UI face of `bun run publish`):
 * starts it, then polls `/publish/status` until terminal. The `state` signal
 * feeds the actions-menu row; `run()` resolves with the terminal state so the
 * caller can show one result dialog.
 */
export class PublishClientService {
    readonly state = new Signal<PublishState | null>(null);

    constructor(private publishApi: PublishApi = api.publish) {}

    /** Refresh state without starting anything (menu-open preseed). */
    async refresh(): Promise<PublishState | null> {
        try {
            const s = await this.publishApi.status();
            this.state.set(s);
            return s;
        } catch {
            return null; // builder API absent (serve mode) or transient — leave the menu unchanged
        }
    }

    /** Start a publish and poll to a terminal state. Throws only if the start itself is rejected. */
    async run(courseId: string): Promise<PublishState> {
        let s = await this.publishApi.start({ courseId });
        this.state.set(s);
        while (s.status === 'running') {
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            try {
                s = await this.publishApi.status();
                this.state.set(s);
            } catch {
                // Transient poll failure — keep polling; the run continues server-side.
            }
        }
        return s;
    }
}
