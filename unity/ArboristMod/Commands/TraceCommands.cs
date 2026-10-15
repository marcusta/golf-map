// The frame recorder: every frame's time, where the game camera stood and looked, which hole it
// was on, and where the main thread spent the frame. Made for GreenKeeper's Course Flyover
// Benchmark (unity/ArboristMod/greenkeeper.ts), so a slow stretch can be put on the map; works in
// any of the players. Recording allocates nothing per frame: fixed arrays, written out on stop.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEngine;

namespace GolfMap.Bridge
{
    // One frame, in the order the player loop passes the marks:
    //   end of frame n-1 -> our Update   "pre"     present / wait for the GPU, input, scripts before ours
    //   our Update -> our LateUpdate     "scripts" the other Update and LateUpdate scripts (VSP among them)
    //   our LateUpdate -> camera cull    "late"    LateUpdate scripts after ours, animation, Cinemachine
    //   cull -> post render (game camera) "render" culling and drawing of the game camera
    //   post render -> end of frame      "after"   other cameras, post-processing, UI
    // Where our two scripts sit among the app's is not fixed, so "pre" / "scripts" / "late" share a border.
    sealed class FrameRecorder : MonoBehaviour
    {
        public int capacity;
        public Func<int> hole;
        public int count, dropped;
        public float[] dt, pre, scripts, late, render, after, x, y, z, yaw, pitch, t;
        public short[] holes;
        public byte[] gc;

        Camera cam;
        double tEnd, tUpdate, tLate, tCull, tPost;
        int lastGc, currentHole = -1;
        static readonly double tick = 1000.0 / System.Diagnostics.Stopwatch.Frequency;
        static double Now() { return System.Diagnostics.Stopwatch.GetTimestamp() * tick; }

        public void Init(int n)
        {
            capacity = n;
            dt = new float[n]; pre = new float[n]; scripts = new float[n]; late = new float[n]; render = new float[n]; after = new float[n];
            x = new float[n]; y = new float[n]; z = new float[n]; yaw = new float[n]; pitch = new float[n]; t = new float[n];
            holes = new short[n]; gc = new byte[n];
            lastGc = GC.CollectionCount(0);
            Camera.onPreCull += OnCull;
            Camera.onPostRender += OnPost;
            StartCoroutine(EndOfFrame());
        }

        void OnDestroy() { Camera.onPreCull -= OnCull; Camera.onPostRender -= OnPost; }

        void Update()
        {
            tUpdate = Now();
            if (!cam || !cam.isActiveAndEnabled || Time.frameCount % 60 == 0) cam = GameCamera();
            if (hole != null && Time.frameCount % 10 == 0) { try { currentHole = hole(); } catch { currentHole = -1; } }
        }

        void LateUpdate() { tLate = Now(); }
        void OnCull(Camera c) { if (c == cam) tCull = Now(); }
        void OnPost(Camera c) { if (c == cam) tPost = Now(); }

        IEnumerator EndOfFrame()
        {
            var wait = new WaitForEndOfFrame();
            while (true)
            {
                yield return wait;
                double now = Now();
                if (tEnd > 0 && tUpdate > tEnd && tCull >= tLate && tPost >= tCull)
                {
                    if (count >= capacity) dropped++;
                    else
                    {
                        int i = count++;
                        dt[i] = Time.unscaledDeltaTime * 1000f;
                        pre[i] = (float)(tUpdate - tEnd); scripts[i] = (float)(tLate - tUpdate); late[i] = (float)(tCull - tLate);
                        render[i] = (float)(tPost - tCull); after[i] = (float)(now - tPost);
                        t[i] = Time.realtimeSinceStartup;
                        if (cam)
                        {
                            var p = cam.transform.position; var e = cam.transform.eulerAngles;
                            x[i] = p.x; y[i] = p.y; z[i] = p.z; yaw[i] = e.y; pitch[i] = e.x > 180 ? e.x - 360 : e.x;
                        }
                        holes[i] = (short)currentHole;
                        int g = GC.CollectionCount(0);
                        gc[i] = (byte)Mathf.Min(255, g - lastGc); lastGc = g;
                    }
                }
                tEnd = now;
            }
        }

        // The camera that draws the picture: the deepest enabled one that renders to the screen.
        static Camera GameCamera()
        {
            Camera best = null;
            foreach (var c in Camera.allCameras)
                if (c.targetTexture == null && c.isActiveAndEnabled && (!best || c.depth > best.depth)) best = c;
            return best;
        }
    }

    static class TraceCommands
    {
        static FrameRecorder recorder;

        // "MainLogic.CartOnHole": a Text (or a number) field of the first live object of that type; the
        // first whole number in its text is the hole.
        static Func<int> HoleReader(string spec)
        {
            if (string.IsNullOrEmpty(spec)) return null;
            int dot = spec.LastIndexOf('.');
            if (dot < 0) throw new BridgeError("hole is Type.field, e.g. MainLogic.CartOnHole");
            string typeName = spec.Substring(0, dot), fieldName = spec.Substring(dot + 1);
            var type = AppDomain.CurrentDomain.GetAssemblies().Select(asm => { try { return asm.GetType(typeName); } catch { return null; } }).FirstOrDefault(tp => tp != null);
            if (type == null) throw new BridgeError("No type " + typeName);
            var field = type.GetField(fieldName, BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            if (field == null) throw new BridgeError("No field " + fieldName + " on " + typeName);
            var owner = field.IsStatic ? null : UnityEngine.Object.FindObjectOfType(type);
            if (!field.IsStatic && owner == null) throw new BridgeError("No live " + typeName);
            var value = field.GetValue(owner);
            var text = value as UnityEngine.UI.Text;
            if (text) return () => FirstNumber(text.text);
            return () => Convert.ToInt32(field.GetValue(owner), CultureInfo.InvariantCulture);
        }

        static int FirstNumber(string s)
        {
            int n = -1;
            if (s == null) return n;
            foreach (char ch in s)
            {
                if (ch >= '0' && ch <= '9') n = (n < 0 ? 0 : n * 10) + (ch - '0');
                else if (n >= 0) break;
            }
            return n;
        }

        [BridgeCommand("trace.start", "Start the frame recorder: each frame's time, the game camera's position and heading, the hole (hole = Type.field whose text holds it, e.g. MainLogic.CartOnHole in GreenKeeper) and the main thread's split (pre: present/wait and early scripts, scripts, late, render: the game camera's cull and draw, after: other cameras, post, UI). Nothing is allocated per frame. A running recording is dropped.",
            args = "capacity=400000 (frames), hole")]
        static object Start(BridgeArgs a)
        {
            if (recorder) UnityEngine.Object.Destroy(recorder.gameObject);
            var go = new GameObject("GolfMapFrameRecorder");
            UnityEngine.Object.DontDestroyOnLoad(go);
            recorder = go.AddComponent<FrameRecorder>();
            recorder.hole = HoleReader(a.String("hole"));
            recorder.Init(Mathf.Clamp(a.Int("capacity", 400000), 1000, 2000000));
            return new Dictionary<string, object> { { "recording", true }, { "capacity", recorder.capacity }, { "hole", recorder.hole != null ? (object)recorder.hole() : null } };
        }

        [BridgeCommand("trace.status", "The frame recorder: frames recorded so far, the last frame's hole and pose, and the mean fps over the last second.")]
        static object Status(BridgeArgs a)
        {
            if (!recorder) return new Dictionary<string, object> { { "recording", false } };
            var r = recorder; int n = r.count;
            var d = new Dictionary<string, object> { { "recording", true }, { "frames", n }, { "dropped", r.dropped } };
            if (n > 0)
            {
                int i = n - 1; float sum = 0; int k = 0;
                for (int j = i; j >= 0 && sum < 1000f; j--, k++) sum += r.dt[j];
                d["hole"] = (int)r.holes[i];
                d["position"] = new List<object> { Math.Round(r.x[i], 1), Math.Round(r.y[i], 1), Math.Round(r.z[i], 1) };
                d["yaw"] = Math.Round(r.yaw[i], 1);
                d["fpsLastSecond"] = k > 0 ? Math.Round(1000.0 * k / sum, 1) : 0;
            }
            return d;
        }

        [BridgeCommand("trace.stop", "Stop the frame recorder and write what it holds as CSV (frame, t, dt and the split in ms, x y z yaw pitch, hole, gc = gen-0 collections that frame). keep=true writes without stopping.",
            args = "file (required), keep=false")]
        static object Stop(BridgeArgs a)
        {
            if (!recorder) throw new BridgeError("The recorder is not running (trace.start).");
            string file = a.Require("file");
            var r = recorder; int n = r.count;
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file)));
            var inv = CultureInfo.InvariantCulture;
            using (var w = new StreamWriter(file, false, new UTF8Encoding(false)))
            {
                w.WriteLine("frame,t,dt,pre,scripts,late,render,after,x,y,z,yaw,pitch,hole,gc");
                for (int i = 0; i < n; i++)
                    w.WriteLine(string.Format(inv, "{0},{1:0.0000},{2:0.000},{3:0.000},{4:0.000},{5:0.000},{6:0.000},{7:0.000},{8:0.00},{9:0.00},{10:0.00},{11:0.0},{12:0.0},{13},{14}",
                        i, r.t[i], r.dt[i], r.pre[i], r.scripts[i], r.late[i], r.render[i], r.after[i], r.x[i], r.y[i], r.z[i], r.yaw[i], r.pitch[i], r.holes[i], r.gc[i]));
            }
            var result = new Dictionary<string, object> { { "file", Path.GetFullPath(file).Replace('\\', '/') }, { "frames", n }, { "dropped", r.dropped } };
            if (!a.Bool("keep", false)) { UnityEngine.Object.Destroy(r.gameObject); recorder = null; }
            return result;
        }
    }
}
