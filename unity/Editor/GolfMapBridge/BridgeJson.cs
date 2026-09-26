// JSON for the bridge's wire format. Self-contained on purpose: the bridge is
// installed into any GSPro/OPCD course project, with or without the GolfMap
// scripts, and the base project ships no JSON library JsonUtility can't replace.
//
// Parsed values: Dictionary<string, object>, List<object>, string, double, bool, null.
// Written values: the same, plus ints, floats, enums, Unity vectors/colours/bounds
// and anything IDictionary / IEnumerable.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;

namespace GolfMap.Bridge
{
    public static class BridgeJson
    {
        public static object Parse(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            int i = 0;
            var value = ParseValue(text, ref i);
            SkipSpace(text, ref i);
            if (i != text.Length) throw new FormatException("Trailing characters at " + i);
            return value;
        }

        public static string Write(object value)
        {
            var sb = new StringBuilder();
            WriteValue(sb, value, 0);
            return sb.ToString();
        }

        static object ParseValue(string s, ref int i)
        {
            SkipSpace(s, ref i);
            if (i >= s.Length) throw new FormatException("Unexpected end of JSON");
            char c = s[i];
            if (c == '{')
            {
                var obj = new Dictionary<string, object>();
                i++;
                SkipSpace(s, ref i);
                if (s[i] == '}') { i++; return obj; }
                while (true)
                {
                    SkipSpace(s, ref i);
                    var key = ParseString(s, ref i);
                    SkipSpace(s, ref i);
                    Expect(s, ref i, ':');
                    obj[key] = ParseValue(s, ref i);
                    SkipSpace(s, ref i);
                    if (s[i] == ',') { i++; continue; }
                    Expect(s, ref i, '}');
                    return obj;
                }
            }
            if (c == '[')
            {
                var list = new List<object>();
                i++;
                SkipSpace(s, ref i);
                if (s[i] == ']') { i++; return list; }
                while (true)
                {
                    list.Add(ParseValue(s, ref i));
                    SkipSpace(s, ref i);
                    if (s[i] == ',') { i++; continue; }
                    Expect(s, ref i, ']');
                    return list;
                }
            }
            if (c == '"') return ParseString(s, ref i);
            if (Word(s, ref i, "true")) return true;
            if (Word(s, ref i, "false")) return false;
            if (Word(s, ref i, "null")) return null;
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            if (start == i) throw new FormatException("Unexpected '" + c + "' at " + i);
            return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        static string ParseString(string s, ref int i)
        {
            Expect(s, ref i, '"');
            var sb = new StringBuilder();
            while (true)
            {
                if (i >= s.Length) throw new FormatException("Unterminated string");
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                char e = s[i++];
                switch (e)
                {
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u': sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber)); i += 4; break;
                    default: sb.Append(e); break;
                }
            }
        }

        static bool Word(string s, ref int i, string word)
        {
            if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) return false;
            i += word.Length;
            return true;
        }

        static void Expect(string s, ref int i, char c)
        {
            if (i >= s.Length || s[i] != c) throw new FormatException("Expected '" + c + "' at " + i);
            i++;
        }

        static void SkipSpace(string s, ref int i)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        }

        // Depth guard: a result built from scene objects must never recurse forever.
        static void WriteValue(StringBuilder sb, object v, int depth)
        {
            if (depth > 32) { WriteString(sb, "<too deep>"); return; }
            if (v == null) { sb.Append("null"); return; }
            if (v is string) { WriteString(sb, (string)v); return; }
            if (v is bool) { sb.Append((bool)v ? "true" : "false"); return; }
            if (v is double) { WriteNumber(sb, (double)v); return; }
            if (v is float)
            {
                // Round-trip the float's own digits: 0.1f, not 0.100000001490116.
                float f = (float)v;
                if (float.IsNaN(f) || float.IsInfinity(f)) sb.Append("null");
                else sb.Append(f.ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            if (v is int || v is long || v is short || v is byte || v is uint || v is ulong)
            {
                sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture));
                return;
            }
            if (v is Enum) { WriteString(sb, v.ToString()); return; }
            if (v is Vector2) { var a = (Vector2)v; WriteValue(sb, new object[] { a.x, a.y }, depth + 1); return; }
            if (v is Vector3) { var a = (Vector3)v; WriteValue(sb, new object[] { a.x, a.y, a.z }, depth + 1); return; }
            if (v is Vector4) { var a = (Vector4)v; WriteValue(sb, new object[] { a.x, a.y, a.z, a.w }, depth + 1); return; }
            if (v is Quaternion) { var a = ((Quaternion)v).eulerAngles; WriteValue(sb, new object[] { a.x, a.y, a.z }, depth + 1); return; }
            if (v is Color) { var a = (Color)v; WriteValue(sb, new object[] { a.r, a.g, a.b, a.a }, depth + 1); return; }
            if (v is Rect) { var a = (Rect)v; WriteValue(sb, new object[] { a.x, a.y, a.width, a.height }, depth + 1); return; }
            if (v is Bounds)
            {
                var a = (Bounds)v;
                WriteValue(sb, new Dictionary<string, object> { { "center", a.center }, { "size", a.size } }, depth + 1);
                return;
            }
            var dict = v as IDictionary;
            if (dict != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (DictionaryEntry e in dict)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, Convert.ToString(e.Key, CultureInfo.InvariantCulture));
                    sb.Append(':');
                    WriteValue(sb, e.Value, depth + 1);
                }
                sb.Append('}');
                return;
            }
            var list = v as IEnumerable;
            if (list != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (var item in list)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteValue(sb, item, depth + 1);
                }
                sb.Append(']');
                return;
            }
            WriteString(sb, v.ToString());
        }

        static void WriteNumber(StringBuilder sb, double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
            sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
        }

        static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }
}
