import { di } from '@basics/core/client/core';
import type { EditorTool, HelpSection } from '../editor/tool';
import { PhotosToolService, PHOTOS_TOOL_ID } from './photos-tool.service';
import { PhotosPanelComponent } from './photos-panel.component';

// Help-modal content (D27) — mirrors the Photos panel and viewer.
const HELP: HelpSection[] = [
    {
        title: 'Browsing',
        shortcuts: [
            { keys: 'List / Map', desc: 'Catalog with thumbnails, or markers where each photo was taken' },
            { keys: 'Click a marker', desc: 'Show that photo (the wedge is the camera direction and field of view)' },
            { keys: 'Click a photo', desc: 'Open it large, with tags, note and hole' },
            { keys: '← / →', desc: 'Previous / next photo in the viewer' },
            { keys: 'Esc', desc: 'Close the viewer, then drop the selection' },
        ],
    },
    {
        title: 'Filters',
        shortcuts: [
            { keys: 'Hole', desc: 'Photos tagged with the hole, or taken within 40 m of its play line' },
            { keys: 'Pick on map', desc: 'Photos taken within a radius of a clicked point, nearest first' },
            { keys: 'Tag chips', desc: 'Photos with any (or all) of the chosen tags' },
        ],
    },
];

/**
 * The `photos` EditorTool registry entry (editor/tools/index.ts): browse and
 * tag the reference photos taken with the iPhone capture mode
 * (docs/feature-reference-photos.md §7). Thin descriptor over the
 * PhotosToolService DI singleton. Not builder-only: the photo routes are
 * mounted in both modes, and the VPS is where the phone uploads.
 */
export const photosTool: EditorTool = {
    id: PHOTOS_TOOL_ID,
    label: 'Photos',
    icon: 'camera',
    order: 80,
    panel: PhotosPanelComponent,
    help: HELP,
    attach: ctx => di.get(PhotosToolService).attach(ctx),
    activate: ctx => di.get(PhotosToolService).activate(ctx),
    deactivate: () => di.get(PhotosToolService).deactivate(),
    onEscape: () => di.get(PhotosToolService).onEscape(),
};
