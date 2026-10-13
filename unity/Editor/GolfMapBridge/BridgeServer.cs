// Editor bridge: a localhost HTTP endpoint that lets tools (the repo's MCP
// server, curl) drive this Unity editor while it is open.
//
// Course-agnostic: nothing here knows about GolfMap or any course. Drop the
// GolfMapBridge folder into any Unity 2018.2+ project under an Editor folder.
//
//   GET  /status          liveness and editor state, answered off the main thread
//   POST /cmd/<name>      run a [BridgeCommand] on the main thread; JSON body = args
//   GET  /job/<id>        result of a command that outlived the request timeout
//
// Every request needs the X-Bridge-Token header. The token, port, pid and
// project path are published in %LOCALAPPDATA%/GolfMapBridge/bridge-<pid>.json,
// which is how the MCP server finds every open editor. Binds 127.0.0.1 only.
//
// Domain reloads (every recompile) tear the listener down; it restarts on the
// same port and token when the new domain loads.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GolfMap.Bridge
{
    [InitializeOnLoad]
    public static class BridgeServer
    {
        const int FirstPort = 8765;
        const int PortCount = 20;
        const string PortKey = "GolfMapBridge.port";
        const string TokenKey = "GolfMapBridge.token";
        const int DefaultTimeoutSeconds = 60;

        sealed class Job
        {
            public string id, command;
            public BridgeArgs args;
            public DateTime started;
            public readonly ManualResetEvent done = new ManualResetEvent(false);
            public Dictionary<string, object> response;
            // The VSP watchdog ran the command a second time (once per job).
            public bool vspReset;
            public string vspFirstError;
            public object vspResetResult;
        }

        static HttpListener listener;
        static Thread acceptThread;
        static string token;
        static int port;
        static int jobCounter;
        static readonly Queue<Job> queue = new Queue<Job>();
        static readonly Dictionary<string, Job> jobs = new Dictionary<string, Job>();
        static Job running;
        static IEnumerator runningSteps;

        // Main-thread state, copied every editor tick so /status never waits on the main thread.
        static volatile string snapshot = "{}";
        static readonly string domainStarted = DateTime.Now.ToString("s");
        static string projectPath, discoveryFile;

        public static int Port { get { return port; } }

        static BridgeServer()
        {
            if (Application.isBatchMode) return;
            projectPath = Path.GetDirectoryName(Application.dataPath).Replace('\\', '/');
            BridgeConsole.Install();
            EditorApplication.update += Pump;
            AssemblyReloadEvents.beforeAssemblyReload += () => { Stop(); BridgeConsole.Save(); };
            EditorApplication.quitting += () => { Stop(); TryDelete(discoveryFile); };
            Start();
        }

        [MenuItem("GolfMap/Bridge/Restart")]
        static void Restart()
        {
            Stop();
            Start();
        }

        [MenuItem("GolfMap/Bridge/Status")]
        static void LogStatus()
        {
            Debug.Log(listener != null
                ? "[Bridge] Listening on http://127.0.0.1:" + port + "/ for " + projectPath + " (discovery: " + discoveryFile + ")."
                : "[Bridge] Not running.");
        }

        static void Start()
        {
            token = SessionState.GetString(TokenKey, "");
            if (token == "")
            {
                token = Guid.NewGuid().ToString("N");
                SessionState.SetString(TokenKey, token);
            }
            int preferred = SessionState.GetInt(PortKey, 0);
            var candidates = new List<int>();
            if (preferred != 0) candidates.Add(preferred);
            for (int p = FirstPort; p < FirstPort + PortCount; p++) if (p != preferred) candidates.Add(p);
            foreach (var p in candidates)
            {
                var l = new HttpListener();
                l.Prefixes.Add("http://127.0.0.1:" + p + "/");
                try { l.Start(); }
                catch (Exception) { try { l.Close(); } catch (Exception) { } continue; }
                listener = l;
                port = p;
                break;
            }
            if (listener == null)
            {
                Debug.LogWarning("[Bridge] No free port in " + FirstPort + "-" + (FirstPort + PortCount - 1) + "; the bridge is off.");
                return;
            }
            SessionState.SetInt(PortKey, port);
            acceptThread = new Thread(Accept) { IsBackground = true, Name = "GolfMapBridge" };
            acceptThread.Start(listener);
            WriteDiscovery();
        }

        static void Stop()
        {
            var l = listener;
            listener = null;
            if (l != null) { try { l.Close(); } catch (Exception) { } }
            lock (queue)
            {
                foreach (var job in queue) Finish(job, Error("The editor is reloading scripts; call again."));
                queue.Clear();
            }
        }

        static void WriteDiscovery()
        {
            var pid = System.Diagnostics.Process.GetCurrentProcess().Id;
            var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GolfMapBridge");
            Directory.CreateDirectory(folder);
            discoveryFile = Path.Combine(folder, "bridge-" + pid + ".json");
            File.WriteAllText(discoveryFile, BridgeJson.Write(new Dictionary<string, object>
            {
                { "pid", pid },
                { "port", port },
                { "token", token },
                { "projectPath", projectPath },
                { "projectName", Path.GetFileName(projectPath) },
                { "unityVersion", Application.unityVersion },
                { "started", domainStarted },
            }));
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
                if (context.Request.Headers["X-Bridge-Token"] != token)
                {
                    statusCode = 403;
                    response = Error("Bad or missing X-Bridge-Token.");
                }
                else response = Route(context.Request);
            }
            catch (Exception e)
            {
                response = Error(e.Message);
            }
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
            if (path == "/status")
                return new Dictionary<string, object> { { "ok", true }, { "result", BridgeJson.Parse(snapshot) } };

            if (path.StartsWith("/job/", StringComparison.Ordinal))
            {
                Job job;
                lock (jobs) jobs.TryGetValue(path.Substring(5), out job);
                if (job == null) return Error("Unknown job (jobs do not survive a script reload).");
                return Wait(job, Timeout(request));
            }

            if (path.StartsWith("/cmd/", StringComparison.Ordinal) && request.HttpMethod == "POST")
            {
                string body;
                using (var reader = new StreamReader(request.InputStream, Encoding.UTF8)) body = reader.ReadToEnd();
                var args = string.IsNullOrWhiteSpace(body) ? null : BridgeJson.Parse(body) as Dictionary<string, object>;
                var job = new Job
                {
                    id = Interlocked.Increment(ref jobCounter).ToString(),
                    command = Uri.UnescapeDataString(path.Substring(5)),
                    args = new BridgeArgs(args),
                    started = DateTime.Now,
                };
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

        // The caller gets the result, or a job id to poll when the command is still running.
        static Dictionary<string, object> Wait(Job job, int seconds)
        {
            if (!job.done.WaitOne(TimeSpan.FromSeconds(seconds)))
                return new Dictionary<string, object>
                {
                    { "ok", false }, { "pending", true }, { "job", job.id }, { "command", job.command },
                    { "error", "Still running after " + seconds + " s; poll /job/" + job.id + "." },
                };
            lock (jobs) jobs.Remove(job.id);
            return job.response;
        }

        static Dictionary<string, object> Error(string message)
        {
            return new Dictionary<string, object> { { "ok", false }, { "error", message } };
        }

        static void Finish(Job job, Dictionary<string, object> response)
        {
            job.response = response;
            job.done.Set();
        }

        // ---- Main thread ----

        static double lastSnapshot;

        static void Pump()
        {
            if (running != null || EditorApplication.timeSinceStartup - lastSnapshot > 0.25)
            {
                lastSnapshot = EditorApplication.timeSinceStartup;
                TakeSnapshot();
            }
            if (running != null) { Step(); return; }
            Job next = null;
            lock (queue) if (queue.Count > 0) next = queue.Dequeue();
            if (next == null) return;
            running = next;
            try
            {
                var result = BridgeCommands.Invoke(next.command, next.args);
                runningSteps = result as IEnumerator;
                if (runningSteps == null) Complete(result);
            }
            catch (Exception e) { Fail(e); }
        }

        // One step per editor frame, so the editor (and the Scene view) keeps updating in between.
        static void Step()
        {
            try
            {
                if (!runningSteps.MoveNext()) { Complete(null); return; }
                if (runningSteps.Current != null) Complete(runningSteps.Current);
            }
            catch (Exception e) { Fail(e); }
        }

        static void Complete(object result)
        {
            var job = running;
            running = null;
            runningSteps = null;
            var response = new Dictionary<string, object> { { "ok", true }, { "result", result }, { "consoleSeq", BridgeConsole.LastSeq } };
            if (job.vspReset) Note(response, job, result);
            Finish(job, response);
        }

        static void Fail(Exception e)
        {
            var job = running;
            // Vegetation Studio Pro's stalled job lists: cured in place, once per job.
            if (job != null && !job.vspReset && IsVspJobStall(e)) { RetryAfterVspReset(job, e); return; }
            running = null;
            runningSteps = null;
            var response = Error(e is BridgeError ? e.Message : e.GetType().Name + ": " + e.Message);
            if (!(e is BridgeError)) response["stack"] = e.StackTrace;
            response["consoleSeq"] = BridgeConsole.LastSeq;
            if (job != null && job.vspReset) Note(response, job, null);
            Finish(job, response);
        }

        // ---- VSP watchdog ----
        //
        // Once an asset refresh has orphaned the jobs one VegetationStudioPro Update
        // scheduled, every later frame and every command that refreshes vegetation
        // throws "The previously scheduled job ... You must call JobHandle.Complete()"
        // (docs/unity-gotchas.md, "VSP stuck on JobHandle.Complete()"). The cure is
        // golfmap.vsp.reset and running the command again, which is what this does for
        // the caller. Safe because our commands are idempotent: they re-read the scene
        // and the exported files and do only what is still missing.
        //
        // The reset is reached as a bridge command, not as a type: Editor/GolfMapBridge/
        // stays free of GolfMap.Editor references, and the registry already holds
        // whatever the project's scripts registered. A project without them simply has
        // no such command, and the first error is reported as it was.
        const string VspResetCommand = "golfmap.vsp.reset";

        static bool IsVspJobStall(Exception e)
        {
            for (var x = e; x != null; x = x.InnerException)
            {
                var message = x.Message ?? "";
                if (message.IndexOf("previously scheduled job", StringComparison.OrdinalIgnoreCase) >= 0 &&
                    message.IndexOf("JobHandle.Complete()", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            }
            return false;
        }

        static void RetryAfterVspReset(Job job, Exception stall)
        {
            job.vspReset = true;
            job.vspFirstError = stall.GetType().Name + ": " + stall.Message;
            runningSteps = null;
            Debug.LogWarning("[Bridge] " + job.command + " hit VSP's stalled job lists; running " + VspResetCommand + " and the command once more.\n" + stall);
            try { job.vspResetResult = RunToEnd(BridgeCommands.Invoke(VspResetCommand, new BridgeArgs(null))); }
            catch (Exception resetFailure)
            {
                job.vspResetResult = resetFailure.Message;
                Debug.LogWarning("[Bridge] " + VspResetCommand + " did not run: " + resetFailure.Message);
            }
            try
            {
                var result = BridgeCommands.Invoke(job.command, job.args);
                runningSteps = result as IEnumerator;
                if (runningSteps == null) Complete(result);
            }
            catch (Exception again) { Fail(again); } // job.vspReset is set: no second retry
        }

        // The reset cannot be stepped frame by frame from inside this one, so a
        // multi-frame reset is run to its end here; it is short either way.
        static object RunToEnd(object result)
        {
            var steps = result as IEnumerator;
            if (steps == null) return result;
            while (steps.MoveNext()) if (steps.Current != null) return steps.Current;
            return null;
        }

        static void Note(Dictionary<string, object> response, Job job, object result)
        {
            response["vspReset"] = true;
            response["vspResetAfter"] = job.vspFirstError;
            response["vspResetResult"] = job.vspResetResult;
            // Clients that see the result alone (unity/mcp/bridge.ts run()) get it too.
            var dict = result as Dictionary<string, object>;
            if (dict != null && !dict.ContainsKey("vspReset")) dict["vspReset"] = true;
        }

        static void TakeSnapshot()
        {
            var scenes = new List<object>();
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var s = SceneManager.GetSceneAt(i);
                scenes.Add(new Dictionary<string, object> { { "name", s.name }, { "path", s.path }, { "dirty", s.isDirty }, { "loaded", s.isLoaded } });
            }
            var state = new Dictionary<string, object>
            {
                { "projectPath", projectPath },
                { "unityVersion", Application.unityVersion },
                { "domainStarted", domainStarted },
                { "compiling", EditorApplication.isCompiling },
                { "updating", EditorApplication.isUpdating },
                { "playing", EditorApplication.isPlayingOrWillChangePlaymode },
                { "scenes", scenes },
                { "consoleSeq", BridgeConsole.LastSeq },
                { "queued", QueueLength() },
            };
            if (running != null)
                state["busy"] = new Dictionary<string, object> { { "command", running.command }, { "job", running.id }, { "seconds", (int)(DateTime.Now - running.started).TotalSeconds } };
            snapshot = BridgeJson.Write(state);
        }

        static int QueueLength() { lock (queue) return queue.Count; }

        static void TryDelete(string path)
        {
            try { if (!string.IsNullOrEmpty(path) && File.Exists(path)) File.Delete(path); }
            catch (Exception) { }
        }
    }
}
