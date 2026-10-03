import type { Signal } from '@basics/core/client/core';
import type { ToolContext } from '../editor/tool';
import type { FeaturesService } from './features.service';
import type { DrawState } from './draw-state';
import { DIGIT_FEATURE_TYPES, type FeatureType } from './feature-palette';
import type { VertexRef } from './draw-hover';

// Keyboard handling of the draw tool: window keydown (claim and input
// guarded), the capture-phase arrow nudge, and the Space hold that drives the
// momentary box-select override. Every action a key triggers is a method on
// the tool, reached through DrawKeysHost.

/** Arrow-key nudge step in screen px (Shift: NUDGE_SHIFT_PX). */
export const NUDGE_PX = 1;
export const NUDGE_SHIFT_PX = 10;

/** Arrow key → screen direction as [right, up] unit steps. */
const ARROW_DIRECTIONS: Record<string, readonly [number, number]> = {
    ArrowRight: [1, 0],
    ArrowLeft: [-1, 0],
    ArrowUp: [0, 1],
    ArrowDown: [0, -1],
};

/** Stack-reorder keys (D27). */
export type ReorderKey = 'PageUp' | 'PageDown' | 'Home' | 'End';

/** What the key handlers read on the draw tool and the actions they call. */
export interface DrawKeysHost {
    readonly state: DrawState;
    readonly features: FeaturesService | null;
    readonly vertexSelection: Signal<ReadonlySet<string>>;
    readonly hoverVertex: Signal<VertexRef | null>;
    /** Space held: momentary box-select override. */
    readonly spaceHeld: Signal<boolean>;
    /** True while a vertex drag or a whole-selection move is live. */
    readonly dragging: boolean;
    /** True while the draw tool holds the map interaction claim. */
    isMyClaim(): boolean;
    undo(): void;
    redo(): void;
    duplicateSelection(): void;
    closeDraft(): void;
    deleteSelectedVertices(): void;
    deleteSelected(): Promise<void>;
    insertBetweenSelectedVertices(): void;
    armDraw(): void;
    toggleHoveredVertexCorner(): void;
    reorderSelected(key: ReorderKey): Promise<void>;
    chooseType(type: FeatureType): void;
    nudgeSelectedVertices(key: string, px: number): boolean;
}

/**
 * Screen direction of an arrow `key` as a unit EPSG:3006 vector at map
 * `bearingDeg`, or null for any other key. Screen up points along the
 * bearing; screen right is 90° clockwise of it. Pure.
 */
export function nudgeDirection(key: string, bearingDeg: number): { east: number; north: number } | null {
    const dir = ARROW_DIRECTIONS[key];
    if (!dir) return null;
    const bearing = (bearingDeg * Math.PI) / 180;
    const [right, up] = dir;
    return {
        east: right * Math.cos(bearing) + up * Math.sin(bearing),
        north: up * Math.cos(bearing) - right * Math.sin(bearing),
    };
}

/**
 * Bind the window key listeners for one activation span. Every listener is
 * removed through `ctx.track` on deactivate.
 */
export function bindDrawKeys(host: DrawKeysHost, ctx: ToolContext): void {
    const onKeyDown = (e: KeyboardEvent) => onDrawKeyDown(host, e);
    window.addEventListener('keydown', onKeyDown);
    ctx.track(() => window.removeEventListener('keydown', onKeyDown));

    // Arrow nudge (24c) listens in the capture phase: MapLibre's keyboard
    // handler on the map container pans on arrows before a bubbling
    // window listener runs, so a consumed arrow stops propagation here.
    const onArrowKey = (e: KeyboardEvent) => {
        if (onDrawArrowKey(host, e)) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    window.addEventListener('keydown', onArrowKey, true);
    ctx.track(() => window.removeEventListener('keydown', onArrowKey, true));

    // Space-release ends the momentary box-select override. Bound
    // separately (keydown is routed through onKeyDown's claim/input
    // guards); the release must always fire so the flag never sticks.
    const onKeyUp = (e: KeyboardEvent) => {
        if (e.key === ' ' || e.code === 'Space') host.spaceHeld.set(false);
    };
    window.addEventListener('keyup', onKeyUp);
    ctx.track(() => window.removeEventListener('keyup', onKeyUp));

    // Focus loss mid-hold (⌘Tab, devtools, macOS overlays) eats the
    // keyup — without this the flag latches and EVERY subsequent drag
    // becomes a marquee until reload.
    const onBlur = () => host.spaceHeld.set(false);
    window.addEventListener('blur', onBlur);
    ctx.track(() => window.removeEventListener('blur', onBlur));
}

function isTextInput(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement
        || target instanceof HTMLSelectElement
        || target instanceof HTMLTextAreaElement;
}

function onDrawKeyDown(host: DrawKeysHost, e: KeyboardEvent): void {
    if (!host.isMyClaim()) return;
    if (isTextInput(e.target)) return;

    const meta = e.metaKey || e.ctrlKey;
    const drawing = host.state.isDrawing;

    // Space held = momentary box-select override (released in the keyup
    // listener). preventDefault stops the page from scrolling. Auto-repeat
    // re-fires keydown harmlessly.
    if ((e.key === ' ' || e.code === 'Space') && !meta) {
        e.preventDefault();
        host.spaceHeld.set(true);
        return;
    }

    if (meta && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (drawing.peek()) {
            // Mid-draw point undo/redo — separate ephemeral stack. When it
            // has nothing to do (e.g. an empty draft just re-armed by a
            // sticky close), fall through to committed history so the
            // just-created feature is undoable without leaving chain mode.
            if (e.shiftKey) {
                if (!host.state.redoPoint()) host.redo();
            } else if (!host.state.undoPoint()) {
                host.undo();
            }
        } else if (e.shiftKey) {
            host.redo();
        } else {
            host.undo();
        }
    } else if (meta && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        if (drawing.peek()) {
            if (!host.state.redoPoint()) host.redo();
        } else host.redo();
    } else if (meta && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        host.duplicateSelection();
    } else if (e.key === 'Enter') {
        if (drawing.peek() && host.state.canClose.peek()) {
            e.preventDefault();
            host.closeDraft();
        }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (host.vertexSelection.peek().size > 0 && host.features?.editableSelected.peek()) {
            e.preventDefault();
            host.deleteSelectedVertices();
        } else if ((host.features?.selectedIds.peek().size ?? 0) > 0) {
            e.preventDefault();
            void host.deleteSelected();
        }
    } else if ((e.key === 'i' || e.key === 'I') && !meta) {
        if (host.vertexSelection.peek().size === 2 && host.features?.editableSelected.peek()) {
            e.preventDefault();
            host.insertBetweenSelectedVertices();
        }
    } else if (e.key === 'n' || e.key === 'N') {
        if (!drawing.peek() && !meta) {
            e.preventDefault();
            host.armDraw();
        }
    } else if (e.key === 'b' || e.key === 'B') {
        if (!drawing.peek() && !meta) {
            e.preventDefault();
            host.state.toggleBoxSelect();
        }
    } else if (e.key === 'c' || e.key === 'C') {
        const target = host.vertexSelection.peek().size > 0 || host.hoverVertex.peek();
        if (!meta && !drawing.peek() && target && host.features?.editableSelected.peek()) {
            e.preventDefault();
            host.toggleHoveredVertexCorner();
        }
    } else if (e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') {
        // D27 stack-reorder bindings (Inkscape-style — not [ / ], which
        // needs AltGr on Swedish layouts). The map claims paging/Home/End
        // for its own navigation, so preventDefault whenever we act.
        if (!meta && !drawing.peek() && (host.features?.selectedIds.peek().size ?? 0) > 0) {
            e.preventDefault();
            void host.reorderSelected(e.key as ReorderKey);
        }
    } else if (!meta && !e.altKey && DIGIT_FEATURE_TYPES[e.key]) {
        // Bare digit = pick a feature type without opening the palette
        // dropdown (⌘/Ctrl/Alt-digit is browser tab switching etc. — never
        // preventDefault there). Same verb as the palette button.
        e.preventDefault();
        host.chooseType(DIGIT_FEATURE_TYPES[e.key]);
    }
}

/** Arrow keys nudge the vertex selection. Returns true when consumed. */
function onDrawArrowKey(host: DrawKeysHost, e: KeyboardEvent): boolean {
    if (!ARROW_DIRECTIONS[e.key]) return false;
    if (!host.isMyClaim() || e.metaKey || e.ctrlKey || e.altKey) return false;
    if (isTextInput(e.target)) return false;
    if (host.state.isDrawing.peek() || host.dragging) return false;
    return host.nudgeSelectedVertices(e.key, e.shiftKey ? NUDGE_SHIFT_PX : NUDGE_PX);
}
