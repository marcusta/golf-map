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

/**
 * The editor whose active GolfMap course's export folder is `exportDir`, or
 * why there is none (each open editor's answer, for the error message).
 */
export async function editorForExportDir(bridge: UnityBridge, exportDir: string): Promise<{ editor: UnityEditor | null; seen: string[] }> {
    const seen: string[] = [];
    for (const editor of bridge.editors()) {
        let active: { name?: string; exportFolder?: string } | null = null;
        try {
            active = (await editor.run('golfmap.course', {}, 30))?.active ?? null;
        } catch (e) {
            seen.push(`${editor.projectName}: ${(e as Error).message.split('\n')[0]}`);
            continue;
        }
        if (!active?.exportFolder) {
            seen.push(`${editor.projectName}: no active GolfMap course with an export folder`);
            continue;
        }
        // Relative folders are relative to the project's Assets folder (Application.dataPath).
        const folder = path.resolve(editor.projectPath, 'Assets', active.exportFolder);
        if (norm(folder) === norm(exportDir)) return { editor, seen };
        seen.push(`${editor.projectName}: course ${active.name ?? '?'} exports to ${folder}`);
    }
    return { editor: null, seen };
}
