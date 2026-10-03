import type { EditorTool, HelpSection } from './tool';
import type { ShortcutLayer } from './shortcut.service';
import { LAYER } from './shortcut.service';

// Editor-wide keyboard routes (review item 21). One ShortcutService layer at
// the global level, below popovers, the help modal and the tool chain. The
// editor canvas pushes it on /course and disposes it on unmount, so the keys
// work in every sub-mode and survive tool deactivation.
//
// Conflict rule: this layer binds only keys the draw tool's own handler
// leaves alone (draw owns Space, digits, N, B, C, I, Enter, Delete,
// Backspace, PageUp/PageDown/Home/End, Cmd+Z/Y/D; Shift+digit, H and
// Shift+H are visibility keys here). Sub-mode letters require
// no modifier at all, so Cmd+D still duplicates. `[` and `]` are avoided:
// they need AltGr on a Swedish layout and the clean tool uses them for stamp
// size.

/** Sub-mode letter → tool id. C and B belong to the draw tool. */
export const SUB_MODE_KEYS: Readonly<Record<string, string>> = {
    d: 'draw',
    m: 'measure',
    f: 'furniture',
    a: 'analysis',
    t: 'terrain-edit',
};

/** What the layer drives. EditorModeService satisfies it. */
export interface EditorKeyActions {
    activeToolBusy(): boolean;
    selectSubMode(toolId: string, offered: readonly EditorTool[]): boolean;
    stepHole(delta: number): boolean;
    fitHole(): boolean;
    fitCourse(): void;
    toggleDocks(): boolean;
    /** Shift+digit: toggle the feature type bound to that digit. False when none is. */
    toggleTypeHidden(digit: string): boolean;
    /** H: hide the selected features. False when nothing is selected. */
    hideSelected(): boolean;
    /** Shift+H: clear every visibility toggle. */
    showAll(): void;
}

/**
 * The global layer. `offered` returns the tools the current server mode
 * shows (visibleEditorTools); a sub-mode key for a tool not offered falls
 * through unconsumed.
 */
export function editorKeyLayer(actions: EditorKeyActions, offered: () => readonly EditorTool[]): ShortcutLayer {
    return {
        id: 'editor-keys',
        level: LAYER.global,
        onKey(e: KeyboardEvent): boolean {
            const meta = e.metaKey || e.ctrlKey;
            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

            // Cmd/Ctrl+\ toggles both docks. e.code covers layouts where `\`
            // sits behind a modifier (Swedish: Shift+Alt+7).
            if (meta && !e.altKey && (e.key === '\\' || e.code === 'Backslash')) {
                e.preventDefault();
                actions.toggleDocks();
                return true;
            }

            if (key === 'f' && e.shiftKey && !e.altKey) {
                if (meta) {
                    e.preventDefault();
                    actions.fitCourse();
                    return true;
                }
                e.preventDefault();
                actions.fitHole();
                return true;
            }

            if (meta || e.altKey) return false;

            // Visibility (review item 27). Shift+digit goes by e.code: the
            // shifted key is '!' or similar on every layout.
            if (e.shiftKey && /^Digit[0-9]$/.test(e.code)) {
                if (!actions.toggleTypeHidden(e.code.slice(5))) return false;
                e.preventDefault();
                return true;
            }
            if (key === 'h') {
                if (e.shiftKey) {
                    e.preventDefault();
                    actions.showAll();
                    return true;
                }
                if (!actions.hideSelected()) return false;
                e.preventDefault();
                return true;
            }

            if (e.key === ',' || e.key === '.') {
                e.preventDefault();
                actions.stepHole(e.key === '.' ? 1 : -1);
                return true;
            }

            if (e.shiftKey) return false;
            const toolId = SUB_MODE_KEYS[key];
            if (!toolId) return false;
            if (!offered().some(tool => tool.id === toolId)) return false;
            // A busy tool (open draft, live drag) keeps the key: it falls
            // through unconsumed, so it never switches away mid-edit.
            if (actions.activeToolBusy()) return false;
            e.preventDefault();
            actions.selectSubMode(toolId, offered());
            return true;
        },
    };
}

/** Help-modal section for the editor-wide keys, filtered to offered tools. */
export function editorHelp(offered: readonly EditorTool[]): HelpSection[] {
    const subModes = Object.entries(SUB_MODE_KEYS)
        .map(([key, id]) => ({ key, tool: offered.find(tool => tool.id === id) }))
        .filter((row): row is { key: string; tool: EditorTool } => row.tool !== undefined)
        .map(({ key, tool }) => ({ keys: key.toUpperCase(), desc: tool.label }));
    return [
        {
            title: 'Editor',
            shortcuts: [
                ...subModes,
                { keys: ', / .', desc: 'Previous / next hole' },
                { keys: 'Shift+F', desc: 'Fit hole' },
                { keys: '⌘/Ctrl+Shift+F', desc: 'Fit course' },
                { keys: '⌘/Ctrl+\\', desc: 'Collapse or expand both docks' },
                { keys: 'Shift+1 … 0', desc: 'Hide or show a feature type' },
                { keys: 'H', desc: 'Hide selected features' },
                { keys: 'Shift+H', desc: 'Show all' },
                // Draw snapping (draw/draw-snap.ts). The row belongs in
                // the Draw section (draw/draw-tool.ts); it lives here until
                // that file takes it.
                ...(offered.some(tool => tool.id === 'draw')
                    ? [{ keys: '⌘/Ctrl while placing or dragging', desc: 'Draw: no snapping to neighbouring shapes' }]
                    : []),
                { keys: '?', desc: 'This help' },
            ],
        },
    ];
}
