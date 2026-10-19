// Editor memory between long bridge runs: a course refresh of hundreds of
// objects keeps imported meshes, textures and readable copies alive until the
// editor is restarted (Omberg 2026-10-18: out of memory at 52 GB inside
// satellite.fill). Unloading what no scene object references, between
// batches, keeps a run of several refreshes inside the machine's memory.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using GolfMap.Bridge;
using UnityEditor;
using UnityEngine.Profiling;

namespace GolfMap.Editor
{
    static class GolfMapEditorMemory
    {
        [BridgeCommand("golfmap.editor.memory", "The editor's memory (Unity's allocated/reserved totals and the Mono heap, MB). unload=true first unloads every asset no open scene references (EditorUtility.UnloadUnusedAssetsImmediate) and collects garbage, and reports before/after. Changes no scene or asset.",
            args = "unload=false")]
        static object Memory(BridgeArgs a)
        {
            var before = Snapshot();
            if (!a.Bool("unload", false)) return before;
            var watch = Stopwatch.StartNew();
            EditorUtility.UnloadUnusedAssetsImmediate(true);
            GC.Collect();
            GC.WaitForPendingFinalizers();
            return new Dictionary<string, object>
            {
                { "before", before }, { "after", Snapshot() }, { "seconds", Math.Round(watch.Elapsed.TotalSeconds, 2) },
            };
        }

        static Dictionary<string, object> Snapshot()
        {
            const double mb = 1024 * 1024;
            // Process.PrivateMemorySize64 reads 0 under the 2018 editor's Mono: the process total
            // (which outgrows these after a long session) has to come from outside, e.g. Get-Process.
            return new Dictionary<string, object>
            {
                { "allocatedMB", Math.Round(Profiler.GetTotalAllocatedMemoryLong() / mb) },
                { "reservedMB", Math.Round(Profiler.GetTotalReservedMemoryLong() / mb) },
                { "monoMB", Math.Round(GC.GetTotalMemory(false) / mb) },
            };
        }
    }
}
