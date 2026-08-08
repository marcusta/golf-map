import { Computed, Signal, batch } from '@basics/core/client/core';
import { EntityStore } from '@basics/core/client/entity-store';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type {
    GamePlan,
    GamePlanHole,
    GamePlansApi,
    PlanGate,
    PlanShot,
} from '../../../shared/api/game-plans.gen';

/** The plan row without its nested hole tree (plan-level wind + version). */
export type PlanHead = Omit<GamePlan, 'holes'>;

/** A plan-hole row without its nested shots/gates (hole-level fields + version). */
export type PlanHoleRow = Omit<GamePlanHole, 'shots' | 'gates'>;

/** Stable key for one sibling group in the flat shot store. */
function parentKey(gamePlanHoleId: string, parentShotId: string | null): string {
    return `${gamePlanHoleId}\u0000${parentShotId ?? ''}`;
}

function stripHole(hole: GamePlanHole): PlanHoleRow {
    const { shots, gates, ...row } = hole;
    return row;
}

/**
 * A real plan tree, vs the API framework's null sentinel. The server mount
 * layer serialises a `null` handler result as `{ ok: true }` (`result ?? { ok:
 * true }`), so `getByCourse` on a course with no plan yet arrives as that
 * object — NOT literal `null`. Guard on the plan shape so `load` treats the
 * sentinel as "no plan"; otherwise `setTree` would poison `plan` with an
 * id-less `{ ok: true }` (and throw on `holes.map`), and the first edit would
 * then skip the upsert and POST an empty `planId` (server 400).
 */
function isPlanTree(tree: unknown): tree is GamePlan {
    return typeof tree === 'object' && tree !== null
        && typeof (tree as GamePlan).id === 'string'
        && Array.isArray((tree as GamePlan).holes);
}

/**
 * The course's game plan for the planner page. Mirrors FeaturesService:
 * the server's plan TREE (plan → holes → shots/gates) is flattened into a
 * head signal + three EntityStores so per-item signals drive $each rows and
 * `mutate` reads each row's own version.
 *
 * Lazy-create semantics: `load` only READS (getByCourse may be null — no
 * plan yet); the plan row and each hole row are created on first edit
 * (upsert / setHole WITHOUT a version — the server creates when absent and
 * version-checks when present). Every subsequent update is version-aware;
 * a 409 (or any save failure) sets `saveError` and re-syncs the whole tree
 * from the server, dropping local patches.
 *
 * DI singleton. `patchShotLocal`/`patchGateLocal` are the per-frame drag
 * feedback paths (no network, version untouched).
 */
export class PlanService {
    /** Plan-level row (wind + version), or null (not loaded / no plan yet). */
    readonly plan = new Signal<PlanHead | null>(null);
    readonly holes = new EntityStore<PlanHoleRow>();
    readonly shots = new EntityStore<PlanShot>();
    readonly gates = new EntityStore<PlanGate>();

    /**
     * Parent index over the flat shot store. Each value is one sibling group,
     * ordered by option rank (`sortOrder`). Roots are scoped by hole id so
     * their shared null parent never mixes holes.
     */
    readonly shotsByParent = new Computed<ReadonlyMap<string, readonly PlanShot[]>>(() => {
        const index = new Map<string, PlanShot[]>();
        for (const shot of this.shots.items.get()) {
            const key = parentKey(shot.gamePlanHoleId, shot.parentShotId);
            const siblings = index.get(key) ?? [];
            siblings.push(shot);
            index.set(key, siblings);
        }
        for (const siblings of index.values()) {
            siblings.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
        }
        return index;
    });

    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    /** True while a create/update/remove is in flight (autosave indicator). */
    readonly saving = new Signal(false);
    readonly saveError = new Signal<RequestError | null>(null);

    private loadedCourseId: string | null = null;

    constructor(private plansApi: GamePlansApi = api.gamePlans) {}

    /**
     * Load the course's plan tree (null = no plan yet). Cached per courseId;
     * pass `force` to refetch a course that is already loaded.
     *
     * The cache is per-service and never expires, so it MUST be forced whenever
     * the planner is (re)entered or refocused — the iOS app writes to the same
     * rows, and without a forced refetch its edits only appeared after a full
     * page reload.
     */
    async load(courseId: string, force = false): Promise<void> {
        if (this.loadedCourseId === courseId && !force) return;
        const tree = await request(this.loading, this.error, () =>
            this.plansApi.getByCourse({ courseId }));
        if (tree === undefined) return; // failed — error signal set, cache untouched
        this.loadedCourseId = courseId;
        // `null` (no plan) reaches us as the framework's `{ ok: true }` sentinel,
        // never literal null — treat any non-plan-shaped response as "no plan".
        if (!isPlanTree(tree)) {
            batch(() => {
                this.plan.set(null);
                this.holes.set([]);
                this.shots.set([]);
                this.gates.set([]);
            });
            return;
        }
        this.setTree(tree);
    }

    /** Re-fetch the loaded course (store re-sync after a failed save). */
    async reload(): Promise<void> {
        const courseId = this.loadedCourseId;
        if (!courseId) return;
        await this.load(courseId, true);
    }

    /** The plan-hole row for a hole number, or undefined (not planned yet). */
    holeRow(holeNumber: number): PlanHoleRow | undefined {
        return this.holes.items.get().find(h => h.holeNumber === holeNumber);
    }

    /** One ordered sibling group (root options when `parentShotId` is null). */
    childShots(gamePlanHoleId: string, parentShotId: string | null): readonly PlanShot[] {
        return this.shotsByParent.get().get(parentKey(gamePlanHoleId, parentShotId)) ?? [];
    }

    /**
     * A hole row's complete shot tree in display order: sibling rank first,
     * then each option's continuation subtree. The source of truth remains the
     * flat EntityStore; this is only a deterministic projection.
     */
    shotsForHole(gamePlanHoleId: string): PlanShot[] {
        // Subscribe once to the parent index, then traverse that settled map.
        const index = this.shotsByParent.get();
        const out: PlanShot[] = [];
        const visit = (parentShotId: string | null): void => {
            for (const shot of index.get(parentKey(gamePlanHoleId, parentShotId)) ?? []) {
                out.push(shot);
                visit(shot.id);
            }
        };
        visit(null);
        return out;
    }

    /** Primary line = follow rank-0 roots/children until the branch ends. */
    primaryLineForHole(gamePlanHoleId: string): PlanShot[] {
        const index = this.shotsByParent.get();
        const out: PlanShot[] = [];
        let parentShotId: string | null = null;
        while (true) {
            const primary: PlanShot | undefined = index.get(parentKey(gamePlanHoleId, parentShotId))?.[0];
            if (!primary) return out;
            out.push(primary);
            parentShotId = primary.id;
        }
    }

    /** A hole row's gates, sorted by sortOrder. */
    gatesForHole(gamePlanHoleId: string): PlanGate[] {
        return this.gates.items.get()
            .filter(g => g.gamePlanHoleId === gamePlanHoleId)
            .sort((a, b) => a.sortOrder - b.sortOrder);
    }

    // ── Plan-level (wind) ───────────────────────────────────────────────────

    /**
     * Set the plan-level wind (sparse patch; explicit null clears a field).
     * Creates the plan on first use (upsert without version); updates with
     * optimistic locking after. The response is the full tree — re-synced
     * wholesale so versions stay correct.
     */
    async setPlanWind(patch: {
        windSpeedMps?: number | null;
        windDirectionDeg?: number | null;
    }): Promise<void> {
        const courseId = this.loadedCourseId;
        if (!courseId) return;
        const current = this.plan.peek();
        const result = await request(this.saving, this.saveError, () =>
            this.plansApi.upsert({
                courseId,
                ...(current ? { version: current.version } : {}),
                ...patch,
            }));
        if (result === undefined) {
            void this.reload();
            return;
        }
        this.setTree(result);
    }

    // ── Hole-level (tee / preferred club / wind override / notes) ──────────

    /**
     * Sparse-patch a plan hole via setHole (null clears nullable fields).
     * Creates the plan row and/or the hole row on first touch (no version);
     * version-aware update once the hole row exists.
     */
    async setHoleFields(holeNumber: number, patch: {
        teeId?: string | null;
        preferredClubId?: string | null;
        plannedDirectionDeg?: number | null;
        windSpeedMps?: number | null;
        windDirectionDeg?: number | null;
        notes?: string | null;
    }): Promise<PlanHoleRow | undefined> {
        const existing = this.holes.items.peek().find(h => h.holeNumber === holeNumber);
        if (!existing) {
            const plan = await this.ensurePlan();
            if (!plan) return undefined;
            const created = await request(this.saving, this.saveError, () =>
                this.plansApi.setHole({ planId: plan.id, holeNumber, ...patch }));
            if (!created) {
                void this.reload();
                return undefined;
            }
            this.holes.add(stripHole(created));
            return stripHole(created);
        }
        const result = await request(this.saving, this.saveError, () =>
            this.holes.mutate(existing.id, version =>
                this.plansApi.setHole({
                    planId: existing.gamePlanId,
                    holeNumber,
                    version: version!,
                    ...patch,
                }).then(stripHole)));
        if (result === undefined) void this.reload();
        return result;
    }

    // ── Shots ───────────────────────────────────────────────────────────────

    /** Append a shot to a hole (creates plan/hole rows on first use). */
    async addShot(holeNumber: number, input: {
        lat: number;
        lon: number;
        elevation?: number | null;
        clubId?: string | null;
        label?: string | null;
        parentShotId?: string | null;
    }): Promise<PlanShot | undefined> {
        const hole = await this.ensureHole(holeNumber);
        if (!hole) return undefined;
        const created = await request(this.saving, this.saveError, () =>
            this.plansApi.addShot({ gamePlanHoleId: hole.id, ...input }));
        if (created) this.shots.add(created);
        return created;
    }

    /**
     * Local-only shot patch for per-frame drag feedback. No network; the
     * version is unchanged so a later `updateShot` still carries the correct
     * optimistic-locking version.
     */
    patchShotLocal(id: string, patch: { lat?: number; lon?: number }): void {
        const current = this.shots.items.peek().find(s => s.id === id);
        if (!current) return;
        this.shots.patch({ ...current, ...patch });
    }

    /** Persist a shot update with optimistic locking (conflict → reload). */
    async updateShot(id: string, patch: {
        lat?: number;
        lon?: number;
        elevation?: number | null;
        clubId?: string | null;
        label?: string | null;
    }): Promise<PlanShot | undefined> {
        const result = await request(this.saving, this.saveError, () =>
            this.shots.mutate(id, version =>
                this.plansApi.updateShot({ id, version: version!, ...patch })));
        if (result === undefined) void this.reload();
        return result;
    }

    /**
     * Delete a shot using O2 semantics: splice heals the chain by promoting
     * direct children into the removed sibling slot; cascade removes the
     * complete option branch.
     */
    async removeShot(id: string, mode: 'splice' | 'cascade' = 'splice'): Promise<boolean> {
        const current = this.shots.items.peek().find(s => s.id === id);
        if (!current) return false;
        const result = await request(this.saving, this.saveError, () =>
            this.plansApi.removeShot({ id, version: current.version, mode }));
        if (result === undefined) {
            void this.reload();
            return false;
        }
        const all = this.shots.items.peek();
        if (mode === 'cascade') {
            const removed = new Set<string>([id]);
            let changed = true;
            while (changed) {
                changed = false;
                for (const shot of all) {
                    if (shot.parentShotId !== null && removed.has(shot.parentShotId) && !removed.has(shot.id)) {
                        removed.add(shot.id);
                        changed = true;
                    }
                }
            }
            this.shots.set(all.filter(shot => !removed.has(shot.id)));
        } else {
            const siblings = all
                .filter(shot => shot.gamePlanHoleId === current.gamePlanHoleId
                    && shot.parentShotId === current.parentShotId)
                .sort((a, b) => a.sortOrder - b.sortOrder);
            const slot = siblings.findIndex(shot => shot.id === id);
            const children = all
                .filter(shot => shot.parentShotId === id)
                .sort((a, b) => a.sortOrder - b.sortOrder);
            const replacementIds = new Set(children.map(shot => shot.id));
            const nextSiblings = [
                ...siblings.slice(0, slot),
                ...children,
                ...siblings.slice(slot + 1),
            ];
            const siblingRank = new Map(nextSiblings.map((shot, rank) => [shot.id, rank]));
            this.shots.set(all
                .filter(shot => shot.id !== id)
                .map(shot => {
                    if (replacementIds.has(shot.id)) {
                        return { ...shot, parentShotId: current.parentShotId, sortOrder: siblingRank.get(shot.id)! };
                    }
                    const rank = siblingRank.get(shot.id);
                    return rank === undefined ? shot : { ...shot, sortOrder: rank };
                }));
        }
        return true;
    }

    /** Promote an option by moving it to rank 0 inside its sibling group. */
    async setPrimary(id: string): Promise<boolean> {
        const current = this.shots.items.peek().find(shot => shot.id === id);
        if (!current) return false;
        const result = await request(this.saving, this.saveError, () => this.plansApi.setPrimary({ id }));
        if (result === undefined) {
            void this.reload();
            return false;
        }
        const siblings = this.shots.items.peek()
            .filter(shot => shot.gamePlanHoleId === current.gamePlanHoleId
                && shot.parentShotId === current.parentShotId)
            .sort((a, b) => a.sortOrder - b.sortOrder);
        const ranks = new Map(
            [current, ...siblings.filter(shot => shot.id !== id)].map((shot, rank) => [shot.id, rank]),
        );
        this.shots.set(this.shots.items.peek().map(shot => {
            const rank = ranks.get(shot.id);
            return rank === undefined ? shot : { ...shot, sortOrder: rank };
        }));
        return true;
    }

    // ── Gates ───────────────────────────────────────────────────────────────

    /** Add a corridor gate to a hole (creates plan/hole rows on first use). */
    async addGate(holeNumber: number, input: {
        lat: number;
        lon: number;
        directionDeg: number;
        halfWidthLeftM: number;
        halfWidthRightM: number;
        source?: 'manual' | 'computed';
    }): Promise<PlanGate | undefined> {
        const hole = await this.ensureHole(holeNumber);
        if (!hole) return undefined;
        const created = await request(this.saving, this.saveError, () =>
            this.plansApi.addGate({ gamePlanHoleId: hole.id, ...input }));
        if (created) this.gates.add(created);
        return created;
    }

    /** Local-only gate patch for per-frame drag feedback (no network). */
    patchGateLocal(id: string, patch: {
        lat?: number;
        lon?: number;
        halfWidthLeftM?: number;
        halfWidthRightM?: number;
    }): void {
        const current = this.gates.items.peek().find(g => g.id === id);
        if (!current) return;
        this.gates.patch({ ...current, ...patch });
    }

    /** Persist a gate update with optimistic locking (conflict → reload). */
    async updateGate(id: string, patch: {
        lat?: number;
        lon?: number;
        directionDeg?: number;
        halfWidthLeftM?: number;
        halfWidthRightM?: number;
    }): Promise<PlanGate | undefined> {
        const result = await request(this.saving, this.saveError, () =>
            this.gates.mutate(id, version =>
                this.plansApi.updateGate({ id, version: version!, ...patch })));
        if (result === undefined) void this.reload();
        return result;
    }

    /** Delete a gate (uses the store's current version). */
    async removeGate(id: string): Promise<boolean> {
        const current = this.gates.items.peek().find(g => g.id === id);
        if (!current) return false;
        const result = await request(this.saving, this.saveError, () =>
            this.plansApi.removeGate({ id, version: current.version }));
        if (result === undefined) {
            void this.reload();
            return false;
        }
        this.gates.remove(id);
        return true;
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /** The plan head, creating the plan row on first edit (upsert, no version). */
    private async ensurePlan(): Promise<PlanHead | undefined> {
        const current = this.plan.peek();
        if (current) return current;
        const courseId = this.loadedCourseId;
        if (!courseId) return undefined;
        const created = await request(this.saving, this.saveError, () =>
            this.plansApi.upsert({ courseId }));
        if (!created) return undefined;
        this.setTree(created);
        return this.plan.peek() ?? undefined;
    }

    /** The hole row, creating plan + hole rows on first edit. */
    private async ensureHole(holeNumber: number): Promise<PlanHoleRow | undefined> {
        const existing = this.holes.items.peek().find(h => h.holeNumber === holeNumber);
        if (existing) return existing;
        return this.setHoleFields(holeNumber, {});
    }

    /** Replace all stores from a server plan tree. */
    private setTree(tree: GamePlan): void {
        const { holes, ...head } = tree;
        batch(() => {
            this.plan.set(head);
            this.holes.set(holes.map(stripHole));
            this.shots.set(holes.flatMap(h => [...h.shots].sort((a, b) => a.sortOrder - b.sortOrder)));
            this.gates.set(holes.flatMap(h => [...h.gates].sort((a, b) => a.sortOrder - b.sortOrder)));
        });
    }
}
