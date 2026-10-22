import { Signal, Computed, batch } from '@basics/core/client/core';
import { EntityStore } from '@basics/core/client/entity-store';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { Tee, TeesApi } from '../../../shared/api/tees.gen';
import type { TeeSet, TeeSetsApi } from '../../../shared/api/tee-sets.gen';
import type { Green, GreensApi } from '../../../shared/api/greens.gen';
import type { Pin, PinsApi } from '../../../shared/api/pins.gen';
import type { AimPoint, AimPointsApi } from '../../../shared/api/aim-points.gen';

/** Interaction-claim id AND overlay id prefix for the furniture tool. */
export const FURNITURE_TOOL_ID = 'furniture';

/** What kind of item the tool is armed to place, or null (select mode). */
export type PlacementKind = 'tee' | 'pin' | 'aim' | 'green' | null;

/** Which point of a green row (one row per hole holds all three). */
export type GreenPoint = 'center' | 'front' | 'back';

/** What can change on a tee set (`TeeSetsApi.update` without id and version). */
export type TeeSetPatch = Omit<Parameters<TeeSetsApi['update']>[0], 'id' | 'version'>;

/** Tee colour presets (the ones the renderer has a fill for, `teeFill`). */
export const TEE_COLORS = ['black', 'white', 'green', 'blue', 'yellow', 'red'] as const;
export type TeeColor = (typeof TEE_COLORS)[number];

/**
 * The pin positions a green has, by name: GreenKeeper and GSPro keep exactly
 * four per hole, one per tournament day, and the GKD export (`gspro.py gkd`)
 * puts a pin named after a day on that day.
 */
export const PIN_DAYS = ['Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export type PinDay = (typeof PIN_DAYS)[number];

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
    /**
     * The course's tee sets (name, colour, men's and women's rating and
     * slope), in order. A hole's tee belongs to one and takes its name and
     * colour from it.
     */
    readonly teeSets = new Signal<TeeSet[]>([]);
    /** The set the next placed tee goes on (null = the course's first). */
    readonly pendingTeeSetId = new Signal<string | null>(null);
    /** Pending attributes for the next placed pin. */
    readonly pendingPinDay = new Signal<PinDay>('Thursday');
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
        private teeSetsApi: TeeSetsApi = api.teeSets,
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
        await this.fetchAndApply(courseId, holeIds);
    }

    /** Re-fetch the loaded course (store re-sync after a failed save). */
    async reload(holeIds: string[]): Promise<void> {
        const courseId = this.loadedCourseId;
        if (!courseId) return;
        this.activeTeeName.set(null); // client-side line-origin is per-session, not persisted
        await this.fetchAndApply(courseId, holeIds);
    }

    private async fetchAndApply(courseId: string, holeIds: string[]): Promise<void> {
        this.selection.set(null);
        const data = await request(this.loading, this.error, async () => {
            // The sets first: listing them adopts tees written without one.
            const teeSets = await this.teeSetsApi.listByCourse({ courseId });
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
            return { teeSets, tees, pins, perHole };
        });
        if (!data) return;
        // Apply all four furniture signals atomically so downstream effects
        // (the overlay geojson build, hole framing) see a complete set in one
        // pass instead of rebuilding on each partial intermediate state.
        batch(() => {
            this.teeSets.set(data.teeSets);
            this.tees.set(sortBySortOrder(data.tees));
            this.pins.set(data.pins);
            this.aims.set(data.perHole.flatMap(h => sortBySortOrder(h.aims)));
            this.greens.set(data.perHole.map(h => h.green).filter((g): g is Green => g !== null));
        });
        this.loadedCourseId = courseId;
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

    /**
     * Select a pin the way the Pin panel shows one: pin placement armed on
     * that pin's day. The panel's day buttons are the one place a pin is
     * picked and read, so a pin picked on the map lands there too.
     */
    focusPin(id: string): void {
        const pin = this.pins.items.peek().find(p => p.id === id);
        if (!pin) return;
        this.notice.set(null);
        this.placing.set('pin');
        const day = PIN_DAYS.find(d => d.toLowerCase() === pin.name.trim().toLowerCase());
        if (day) this.pendingPinDay.set(day);
        this.selection.set({ kind: 'pin', id });
    }

    // ── Tee-name presets / duplicate handling ──────────────────────────────

    /** True when a tee with this name already exists on the hole. */
    teeNameTaken(holeId: string, name: string): boolean {
        const n = name.trim().toLowerCase();
        return this.tees.items.peek().some(t => t.holeId === holeId && t.name.trim().toLowerCase() === n);
    }

    /** The set the next placed tee goes on: the picked one, else the course's first; null without any. */
    pendingTeeSet(): TeeSet | null {
        const sets = this.teeSets.get();
        return sets.find(s => s.id === this.pendingTeeSetId.get()) ?? sets[0] ?? null;
    }

    /**
     * Advance the pending tee set to the next one (in the course's order)
     * the hole has no tee of. Returns true if it moved to a free set, false
     * when the hole has every set.
     */
    advancePendingTee(holeId: string): boolean {
        const sets = this.teeSets.peek();
        const start = Math.max(sets.findIndex(s => s.id === this.pendingTeeSet()?.id), 0);
        for (let i = 1; i <= sets.length; i++) {
            const set = sets[(start + i) % sets.length];
            if (!this.teeNameTaken(holeId, set.name)) {
                this.pendingTeeSetId.set(set.id);
                return true;
            }
        }
        return false;
    }

    // ── Tee sets (course level) ────────────────────────────────────────────

    async createTeeSet(name: string, color: string | null): Promise<TeeSet | undefined> {
        const courseId = this.loadedCourseId;
        if (!courseId) return undefined;
        const created = await request(this.saving, this.saveError, () =>
            this.teeSetsApi.create({ courseId, name, color }));
        if (created) {
            this.teeSets.set([...this.teeSets.peek(), created]);
            this.pendingTeeSetId.set(created.id);
        }
        return created;
    }

    /**
     * Change a set. A new name, colour or GSPro-only mark is on its tees too,
     * so those are re-read; a GSPro tee taken from another set changed that
     * set as well, so the sets are.
     */
    async updateTeeSet(id: string, patch: TeeSetPatch): Promise<TeeSet | undefined> {
        const current = this.teeSets.peek().find(s => s.id === id);
        const courseId = this.loadedCourseId;
        if (!current || !courseId) return undefined;
        const updated = await request(this.saving, this.saveError, () =>
            this.teeSetsApi.update({ id, version: current.version, ...patch }));
        if (!updated) return undefined;
        this.teeSets.set(this.teeSets.peek().map(s => (s.id === id ? updated : s)));
        if (updated.gsproTee && updated.gsproTee !== current.gsproTee) {
            const sets = await request(this.loading, this.error, () => this.teeSetsApi.listByCourse({ courseId }));
            if (sets) this.teeSets.set(sets);
        }
        if (updated.name !== current.name || updated.color !== current.color || updated.gsproOnly !== current.gsproOnly) {
            const tees = await request(this.loading, this.error, () => this.teesApi.listByCourse({ courseId }));
            if (tees) this.tees.set(sortBySortOrder(tees));
        }
        return updated;
    }

    /** Re-read the sets after something else changed them (ratings read in from a .GKD). */
    async reloadTeeSets(): Promise<void> {
        const courseId = this.loadedCourseId;
        if (!courseId) return;
        const sets = await request(this.loading, this.error, () => this.teeSetsApi.listByCourse({ courseId }));
        if (sets) this.teeSets.set(sets);
    }

    /** Remove a set no hole has a tee of (the server refuses otherwise). */
    async removeTeeSet(id: string): Promise<boolean> {
        const current = this.teeSets.peek().find(s => s.id === id);
        if (!current) return false;
        const res = await request(this.saving, this.saveError, () =>
            this.teeSetsApi.remove({ id, version: current.version }));
        if (res === undefined) return false;
        this.teeSets.set(this.teeSets.peek().filter(s => s.id !== id));
        if (this.pendingTeeSetId.peek() === id) this.pendingTeeSetId.set(null);
        return true;
    }

    /** Keep a set's tee count in step with a tee added to or removed from it. */
    private countTee(teeSetId: string | null | undefined, delta: number): void {
        if (!teeSetId) return;
        this.teeSets.set(this.teeSets.peek().map(s => (s.id === teeSetId ? { ...s, teeCount: s.teeCount + delta } : s)));
    }

    // ── Green lookup ───────────────────────────────────────────────────────

    /** The green row for a hole, or null (no green imported/drawn yet). */
    greenForHole(holeId: string): Green | null {
        return this.greens.get().find(g => g.holeId === holeId) ?? null;
    }

    /** Position of a green point (center/front/back), or null when unset. */
    greenPointPos(green: Green, point: GreenPoint): { lat: number; lon: number } | null {
        if (point === 'center') return finiteWgs84Point(green.centerLat, green.centerLon);
        if (point === 'front') return finiteWgs84Point(green.frontLat, green.frontLon);
        return finiteWgs84Point(green.backLat, green.backLon);
    }

    /** Which of a hole's green points exist (for the panel summary). */
    greenPointStatus(holeId: string): { center: boolean; front: boolean; back: boolean } | null {
        const g = this.greenForHole(holeId);
        if (!g) return null;
        return {
            center: true, // a row always has a center (create requires it)
            front: finiteWgs84Point(g.frontLat, g.frontLon) !== null,
            back: finiteWgs84Point(g.backLat, g.backLon) !== null,
        };
    }

    // ── Elevation ──────────────────────────────────────────────────────────

    /** Sample elevation at a position; undefined when unavailable (so it's omitted from the payload). */
    private async sampleElevation(lat: number, lon: number): Promise<number | undefined> {
        const e = await this.elevation.elevationAt({ lng: lon, lat });
        return e === null ? undefined : e;
    }

    // ── Tee CRUD ───────────────────────────────────────────────────────────

    /** Add a tee to a hole, on one of the course's tee sets (it takes the set's name and colour). */
    async createTee(input: { holeId: string; teeSetId?: string; name?: string; color?: string; lat: number; lon: number }): Promise<Tee | undefined> {
        if (!this.loadedCourseId) return undefined;
        const elevation = await this.sampleElevation(input.lat, input.lon);
        const created = await request(this.saving, this.saveError, () =>
            this.teesApi.create({ ...input, ...(elevation !== undefined ? { elevation } : {}) }));
        if (created) {
            this.tees.add(created);
            this.countTee(created.teeSetId, 1);
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
        this.countTee(current.teeSetId, -1);
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

    /** A green's pin for a tournament day (by name, any case), if it has one. */
    pinForDay(greenId: string, day: PinDay): Pin | undefined {
        return this.pins.items.peek().find(p => p.greenId === greenId && p.name.trim().toLowerCase() === day.toLowerCase());
    }

    /**
     * Point the next pin placement at the first day the green has no pin for
     * (left as it is when all four are placed). True when one was free.
     */
    advancePendingPinDay(greenId: string): boolean {
        const free = PIN_DAYS.find(day => !this.pinForDay(greenId, day));
        if (free) this.pendingPinDay.set(free);
        return !!free;
    }

    private clearSelectionIf(kind: 'tee' | 'pin' | 'aim', id: string): void {
        const sel = this.selection.peek();
        if (sel && sel.kind === kind && sel.id === id) this.selection.set(null);
    }

    /** Re-sync stores after a save conflict — needs the hole set, which we cached. */
    private async reloadHoleIds(): Promise<void> {
        await this.reload(this.cachedHoleIds);
    }
    /** Re-read the loaded course's furniture after the server wrote it (Place tees, a scorecard). */
    async refresh(): Promise<void> {
        await this.reloadHoleIds();
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

export function finiteWgs84Point(
    lat: number | null | undefined,
    lon: number | null | undefined,
): { lat: number; lon: number } | null {
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90) return null;
    return { lat, lon };
}
