// The `props` target's own facts: where a course's props spec lives, what
// Unity made of it, and the one line the board shows about the props standing
// in the scene. The chain itself is `GsproSyncService.updateProps`.
//
// Props are the one scene input with no row of their own until now: the spec is
// hand-written Python under `docs/gspro/<course slug>/` (`*-props.gen.py`,
// which writes the `*-props.json` `blender/tools/build_props.py` builds the FBX
// from), the models land in the Unity project (`<course folder>/Props/`), and
// `golfmap.props.place` puts them in the scene. Nothing on the server knew any
// of that; this module is the little that has to be read off disk for the
// board.
//
// `placed.json` is Unity's own record of what a place put where
// (`golfmap-props-placed-v1`, unity/Editor/GolfMap/GolfMapPropsPlaced.cs): the
// `hand` flag per instance marks a prop the user moved or rotated, which the
// next place keeps. The board says how many there are, because that is the
// state an operator has to know before pressing Update — and the only
// PERMANENT place for a hand move is still the `.gen.py` (docs/workflows.md
// section 4).
import * as path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

/** The suffix that makes a file in the course's docs folder a props generator. */
export const PROPS_GEN_SUFFIX = '-props.gen.py';
/** The folder `build_props.py --out` writes into, under the Unity course folder. */
export const PROPS_FOLDER = 'Props';
/** `build_props.py`'s manifest, which `golfmap.props.place` reads. */
export const PROPS_MANIFEST = 'props.json';
/** Unity's record of what the last place put where. */
export const PROPS_PLACED = 'placed.json';
export const PROPS_PLACED_FORMAT = 'golfmap-props-placed-v1';

/** One props spec of a course: the generator and the JSON it writes. */
export interface PropsSpec {
    /** `clubhouse` for `clubhouse-props.gen.py`. */
    name: string;
    /** `docs/gspro/<slug>/<name>-props.gen.py`, absolute. */
    gen: string;
    /** `docs/gspro/<slug>/<name>-props.json`, absolute — what the generator writes. */
    json: string;
}

/**
 * Every `*-props.gen.py` in the course's docs folder, by name. Empty for a
 * course with no props spec (and for a folder that is not there at all) —
 * which is what blocks the Props row.
 *
 * Only `*-props.gen.py`: `stone-walls.gen.py` and `hole-signs.gen.py` next to
 * it are their own tools with their own `--out`, not props the manifest holds.
 */
export async function propsSpecs(docsDir: string): Promise<PropsSpec[]> {
    let names: string[];
    try {
        names = await readdir(docsDir);
    } catch {
        return [];
    }
    return names
        .filter(n => n.endsWith(PROPS_GEN_SUFFIX))
        .sort((a, b) => a.localeCompare(b))
        .map(n => {
            const name = n.slice(0, -PROPS_GEN_SUFFIX.length);
            return { name, gen: path.join(docsDir, n), json: path.join(docsDir, `${name}-props.json`) };
        });
}

/**
 * The board's `note` for the Props row, read from `<Props>/placed.json`: how
 * many props an update keeps as the user left them, or that there is no record
 * yet (the first update records the scene before it places, so nothing is
 * dropped). Null is never returned — a file that cannot be read is the same
 * state as no file for the operator: nothing is recorded yet.
 */
export async function propsNote(propsDir: string): Promise<string> {
    const file = path.join(propsDir, PROPS_PLACED);
    let doc: { format?: unknown; instances?: unknown };
    try {
        doc = JSON.parse(await readFile(file, 'utf8')) as { format?: unknown; instances?: unknown };
    } catch {
        return `no ${PROPS_PLACED} yet: the first update records the scene before placing`;
    }
    if (doc.format !== PROPS_PLACED_FORMAT || !Array.isArray(doc.instances)) {
        return `no ${PROPS_PLACED} yet: the first update records the scene before placing`;
    }
    const hand = doc.instances.filter(i => (i as { hand?: unknown } | null)?.hand === true).length;
    if (hand === 0) return 'no prop has been moved by hand: every one comes from the spec';
    return hand === 1
        ? '1 hand-placed prop is kept on update'
        : `${hand} hand-placed props are kept on update`;
}
