import { Signal } from '@basics/core/client/core';

/**
 * Exclusive-interaction arbitration for editor tools (draw / measure /
 * green-analysis / furniture placement). Owned and re-exposed by MapService
 * as `interactionMode` / `claimInteraction()`.
 *
 * ## The interaction-claim contract
 *
 * - `mode` is a `Signal<string | null>`. `null` means no tool is active —
 *   only default map navigation handles input.
 * - A tool calls `claim('measure')` (any unique string id) when it
 *   activates, BEFORE acting on map events. It receives a `release()`
 *   function; call it when the tool deactivates (register it with the
 *   component's `track()` so teardown is automatic).
 * - Last claim wins: claiming while another tool holds the mode simply
 *   replaces it. The displaced tool MUST watch the `mode` signal (via
 *   `effect`) and deactivate itself when the value is no longer its own id.
 * - Every map onClick/onMouseMove handler that implements tool behavior
 *   MUST first check `mode.get() === <its own id>` and return early
 *   otherwise — handlers are broadcast to all subscribers, the claim is
 *   what makes handling exclusive.
 * - `release()` is idempotent and stale-safe: it only clears the mode if
 *   this specific claim is still the active one, so releasing after being
 *   displaced is a harmless no-op.
 */
export class InteractionClaims {
    /** Current interaction mode, or null when no tool is active. */
    readonly mode = new Signal<string | null>(null);

    private seq = 0;
    private active = 0;

    /** Claim exclusive interaction. Returns the matching release function. */
    claim(mode: string): () => void {
        const id = ++this.seq;
        this.active = id;
        this.mode.set(mode);
        return () => {
            if (this.active !== id) return; // displaced or already released
            this.active = 0;
            this.mode.set(null);
        };
    }
}
