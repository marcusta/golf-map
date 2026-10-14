// The open Unity editors (the GolfMap editor bridge, unity/Editor/GolfMapBridge)
// and which one works on a course. Builder mode only: the bridge listens on
// 127.0.0.1 of the machine the editor runs on.
//
// The client is the MCP server's (unity/mcp/bridge.ts: discovery files in
// %LOCALAPPDATA%/GolfMapBridge, token header, long commands polled as jobs,
// retries across script reloads), so there is one implementation of the
// protocol. An editor is matched to a course by its ACTIVE GolfMap course's
// export folder: the folder golf-map writes the course's GSPro exports into is
// the one that course's Unity project imports from.
import * as path from 'node:path';
import { listBridges, run } from '../../unity/mcp/bridge';

export interface UnityEditor {
    projectPath: string;
    projectName: string;
    /** Run a [BridgeCommand]; long ones are followed for up to `totalSec`. Throws the command's error. */
    run(command: string, args?: Record<string, unknown>, totalSec?: number): Promise<any>;
}

export interface UnityBridge {
    /** The editors open right now. */
    editors(): UnityEditor[];
}

/** The real bridge; `discoveryDir` overrides where editors publish themselves (tests). */
export function defaultUnityBridge(discoveryDir?: string): UnityBridge {
    return {
        editors: () => listBridges(discoveryDir).map(b => ({
            projectPath: b.projectPath,
            projectName: b.projectName,
            run: (command, args = {}, totalSec = 120) => run(b, command, args, totalSec),
        })),
    };
}

const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** One open editor as the probe found it — what the GSPro status board's Unity chip shows. */
export interface UnityEditorInfo {
    projectName: string;
    projectPath: string;
    /** Its active GolfMap course's name; null when it has none, or the probe failed. */
    activeCourse: string | null;
    /** That course's export folder, resolved absolute; null when it has none. */
    exportFolder: string | null;
    /** True when `exportFolder` is the folder asked about: this editor works on that course. */
    matches: boolean;
    /** The probe's own words when it said nothing useful (an error, no active course), else null. */
    error: string | null;
}

/**
 * One editor asked what course it has active (`golfmap.course`, 30 s cap) and
 * what that means for `exportDir`. `note` is the line the callers put in their
 * `seen` list for the error message.
 */
async function probeEditor(editor: UnityEditor, exportDir: string): Promise<{ info: UnityEditorInfo; note: string | null }> {
    const base = { projectName: editor.projectName, projectPath: editor.projectPath };
    let active: { name?: string; exportFolder?: string } | null = null;
    try {
        active = (await editor.run('golfmap.course', {}, 30))?.active ?? null;
    } catch (e) {
        const error = (e as Error).message.split('\n')[0] ?? String(e);
        return {
            info: { ...base, activeCourse: null, exportFolder: null, matches: false, error },
            note: `${editor.projectName}: ${error}`,
        };
    }
    if (!active?.exportFolder) {
        const error = 'no active GolfMap course with an export folder';
        return {
            info: { ...base, activeCourse: active?.name ?? null, exportFolder: null, matches: false, error },
            note: `${editor.projectName}: ${error}`,
        };
    }
    // Relative folders are relative to the project's Assets folder (Application.dataPath).
    const folder = path.resolve(editor.projectPath, 'Assets', active.exportFolder);
    const matches = norm(folder) === norm(exportDir);
    return {
        info: { ...base, activeCourse: active.name ?? null, exportFolder: folder, matches, error: null },
        note: matches ? null : `${editor.projectName}: course ${active.name ?? '?'} exports to ${folder}`,
    };
}

/**
 * The editor whose active GolfMap course's export folder is `exportDir`, or
 * why there is none (each open editor's answer, for the error message). Stops
 * at the first match: the probe costs a round trip per editor.
 */
export async function editorForExportDir(bridge: UnityBridge, exportDir: string): Promise<{ editor: UnityEditor | null; seen: string[] }> {
    const seen: string[] = [];
    for (const editor of bridge.editors()) {
        const { info, note } = await probeEditor(editor, exportDir);
        if (info.matches) return { editor, seen };
        if (note) seen.push(note);
    }
    return { editor: null, seen };
}

/**
 * EVERY open editor probed, in discovery order — the status board shows them
 * all, matching or not, so the operator can see which project is in front of
 * them. `editorForExportDir` is the same probe, stopping at the match.
 *
 * The probes run side by side: each costs a round trip to its editor, capped
 * at 30 s, and an editor busy compiling holds its answer that long — a board
 * poll with three editors open must not take three times as long as one.
 */
export async function unityEditorsFor(bridge: UnityBridge, exportDir: string): Promise<UnityEditorInfo[]> {
    const probes = bridge.editors().map(editor => probeEditor(editor, exportDir));
    return (await Promise.all(probes)).map(p => p.info);
}
