// What every player bridge offers: the command list, the log, the scene, the camera and a
// screenshot of what the game camera sees. Nothing here knows Arborist; its own commands go in
// ArboristCommands.cs.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GolfMap.Bridge
{
    static class PlayerCommands
    {
        [BridgeCommand("console", "The player's log since a sequence number (Debug.Log and friends, as the bridge has captured them since it started).",
            args = "since=0, limit=100, contains, stacks=false, types=[error, exception, assert, warning, log]")]
        static object Console(BridgeArgs a)
        {
            int since = a.Int("since", 0), limit = a.Int("limit", 100);
            string contains = a.String("contains");
            bool stacks = a.Bool("stacks", false);
            var types = a.List("types");
            var hits = PlayerBridge.LogSince(since).Where(e =>
                (contains == null || e.message.IndexOf(contains, StringComparison.OrdinalIgnoreCase) >= 0) &&
                (types == null || types.Any(t => string.Equals(Convert.ToString(t), e.type, StringComparison.OrdinalIgnoreCase)))).ToList();
            var shown = hits.Skip(Math.Max(0, hits.Count - limit)).Select(e =>
            {
                var d = new Dictionary<string, object> { { "seq", e.seq }, { "time", e.time }, { "type", e.type }, { "message", e.message } };
                if (stacks && !string.IsNullOrEmpty(e.stack)) d["stack"] = e.stack;
                return (object)d;
            }).ToList();
            return new Dictionary<string, object> { { "lastSeq", PlayerBridge.LastSeq }, { "matched", hits.Count }, { "messages", shown } };
        }

        static List<object> V(Vector3 v) { return new List<object> { v.x, v.y, v.z }; }

        static Camera ViewCamera(string name = null)
        {
            var all = Camera.allCameras;
            if (!string.IsNullOrEmpty(name))
            {
                var named = Resources.FindObjectsOfTypeAll<Camera>().FirstOrDefault(c => c.name == name && c.gameObject.scene.IsValid());
                if (!named) throw new BridgeError("No camera named '" + name + "'.");
                return named;
            }
            var camera = Camera.main ? Camera.main : all.OrderByDescending(c => c.depth).FirstOrDefault(c => c.targetTexture == null);
            if (!camera) throw new BridgeError("No enabled camera.");
            return camera;
        }

        [BridgeCommand("scene", "The loaded scenes with their root objects (active?, child count, component types), and every camera.",
            args = "components=true")]
        static object Scene(BridgeArgs a)
        {
            bool components = a.Bool("components", true);
            var scenes = new List<object>();
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var s = SceneManager.GetSceneAt(i);
                if (!s.isLoaded) continue;
                scenes.Add(new Dictionary<string, object>
                {
                    { "name", s.name }, { "path", s.path },
                    { "roots", s.GetRootGameObjects().Select(g =>
                        {
                            var d = new Dictionary<string, object> { { "name", g.name }, { "active", g.activeSelf }, { "children", g.transform.childCount } };
                            if (components) d["components"] = string.Join(", ", g.GetComponents<Component>().Where(c => c && !(c is Transform)).Select(c => c.GetType().Name).ToArray());
                            return (object)d;
                        }).ToList() },
                });
            }
            return new Dictionary<string, object>
            {
                { "scenes", scenes },
                { "cameras", Camera.allCameras.Select(c => (object)new Dictionary<string, object>
                    {
                        { "name", c.name }, { "main", c == Camera.main }, { "depth", c.depth }, { "position", V(c.transform.position) },
                        { "rotation", V(c.transform.eulerAngles) }, { "fov", c.fieldOfView }, { "far", c.farClipPlane }, { "toTexture", c.targetTexture != null },
                    }).ToList() },
            };
        }

        // The app steers the camera's parent (Arborist: CameraParent with CameraControlScript, the
        // camera a child at no offset) and its keys move along the parent's axes. A camera moved on
        // its own, or put back to an old world pose after the user moved the parent, is left at an
        // offset and a roll against the parent, and WASDQE then go the wrong way. So: a lasting move
        // goes to the parent, and a pose for one capture is undone in local terms.
        // GSPro is the other way round: its camera (TVGCamera) hangs straight under MainGameObjects,
        // the root that also holds the sun, the sky and GSPro's own Vegetation Studio system. Moving
        // that parent turned the sun with the camera and, through VSP's floating origin, shifted every
        // Arborist tree by as much as the system's object moved ("trees in the sky", 2026-10-13). So
        // only a parent that is a camera rig (a single-purpose object, at most a few children) moves.
        static Transform Rig(Transform t)
        {
            var parent = t.parent;
            return parent && parent.childCount <= 3 && parent.GetComponent<Light>() == null ? parent : null;
        }

        static void MoveRig(Transform t, Vector3 position, Quaternion rotation)
        {
            var rig = Rig(t);
            if (!rig) { t.position = position; t.rotation = rotation; return; }
            rig.rotation = rotation * Quaternion.Inverse(t.localRotation);
            rig.position += position - t.position;
        }

        // The highest collider under a point (course meshes and terrain have colliders in a built course).
        static float? GroundY(float x, float z)
        {
            RaycastHit hit;
            if (Physics.Raycast(new Vector3(x, 2000f, z), Vector3.down, out hit, 4000f, ~0, QueryTriggerInteraction.Ignore)) return hit.point.y;
            return null;
        }

        static Vector3? OverGround(Vector3? position, float eye)
        {
            if (!position.HasValue || float.IsNaN(eye)) return position;
            var ground = GroundY(position.Value.x, position.Value.z);
            return ground.HasValue ? new Vector3(position.Value.x, ground.Value + eye, position.Value.z) : position;
        }

        [BridgeCommand("ground", "The height of the ground (the highest collider) at world x, z, and what was hit.", args = "x (required), z (required)")]
        static object Ground(BridgeArgs a)
        {
            float x = (float)a.Number("x", 0), z = (float)a.Number("z", 0);
            RaycastHit hit;
            if (!Physics.Raycast(new Vector3(x, 2000f, z), Vector3.down, out hit, 4000f, ~0, QueryTriggerInteraction.Ignore)) return new Dictionary<string, object> { { "hit", false } };
            return new Dictionary<string, object> { { "hit", true }, { "y", hit.point.y }, { "object", hit.collider.name } };
        }

        [BridgeCommand("camera", "The game camera's pose; with position/rotation/at it is moved first, by moving the parent the app steers, so the app's own keys keep working from the new place. reset=true repairs a rig knocked out of line (keys going the wrong way): the view is kept, without roll, and the camera sits at no offset under its parent again.",
            args = "camera (name; default the main camera), position=[x,y,z], eye (metres over the ground at x,z instead of y), rotation=[x,y,z] (euler), at=[x,y,z] (look at), reset=true")]
        static object CameraPose(BridgeArgs a)
        {
            var camera = ViewCamera(a.String("camera"));
            var t = camera.transform;
            var position = OverGround(a.Vector("position"), (float)a.Number("eye", double.NaN)); var rotation = a.Vector("rotation"); var at = a.Vector("at");
            if (a.Bool("reset", false) && Rig(t))
            {
                Vector3 p = t.position, e = t.eulerAngles;
                t.localPosition = Vector3.zero; t.localRotation = Quaternion.identity;
                t.parent.position = p; t.parent.rotation = Quaternion.Euler(e.x, e.y, 0);
            }
            if (position.HasValue || rotation.HasValue || at.HasValue)
            {
                var to = position ?? t.position;
                var facing = rotation.HasValue ? Quaternion.Euler(rotation.Value) : t.rotation;
                if (at.HasValue && (at.Value - to).sqrMagnitude > 1e-6f) facing = Quaternion.LookRotation(at.Value - to);
                MoveRig(t, to, facing);
            }
            return new Dictionary<string, object>
            {
                { "camera", camera.name }, { "position", V(t.position) }, { "rotation", V(t.eulerAngles) }, { "fov", camera.fieldOfView },
                { "localPosition", V(t.localPosition) }, { "localRotation", V(t.localEulerAngles) },
            };
        }

        // The camera's own frame, drawn into a texture for one frame: never screen pixels, so it works
        // while the window is covered, and it holds what the app draws for that camera in its normal
        // frame (VSP queues its vegetation in LateUpdate; a Camera.Render() on the side misses it).
        // The window shows the previous image for that one frame. With from/at the camera is posed
        // for the capture and put back after.
        [BridgeCommand("screenshot", "The game camera's next frame as a PNG (path in the result). from + at pose the camera for the capture only; frames = frames drawn from that pose first, so the vegetation round it loads (default 30 when posed).",
            args = "width=1280, height=720, camera (name), from=[x,y,z], eye (metres over the ground at from's x,z instead of its y), at=[x,y,z], rotation=[x,y,z], frames")]
        static IEnumerator Screenshot(BridgeArgs a)
        {
            var camera = ViewCamera(a.String("camera"));
            int width = Mathf.Clamp(a.Int("width", 1280), 16, 4096), height = Mathf.Clamp(a.Int("height", 720), 16, 4096);
            var from = OverGround(a.Vector("from"), (float)a.Number("eye", double.NaN)); var at = a.Vector("at"); var rotation = a.Vector("rotation");
            bool posed = from.HasValue || at.HasValue || rotation.HasValue;
            int frames = Mathf.Clamp(a.Int("frames", posed ? 30 : 0), 0, 600);
            var t = camera.transform;
            // Local, not world: the user may move the parent while the frames are drawn (see MoveRig).
            var oldPosition = t.localPosition; var oldRotation = t.localRotation; var worldPosition = t.position;
            Action pose = () =>
            {
                if (from.HasValue) t.position = from.Value;
                if (rotation.HasValue) t.rotation = Quaternion.Euler(rotation.Value);
                if (at.HasValue) t.LookAt(at.Value);
            };
            var rt = RenderTexture.GetTemporary(width, height, 24, RenderTextureFormat.ARGB32);
            var oldTarget = camera.targetTexture; var oldActive = RenderTexture.active;
            var shot = new Texture2D(width, height, TextureFormat.RGB24, false);
            string file = null;
            bool failed = true;
            try
            {
                for (int i = 0; i < frames; i++) { if (posed) pose(); yield return null; }
                if (posed) pose();
                camera.targetTexture = rt;
                yield return null;   // this frame is drawn into rt
                RenderTexture.active = rt;
                shot.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                shot.Apply();
                var folder = Path.Combine(Path.GetTempPath(), "GolfMapPlayerBridge");
                Directory.CreateDirectory(folder);
                file = Path.Combine(folder, "shot-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".png").Replace('\\', '/');
                File.WriteAllBytes(file, shot.EncodeToPNG());
                failed = false;
            }
            finally
            {
                camera.targetTexture = oldTarget;
                RenderTexture.active = oldActive;
                RenderTexture.ReleaseTemporary(rt);
                UnityEngine.Object.Destroy(shot);
                if (posed) { t.localPosition = oldPosition; t.localRotation = oldRotation; }
            }
            if (failed) yield break;
            yield return new Dictionary<string, object>
            {
                { "file", file }, { "width", width }, { "height", height }, { "camera", camera.name },
                { "position", V(posed && from.HasValue ? from.Value : worldPosition) },
            };
        }
    }
}
