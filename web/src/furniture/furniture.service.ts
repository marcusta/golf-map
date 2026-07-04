import { Signal, Computed } from '@basics/core/client/core';
import { EntityStore } from '@basics/core/client/entity-store';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { Tee, TeesApi } from '../../../shared/api/tees.gen';
import type { Green, GreensApi } from '../../../shared/api/greens.gen';
import type { Pin, PinsApi } from '../../../shared/api/pins.gen';
import type { AimPoint, AimPointsApi } from '../../../shared/api/aim-points.gen';

/** Interaction-claim id AND overlay id prefix for the furniture tool. */
export const FURNITURE_TOOL_ID = 'furniture';

/** What kind of item the tool is armed to place, or null (select mode). */
export type PlacementKind = 'tee' | 'pin' | 'aim' | 'green' | null;

/** Which point of a green row (one row per hole holds all three). */
export type GreenPoint = 'center' | 'front' | 'back';

/** Tee colour presets (the four tournament sets the renderer knows about). */
export const TEE_COLORS = ['black', 'white', 'yellow', 'blue', 'red'] as const;
export type TeeColor = (typeof TEE_COLORS)[number];

/** Pin difficulty presets. */
export const PIN_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type PinDifficulty = (typeof PIN_DIFFICULTIES)[number];

/** A selected placed item (discriminated by kind). */
export type Selection =
    | { kind: 'tee'; id: string }
    | { kind: 'pin'; id: string }
    | { kind: 'aim'; id: string }
    | { kind: 'green'; holeId: string; point: GreenPoint }
    | null;

/**
 * Async elevation sampler — the subset of ElevationService the service
 * depends on (injected for tests). `elevationAt` returns metres or null
 * (unconfigured / outside coverage).
 */
export interface ElevationSampler {
    elevationAt(lngLat: { lng: number; lat: number }): Promise<number | null>;
}

/** No-op sampler for tests that don't care about elevation. */
const NULL_ELEVATION: ElevationSampler = { elevationAt: async () => null };

/**
 * Furniture (tees / greens / pins / aim points) for the editor. Mirrors
 * FeaturesService: per-course EntityStores keyed by id, CRUD against the
 * generated clients with optimistic locking (version), a discriminated
 * selection signal, and a placement state machine (which kind is armed +
 * the pending attributes for the next created item).
 *
 * Coordinates here are WGS84 lat/lon (NOT the EPSG:3006 used by course
 * features). Elevation is auto-sampled through the injected ElevationSampler
 * at placement / move time and stored in the row's `elevation` field.
 *
 * Data model quirks handled here:
 * - Pins belong to a GREEN row (greenId), not a hole. Pin placement needs
 *   the green for the selected hole; `greenForHole` resolves it.
 * - Pin set-active is exclusive per green — `setPinActive` refetches the
 *   green's pins so the store reflects the flipped exclusivity.
 * - Tees and aim points are ordered per hole (sortOrder + reorder).
 *
 * DI singleton. `load()` is cached per courseId.
 */
export class FurnitureService {
    readonly tees = new EntityStore<Tee>();
    readonly pins = new EntityStore<Pin>();
    readonly aims = new EntityStore<AimPoint>();
    /** Greens keyed by hole id (one row per hole). Not an EntityStore — no version churn here beyond ours. */
    readonly greens = new Signal<Green[]>([]);

    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    readonly saving = new Signal(false);
    readonly saveError = new Signal<RequestError | null>(null);

    /** Armed placement kind (null = select mode). */
    readonly placing = new Signal<PlacementKind>(null);
    /** Pending attributes for the next placed tee. */
    readonly pendingTeeName = new Signal('');
    readonly pendingTeeColor = new Signal<TeeColor>('white');
    /** Pending attributes for the next placed pin. */
    readonly pendingPinName = new Signal('');
    readonly pendingPinDifficulty = new Signal<PinDifficulty>('medium');
    /** Which green point the tool places when armed to 'green'. */
    readonly pendingGreenPoint = new Signal<GreenPoint>('center');

    /** Current selection (discriminated). */
    readonly selection = new Signal<Selection>(null);

    /**
     * Course-level "active teebox" that anchors each hole's aim polyline
     * (tee → aims → green). Sticky across holes BY TEE NAME: pick 'Yellow' on
     * one hole and every other hole's line draws from its Yellow tee too,
     * falling back to the hole's first tee (by sortOrder) when that name
     * doesn't exist on the hole. `null` = default (always first by sortOrder).
     *
     * Client-side only — NOT persisted (a future hole-info panel drives this
     * signal; resets to null on reload). Kept here so the overlay can react to
     * it and unit tests can exercise the name→tee resolution + fallback.
     */
    readonly activeTeeName = new Signal<string | null>(null);

    /** Set (or clear with null) the sticky line-origin tee name. */
    setActiveTeeName(name: string | null): void {
        this.activeTeeName.set(name);
    }

    /**
     * Resolve the tee a hole's aim polyline should start from. When
     * `activeTeeName` is set, matches the hole's tee with that name
     * (case-insensitive); otherwise — or when no tee on the hole carries that
     * name — falls back to the hole's first tee by sortOrder. Null when the
     * hole has no tees.
     */
    lineOriginTee(holeId: string): Tee | null {
        const holeTees = this.teesForHole(holeId);
        if (holeTees.length === 0) return null;
        const name = this.activeTeeName.get();
        if (name !== null) {
            const wanted = name.trim().toLowerCase();
            const match = holeTees.find(t => t.name.trim().toLowerCase() === wanted);
            if (match) return match;
        }
        return holeTees[0] ?? null;
    }

    /**
     * Human-readable notice shown in the panel (e.g. a duplicate tee-name
     * clash). Transient — cleared on the next successful placement or arm.
     */
    readonly notice = new Signal<string | null>(null);

    private loadedCourseId: string | null = null;

    readonly selectedTee = new Computed<Tee | null>(() => {
        const sel = this.selection.get();
        if (sel?.kind !== 'tee') return null;
        return this.tees.items.get().find(t => t.id === sel.id) ?? null;
    });
    readonly selectedPin = new Computed<Pin | null>(() => {
        const sel = this.selection.get();
        if (sel?.kind !== 'pin') return null;
        return this.pins.items.get().find(p => p.id === sel.id) ?? null;
    });
    readonly selectedAim = new Computed<AimPoint | null>(() => {
        const sel = this.selection.get();
        if (sel?.kind !== 'aim') return null;
        return this.aims.items.get().find(a => a.id === sel.id) ?? null;
    });
    /** The selected green point (row + which point), or null. */
    readonly selectedGreen = new Computed<{ green: Green; point: GreenPoint } | null>(() => {
        const sel = this.selection.get();
        if (sel?.kind !== 'green') return null;
        const green = this.greens.get().find(g => g.holeId === sel.holeId) ?? null;
        return green ? { green, point: sel.point } : null;
    });

    constructor(
        private teesApi: TeesApi = api.tees,
        private greensApi: GreensApi = api.greens,
        private pinsApi: PinsApi = api.pins,
        private aimPointsApi: AimPointsApi = api.aimPoints,
        private elevation: ElevationSampler = NULL_ELEVATION,
    ) {}

    /**
     * Bind the live elevation sampler (ElevationService). The DI singleton is
     * constructed with the null sampler; the tool wires the real one in
     * `attach` from ctx.elevation so placement/move auto-sampling works.
     */
    useElevation(sampler: ElevationSampler): void {
        this.elevation = sampler;
    }

    // ── Loading ───────────────────────────────────────────────────────────

    /**
     * Load all furniture for a course. Tees and pins have by-course
     * endpoints; aim points and greens are per-hole, so we fan out over the
     * holes passed in. Cached per courseId.
     */
    async load(courseId: string, holeIds: string[]): Promise<void> {
        if (this.loadedCourseId === courseId) return;
        this.selection.set(null);
        this.activeTeeName.set(null); // client-side line-origin is per-session, not persisted
        const data = await request(this.loading, this.error, async () => {
            const [tees, pins, perHole] = await Promise.all([
                this.teesApi.listByCourse({ courseId }),
                this.pinsApi.listByCourse({ courseId }),
                Promise.all(
                    holeIds.map(async holeId => ({
                        holeId,
                        aims: await this.aimPointsApi.listByHole({ holeId }),
                        green: await this.greensApi.getByHole({ holeId }),
                    })),
                ),
            ]);
            return { tees, pins, perHole };
        });
        if (!data) return;
        this.tees.set(sortBySortOrder(data.tees));
        this.pins.set(data.pins);
        this.aims.set(data.perHole.flatMap(h => sortBySortOrder(h.aims)));
        this.greens.set(data.perHole.map(h => h.green).filter((g): g is Green => g !== null));
        this.loadedCourseId = courseId;
    }

    /** Re-fetch the loaded course (store re-sync after a failed save). */
    async reload(holeIds: string[]): Promise<void> {
        const courseId = this.loadedCourseId;
        if (!courseId) return;
        this.loadedCourseId = null;
        await this.load(courseId, holeIds);
    }

    // ── Selection / placement state machine ────────────────────────────────

    /** Arm placement of `kind`, dropping any current selection. Toggles off if already armed. */
    arm(kind: Exclude<PlacementKind, null>): void {
        this.notice.set(null);
        if (this.placing.peek() === kind) {
            this.placing.set(null);
            return;
        }
        this.selection.set(null);
        this.placing.set(kind);
    }

    /** Leave placement mode. */
    disarm(): void {
        this.placing.set(null);
    }

    select(selection: Selection): void {
        this.placing.set(null);
        this.notice.set(null);
        this.selection.set(selection);
    }

    // ── Tee-name presets / duplicate handling ──────────────────────────────

    /** True when a tee with this name already exists on the hole. */
    teeNameTaken(holeId: string, name: string): boolean {
        const n = name.trim().toLowerCase();
        return this.tees.items.peek().some(t => t.holeId === holeId && t.name.trim().toLowerCase() === n);
    }

    /**
     * Advance `pendingTeeColor` / `pendingTeeName` to the next colour preset
     * whose default name is still free on the hole. Returns true if it moved
     * to a free preset, false when every preset is taken.
     */
    advancePendingTee(holeId: string): boolean {
        const start = TEE_COLORS.indexOf(this.pendingTeeColor.peek() as TeeColor);
        for (let i = 1; i <= TEE_COLORS.length; i++) {
            const color = TEE_COLORS[(Math.max(start, 0) + i) % TEE_COLORS.length];
            const name = defaultTeeName(color);
            if (!this.teeNameTaken(holeId, name)) {
                this.pendingTeeColor.set(color);
                this.pendingTeeName.set('');
                return true;
            }
        }
        return false;
    }

    // ── Green lookup ───────────────────────────────────────────────────────

    /** The green row for a hole, or null (no green imported/drawn yet). */
    greenForHole(holeId: string): Green | null {
        return this.greens.get().find(g => g.holeId === holeId) ?? null;
    }

    /** Position of a green point (center/front/back), or null when unset. */
    greenPointPos(green: Green, point: GreenPoint): { lat: number; lon: number } | null {
        if (point === 'center') return { lat: green.centerLat, lon: green.centerLon };
        if (point === 'front') {
            return green.frontLat !== null && green.frontLon !== null
                ? { lat: green.frontLat, lon: green.frontLon } : null;
        }
        return green.backLat !== null && green.backLon !== null
            ? { lat: green.backLat, lon: green.backLon } : null;
    }

    /** Which of a hole's green points exist (for the panel summary). */
    greenPointStatus(holeId: string): { center: boolean; front: boolean; back: boolean } | null {
        const g = this.greenForHole(holeId);
        if (!g) return null;
        return {
            center: true, // a row always has a center (create requires it)
            front: g.frontLat !== null && g.frontLon !== null,
            back: g.backLat !== null && g.backLon !== null,
        };
    }

    // ── Elevation ──────────────────────────────────────────────────────────

    /** Sample elevation at a position; undefined when unavailable (so it's omitted from the payload). */
    private async sampleElevation(lat: number, lon: number): Promise<number | undefined> {
        const e = await this.elevation.elevationAt({ lng: lon, lat });
        return e === null ? undefined : e;
    }

    // ── Tee CRUD ───────────────────────────────────────────────────────────

    async createTee(input: { holeId: string; name: string; color: string; lat: number; lon: number }): Promise<Tee | undefined> {
        if (!this.loadedCourseId) return undefined;
        const elevation = await this.sampleElevation(input.lat, input.lon);
        const created = await request(this.saving, this.saveError, () =>
            this.teesApi.create({ ...input, ...(elevation !== undefined ? { elevation } : {}) }));
        if (created) {
            this.tees.add(created);
            this.selection.set({ kind: 'tee', id: created.id });
        }
        return created;
    }

    /** Move a tee (re-samples elevation). Local patch first for instant feedback. */
    async moveTee(id: string, lat: number, lon: number): Promise<Tee | undefined> {
        const current = this.tees.items.peek().find(t => t.id === id);
        if (!current) return undefined;
        this.tees.patch({ ...current, lat, lon });
        const elevation = await this.sampleElevation(lat, lon);
        const result = await request(this.saving, this.saveError, () =>
            this.tees.mutate(id, version => this.teesApi.update({ id, version: version!, lat, lon, ...(elevation !== undefined ? { elevation } : {}) })));
        if (result === undefined) await this.reloadHoleIds();
        return result;
    }

    async updateTee(id: string, patch: { name?: string; color?: string }): Promise<Tee | undefined> {
        const result = await request(this.saving, this.saveError, () =>
            this.tees.mutate(id, version => this.teesApi.update({ id, version: version!, ...patch })));
        if (result === undefined) await this.reloadHoleIds();
        return result;
    }

    async removeTee(id: string): Promise<boolean> {
        const current = this.tees.items.peek().find(t => t.id === id);
        if (!current) return false;
        const result = await request(this.saving, this.saveError, () =>
            this.teesApi.remove({ id, version: current.version }));
        if (result === undefined) { await this.reloadHoleIds(); return false; }
        this.tees.remove(id);
        this.clearSelectionIf('tee', id);
        // If the deleted tee was the sticky line-origin and no tee by that name
        // survives anywhere on the course, drop back to the default (first by
        // sortOrder) by clearing the stale active-tee entry.
        const active = this.activeTeeName.peek();
        if (active !== null) {
            const wanted = active.trim().toLowerCase();
            const stillExists = this.tees.items.peek().some(t => t.name.trim().toLowerCase() === wanted);
            if (!stillExists) this.activeTeeName.set(null);
        }
        return true;
    }

    /** Reorder tees within a hole (up/down in the panel). */
    async reorderTees(holeId: string, orderedIds: string[]): Promise<boolean> {
        const result = await request(this.saving, this.saveError, () =>
            this.teesApi.reorder({ holeId, orderedIds }));
        if (result === undefined) { await this.reloadHoleIds(); return false; }
        this.applySortOrder(this.tees, holeId, orderedIds);
        return true;
    }

    // ── Pin CRUD (per green, set-active exclusivity) ───────────────────────

    async createPin(input: { greenId: string; name: string; difficulty: string; lat: number; lon: number }): Promise<Pin | undefined> {
        const created = await request(this.saving, this.saveError, () =>
            this.pinsApi.create(input));
        if (created) {
            this.pins.add(created);
            this.selection.set({ kind: 'pin', id: created.id });
        }
        return created;
    }

    async movePin(id: string, lat: number, lon: number): Promise<Pin | undefined> {
        const current = this.pins.items.peek().find(p => p.id === id);
        if (!current) return undefined;
        this.pins.patch({ ...current, lat, lon });
        const result = await request(this.saving, this.saveError, () =>
            this.pins.mutate(id, version => this.pinsApi.update({ id, version: version!, lat, lon })));
        if (result === undefined) await this.reloadHoleIds();
        return result;
    }

    async updatePin(id: string, patch: { name?: string; difficulty?: string }): Promise<Pin | undefined> {
        const result = await request(this.saving, this.saveError, () =>
            this.pins.mutate(id, version => this.pinsApi.update({ id, version: version!, ...patch })));
        if (result === undefined) await this.reloadHoleIds();
        return result;
    }

    async removePin(id: string): Promise<boolean> {
        const current = this.pins.items.peek().find(p => p.id === id);
        if (!current) return false;
        const result = await request(this.saving, this.saveError, () =>
            this.pinsApi.remove({ id, version: current.version }));
        if (result === undefined) { await this.reloadHoleIds(); return false; }
        this.pins.remove(id);
        this.clearSelectionIf('pin', id);
        return true;
    }

    /**
     * Make a pin the active one for its green. Set-active is exclusive, so
     * after the server flips it we refetch the green's pins to reflect the
     * others being deactivated.
     */
    async setPinActive(id: string): Promise<boolean> {
        const current = this.pins.items.peek().find(p => p.id === id);
        if (!current) return false;
        const updated = await request(this.saving, this.saveError, () =>
            this.pinsApi.setActive({ id, version: current.version }));
        if (updated === undefined) { await this.reloadHoleIds(); return false; }
        // Refetch the green's pins to pick up the exclusivity change.
        const fresh = await request(this.saving, this.saveError, () =>
            this.pinsApi.listByGreen({ greenId: current.greenId }));
        if (fresh) {
            const others = this.pins.items.peek().filter(p => p.greenId !== current.greenId);
            this.pins.set([...others, ...fresh]);
        } else {
            this.pins.patch(updated);
        }
        return true;
    }

    // ── Aim-point CRUD (ordered per hole) ──────────────────────────────────

    async createAim(input: { holeId: string; lat: number; lon: number; label?: string }): Promise<AimPoint | undefined> {
        if (!this.loadedCourseId) return undefined;
        const elevation = await this.sampleElevation(input.lat, input.lon);
        const created = await request(this.saving, this.saveError, () =>
            this.aimPointsApi.create({ ...input, ...(elevation !== undefined ? { elevation } : {}) }));
        if (created) {
            this.aims.add(created);
            this.selection.set({ kind: 'aim', id: created.id });
        }
        return created;
    }

    async moveAim(id: string, lat: number, lon: number): Promise<AimPoint | undefined> {
        const current = this.aims.items.peek().find(a => a.id === id);
        if (!current) return undefined;
        this.aims.patch({ ...current, lat, lon });
        const elevation = await this.sampleElevation(lat, lon);
        const result = await request(this.saving, this.saveError, () =>
            this.aims.mutate(id, version => this.aimPointsApi.update({ id, version: version!, lat, lon, ...(elevation !== undefined ? { elevation } : {}) })));
        if (result === undefined) await this.reloadHoleIds();
        return result;
    }

    async removeAim(id: string): Promise<boolean> {
        const current = this.aims.items.peek().find(a => a.id === id);
        if (!current) return false;
        const result = await request(this.saving, this.saveError, () =>
            this.aimPointsApi.remove({ id, version: current.version }));
        if (result === undefined) { await this.reloadHoleIds(); return false; }
        this.aims.remove(id);
        this.clearSelectionIf('aim', id);
        return true;
    }

    /** Reorder aim points within a hole (up/down in the panel). */
    async reorderAims(holeId: string, orderedIds: string[]): Promise<boolean> {
        const result = await request(this.saving, this.saveError, () =>
            this.aimPointsApi.reorder({ holeId, orderedIds }));
        if (result === undefined) { await this.reloadHoleIds(); return false; }
        this.applySortOrder(this.aims, holeId, orderedIds);
        return true;
    }

    // ── Green-point CRUD (one row per hole; C mandatory, F/B nullable) ──────

    /**
     * Set a green point (center/front/back) on a hole to a WGS84 position.
     * Re-samples elevation (a green has a single shared elevation field).
     *
     * If the hole has no green row yet, one is CREATED. The server's
     * greens/create requires a center, so:
     * - placing Center on a green-less hole creates the row with that center;
     * - placing Front/Back on a green-less hole is rejected (returns null with
     *   a notice) — the caller/panel must require Center first.
     * When the row exists, this is an UPDATE (optimistic version); placing an
     * already-set point simply moves it.
     */
    async setGreenPoint(holeId: string, point: GreenPoint, lat: number, lon: number): Promise<Green | undefined> {
        const existing = this.greenForHole(holeId);
        const elevation = await this.sampleElevation(lat, lon);

        if (!existing) {
            if (point !== 'center') {
                this.notice.set('This hole has no green yet — place the green Center first.');
                return undefined;
            }
            const created = await request(this.saving, this.saveError, () =>
                this.greensApi.create({
                    holeId, centerLat: lat, centerLon: lon,
                    ...(elevation !== undefined ? { elevation } : {}),
                }));
            if (created) {
                this.greens.set([...this.greens.peek(), created]);
                this.selection.set({ kind: 'green', holeId, point: 'center' });
            }
            return created;
        }

        // Optimistic local patch for instant feedback, then persist an update.
        const fields = greenPointFields(point, lat, lon);
        this.patchGreen({ ...existing, ...fields, ...(elevation !== undefined ? { elevation } : {}) });
        const result = await request(this.saving, this.saveError, () =>
            this.greensApi.update({
                id: existing.id, version: existing.version,
                ...fields, ...(elevation !== undefined ? { elevation } : {}),
            }));
        if (result === undefined) { await this.reloadHoleIds(); return undefined; }
        this.patchGreen(result);
        this.selection.set({ kind: 'green', holeId, point });
        return result;
    }

    /** Replace a green row in the signal by holeId (no EntityStore here). */
    private patchGreen(green: Green): void {
        this.greens.set(this.greens.peek().map(g => g.holeId === green.holeId ? green : g));
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    /** Ordered aim points for a hole (by sortOrder). */
    aimsForHole(holeId: string): AimPoint[] {
        return sortBySortOrder(this.aims.items.get().filter(a => a.holeId === holeId));
    }

    /** Ordered tees for a hole (by sortOrder). */
    teesForHole(holeId: string): Tee[] {
        return sortBySortOrder(this.tees.items.get().filter(t => t.holeId === holeId));
    }

    /** Pins for a hole (via its green), or [] when the hole has no green. */
    pinsForHole(holeId: string): Pin[] {
        const green = this.greenForHole(holeId);
        if (!green) return [];
        return this.pins.items.get().filter(p => p.greenId === green.id);
    }

    private clearSelectionIf(kind: 'tee' | 'pin' | 'aim', id: string): void {
        const sel = this.selection.peek();
        if (sel && sel.kind === kind && sel.id === id) this.selection.set(null);
    }

    /** Re-sync stores after a save conflict — needs the hole set, which we cached. */
    private async reloadHoleIds(): Promise<void> {
        await this.reload(this.cachedHoleIds);
    }
    private cachedHoleIds: string[] = [];
    /** Called by load() consumers so conflict re-syncs know the hole set. */
    setHoleIds(holeIds: string[]): void {
        this.cachedHoleIds = holeIds;
    }

    /** Apply a new ordering locally by rewriting sortOrder on the affected rows. */
    private applySortOrder<T extends { id: string; holeId: string; sortOrder: number }>(
        store: EntityStore<T>,
        holeId: string,
        orderedIds: string[],
    ): void {
        orderedIds.forEach((id, i) => {
            const row = store.items.peek().find(r => r.id === id && r.holeId === holeId);
            if (row) store.patch({ ...row, sortOrder: i });
        });
    }
}

function sortBySortOrder<T extends { sortOrder: number }>(rows: T[]): T[] {
    return [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Default tee name for a colour preset (e.g. 'blue' → 'Blue'). */
export function defaultTeeName(color: string): string {
    return color.charAt(0).toUpperCase() + color.slice(1);
}

/** Map a green point to its lat/lon update fields (center_lat pair etc.). */
export function greenPointFields(point: GreenPoint, lat: number, lon: number):
    { centerLat: number; centerLon: number }
    | { frontLat: number; frontLon: number }
    | { backLat: number; backLon: number } {
    if (point === 'center') return { centerLat: lat, centerLon: lon };
    if (point === 'front') return { frontLat: lat, frontLon: lon };
    return { backLat: lat, backLon: lon };
}
