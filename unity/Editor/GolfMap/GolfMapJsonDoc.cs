// Lossless JSON document for files that are edited from both sides (palette.json).
//
// JsonUtility drops every key it has no field for and cannot hold a map, so a
// load/save through it would strip "zones", "originalPath" and any species the
// class does not name. This keeps the whole tree: objects preserve key order,
// and a number keeps its source text until it is actually changed, so a save
// that touches one weight produces a one-line diff. Output matches
// JSON.stringify(value, null, 2) + "\n", which is what the node scripts write.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace GolfMap.Editor
{
    public sealed class GolfMapJsonNumber
    {
        public readonly string raw;
        public GolfMapJsonNumber(string raw) { this.raw = raw; }
        public double Value { get { return double.Parse(raw, NumberStyles.Float, CultureInfo.InvariantCulture); } }
    }

    // Ordered string -> value map. Values: GolfMapJsonObject, List<object>, string,
    // GolfMapJsonNumber, bool or null.
    public sealed class GolfMapJsonObject
    {
        public readonly List<string> keys = new List<string>();
        readonly Dictionary<string, object> values = new Dictionary<string, object>();

        public bool Has(string key) { return values.ContainsKey(key); }
        public object this[string key]
        {
            get { object v; return values.TryGetValue(key, out v) ? v : null; }
            set { if (!values.ContainsKey(key)) keys.Add(key); values[key] = value; }
        }
        public void Remove(string key) { if (values.Remove(key)) keys.Remove(key); }

        public GolfMapJsonObject Object(string key) { return this[key] as GolfMapJsonObject; }
        public List<object> Array(string key) { return this[key] as List<object>; }
        public string String(string key) { return this[key] as string; }
        public double Number(string key, double fallback = 0) { var n = this[key] as GolfMapJsonNumber; return n != null ? n.Value : fallback; }
        public bool Bool(string key, bool fallback) { var v = this[key]; return v is bool ? (bool)v : fallback; }

        // Leaves the source token alone when the value did not change.
        public void SetNumber(string key, double value)
        {
            var n = this[key] as GolfMapJsonNumber;
            if (n != null && n.Value == value) return;
            this[key] = new GolfMapJsonNumber(GolfMapJsonDoc.Format(value));
        }
        public void SetString(string key, string value) { if (String(key) != value) this[key] = value; }
        public void SetBool(string key, bool value) { var v = this[key]; if (!(v is bool) || (bool)v != value) this[key] = value; }
    }

    public static class GolfMapJsonDoc
    {
        public static GolfMapJsonObject ParseObject(string text)
        {
            int i = 0;
            text = text.TrimStart('\uFEFF');
            var value = Read(text, ref i) as GolfMapJsonObject;
            Skip(text, ref i);
            if (value == null || i != text.Length) throw new FormatException("Expected one JSON object.");
            return value;
        }

        // Shortest text that parses back to the same double, without an exponent (as JS prints
        // every magnitude a palette holds).
        public static string Format(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) throw new ArgumentException("JSON cannot hold " + value);
            if (value == Math.Floor(value) && Math.Abs(value) < 1e15) return ((long)value).ToString(CultureInfo.InvariantCulture);
            var text = value.ToString("R", CultureInfo.InvariantCulture);
            for (int digits = 1; digits < 17; digits++)
            {
                var shorter = value.ToString("G" + digits, CultureInfo.InvariantCulture);
                if (double.Parse(shorter, NumberStyles.Float, CultureInfo.InvariantCulture) == value) { text = shorter; break; }
            }
            if (text.IndexOf('E') >= 0) text = ((decimal)value).ToString(CultureInfo.InvariantCulture);
            return text;
        }

        // Deep copy of a value tree (duplicating a look copies its recorded materials too).
        public static object Clone(object value)
        {
            var obj = value as GolfMapJsonObject;
            if (obj != null) { var copy = new GolfMapJsonObject(); foreach (var key in obj.keys) copy[key] = Clone(obj[key]); return copy; }
            var list = value as List<object>;
            if (list != null) { var copy = new List<object>(); foreach (var item in list) copy.Add(Clone(item)); return copy; }
            return value;   // strings, numbers and bools are immutable
        }

        public static string Write(GolfMapJsonObject root)
        {
            var sb = new StringBuilder();
            Write(sb, root, 0);
            sb.Append('\n');
            return sb.ToString();
        }

        static void Write(StringBuilder sb, object value, int depth)
        {
            if (value == null) { sb.Append("null"); return; }
            if (value is string) { WriteString(sb, (string)value); return; }
            if (value is bool) { sb.Append((bool)value ? "true" : "false"); return; }
            var number = value as GolfMapJsonNumber;
            if (number != null) { sb.Append(number.raw); return; }
            var obj = value as GolfMapJsonObject;
            if (obj != null)
            {
                if (obj.keys.Count == 0) { sb.Append("{}"); return; }
                sb.Append("{\n");
                for (int k = 0; k < obj.keys.Count; k++)
                {
                    Indent(sb, depth + 1); WriteString(sb, obj.keys[k]); sb.Append(": ");
                    Write(sb, obj[obj.keys[k]], depth + 1);
                    sb.Append(k < obj.keys.Count - 1 ? ",\n" : "\n");
                }
                Indent(sb, depth); sb.Append('}');
                return;
            }
            var list = value as List<object>;
            if (list == null) throw new ArgumentException("Not a JSON value: " + value.GetType().Name);
            if (list.Count == 0) { sb.Append("[]"); return; }
            sb.Append("[\n");
            for (int k = 0; k < list.Count; k++)
            {
                Indent(sb, depth + 1); Write(sb, list[k], depth + 1);
                sb.Append(k < list.Count - 1 ? ",\n" : "\n");
            }
            Indent(sb, depth); sb.Append(']');
        }

        static void Indent(StringBuilder sb, int depth) { sb.Append(' ', depth * 2); }

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
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        static void Skip(string s, ref int i) { while (i < s.Length && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) i++; }

        static object Read(string s, ref int i)
        {
            Skip(s, ref i);
            if (i >= s.Length) throw new FormatException("Unexpected end of JSON.");
            char c = s[i];
            if (c == '{')
            {
                var obj = new GolfMapJsonObject(); i++;
                Skip(s, ref i);
                if (s[i] == '}') { i++; return obj; }
                while (true)
                {
                    Skip(s, ref i);
                    if (s[i] != '"') throw Error(s, i, "key");
                    var key = ReadString(s, ref i);
                    Skip(s, ref i);
                    if (s[i++] != ':') throw Error(s, i - 1, "':'");
                    obj[key] = Read(s, ref i);
                    Skip(s, ref i);
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == '}') { i++; return obj; }
                    throw Error(s, i, "',' or '}'");
                }
            }
            if (c == '[')
            {
                var list = new List<object>(); i++;
                Skip(s, ref i);
                if (s[i] == ']') { i++; return list; }
                while (true)
                {
                    list.Add(Read(s, ref i));
                    Skip(s, ref i);
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == ']') { i++; return list; }
                    throw Error(s, i, "',' or ']'");
                }
            }
            if (c == '"') return ReadString(s, ref i);
            if (string.CompareOrdinal(s, i, "true", 0, 4) == 0) { i += 4; return true; }
            if (string.CompareOrdinal(s, i, "false", 0, 5) == 0) { i += 5; return false; }
            if (string.CompareOrdinal(s, i, "null", 0, 4) == 0) { i += 4; return null; }
            int start = i;
            while (i < s.Length && (char.IsDigit(s[i]) || s[i] == '-' || s[i] == '+' || s[i] == '.' || s[i] == 'e' || s[i] == 'E')) i++;
            if (i == start) throw Error(s, i, "a value");
            var number = new GolfMapJsonNumber(s.Substring(start, i - start));
            double check;
            if (!double.TryParse(number.raw, NumberStyles.Float, CultureInfo.InvariantCulture, out check)) throw Error(s, start, "a number");
            return number;
        }

        static string ReadString(string s, ref int i)
        {
            var sb = new StringBuilder(); i++;
            while (true)
            {
                if (i >= s.Length) throw new FormatException("Unterminated JSON string.");
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
                    case 'u': sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture)); i += 4; break;
                    default: sb.Append(e); break;
                }
            }
        }

        static FormatException Error(string s, int i, string expected)
        {
            int line = 1; for (int k = 0; k < i && k < s.Length; k++) if (s[k] == '\n') line++;
            return new FormatException("JSON line " + line + ": expected " + expected + ".");
        }
    }
}
