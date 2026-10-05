// ─── One keydown dispatcher with an explicit layer stack ──────────────────
//
// Review item 31. Before this service, Esc ordering between popovers, the
// help modal and the editor tool chain depended on the order in which each
// component added its own window keydown listener. Now every such layer
// pushes onto one stack and this service owns the single window listener.
//
// Dispatch rules:
// - Layers are offered the event top-down: highest `level` first, and within
//   a level the most recently pushed first. The first handler that returns
//   true consumes the event; lower layers never see it, and the dispatcher
//   calls stopImmediatePropagation so later window listeners (a tool's own
//   key handler) do not act on it either. Handlers call preventDefault
//   themselves when they want it.
// - Keys typed into an input, select, textarea or contenteditable element
//   never reach the stack, except Escape.
// - An event an earlier listener already preventDefault'ed (the app-level
//   confirm dialog cancels on Escape that way) is skipped.
//
// The window listener is added on the first push and removed when the stack
// empties. In the editor that first push is the canvas mount, which runs
// before any tool activates, so the dispatcher sees keys before the tools'
// own window listeners do.

/** Stack levels, top to bottom. */
export const LAYER = {
    /** An open popover or menu (PopoverComponent, the canvas layers popover). */
    popover: 300,
    /** The help modal. */
    modal: 200,
    /** The active tool's Esc chain (toolbar.component.ts). */
    toolChain: 100,
    /** Editor-wide routes: sub-mode, hole step, fit, docks (editor-keys.ts). */
    global: 50,
} as const;

export interface ShortcutLayer {
    /** Debug name, unique per live layer by convention. */
    id: string;
    /** Stack level; higher is offered the event first. Defaults to LAYER.global. */
    level?: number;
    /** Return true to consume the event and stop the dispatch. */
    onKey(e: KeyboardEvent): boolean;
}

interface Entry {
    layer: ShortcutLayer;
    level: number;
    seq: number;
}

/** True when `target` is a text-entry element whose keys belong to it. */
export function isTypingTarget(target: EventTarget | null): boolean {
    if (!target || typeof (target as Element).tagName !== 'string') return false;
    const el = target as HTMLElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        return true;
    }
    if (el.isContentEditable) return true;
    const editable = el.closest?.('[contenteditable]');
    return !!editable && editable.getAttribute('contenteditable') !== 'false';
}

export class ShortcutService {
    private entries: Entry[] = [];
    private seq = 0;
    private listening = false;

    private readonly onWindowKey = (e: KeyboardEvent): void => { this.dispatch(e); };

    /** Push a layer; the returned disposer removes it (idempotent). */
    push(layer: ShortcutLayer): () => void {
        const entry: Entry = { layer, level: layer.level ?? LAYER.global, seq: ++this.seq };
        this.entries.push(entry);
        if (!this.listening) {
            window.addEventListener('keydown', this.onWindowKey);
            this.listening = true;
        }
        return () => {
            const i = this.entries.indexOf(entry);
            if (i < 0) return;
            this.entries.splice(i, 1);
            if (this.entries.length === 0 && this.listening) {
                window.removeEventListener('keydown', this.onWindowKey);
                this.listening = false;
            }
        };
    }

    /** Ids of the live layers, top first. For tests and debugging. */
    layerIds(): string[] {
        return this.ordered().map(entry => entry.layer.id);
    }

    /** Offer `e` to the stack. Returns true when a layer consumed it. */
    dispatch(e: KeyboardEvent): boolean {
        if (e.defaultPrevented) return false;
        if (e.key !== 'Escape' && isTypingTarget(e.target)) return false;
        for (const entry of this.ordered()) {
            // A handler may pop layers (closing a popover); skip the ones gone.
            if (!this.entries.includes(entry)) continue;
            if (entry.layer.onKey(e)) {
                e.stopImmediatePropagation();
                return true;
            }
        }
        return false;
    }

    private ordered(): Entry[] {
        return [...this.entries].sort((a, b) => b.level - a.level || b.seq - a.seq);
    }
}
