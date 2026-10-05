// Command registry for the editor bridge.
//
// Any static editor method marked [BridgeCommand] is callable over the bridge by
// name, from any assembly in the project: the bridge knows nothing about the
// scripts that register commands, so course tooling (GolfMap planter, a future
// course's own scripts) adds commands without touching the bridge or the MCP
// server. Signatures: static object M() or static object M(BridgeArgs args).
// Return a result (anything BridgeJson.Write takes), or an IEnumerator to run
// across editor frames: yield null to wait a frame, yield a value to finish.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEngine;

namespace GolfMap.Bridge
{
    [AttributeUsage(AttributeTargets.Method)]
    public sealed class BridgeCommandAttribute : Attribute
    {
        public readonly string name;
        public readonly string description;
        // Short argument summary shown in the command list, e.g. "path, depth=2".
        public string args = "";

        public BridgeCommandAttribute(string name, string description)
        {
            this.name = name;
            this.description = description;
        }
    }

    // Thrown for a caller mistake: reported as the message alone, without a stack.
    public sealed class BridgeError : Exception
    {
        public BridgeError(string message) : base(message) { }
    }

    public sealed class BridgeArgs
    {
        readonly Dictionary<string, object> values;

        public BridgeArgs(Dictionary<string, object> values)
        {
            this.values = values ?? new Dictionary<string, object>();
        }

        public bool Has(string key) { return values.ContainsKey(key) && values[key] != null; }
        public object Raw(string key) { object v; return values.TryGetValue(key, out v) ? v : null; }

        public string String(string key, string fallback = null)
        {
            var v = Raw(key);
            return v == null ? fallback : Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture);
        }

        public string Require(string key)
        {
            var v = String(key);
            if (string.IsNullOrEmpty(v)) throw new BridgeError("Missing argument '" + key + "'.");
            return v;
        }

        // Numbers may arrive as strings from a client that did not know the argument's type.
        public double Number(string key, double fallback)
        {
            var v = Raw(key);
            if (v is double) return (double)v;
            double parsed;
            var text = v as string;
            return text != null && double.TryParse(text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out parsed) ? parsed : fallback;
        }

        public int Int(string key, int fallback) { return (int)Number(key, fallback); }

        public bool Bool(string key, bool fallback)
        {
            var v = Raw(key);
            if (v is bool) return (bool)v;
            bool parsed;
            return v is string && bool.TryParse((string)v, out parsed) ? parsed : fallback;
        }

        public List<object> List(string key) { return Raw(key) as List<object>; }

        public string[] Strings(string key)
        {
            var list = List(key);
            if (list != null) return list.Select(o => Convert.ToString(o)).ToArray();
            var one = String(key);
            return one == null ? new string[0] : new[] { one };
        }

        // [x, y, z]; null when absent.
        public Vector3? Vector(string key)
        {
            var list = List(key);
            if (list == null) return null;
            if (list.Count != 3 || !list.All(o => o is double)) throw new BridgeError("'" + key + "' must be [x, y, z].");
            return new Vector3((float)(double)list[0], (float)(double)list[1], (float)(double)list[2]);
        }
    }

    public static class BridgeCommands
    {
        public sealed class Entry
        {
            public string name, description, args, declaredIn;
            public MethodInfo method;
        }

        static Dictionary<string, Entry> registry;

        public static IEnumerable<Entry> All { get { return Registry().Values.OrderBy(e => e.name, StringComparer.Ordinal); } }

        public static object Invoke(string name, BridgeArgs args)
        {
            Entry entry;
            if (!Registry().TryGetValue(name, out entry))
                throw new BridgeError("Unknown command '" + name + "'. Call 'commands' for the list.");
            var parameters = entry.method.GetParameters();
            try
            {
                return entry.method.Invoke(null, parameters.Length == 0 ? new object[0] : new object[] { args });
            }
            catch (TargetInvocationException e)
            {
                // Rethrowing resets the stack: keep the inner one in the console (bridge errors are expected, not logged).
                if (e.InnerException != null && !(e.InnerException is BridgeError)) Debug.LogError("[bridge] " + name + ": " + e.InnerException);
                throw e.InnerException ?? e;
            }
        }

        // Built once per domain; a recompile reloads the domain and rebuilds it.
        static Dictionary<string, Entry> Registry()
        {
            if (registry != null) return registry;
            var found = new Dictionary<string, Entry>();
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (!MayDeclareCommands(assembly)) continue;
                Type[] types;
                try { types = assembly.GetTypes(); }
                catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray(); }
                foreach (var type in types)
                {
                    foreach (var method in type.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
                    {
                        var attr = (BridgeCommandAttribute)Attribute.GetCustomAttribute(method, typeof(BridgeCommandAttribute));
                        if (attr == null) continue;
                        var ps = method.GetParameters();
                        if (ps.Length > 1 || (ps.Length == 1 && ps[0].ParameterType != typeof(BridgeArgs)))
                        {
                            Debug.LogWarning("[Bridge] " + type.FullName + "." + method.Name + ": a bridge command takes no parameters or one BridgeArgs.");
                            continue;
                        }
                        if (found.ContainsKey(attr.name))
                        {
                            Debug.LogWarning("[Bridge] Command '" + attr.name + "' is declared twice; keeping " + found[attr.name].declaredIn + ".");
                            continue;
                        }
                        found[attr.name] = new Entry
                        {
                            name = attr.name,
                            description = attr.description,
                            args = attr.args,
                            declaredIn = type.FullName + "." + method.Name,
                            method = method,
                        };
                    }
                }
            }
            registry = found;
            return registry;
        }

        // Project scripts and plugins only; engine and framework assemblies are large and declare none.
        static bool MayDeclareCommands(Assembly assembly)
        {
            var name = assembly.GetName().Name;
            string[] skip = { "System", "mscorlib", "Mono.", "UnityEngine", "UnityEditor", "Unity.", "nunit", "ExCSS", "Boo.", "netstandard", "SyntaxTree", "JetBrains" };
            return !skip.Any(p => name == p || name.StartsWith(p, StringComparison.Ordinal));
        }
    }
}
