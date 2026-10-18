// Snapshot-based undo/redo history for the course-feature editor.
//
// Every committed edit pushes ONE HistoryEntry — an array of per-feature
// diffs so bulk operations (multi-move, bulk delete, duplicate of many)
// undo/redo atomically as a single step. Drags follow the prototype's
// visual-vs-commit split: per-frame feedback renders as a ghost overlay
// (no store writes, no history), one entry is pushed on commit
// (mouseup/autosave).
//
// Because edits autosave to the server, undo/redo are themselves server
// mutations replayed through the FeaturesService batch funnels (updateMany /
// createMany / removeMany). The store is the single source of truth and
// optimistic-lock versions are read from it when each request is sent, so
// entries never go stale version-wise. `beforeVersion` is recorded for
// diagnostics/tests, not for applying.
//
// Special cases:
// - Undoing a DELETE re-creates the feature — the server assigns a NEW id,
//   so the old id is remapped across BOTH stacks (any other entry touching
//   that feature follows the rename).
// - Any failed application (version conflict from an external writer,
//   network error) drops BOTH stacks and sets `notice`; FeaturesService
//   already re-syncs the store from the server on save failures, so the
//   editor converges on server truth with an empty history.

import { Signal, Computed } from '@basics/core/client/core';
import type { FeatureGeometry } from '../geo/bezier';
import { batched, type FeaturesService, type FeatureAttributesPatch } from './features.service';
import type { CourseFeature } from '../../../shared/api/course-features.gen';
import { isRoughsLayerType, type FeatureLayer } from '../../../shared/render/stack-key';

/** Everything undo/redo restores about a feature. */
interface FeatureSnapshot {
    /** Opt-in insertion position for operations with an explicit stack location. */
    sortOrder?: number;
    /** Stable next sibling for replay after deletions leave numeric gaps. */
    insertBeforeId?: string;
    geometry: FeatureGeometry;
    type: string;
    holeId: string | null;
    /**
     * Absent on the geometry-only snapshots the draw tool builds by hand: an
     * update then leaves the feature's layer alone.
     */
    layer?: FeatureLayer;
    /** Opt-in attribute snapshots for edits that restore their settings. */
    attributes?: FeatureAttributesPatch | null;
}

/**
 * The layer a snapshot restores to. A retype out of the rough types leaves
 * the Roughs layer server-side, so a snapshot pairing the old layer with the
 * new type (`{ ...snapshotOf(f), type }`) means course-level.
 */
function layerOf(snapshot: FeatureSnapshot): FeatureLayer | undefined {
    if (snapshot.layer === undefined) return undefined;
    return isRoughsLayerType(snapshot.type) ? snapshot.layer : null;
}

/**
 * One feature's change inside a history entry. `before: null` = the op
 * created the feature; `after: null` = the op deleted it; both set = an
 * update (geometry and/or type/holeId).
 */
interface FeatureDiff {
    featureId: string;
    before: FeatureSnapshot | null;
    after: FeatureSnapshot | null;
    /** The feature's optimistic-lock version before the op (null on create). */
    beforeVersion: number | null;
}

/** One undoable step: all feature diffs of a single user action. */
export type HistoryEntry = FeatureDiff[];

/** Maximum retained entries (oldest dropped first) — prototype value. */
export const MAX_HISTORY = 100;

/** Snapshot the restorable fields of a feature. */
export function snapshotOf(feature: CourseFeature): FeatureSnapshot {
    return { geometry: feature.geometry, type: feature.type, holeId: feature.holeId, layer: feature.layer ?? null };
}

export class EditHistory {
    private undoStack = new Signal<HistoryEntry[]>([]);
    private redoStack = new Signal<HistoryEntry[]>([]);
    /** Prevents concurrent undo/redo applications interleaving. */
    private applying = false;

    readonly canUndo = new Computed(() => this.undoStack.get().length > 0);
    readonly canRedo = new Computed(() => this.redoStack.get().length > 0);
    /** One-line panel notice (set when the history is dropped on conflict). */
    readonly notice = new Signal<string | null>(null);

    /** The entry the next undo takes back (a tool that pushed one can tell whether it is still on top). */
    lastEntry(): HistoryEntry | undefined {
        const stack = this.undoStack.peek();
        return stack[stack.length - 1];
    }

    /** Record a committed edit. Clears the redo stack (linear history). */
    push(entry: HistoryEntry): void {
        if (entry.length === 0) return;
        this.notice.set(null);
        this.redoStack.set([]);
        this.undoStack.update(stack => {
            const next = [...stack, entry];
            return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
        });
    }

    /** Drop both stacks (course switch, save conflict). */
    clear(): void {
        this.undoStack.set([]);
        this.redoStack.set([]);
    }

    /** Undo the most recent entry by replaying its inverse via `features`. */
    async undo(features: FeaturesService): Promise<boolean> {
        if (this.applying) return false;
        const stack = this.undoStack.peek();
        const entry = stack[stack.length - 1];
        if (!entry) return false;
        this.undoStack.set(stack.slice(0, -1));
        const ok = await this.apply(features, entry, 'undo');
        if (ok) this.redoStack.update(s => [...s, entry]);
        return ok;
    }

    /** Re-apply the most recently undone entry. */
    async redo(features: FeaturesService): Promise<boolean> {
        if (this.applying) return false;
        const stack = this.redoStack.peek();
        const entry = stack[stack.length - 1];
        if (!entry) return false;
        this.redoStack.set(stack.slice(0, -1));
        const ok = await this.apply(features, entry, 'redo');
        if (ok) this.undoStack.update(s => [...s, entry]);
        return ok;
    }

    /**
     * Apply one entry in the given direction: undo restores each diff's
     * `before` state, redo its `after`. Deletes and updates land in the
     * store first, in one `batch()` (one overlay push), then go out as one
     * `removeMany` and one `updateMany` request. Re-creations wait for the
     * server (it assigns the ids) and go out as one `createMany`.
     */
    private async apply(features: FeaturesService, entry: HistoryEntry, direction: 'undo' | 'redo'): Promise<boolean> {
        this.applying = true;
        try {
            const diffs = direction === 'undo' ? [...entry].reverse() : entry;
            const removes: string[] = [];
            const updates: { id: string; patch: FeatureSnapshot }[] = [];
            const creates: { diff: FeatureDiff; target: FeatureSnapshot }[] = [];
            for (const diff of diffs) {
                const target = direction === 'undo' ? diff.before : diff.after;
                const source = direction === 'undo' ? diff.after : diff.before;
                if (target === null) removes.push(diff.featureId); // undo of create / redo of delete
                else if (source === null) creates.push({ diff, target }); // undo of delete / redo of create
                else updates.push({ id: diff.featureId, patch: { ...target, layer: layerOf(target) } });
            }

            const sent: { removed?: Promise<boolean>; updated?: Promise<unknown[] | undefined> } = {};
            batched(() => {
                if (removes.length > 0) sent.removed = features.removeMany(removes);
                if (updates.length > 0) sent.updated = features.updateMany(updates, { local: true });
            });
            if (sent.removed && !(await sent.removed)) return this.dropOnConflict();
            if (sent.updated && !(await sent.updated)) return this.dropOnConflict();

            if (creates.length > 0) {
                // Restore explicit slots bottom first so later creates do not
                // shift already restored features away from their saved slot.
                creates.sort((a, b) => (a.target.sortOrder ?? Infinity) - (b.target.sortOrder ?? Infinity));
                const positions = new Map(features.store.items.peek().map(f => [f.id, f.sortOrder]));
                const inputs = creates.map(c => {
                    const sortOrder = (c.target.insertBeforeId ? positions.get(c.target.insertBeforeId) : undefined) ?? c.target.sortOrder;
                    if (sortOrder !== undefined) {
                        for (const row of features.stackFor({ holeId: c.target.holeId, layer: layerOf(c.target) ?? null })) {
                            const position = positions.get(row.id)!;
                            if (position >= sortOrder) positions.set(row.id, position + 1);
                        }
                    }
                    return {
                        type: c.target.type,
                        sortOrder,
                        holeId: c.target.holeId,
                        layer: layerOf(c.target),
                        geometry: c.target.geometry,
                        attributes: c.target.attributes,
                    };
                });
                const created = await features.createMany(inputs);
                if (!created) return this.dropOnConflict();
                // The server assigns fresh ids: rename across both stacks AND
                // this in-flight entry (it is off-stack while applying,
                // re-pushed after).
                creates.forEach((c, i) => {
                    const newId = created[i]!.id;
                    this.remapId(c.diff.featureId, newId);
                    c.diff.featureId = newId;
                });
            }
            return true;
        } finally {
            this.applying = false;
        }
    }

    /** Rename a feature id across both stacks (delete-undo re-creation). */
    private remapId(oldId: string, newId: string): void {
        const snapshot = (value: FeatureSnapshot | null): FeatureSnapshot | null =>
            value?.insertBeforeId === oldId ? { ...value, insertBeforeId: newId } : value;
        const remap = (stack: HistoryEntry[]): HistoryEntry[] =>
            stack.map(entry => entry.map(diff => ({
                ...diff,
                featureId: diff.featureId === oldId ? newId : diff.featureId,
                before: snapshot(diff.before),
                after: snapshot(diff.after),
            })));
        this.undoStack.update(remap);
        this.redoStack.update(remap);
    }

    private dropOnConflict(): false {
        this.clear();
        this.notice.set('Edit history dropped — the server rejected a change (version conflict). The editor re-synced to server state.');
        return false;
    }
}
