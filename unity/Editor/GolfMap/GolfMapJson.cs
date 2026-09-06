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
            switch (value)
            {
                case null: sb.Append("null"); return;
                case string s: WriteString(sb, s); return;
                case bool b: sb.Append(b ? "true" : "false"); return;
                case float f: WriteNumber(sb, f); return;
                case double d: WriteNumber(sb, d); return;
                case int i: sb.Append(i.ToString(CultureInfo.InvariantCulture)); return;
                case long l: sb.Append(l.ToString(CultureInfo.InvariantCulture)); return;
                case Vector3 v: Write(sb, new object[] { v.x, v.y, v.z }, -1); return;
                case Vector2 v: Write(sb, new object[] { v.x, v.y }, -1); return;
                case Quaternion q: Write(sb, new object[] { q.x, q.y, q.z, q.w }, -1); return;
                case Color c: Write(sb, new object[] { c.r, c.g, c.b, c.a }, -1); return;
                case Bounds bo: Write(sb, new Dictionary<string, object> { { "center", bo.center }, { "size", bo.size } }, -1); return;
                case Enum e: WriteString(sb, e.ToString()); return;
                case IDictionary dict: WriteObject(sb, dict, indent); return;
                case IEnumerable list: WriteArray(sb, list, indent); return;
                default: WriteString(sb, value.ToString()); return;
            }
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
