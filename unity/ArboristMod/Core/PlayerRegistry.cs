// The player bridge's commands live in an assembly of their own, loaded from bytes out of
// <plugin folder>/commands/ (the newest GolfMapPlayerCommands*.dll). A new build is picked up with
// the `reload` command, without restarting the app: only a change to the core (this folder) needs
// a restart. Older command assemblies stay in memory, unused.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;

namespace GolfMap.Bridge
{
    public static class PlayerRegistry
    {
        static Assembly commands;
        static Dictionary<string, BridgeCommands.Entry> map;

        public static string Loaded { get; private set; }

        public static string Folder
        {
            get { return Path.Combine(Path.GetDirectoryName(typeof(PlayerRegistry).Assembly.Location), "commands"); }
        }

        public static string Load()
        {
            if (!Directory.Exists(Folder)) throw new BridgeError("No folder " + Folder + ".");
            var newest = new DirectoryInfo(Folder).GetFiles("GolfMapPlayerCommands*.dll").OrderByDescending(f => f.LastWriteTimeUtc).FirstOrDefault();
            if (newest == null) throw new BridgeError("No GolfMapPlayerCommands*.dll in " + Folder + ".");
            commands = Assembly.Load(File.ReadAllBytes(newest.FullName));
            map = null;
            Loaded = newest.Name;
            return Loaded;
        }

        static Dictionary<string, BridgeCommands.Entry> Map()
        {
            if (map != null) return map;
            var found = new Dictionary<string, BridgeCommands.Entry>();
            foreach (var assembly in new[] { typeof(PlayerRegistry).Assembly, commands })
            {
                if (assembly == null) continue;
                Type[] types;
                try { types = assembly.GetTypes(); }
                catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray(); }
                foreach (var type in types)
                    foreach (var method in type.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
                    {
                        var attr = (BridgeCommandAttribute)Attribute.GetCustomAttribute(method, typeof(BridgeCommandAttribute));
                        if (attr == null) continue;
                        found[attr.name] = new BridgeCommands.Entry { name = attr.name, description = attr.description, args = attr.args, declaredIn = type.FullName + "." + method.Name, method = method };
                    }
            }
            return map = found;
        }

        public static object Invoke(string name, BridgeArgs args)
        {
            BridgeCommands.Entry entry;
            if (!Map().TryGetValue(name, out entry)) throw new BridgeError("Unknown command '" + name + "'. Call 'commands' for the list.");
            try { return entry.method.Invoke(null, entry.method.GetParameters().Length == 0 ? new object[0] : new object[] { args }); }
            catch (TargetInvocationException e) { throw e.InnerException ?? e; }
        }

        [BridgeCommand("commands", "List every registered bridge command.")]
        static object Commands()
        {
            return Map().Values.OrderBy(e => e.name, StringComparer.Ordinal).Select(e => (object)new Dictionary<string, object>
            {
                { "name", e.name }, { "description", e.description }, { "args", e.args }, { "declaredIn", e.declaredIn },
            }).ToList();
        }

        [BridgeCommand("reload", "Load the newest commands assembly from the plugin's commands folder (after unity/ArboristMod/build.ps1).")]
        static object Reload()
        {
            string file = Load();
            return new Dictionary<string, object> { { "loaded", file }, { "commands", Map().Count } };
        }
    }
}
