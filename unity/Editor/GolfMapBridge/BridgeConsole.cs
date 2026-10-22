// Console and compiler capture for the bridge.
//
// Log messages go into a numbered ring buffer so a caller can ask "what was
// logged since #N" after running something. Compiler messages never reach
// Application.logMessageReceived, so they come from CompilationPipeline. Both
// are kept in SessionState across domain reloads: a successful compile reloads
// the domain, and the messages from just before it are the interesting ones.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

namespace GolfMap.Bridge
{
    public static class BridgeConsole
    {
        public sealed class Entry
        {
            public long seq;
            public string time, type, message, stack;
        }

        const int Capacity = 2000;
        const int Persisted = 500;
        const string LogKey = "GolfMapBridge.log";
        const string CompileKey = "GolfMapBridge.compile";

        static readonly object gate = new object();
        static readonly LinkedList<Entry> entries = new LinkedList<Entry>();
        static long nextSeq = 1;
        static bool installed;

        // Assembly -> messages of its last compile, plus when that compile finished.
        static Dictionary<string, object> compile = new Dictionary<string, object>();

        public static long LastSeq { get { lock (gate) return nextSeq - 1; } }

        public static void Install()
        {
            if (installed) return;
            installed = true;
            Restore();
            Application.logMessageReceivedThreaded += OnLog;
            CompilationPipeline.assemblyCompilationFinished += OnCompiled;
        }

        static void OnLog(string message, string stack, LogType type)
        {
            lock (gate)
            {
                entries.AddLast(new Entry
                {
                    seq = nextSeq++,
                    time = DateTime.Now.ToString("HH:mm:ss.fff"),
                    type = type.ToString().ToLowerInvariant(),
                    message = message,
                    stack = stack,
                });
                while (entries.Count > Capacity) entries.RemoveFirst();
            }
        }

        static void OnCompiled(string assemblyPath, CompilerMessage[] messages)
        {
            var list = messages.Select(m => (object)new Dictionary<string, object>
            {
                { "type", m.type.ToString().ToLowerInvariant() },
                { "message", m.message },
                { "file", m.file },
                { "line", m.line },
            }).ToList();
            lock (gate)
            {
                compile[System.IO.Path.GetFileName(assemblyPath)] = new Dictionary<string, object>
                {
                    { "finished", DateTime.Now.ToString("s") },
                    { "errors", messages.Count(m => m.type == CompilerMessageType.Error) },
                    { "messages", list },
                };
            }
            Save();
        }

        public static List<Dictionary<string, object>> Query(long since, string[] types, string contains, int limit, bool stacks)
        {
            lock (gate)
            {
                IEnumerable<Entry> q = entries.Where(e => e.seq > since);
                if (types.Length > 0) q = q.Where(e => types.Contains(e.type));
                if (!string.IsNullOrEmpty(contains)) q = q.Where(e => e.message.IndexOf(contains, StringComparison.OrdinalIgnoreCase) >= 0);
                // The newest `limit` entries, oldest first.
                var picked = q.Reverse().Take(limit).Reverse();
                return picked.Select(e =>
                {
                    var d = new Dictionary<string, object> { { "seq", e.seq }, { "time", e.time }, { "type", e.type }, { "message", e.message } };
                    if (stacks && !string.IsNullOrEmpty(e.stack)) d["stack"] = e.stack;
                    return d;
                }).ToList();
            }
        }

        public static Dictionary<string, object> Compile()
        {
            lock (gate) return new Dictionary<string, object>(compile);
        }

        // Clears the bridge buffer, and Unity's Console window when asked.
        public static void Clear(bool unityConsole)
        {
            lock (gate) entries.Clear();
            if (!unityConsole) return;
            // Internal API; the class moved namespace between Unity versions.
            var type = Type.GetType("UnityEditor.LogEntries, UnityEditor") ?? Type.GetType("UnityEditorInternal.LogEntries, UnityEditor");
            var clear = type == null ? null : type.GetMethod("Clear", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            if (clear != null) clear.Invoke(null, null);
        }

        // ConsoleWindow's Mode bits that make a row an error: Error, Assert, Fatal, AssetImportError, ScriptingError,
        // ScriptCompileError, ScriptingException, GraphCompileError, ScriptingAssertion
        const int ErrorModes = 1 | 2 | 16 | 64 | 256 | 2048 | 131072 | 1048576 | 2097152;

        // The error rows Unity's Console window shows now (what the user has not cleared), oldest first: message
        // (first line), file, line. Null when this Unity's internal LogEntries API is not the one expected.
        public static List<Dictionary<string, object>> UnityConsoleErrors(int limit)
        {
            var entries = Type.GetType("UnityEditor.LogEntries, UnityEditor") ?? Type.GetType("UnityEditorInternal.LogEntries, UnityEditor");
            var entryType = Type.GetType("UnityEditor.LogEntry, UnityEditor") ?? Type.GetType("UnityEditorInternal.LogEntry, UnityEditor");
            if (entries == null || entryType == null) return null;
            const BindingFlags S = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
            const BindingFlags I = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            var start = entries.GetMethod("StartGettingEntries", S);
            var end = entries.GetMethod("EndGettingEntries", S);
            var get = entries.GetMethod("GetEntryInternal", S);
            var count = entries.GetMethod("GetCount", S);
            var text = entryType.GetField("condition", I) ?? entryType.GetField("message", I);
            var mode = entryType.GetField("mode", I);
            var file = entryType.GetField("file", I);
            var line = entryType.GetField("line", I);
            if (start == null || end == null || get == null || count == null || text == null || mode == null) return null;
            var rows = new List<Dictionary<string, object>>();
            var entry = Activator.CreateInstance(entryType);
            start.Invoke(null, null);
            try
            {
                int n = (int)count.Invoke(null, null);
                for (int i = 0; i < n && rows.Count < limit; i++)
                {
                    get.Invoke(null, new object[] { i, entry });
                    if ((Convert.ToInt32(mode.GetValue(entry)) & ErrorModes) == 0) continue;
                    var message = (text.GetValue(entry) as string ?? "").Trim();
                    int nl = message.IndexOf('\n');
                    rows.Add(new Dictionary<string, object>
                    {
                        { "message", nl > 0 ? message.Substring(0, nl).Trim() : message },
                        { "file", file != null ? file.GetValue(entry) as string : null },
                        { "line", line != null ? line.GetValue(entry) : null },
                    });
                }
            }
            finally { end.Invoke(null, null); }
            return rows;
        }

        public static void Save()
        {
            lock (gate)
            {
                var tail = entries.Skip(Math.Max(0, entries.Count - Persisted)).Select(e => (object)new Dictionary<string, object>
                {
                    { "seq", e.seq }, { "time", e.time }, { "type", e.type }, { "message", e.message }, { "stack", e.stack },
                }).ToList();
                SessionState.SetString(LogKey, BridgeJson.Write(new Dictionary<string, object> { { "next", nextSeq }, { "entries", tail } }));
                SessionState.SetString(CompileKey, BridgeJson.Write(compile));
            }
        }

        static void Restore()
        {
            try
            {
                var log = BridgeJson.Parse(SessionState.GetString(LogKey, "")) as Dictionary<string, object>;
                if (log != null)
                {
                    nextSeq = (long)(double)log["next"];
                    foreach (Dictionary<string, object> e in (List<object>)log["entries"])
                        entries.AddLast(new Entry
                        {
                            seq = (long)(double)e["seq"],
                            time = (string)e["time"],
                            type = (string)e["type"],
                            message = (string)e["message"],
                            stack = e["stack"] as string,
                        });
                }
                var saved = BridgeJson.Parse(SessionState.GetString(CompileKey, "")) as Dictionary<string, object>;
                if (saved != null) compile = saved;
            }
            catch (Exception e)
            {
                Debug.LogWarning("[Bridge] Could not restore the console buffer: " + e.Message);
            }
        }
    }
}
