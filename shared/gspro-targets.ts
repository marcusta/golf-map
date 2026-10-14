// The things a GSPro course is made of, as the web's GSPro status board and
// the server's `GsproSyncService` name them: one TARGET per thing you change
// in the editor, each with one verb — Update — that runs the whole chain for
// it (both terrains, the files on the way, and the push into the open Unity
// editor).
//
// Shared so the web and the server agree on the ids and the words: the board
// shows `label` + `description`, the row's footer shows `manual` (the step a
// human still has to do after an update), and `featureTypes` is what an edit
// has to be for the row to go stale (`GsproSyncService.status`'s
// `changedSince`; the server owns the terrain-edit side).

export const GSPRO_TARGET_IDS = [
    'terrain', 'photo', 'shapes', 'meshes', 'vegetation', 'trees', 'buildings', 'props', 'creeks', 'course-file',
] as const;

export type GsproTargetId = (typeof GSPRO_TARGET_IDS)[number];

export interface GsproTarget {
    id: GsproTargetId;
    /** Board row title. */
    label: string;
    /** One line: what an update of this target does. */
    description: string;
    /** The step a human must do after an update, or null when there is none. */
    manual: string | null;
    /**
     * The `course_features.type`s whose edits make this target stale. Empty
     * where the target has no drawn features behind it (its staleness comes
     * from terrain edits, a photo's mtime or the course's own tables).
     */
    featureTypes: readonly string[];
}

/**
 * The feature types `gspro.py svg` writes: its `TYPE_SURFACE`, plus `trees`
 * through the server's `--map trees=pinestraw`. It skips everything else
 * (rules lines, vegetation zones, outside) whatever is excluded, so the SVG
 * exclusion list only offers these, and only an edit to one of them can
 * change the exported SVG.
 */
export const SVG_FEATURE_TYPES: readonly string[] = [
    'green', 'tee', 'fairway', 'bunker', 'semi_rough', 'rough', 'deep_rough',
    'water', 'water_creek', 'path', 'trees',
];

/**
 * The surfaces the Blender shaping shapes: a recipe (`op: recipe` terrain
 * edit) hangs off one of these, and `golfmap.cut_out` cuts a rock slab out of
 * the ground. A changed outline re-shapes the mesh, so the Meshes row goes
 * stale with it.
 */
export const MESH_FEATURE_TYPES: readonly string[] = ['rock_slab', 'path', 'bunker', 'water', 'water_creek'];

/** The targets in board order — the order a "update everything stale" run takes them in. */
export const GSPRO_TARGETS: readonly GsproTarget[] = [
    {
        id: 'terrain',
        label: 'Terrain',
        description: 'Terrain edits baked into the map, both heightmaps exported and put onto the Unity terrains, then the files that read them.',
        manual: null,
        featureTypes: [],
    },
    {
        id: 'photo',
        label: 'Photo',
        description: 'The inner orthophoto (the cleaned one when there is one) onto the Unity course meshes, and the outer terrain\'s texture.',
        manual: null,
        featureTypes: [],
    },
    {
        id: 'shapes',
        label: 'Course shapes',
        description: 'The drawn course as the layered OPCD SVG, kept as an export snapshot.',
        manual: 'Build the SVG in Blender (OPCD), then Update meshes',
        featureTypes: SVG_FEATURE_TYPES,
    },
    {
        id: 'meshes',
        label: 'Meshes',
        description: 'The shaping layers, the Blender worker over what changed, and the changed objects re-imported in Unity.',
        manual: null,
        featureTypes: MESH_FEATURE_TYPES,
    },
    {
        id: 'vegetation',
        label: 'Vegetation',
        description: 'The vegetation generators, the zone masks for both terrains, the import and grass palettes in Unity, and the Arborist file.',
        manual: null,
        featureTypes: ['vegetation_zone', 'tree_area'],
    },
    {
        id: 'trees',
        label: 'Trees',
        description: 'The lidar tree stems of both terrains as the Tree Planter\'s files, then planted in Unity.',
        manual: null,
        featureTypes: ['tree_area', 'power_line', 'rock_slab'],
    },
    {
        id: 'buildings',
        label: 'Buildings',
        description: 'The building survey of both terrains as the building planter\'s files.',
        manual: 'Run GolfMap › Buildings › Plant from assignments in Unity',
        featureTypes: [],
    },
    {
        id: 'props',
        label: 'Props',
        description: 'Buildings, cars, signs and the rest placed from the course\'s props spec',
        manual: null,
        featureTypes: [],
    },
    {
        id: 'creeks',
        label: 'Creeks',
        description: 'The creeks as R.A.M. splines at the water surface, imported in Unity.',
        manual: null,
        featureTypes: ['water_creek'],
    },
    {
        id: 'course-file',
        label: 'Course file',
        description: 'GreenKeeper\'s .GKD in the course\'s GSPro folder: tees, pins, green centres, aim points, hazards and the OOB ring.',
        manual: null,
        featureTypes: [],
    },
];

const BY_ID = new Map(GSPRO_TARGETS.map(t => [t.id, t]));

/** The target with that id; throws for anything else (the API validates first). */
export function gsproTarget(id: GsproTargetId): GsproTarget {
    const target = BY_ID.get(id);
    if (!target) throw new Error(`Unknown GSPro target '${String(id)}'`);
    return target;
}

export function isGsproTargetId(id: unknown): id is GsproTargetId {
    return typeof id === 'string' && BY_ID.has(id as GsproTargetId);
}
