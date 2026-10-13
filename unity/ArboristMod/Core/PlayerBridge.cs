// The GolfMap bridge inside a Unity player (Arborist): the same HTTP protocol as the editor
// bridge (unity/Editor/GolfMapBridge/BridgeServer.cs: /status, POST /cmd/<name>, /job/<id>,
// X-Bridge-Token), so unity/mcp/bridge.ts talks to it unchanged. It announces itself in its own
// folder, %LOCALAPPDATA%\GolfMapPlayerBridge\bridge-<pid>.json, so the tools that look for an
// open Unity editor never pick a player by mistake (point GOLFMAP_BRIDGE_DIR there to reach it).
//
// Loaded into the player by whatever loader calls Boot() once (see README.md). Commands are
// [BridgeCommand] methods, as in the editor; they run on the main thread from Update.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GolfMap.Bridge
{
    public sealed class PlayerBridge : MonoBehaviour
    {
        const int FirstPort = 8790, PortCount = 10, DefaultTimeoutSeconds = 60, LogCapacity = 2000;

        sealed class Job
        {
            public string id, command;
            public BridgeArgs args;
            public DateTime started;
            public readonly ManualResetEvent done = new ManualResetEvent(false);
            public Dictionary<string, object> response;
        }

        public sealed class LogEntry { public int seq; public string type, message, stack, time; }

        static PlayerBridge instance;
        static HttpListener listener;
        static string token, discoveryFile, appPath;
        static int port, jobCounter, logSeq;
        static readonly Queue<Job> queue = new Queue<Job>();
        static readonly Dictionary<string, Job> jobs = new Dictionary<string, Job>();
        static readonly List<LogEntry> log = new List<LogEntry>();
        static volatile string snapshot = "{}";
        static readonly string started = DateTime.Now.ToString("s");
        Job running;
        IEnumerator runningSteps;
        float lastSnapshot;

        public static void Run(IEnumerator routine) { instance.StartCoroutine(routine); }
        public static int LastSeq { get { return logSeq; } }
        public static string AppPath { get { return appPath; } }

        // The loader's one call. Safe to call more than once.
        public static void Boot()
        {
            if (instance) return;
            var go = new GameObject("GolfMapPlayerBridge");
            DontDestroyOnLoad(go);
            go.hideFlags = HideFlags.HideAndDontSave;
            instance = go.AddComponent<PlayerBridge>();
        }

        void Awake()
        {
            appPath = Path.GetDirectoryName(Application.dataPath).Replace('\\', '/');
            Application.logMessageReceivedThreaded += OnLog;
            token = Guid.NewGuid().ToString("N");
            for (int p = FirstPort; p < FirstPort + PortCount && listener == null; p++)
            {
                var l = new HttpListener();
                l.Prefixes.Add("http://127.0.0.1:" + p + "/");
                try { l.Start(); listener = l; port = p; }
                catch (Exception) { try { l.Close(); } catch (Exception) { } }
            }
            if (listener == null) { Debug.LogWarning("[GolfMapPlayerBridge] No free port; the bridge is off."); return; }
            new Thread(Accept) { IsBackground = true, Name = "GolfMapPlayerBridge" }.Start(listener);
            var pid = System.Diagnostics.Process.GetCurrentProcess().Id;
            var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GolfMapPlayerBridge");
            Directory.CreateDirectory(folder);
            discoveryFile = Path.Combine(folder, "bridge-" + pid + ".json");
            File.WriteAllText(discoveryFile, BridgeJson.Write(new Dictionary<string, object>
            {
                { "pid", pid }, { "port", port }, { "token", token }, { "projectPath", appPath },
                { "projectName", Application.productName }, { "unityVersion", Application.unityVersion }, { "started", started },
            }));
            try { PlayerRegistry.Load(); }
            catch (Exception e) { Debug.LogWarning("[GolfMapPlayerBridge] No commands loaded: " + e.Message); }
            Debug.Log("[GolfMapPlayerBridge] Listening on http://127.0.0.1:" + port + "/ (" + discoveryFile + ").");
        }

        void OnApplicationQuit()
        {
            var l = listener; listener = null;
            if (l != null) { try { l.Close(); } catch (Exception) { } }
            try { if (discoveryFile != null && File.Exists(discoveryFile)) File.Delete(discoveryFile); } catch (Exception) { }
        }

        static void OnLog(string message, string stack, LogType type)
        {
            lock (log)
            {
                log.Add(new LogEntry { seq = ++logSeq, type = type.ToString().ToLowerInvariant(), message = message, stack = stack, time = DateTime.Now.ToString("HH:mm:ss.fff") });
                if (log.Count > LogCapacity) log.RemoveRange(0, log.Count - LogCapacity);
            }
        }

        public static List<LogEntry> LogSince(int since)
        {
            lock (log) return log.FindAll(e => e.seq > since);
        }

        // ---- HTTP side (background threads) ----

        static void Accept(object state)
        {
            var l = (HttpListener)state;
            while (l.IsListening)
            {
                HttpListenerContext context;
                try { context = l.GetContext(); }
                catch (Exception) { return; }
                ThreadPool.QueueUserWorkItem(Handle, context);
            }
        }

        static void Handle(object state)
        {
            var context = (HttpListenerContext)state;
            Dictionary<string, object> response;
            int statusCode = 200;
            try
            {
                if (context.Request.Headers["X-Bridge-Token"] != token) { statusCode = 403; response = Error("Bad or missing X-Bridge-Token."); }
                else response = Route(context.Request);
            }
            catch (Exception e) { response = Error(e.Message); }
            try
            {
                var bytes = Encoding.UTF8.GetBytes(BridgeJson.Write(response));
                context.Response.StatusCode = statusCode;
                context.Response.ContentType = "application/json; charset=utf-8";
                context.Response.ContentLength64 = bytes.Length;
                context.Response.OutputStream.Write(bytes, 0, bytes.Length);
                context.Response.OutputStream.Close();
            }
            catch (Exception) { }
        }

        static Dictionary<string, object> Route(HttpListenerRequest request)
        {
            var path = request.Url.AbsolutePath.TrimEnd('/');
            if (path == "/status") return new Dictionary<string, object> { { "ok", true }, { "result", BridgeJson.Parse(snapshot) } };
            if (path.StartsWith("/job/", StringComparison.Ordinal))
            {
                Job job;
                lock (jobs) jobs.TryGetValue(path.Substring(5), out job);
                if (job == null) return Error("Unknown job.");
                return Wait(job, Timeout(request));
            }
            if (path.StartsWith("/cmd/", StringComparison.Ordinal) && request.HttpMethod == "POST")
            {
                string body;
                using (var reader = new StreamReader(request.InputStream, Encoding.UTF8)) body = reader.ReadToEnd();
                var args = string.IsNullOrWhiteSpace(body) ? null : BridgeJson.Parse(body) as Dictionary<string, object>;
                var job = new Job { id = Interlocked.Increment(ref jobCounter).ToString(), command = Uri.UnescapeDataString(path.Substring(5)), args = new BridgeArgs(args), started = DateTime.Now };
                lock (jobs) jobs[job.id] = job;
                lock (queue) queue.Enqueue(job);
                return Wait(job, Timeout(request));
            }
            return Error("Unknown endpoint " + request.HttpMethod + " " + path);
        }

        static int Timeout(HttpListenerRequest request)
        {
            int seconds;
            return int.TryParse(request.Headers["X-Bridge-Timeout"], out seconds) && seconds > 0 ? Math.Min(seconds, 600) : DefaultTimeoutSeconds;
        }

        static Dictionary<string, object> Wait(Job job, int seconds)
        {
            if (!job.done.WaitOne(TimeSpan.FromSeconds(seconds)))
                return new Dictionary<string, object> { { "ok", false }, { "pending", true }, { "job", job.id }, { "command", job.command }, { "error", "Still running after " + seconds + " s; poll /job/" + job.id + "." } };
            lock (jobs) jobs.Remove(job.id);
            return job.response;
        }

        static Dictionary<string, object> Error(string message) { return new Dictionary<string, object> { { "ok", false }, { "error", message } }; }

        // ---- Main thread ----

        void Update()
        {
            if (running != null || Time.unscaledTime - lastSnapshot > 0.25f) { lastSnapshot = Time.unscaledTime; TakeSnapshot(); }
            if (running != null) { Step(); return; }
            Job next = null;
            lock (queue) if (queue.Count > 0) next = queue.Dequeue();
            if (next == null) return;
            running = next;
            try
            {
                var result = PlayerRegistry.Invoke(next.command, next.args);
                runningSteps = result as IEnumerator;
                if (runningSteps == null) Complete(result);
            }
            catch (Exception e) { Fail(e); }
        }

        void Step()
        {
            try
            {
                if (!runningSteps.MoveNext()) { Complete(null); return; }
                if (runningSteps.Current != null) Complete(runningSteps.Current);
            }
            catch (Exception e) { Fail(e); }
        }

        void Complete(object result)
        {
            var job = running; running = null; runningSteps = null;
            job.response = new Dictionary<string, object> { { "ok", true }, { "result", result }, { "consoleSeq", logSeq } };
            job.done.Set();
        }

        void Fail(Exception e)
        {
            var job = running; running = null; runningSteps = null;
            var response = Error(e is BridgeError ? e.Message : e.GetType().Name + ": " + e.Message);
            if (!(e is BridgeError)) response["stack"] = e.StackTrace;
            response["consoleSeq"] = logSeq;
            job.response = response;
            job.done.Set();
        }

        void TakeSnapshot()
        {
            var scenes = new List<object>();
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var s = SceneManager.GetSceneAt(i);
                scenes.Add(new Dictionary<string, object> { { "name", s.name }, { "path", s.path }, { "loaded", s.isLoaded } });
            }
            var state = new Dictionary<string, object>
            {
                { "projectPath", appPath }, { "product", Application.productName }, { "unityVersion", Application.unityVersion },
                { "domainStarted", started }, { "compiling", false }, { "updating", false }, { "playing", true },
                { "scenes", scenes }, { "consoleSeq", logSeq },
            };
            if (running != null) state["busy"] = new Dictionary<string, object> { { "command", running.command }, { "job", running.id }, { "seconds", (int)(DateTime.Now - running.started).TotalSeconds } };
            snapshot = BridgeJson.Write(state);
        }
    }
}
