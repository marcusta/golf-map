import type { EditorTool } from './tool';
import type { EditorModeService } from './editor-mode.service';
import type { ShortcutService } from './shortcut.service';
import type { FurnitureService } from '../furniture/furniture.service';
import type { MapService } from '../map/map.service';
import { editorKeyLayer } from './editor-keys';
import { attachHoleFraming } from './hole-framing';

export interface EditorChromeDeps {
    shortcuts: ShortcutService;
    mode: EditorModeService;
    map: Pick<MapService, 'ready' | 'fitBounds'>;
    furniture: FurnitureService;
    /** Tools the current server mode offers (visibleEditorTools). */
    offered: () => readonly EditorTool[];
}

/**
 * Create-mode canvas extras bound to one canvas mount: the editor-wide key
 * layer (editor-keys.ts) and the follow-hole camera (hole-framing.ts).
 * EditorCanvasComponent calls it on /course; the returned disposer undoes
 * both.
 */
export function attachEditorChrome(deps: EditorChromeDeps): () => void {
    const popKeys = deps.shortcuts.push(editorKeyLayer(deps.mode, deps.offered));
    const stopFraming = attachHoleFraming({
        map: deps.map,
        furniture: deps.furniture,
        selectedHole: deps.mode.selectedHole,
        followHole: deps.mode.followHole,
    });
    return () => {
        popKeys();
        stopFraming();
    };
}
