// Minimal JSON writer for editor reports. JsonUtility cannot serialize
// dictionaries or nested arbitrary structures, and the OPCD base project may
// not ship Newtonsoft, so the spelunker writes JSON by hand.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapJson
    {
        public static string Serialize(object value, bool pretty = true)
        {
            var sb = new StringBuilder();
            Write(sb, value, pretty ? 0 : -1);
            return sb.ToString();
        }

        static void Write(StringBuilder sb, object value, int indent)
        {
            // C# 6 (Unity 2018.2): no type patterns, so an is/cast ladder.
            if (value == null) { sb.Append("null"); return; }
            if (value is string) { WriteString(sb, (string)value); return; }
            if (value is bool) { sb.Append((bool)value ? "true" : "false"); return; }
            if (value is float) { WriteNumber(sb, (float)value); return; }
            if (value is double) { WriteNumber(sb, (double)value); return; }
            if (value is int) { sb.Append(((int)value).ToString(CultureInfo.InvariantCulture)); return; }
            if (value is long) { sb.Append(((long)value).ToString(CultureInfo.InvariantCulture)); return; }
            if (value is Vector3) { var v = (Vector3)value; Write(sb, new object[] { v.x, v.y, v.z }, -1); return; }
            if (value is Vector2) { var v = (Vector2)value; Write(sb, new object[] { v.x, v.y }, -1); return; }
            if (value is Quaternion) { var q = (Quaternion)value; Write(sb, new object[] { q.x, q.y, q.z, q.w }, -1); return; }
            if (value is Color) { var c = (Color)value; Write(sb, new object[] { c.r, c.g, c.b, c.a }, -1); return; }
            if (value is Bounds) { var bo = (Bounds)value; Write(sb, new Dictionary<string, object> { { "center", bo.center }, { "size", bo.size } }, -1); return; }
            if (value is Enum) { WriteString(sb, value.ToString()); return; }
            var dict = value as IDictionary;
            if (dict != null) { WriteObject(sb, dict, indent); return; }
            var list = value as IEnumerable;
            if (list != null) { WriteArray(sb, list, indent); return; }
            WriteString(sb, value.ToString());
        }

        static void WriteNumber(StringBuilder sb, double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
            sb.Append(Math.Round(d, 4).ToString("R", CultureInfo.InvariantCulture));
        }

        static void WriteObject(StringBuilder sb, IDictionary dict, int indent)
        {
            sb.Append('{');
            bool first = true;
            foreach (DictionaryEntry entry in dict)
            {
                if (!first) sb.Append(',');
                first = false;
                NewLine(sb, indent < 0 ? -1 : indent + 1);
                WriteString(sb, entry.Key.ToString());
                sb.Append(indent < 0 ? ":" : ": ");
                Write(sb, entry.Value, indent < 0 ? -1 : indent + 1);
            }
            if (!first) NewLine(sb, indent);
            sb.Append('}');
        }

        static void WriteArray(StringBuilder sb, IEnumerable list, int indent)
        {
            sb.Append('[');
            bool first = true;
            foreach (var item in list)
            {
                if (!first) sb.Append(',');
                first = false;
                NewLine(sb, indent < 0 ? -1 : indent + 1);
                Write(sb, item, indent < 0 ? -1 : indent + 1);
            }
            if (!first) NewLine(sb, indent);
            sb.Append(']');
        }

        static void NewLine(StringBuilder sb, int indent)
        {
            if (indent < 0) return;
            sb.Append('\n').Append(' ', indent * 2);
        }

        static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var ch in s)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                        else sb.Append(ch);
                        break;
                }
            }
            sb.Append('"');
        }
    }
}
