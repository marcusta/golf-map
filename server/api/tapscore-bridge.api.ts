import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { TapscoreBridgeService } from '../services/tapscore-bridge.service';

// --- Input schemas ---

const StatusInput = Type.Object({
    roundId: Type.String(),
});

const LinkInput = Type.Object({
    roundId: Type.String(),
    // The Tapscore friendly-round share token — the whole credential.
    token: Type.String({ minLength: 1 }),
    // Which Tapscore ball the scores land on. Optional: auto-picked when the
    // round has exactly one ball; required (else 409) when it has several.
    ballId: Type.Optional(Type.String()),
});

const UnlinkInput = Type.Object({
    roundId: Type.String(),
});

// --- API descriptor ---
//
// Small surface for clients to link/unlink a round to a Tapscore round and read
// link status. Authenticated like the rest of the rounds API. Publishing itself
// is automatic (the shot-write hook), so there is no explicit "sync" endpoint.

export function createTapscoreBridgeApi(svc: TapscoreBridgeService) {
    const mw = [requireAuth()];
    return {
        status: {
            method: 'GET' as const,
            path: '/rounds/tapscore-link',
            fn: (input: Static<typeof StatusInput>) => svc.status(input.roundId),
            schema: StatusInput,
            middleware: mw,
        },
        link: {
            method: 'POST' as const,
            path: '/rounds/tapscore-link',
            fn: (input: Static<typeof LinkInput>) => svc.link(input.roundId, input.token, input.ballId),
            schema: LinkInput,
            middleware: mw,
        },
        unlink: {
            method: 'POST' as const,
            path: '/rounds/tapscore-unlink',
            fn: (input: Static<typeof UnlinkInput>) => svc.unlink(input.roundId),
            schema: UnlinkInput,
            middleware: mw,
        },
    };
}
