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
// mutations replayed through the SAME FeaturesService funnels (update /
// create / removeFeature) — the store is the single source of truth and
// optimistic-lock versions are always read live from it (store.mutate), so
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
import type { FeaturesService } from './features.service';
import type { CourseFeature } from '../../../shared/api/course-features.gen';

/** Everything undo/redo restores about a feature. */
export interface FeatureSnapshot {
    geometry: FeatureGeometry;
    type: string;
    holeId: string | null;
}

/**
 * One feature's change inside a history entry. `before: null` = the op
 * created the feature; `after: null` = the op deleted it; both set = an
 * update (geometry and/or type/holeId).
 */
export interface FeatureDiff {
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
    return { geometry: feature.geometry, type: feature.type, holeId: feature.holeId };
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
     * Apply one entry in the given direction. Undo restores each diff's
     * `before` state (reverse order); redo restores `after` (forward
     * order). All server effects go through the FeaturesService funnels.
     */
    private async apply(features: FeaturesService, entry: HistoryEntry, direction: 'undo' | 'redo'): Promise<boolean> {
        this.applying = true;
        try {
            const diffs = direction === 'undo' ? [...entry].reverse() : entry;
            for (const diff of diffs) {
                const target = direction === 'undo' ? diff.before : diff.after;
                if (target === null) {
                    // Inverse is a delete (undo of create / redo of delete).
                    const ok = await features.removeFeature(diff.featureId);
                    if (!ok) return this.dropOnConflict();
                } else if ((direction === 'undo' ? diff.after : diff.before) === null) {
                    // Inverse is a create (undo of delete / redo of create):
                    // the server assigns a fresh id — remap the old one.
                    const created = await features.create({
                        type: target.type,
                        holeId: target.holeId,
                        geometry: target.geometry,
                    });
                    if (!created) return this.dropOnConflict();
                    // Rename across both stacks AND this in-flight entry
                    // (it is off-stack while applying, re-pushed after).
                    this.remapId(diff.featureId, created.id);
                    diff.featureId = created.id;
                } else {
                    const updated = await features.update(diff.featureId, {
                        geometry: target.geometry,
                        type: target.type,
                        holeId: target.holeId,
                    });
                    if (!updated) return this.dropOnConflict();
                }
            }
            return true;
        } finally {
            this.applying = false;
        }
    }

    /** Rename a feature id across both stacks (delete-undo re-creation). */
    private remapId(oldId: string, newId: string): void {
        const remap = (stack: HistoryEntry[]): HistoryEntry[] =>
            stack.map(entry => entry.map(diff =>
                diff.featureId === oldId ? { ...diff, featureId: newId } : diff));
        this.undoStack.update(remap);
        this.redoStack.update(remap);
    }

    private dropOnConflict(): false {
        this.clear();
        this.notice.set('Edit history dropped — the server rejected a change (version conflict). The editor re-synced to server state.');
        return false;
    }
}
