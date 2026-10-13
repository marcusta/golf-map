// Looking round inside the player without a new build per question: list types and members,
// find live objects, read and set fields, call methods. Paths are dotted member names with
// [n] for list items, starting at a type's static members or at one of its live instances.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEngine;

namespace GolfMap.Bridge
{
    static class ReflectCommands
    {
        const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy;

        static IEnumerable<Type> Types()
        {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = assembly.GetTypes(); }
                catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray(); }
                foreach (var t in types) yield return t;
            }
        }

        static Type FindType(string name)
        {
            var hits = Types().Where(t => t.FullName == name).ToList();
            if (hits.Count == 0) hits = Types().Where(t => t.Name == name).ToList();
            if (hits.Count == 0) throw new BridgeError("No type '" + name + "'.");
            if (hits.Count > 1 && hits.Select(t => t.FullName).Distinct().Count() > 1)
                throw new BridgeError("'" + name + "' is ambiguous: " + string.Join(", ", hits.Select(t => t.FullName + " (" + t.Assembly.GetName().Name + ")").ToArray()));
            return hits[0];
        }

        static string Sig(MethodBase m)
        {
            var mi = m as MethodInfo;
            return (m.IsStatic ? "static " : "") + (mi != null ? Short(mi.ReturnType) + " " : "") + m.Name + "(" +
                string.Join(", ", m.GetParameters().Select(p => Short(p.ParameterType) + " " + p.Name).ToArray()) + ")";
        }

        static string Short(Type t)
        {
            if (!t.IsGenericType) return t.Name;
            return t.Name.Split('`')[0] + "<" + string.Join(", ", t.GetGenericArguments().Select(Short).ToArray()) + ">";
        }

        [BridgeCommand("types", "Types whose full name contains `contains` (in `assembly`, default Assembly-CSharp; \"*\" = every assembly), or with `type` that type's fields, properties and methods.",
            args = "contains, assembly=Assembly-CSharp, type (exact name: list its members), inherited=false, limit=200")]
        static object TypesCommand(BridgeArgs a)
        {
            if (a.Has("type"))
            {
                var t = FindType(a.String("type"));
                var flags = a.Bool("inherited", false) ? All : All | BindingFlags.DeclaredOnly;
                return new Dictionary<string, object>
                {
                    { "type", t.FullName }, { "assembly", t.Assembly.GetName().Name }, { "base", t.BaseType != null ? t.BaseType.FullName : null },
                    { "enumValues", t.IsEnum ? (object)Enum.GetNames(t).Cast<object>().ToList() : null },
                    { "fields", t.GetFields(flags).Select(f => (object)((f.IsStatic ? "static " : "") + Short(f.FieldType) + " " + f.Name)).ToList() },
                    { "properties", t.GetProperties(flags).Select(p => (object)(Short(p.PropertyType) + " " + p.Name)).ToList() },
                    { "methods", t.GetMethods(flags).Where(m => !m.IsSpecialName).Select(m => (object)Sig(m)).ToList() },
                };
            }
            string contains = a.String("contains", ""), assembly = a.String("assembly", "Assembly-CSharp");
            int limit = a.Int("limit", 200);
            var hits = Types().Where(t => (assembly == "*" || t.Assembly.GetName().Name == assembly) && (t.FullName ?? t.Name).IndexOf(contains, StringComparison.OrdinalIgnoreCase) >= 0)
                .Select(t => t.FullName).Distinct().OrderBy(n => n, StringComparer.Ordinal).ToList();
            return new Dictionary<string, object> { { "count", hits.Count }, { "types", hits.Take(limit).Cast<object>().ToList() } };
        }

        static string PathOf(Transform t)
        {
            var parts = new List<string>();
            for (; t != null; t = t.parent) parts.Add(t.name);
            parts.Reverse();
            return "/" + string.Join("/", parts.ToArray());
        }

        static List<UnityEngine.Object> Instances(Type t)
        {
            return Resources.FindObjectsOfTypeAll(t).Where(o =>
            {
                var c = o as Component; var g = o as GameObject;
                if (c) return c.gameObject.scene.IsValid();
                if (g) return g.scene.IsValid();
                return true;
            }).ToList();
        }

        [BridgeCommand("objects", "Live objects of a type (components in loaded scenes, inactive ones included; other Unity objects as loaded): index, name, scene path, active.",
            args = "type (required), limit=50")]
        static object Objects(BridgeArgs a)
        {
            var t = FindType(a.Require("type"));
            if (!typeof(UnityEngine.Object).IsAssignableFrom(t)) throw new BridgeError(t.FullName + " is not a Unity object; read it through a field of one (get).");
            var all = Instances(t);
            int limit = a.Int("limit", 50);
            return new Dictionary<string, object>
            {
                { "count", all.Count },
                { "objects", all.Take(limit).Select((o, i) =>
                    {
                        var c = o as Component;
                        return (object)new Dictionary<string, object>
                        {
                            { "index", i }, { "name", o.name }, { "type", o.GetType().Name },
                            { "path", c ? PathOf(c.transform) : null }, { "active", c ? (object)c.gameObject.activeInHierarchy : null },
                        };
                    }).ToList() },
            };
        }

        // ---- values ----

        static object Dump(object v, int depth, int items)
        {
            if (v == null) return null;
            var t = v.GetType();
            if (v is string || v is bool) return v;
            if (t.IsPrimitive) return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture);
            if (t.IsEnum) return v.ToString();
            if (v is Vector2) { var p = (Vector2)v; return new List<object> { p.x, p.y }; }
            if (v is Vector3) { var p = (Vector3)v; return new List<object> { p.x, p.y, p.z }; }
            if (v is Vector4) { var p = (Vector4)v; return new List<object> { p.x, p.y, p.z, p.w }; }
            if (v is Quaternion) { var p = (Quaternion)v; return new List<object> { p.x, p.y, p.z, p.w }; }
            if (v is Color) { var p = (Color)v; return new List<object> { p.r, p.g, p.b, p.a }; }
            if (v is Rect) { var p = (Rect)v; return new List<object> { p.x, p.y, p.width, p.height }; }
            if (v is Bounds) { var p = (Bounds)v; return new Dictionary<string, object> { { "center", Dump(p.center, 0, 0) }, { "size", Dump(p.size, 0, 0) } }; }
            var unity = v as UnityEngine.Object;
            if (!ReferenceEquals(unity, null))
            {
                if (!unity) return "(destroyed " + t.Name + ")";
                var c = unity as Component;
                if (depth <= 0 || !(unity is MonoBehaviour || unity is ScriptableObject))
                    return "<" + t.Name + " " + (c ? PathOf(c.transform) : unity.name) + ">";
            }
            var dictionary = v as IDictionary;
            if (dictionary != null)
            {
                if (depth <= 0) return "{" + dictionary.Count + " entries}";
                var d = new Dictionary<string, object>();
                foreach (DictionaryEntry e in dictionary) { if (d.Count >= items) { d["..."] = dictionary.Count + " entries"; break; } d[Convert.ToString(e.Key)] = Dump(e.Value, depth - 1, items); }
                return d;
            }
            var list = v as IEnumerable;
            if (list != null)
            {
                var collection = v as ICollection;
                if (depth <= 0) return "[" + (collection != null ? collection.Count.ToString() : "?") + " items of " + Short(t) + "]";
                var result = new List<object>();
                foreach (var item in list) { if (result.Count >= items) { result.Add("... " + (collection != null ? collection.Count + " in all" : "more")); break; } result.Add(Dump(item, depth - 1, items)); }
                return result;
            }
            if (depth <= 0) return "{" + Short(t) + "}";
            var fields = new Dictionary<string, object>();
            foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
            {
                if (f.Name.Contains("k__BackingField") && f.IsPrivate) { }
                object value;
                try { value = f.GetValue(v); } catch (Exception e) { value = "(" + e.GetType().Name + ")"; }
                fields[f.Name] = Dump(value, depth - 1, items);
            }
            return fields;
        }

        static object Member(object target, Type type, string name)
        {
            for (var t = type; t != null; t = t.BaseType)
            {
                var f = t.GetField(name, All | BindingFlags.DeclaredOnly);
                if (f != null) return f.GetValue(f.IsStatic ? null : target);
                var p = t.GetProperty(name, All | BindingFlags.DeclaredOnly);
                if (p != null && p.GetIndexParameters().Length == 0) return p.GetValue(p.GetGetMethod(true).IsStatic ? null : target, null);
            }
            throw new BridgeError("No field or property '" + name + "' on " + type.FullName + ".");
        }

        // "a.b[2].c" from a type (statics) or one of its live instances.
        static object Resolve(BridgeArgs a, out Type type, out object parent, out string last)
        {
            type = FindType(a.Require("type"));
            object current = null;
            if (a.Has("instance"))
            {
                var all = Instances(type);
                int i = a.Int("instance", 0);
                if (i < 0 || i >= all.Count) throw new BridgeError(all.Count + " live " + type.Name + " object(s); instance " + i + " is out of range.");
                current = all[i];
            }
            parent = current; last = null;
            string path = a.String("path", "");
            if (path == "") return current;
            var currentType = type;
            foreach (var raw in path.Split('.'))
            {
                string name = raw; var indexes = new List<int>();
                while (name.EndsWith("]", StringComparison.Ordinal))
                {
                    int open = name.LastIndexOf('[');
                    indexes.Insert(0, int.Parse(name.Substring(open + 1, name.Length - open - 2)));
                    name = name.Substring(0, open);
                }
                parent = current; last = raw;
                if (name != "")
                {
                    current = Member(current, current != null ? current.GetType() : currentType, name);
                }
                foreach (var index in indexes)
                {
                    var list = current as IList;
                    if (list == null) throw new BridgeError("'" + name + "' is not a list.");
                    if (index < 0 || index >= list.Count) throw new BridgeError("'" + name + "' has " + list.Count + " items.");
                    current = list[index];
                }
                if (current == null) break;
                currentType = current.GetType();
            }
            return current;
        }

        [BridgeCommand("get", "Read a value by path from a type's static members, or (with instance=<index from objects>) from a live object. No path: the object itself.",
            args = "type (required), instance (index), path (a.b[2].c), depth=1, items=20")]
        static object Get(BridgeArgs a)
        {
            Type type; object parent; string last;
            var value = Resolve(a, out type, out parent, out last);
            return new Dictionary<string, object> { { "valueType", value != null ? Short(value.GetType()) : null }, { "value", Dump(value, a.Int("depth", 1), a.Int("items", 20)) } };
        }

        static object Coerce(object raw, Type target)
        {
            if (raw == null) return null;
            // {"type": ..., "instance": ..., "path": ...}: a live object, found the way get finds it.
            var reference = raw as Dictionary<string, object>;
            if (reference != null && reference.ContainsKey("type"))
            {
                Type t; object parent; string last;
                var found = Resolve(new BridgeArgs(reference), out t, out parent, out last);
                if (found != null && !target.IsInstanceOfType(found)) throw new BridgeError("The referenced " + Short(found.GetType()) + " is not a " + Short(target) + ".");
                return found;
            }
            if (target.IsEnum) return Enum.Parse(target, Convert.ToString(raw), true);
            if (target == typeof(string)) return Convert.ToString(raw);
            if (target == typeof(bool)) return raw is bool ? raw : (object)bool.Parse(Convert.ToString(raw));
            var list = raw as List<object>;
            if (list != null)
            {
                var n = list.Select(o => Convert.ToSingle(o, System.Globalization.CultureInfo.InvariantCulture)).ToArray();
                if (target == typeof(Vector2)) return new Vector2(n[0], n[1]);
                if (target == typeof(Vector3)) return new Vector3(n[0], n[1], n[2]);
                if (target == typeof(Vector4)) return new Vector4(n[0], n[1], n[2], n[3]);
                if (target == typeof(Quaternion)) return new Quaternion(n[0], n[1], n[2], n[3]);
                if (target == typeof(Color)) return new Color(n[0], n[1], n[2], n.Length > 3 ? n[3] : 1);
            }
            if (target.IsPrimitive) return Convert.ChangeType(raw, target, System.Globalization.CultureInfo.InvariantCulture);
            throw new BridgeError("Cannot turn " + raw.GetType().Name + " into " + Short(target) + ".");
        }

        [BridgeCommand("set", "Set a field or property by path (numbers, booleans, strings, enum names, [x,y,z] vectors and colours).",
            args = "type (required), instance (index), path (required), value (required)")]
        static object Set(BridgeArgs a)
        {
            var path = a.Require("path");
            int dot = path.LastIndexOf('.');
            var parentArgs = new Dictionary<string, object> { { "type", a.Raw("type") }, { "instance", a.Raw("instance") }, { "path", dot < 0 ? "" : path.Substring(0, dot) } };
            Type type; object ignored; string last;
            var owner = Resolve(new BridgeArgs(parentArgs), out type, out ignored, out last);
            string name = dot < 0 ? path : path.Substring(dot + 1);
            var ownerType = owner != null ? owner.GetType() : type;
            for (var t = ownerType; t != null; t = t.BaseType)
            {
                var f = t.GetField(name, All | BindingFlags.DeclaredOnly);
                if (f != null) { f.SetValue(f.IsStatic ? null : owner, Coerce(a.Raw("value"), f.FieldType)); return Dump(f.GetValue(f.IsStatic ? null : owner), 1, 20); }
                var p = t.GetProperty(name, All | BindingFlags.DeclaredOnly);
                if (p != null && p.CanWrite) { p.SetValue(owner, Coerce(a.Raw("value"), p.PropertyType), null); return Dump(p.GetValue(owner, null), 1, 20); }
            }
            throw new BridgeError("No settable '" + name + "' on " + ownerType.FullName + ".");
        }

        [BridgeCommand("call", "Call a method (static, or with instance/path on a live object) with simple arguments; the result is dumped like get. An IEnumerator result is run as a coroutine on the bridge object and not waited for.",
            args = "type (required), instance (index), path (to the object the method is on), method (required), args=[...], depth=1, items=20")]
        static object Call(BridgeArgs a)
        {
            Type type; object parent; string last;
            var target = Resolve(a, out type, out parent, out last);
            var targetType = target != null ? target.GetType() : type;
            var given = a.List("args") ?? new List<object>();
            string name = a.Require("method");
            var candidates = new List<MethodInfo>();
            for (var t = targetType; t != null; t = t.BaseType)
                candidates.AddRange(t.GetMethods(All | BindingFlags.DeclaredOnly).Where(m => m.Name == name && m.GetParameters().Length == given.Count));
            if (candidates.Count == 0) throw new BridgeError("No method " + name + " with " + given.Count + " argument(s) on " + targetType.FullName + ".");
            Exception lastError = null;
            foreach (var m in candidates)
            {
                object[] converted;
                try { converted = m.GetParameters().Select((p, i) => Coerce(given[i], p.ParameterType)).ToArray(); }
                catch (Exception e) { lastError = e; continue; }
                object result;
                try { result = m.Invoke(m.IsStatic ? null : target, converted); }
                catch (TargetInvocationException e) { throw e.InnerException ?? e; }
                var routine = result as IEnumerator;
                if (routine != null) { PlayerBridge.Run(routine); return new Dictionary<string, object> { { "called", Sig(m) }, { "result", "(coroutine started)" } }; }
                return new Dictionary<string, object> { { "called", Sig(m) }, { "result", Dump(result, a.Int("depth", 1), a.Int("items", 20)) } };
            }
            throw new BridgeError("Arguments do not fit " + name + ": " + (lastError != null ? lastError.Message : ""));
        }
    }
}
