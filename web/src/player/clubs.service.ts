import { Signal } from '@basics/core/client/core';
import { EntityStore } from '@basics/core/client/entity-store';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { Club, ClubsApi } from '../../../shared/api/clubs.gen';

/**
 * Player clubs (Phase 5 player settings): EntityStore keyed by club id, CRUD
 * against the clubs API with optimistic locking (version). `userId` is left
 * unset on every call — the server scopes to the authenticated user via
 * session middleware (see server/api/clubs.api.ts), so there is exactly one
 * "active player" bag per session.
 *
 * Mirrors the FeaturesService shape: `load()` is cached, `update`/`remove`
 * go through `store.mutate`/version-aware calls, and a failed write sets
 * `saveError` + re-syncs the store from the server (conflict recovery).
 * `reorder` is optimistic (local reorder applied immediately, server call
 * fired alongside) since drag/up-down reordering should feel instant.
 */
export class ClubsService {
    readonly store = new EntityStore<Club>();
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    /** True while a create/update/remove/reorder is in flight. */
    readonly saving = new Signal(false);
    readonly saveError = new Signal<RequestError | null>(null);

    private loaded = false;

    constructor(private clubsApi: ClubsApi = api.clubs) {}

    /** Load all clubs for the active player, ordered by sortOrder. Cached. */
    async load(): Promise<void> {
        if (this.loaded) return;
        const items = await request(this.loading, this.error, () => this.clubsApi.list({}));
        if (!items) return; // failed — error signal set, cache untouched
        this.store.set(items);
        this.loaded = true;
    }

    /** Re-fetch from the server (store re-sync after a failed save). */
    async reload(): Promise<void> {
        this.loaded = false;
        await this.load();
    }

    /** Create a club (appends at the end of the sort order). */
    async create(name: string, carryM: number, dispersionM: number): Promise<Club | undefined> {
        const created = await request(this.saving, this.saveError, () =>
            this.clubsApi.create({ name, carryM, dispersionM }));
        if (created) this.store.add(created);
        return created;
    }

    /**
     * Persist a partial update (name / carryM / dispersionM) with optimistic
     * locking. On version conflict or other failure, `saveError` is set and
     * the store re-syncs from the server (dropping the local edit).
     */
    async update(id: string, patch: { name?: string; carryM?: number; dispersionM?: number }): Promise<Club | undefined> {
        const result = await request(this.saving, this.saveError, () =>
            this.store.mutate(id, version => this.clubsApi.update({ id, version: version!, ...patch })));
        if (result === undefined) void this.reload();
        return result;
    }

    /** Delete a club (uses the store's current version). */
    async remove(id: string): Promise<boolean> {
        const current = this.store.items.peek().find(c => c.id === id);
        if (!current) return false;
        const result = await request(this.saving, this.saveError, () =>
            this.clubsApi.remove({ id, version: current.version }));
        if (result === undefined) {
            void this.reload();
            return false;
        }
        this.store.remove(id);
        return true;
    }

    /**
     * Reorder clubs (up/down buttons). Applies the new order to the store
     * immediately (optimistic — no version bump, since sortOrder isn't
     * returned by `reorder`) and fires the server call alongside; a failure
     * re-syncs the store from the server.
     */
    async reorder(orderedIds: string[]): Promise<boolean> {
        const byId = new Map(this.store.items.peek().map(c => [c.id, c]));
        const reordered = orderedIds
            .map((id, i) => {
                const club = byId.get(id);
                return club ? { ...club, sortOrder: i } : undefined;
            })
            .filter((c): c is Club => c !== undefined);
        this.store.set(reordered);

        const result = await request(this.saving, this.saveError, () =>
            this.clubsApi.reorder({ orderedIds }));
        if (result === undefined) {
            void this.reload();
            return false;
        }
        return true;
    }
}
