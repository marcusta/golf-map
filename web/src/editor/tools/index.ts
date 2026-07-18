// ─── THE editor tool registry ─────────────────────────────────────────────
//
// This is the ONE existing file a new tool touches: add ONE import line and
// ONE array entry line. Keep every entry on its own line so parallel
// single-line edits by different agents/branches don't collide. Everything
// else (button, activation, panel hosting, ESC, interaction claims) is
// derived from the registry by EditorToolbarComponent.
//
// Contract for a tool entry: implement EditorTool (see ../tool.ts for the
// full lifecycle documentation), give it a unique `id` (also used as the
// MapService interaction mode) and an unclaimed `order` slot:
//   draw = 10, furniture = 20, measure = 30, green analysis = 40.

import type { EditorTool } from '../tool';
import { drawTool } from '../../draw/draw-tool';
import { furnitureTool } from '../../furniture/furniture-tool';
import { measureTool } from '../../measure/measure-tool';
import { analysisTool } from '../../analysis/analysis-tool';
import { samTool } from '../../sam/sam-tool';
import { terrainEditTool } from '../../terrain-edit/terrain-edit-tool';

export const EDITOR_TOOLS: EditorTool[] = [
    drawTool, // course-feature drawing (batch C1)
    furnitureTool, // tees / pins / aim-points placement (batch C2)
    measureTool, // click-click multi-segment distance + elevation profile (batch C3)
    analysisTool, // green + surrounds height/slope analysis (batch C4)
    samTool, // SAM click-to-feature assist (T45)
    terrainEditTool, // DEM smooth/flatten edit polygons (T55b)
];
