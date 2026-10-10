//! PhotoCraft's retouching tools on one flat photo: the Clean tool's pixel engine.
//!
//! The cleaned photo is a PhotoCraft document with a single RGBA8 layer. The tools are
//! PhotoCraft's own commands (`paint.cloneStamp`, `paint.healingBrush`, `paint.spotHealing`,
//! `paint.remove`), run with the params the editor's own tools send, so a stroke here is the
//! stroke PhotoCraft paints. Undo and redo are the document's history.
//!
//! The caller (web/src/clean/retouch.worker.ts) loads the pixels once, drives strokes, and reads
//! back the rectangles that changed: to show them on the map and to write them into the photo
//! file. Nothing here knows about maps, files or the network.

use std::sync::Arc;

use photocraft_color::{ColorMode, PixelFormat, SampleType};
use photocraft_doc::{Document, Layer};
use photocraft_engine::Session;
use photocraft_engine::retouch_cmds::LiveRetouch;
use photocraft_geom::{Rect, Size};
use photocraft_paint::StrokePoint;
use serde_json::{Value, json};

/// The tools with a live preview while the stroke is drawn.
const LIVE: [&str; 2] = ["paint.cloneStamp", "paint.healingBrush"];

pub struct Retouch {
    session: Session,
    size: Size,
    /// The photo as loaded: what `read` compares against for `only_changed`.
    original: Option<Arc<Document>>,
    live: Option<Live>,
    /// What each history step changed, oldest first, and the steps undone since: an undo or a
    /// redo touches exactly the rectangle its command did.
    done: Vec<Rect>,
    undone: Vec<Rect>,
}

struct Live {
    stroke: LiveRetouch,
    cmd: String,
    params: Value,
    points: Vec<Value>,
}

fn rect_json(r: Rect) -> Value {
    if r.is_empty() { Value::Null } else { json!([r.x0, r.y0, r.width(), r.height()]) }
}

fn point(v: &Value) -> Option<StrokePoint> {
    let a = v.as_array()?;
    Some(StrokePoint { x: a.first()?.as_f64()?, y: a.get(1)?.as_f64()?, pressure: 1.0, ..Default::default() })
}

impl Retouch {
    /// An empty (transparent) photo of `width` x `height` pixels.
    pub fn new(width: u32, height: u32) -> Self {
        let size = Size { width, height };
        let mut doc = Document::new("photo", size, ColorMode::Rgb, SampleType::U8);
        doc.layers.push(Layer::raster("Photo", PixelFormat::RGBA8));
        let mut session = Session::new();
        session.add_document(doc, None);
        Self { session, size, original: None, live: None, done: Vec::new(), undone: Vec::new() }
    }

    fn bounds(&self) -> Rect {
        Rect::from_size(self.size)
    }

    /// Put rows of RGB bytes (3 per pixel, full width) into the photo from row `y` down. This is
    /// loading, not editing: no history step. Call `loaded` after the last strip.
    pub fn load_rgb_rows(&mut self, y: u32, rgb: &[u8]) -> Result<(), String> {
        let w = self.size.width as usize;
        if w == 0 || rgb.len() % (w * 3) != 0 {
            return Err(format!("{} bytes is not whole rows of {w} RGB pixels", rgb.len()));
        }
        let rows = (rgb.len() / (w * 3)) as u32;
        if y + rows > self.size.height {
            return Err(format!("rows {y}..{} are outside the photo ({} high)", y + rows, self.size.height));
        }
        let mut rgba = vec![255u8; w * rows as usize * 4];
        for (dst, src) in rgba.chunks_exact_mut(4).zip(rgb.chunks_exact(3)) {
            dst[..3].copy_from_slice(src);
        }
        let st = self.session.active_mut().ok_or("no document")?;
        let doc = Arc::make_mut(&mut st.doc);
        let surf = doc.layers.first_mut().and_then(Layer::surface_mut).ok_or("no pixel layer")?;
        surf.write_interleaved(Rect::from_xywh(0, y as i32, w as u32, rows), &rgba);
        Ok(())
    }

    /// The photo is complete: remember it as the original.
    pub fn loaded(&mut self) {
        self.original = self.session.active().map(|st| st.doc.clone());
    }

    /// RGBA bytes of a rectangle of the photo as it shows now (with the live stroke, if one is
    /// being drawn). With `only_changed`, pixels equal to the original get alpha 0.
    pub fn read(&self, x: i32, y: i32, w: u32, h: u32, only_changed: bool) -> Result<Vec<u8>, String> {
        let r = Rect::from_xywh(x, y, w, h);
        if r.is_empty() || r.intersect(&self.bounds()) != r {
            return Err(format!("rectangle {x},{y} {w}x{h} is outside the photo"));
        }
        let doc = match &self.live {
            Some(l) => &l.stroke.doc,
            None => &self.session.active().ok_or("no document")?.doc,
        };
        let surf = doc.layers.first().and_then(Layer::surface).ok_or("no pixel layer")?;
        let mut out = surf.to_interleaved(r);
        if only_changed && let Some(orig) = self.original.as_ref().and_then(|d| d.layers.first()).and_then(Layer::surface) {
            let was = orig.to_interleaved(r);
            for (now, before) in out.chunks_exact_mut(4).zip(was.chunks_exact(4)) {
                if now[..3] == before[..3] {
                    now[3] = 0;
                }
            }
        }
        Ok(out)
    }

    /// Start a stroke of `cmd` with `params` (PhotoCraft's brush params; `points` holds the first
    /// point). Clone Stamp and Healing Brush preview live: returns the rectangle that changed.
    /// The other tools show nothing until `end`.
    pub fn begin(&mut self, cmd: &str, params: Value) -> Result<Value, String> {
        self.live = None;
        if !LIVE.contains(&cmd) {
            return Err(format!("{cmd} has no live preview: run it with `run`"));
        }
        let points = params.get("points").and_then(Value::as_array).cloned().unwrap_or_default();
        let stroke = LiveRetouch::begin(&self.session, cmd, &params).map_err(|e| e.to_string())?;
        let changed = stroke.bounds().intersect(&self.bounds());
        self.live = Some(Live { stroke, cmd: cmd.into(), params, points });
        Ok(rect_json(changed))
    }

    /// More points of the live stroke: returns the rectangle that changed.
    pub fn push(&mut self, points: &[Value]) -> Result<Value, String> {
        let bounds = self.bounds();
        let live = self.live.as_mut().ok_or("no stroke is being drawn")?;
        let pts: Vec<StrokePoint> = points.iter().filter_map(point).collect();
        let changed = live.stroke.push(&pts).map_err(|e| e.to_string())?;
        live.points.extend(points.iter().cloned());
        Ok(rect_json(changed.intersect(&bounds)))
    }

    /// Finish the live stroke: it becomes one history step. Returns the command's result with
    /// `damage` as `[x, y, w, h]` (or null), which covers everything the preview showed.
    pub fn end(&mut self) -> Result<Value, String> {
        let live = self.live.take().ok_or("no stroke is being drawn")?;
        let shown = live.stroke.bounds();
        let mut params = live.params;
        params["points"] = Value::Array(live.points);
        self.run_shown(&live.cmd, params, shown)
    }

    /// Drop the live stroke. Returns the rectangle its preview covered.
    pub fn cancel(&mut self) -> Value {
        let shown = self.live.take().map_or(Rect::EMPTY, |l| l.stroke.bounds());
        rect_json(shown.intersect(&self.bounds()))
    }

    /// Run a whole command in one go (Spot Healing, Remove). One history step.
    pub fn run(&mut self, cmd: &str, params: Value) -> Result<Value, String> {
        self.live = None;
        self.run_shown(cmd, params, Rect::EMPTY)
    }

    fn run_shown(&mut self, cmd: &str, params: Value, shown: Rect) -> Result<Value, String> {
        let mut out = self.session.execute(cmd, params).map_err(|e| e.to_string())?;
        let dmg = out.get("damage").and_then(Value::as_array).and_then(|a| {
            let v: Vec<i32> = a.iter().filter_map(|n| n.as_i64().map(|n| n as i32)).collect();
            // PhotoCraft reports damage as [x, y, w, h].
            (v.len() == 4 && v[2] > 0 && v[3] > 0).then(|| Rect::from_xywh(v[0], v[1], v[2] as u32, v[3] as u32))
        });
        let all = dmg.unwrap_or(Rect::EMPTY).union(&shown).intersect(&self.bounds());
        self.done.push(dmg.unwrap_or(Rect::EMPTY).intersect(&self.bounds()));
        self.undone.clear();
        if !out.is_object() {
            out = json!({});
        }
        out["damage"] = rect_json(all);
        Ok(out)
    }

    /// Step back in the history. Returns the rectangle that changed, or null with nothing to undo.
    pub fn undo(&mut self) -> Value {
        self.live = None;
        let Some(rect) = self.done.last().copied() else { return Value::Null };
        if !self.session.undo() {
            return Value::Null;
        }
        self.done.pop();
        self.undone.push(rect);
        rect_json(rect)
    }

    pub fn redo(&mut self) -> Value {
        self.live = None;
        let Some(rect) = self.undone.last().copied() else { return Value::Null };
        if !self.session.redo() {
            return Value::Null;
        }
        self.undone.pop();
        self.done.push(rect);
        rect_json(rect)
    }
}

#[cfg(target_arch = "wasm32")]
mod web {
    use wasm_bindgen::prelude::*;

    fn err(e: String) -> JsError {
        JsError::new(&e)
    }

    fn parse(s: &str) -> Result<serde_json::Value, JsError> {
        serde_json::from_str(s).map_err(|e| JsError::new(&e.to_string()))
    }

    /// The engine as JavaScript sees it: params and results cross as JSON text, pixels as bytes.
    #[wasm_bindgen]
    pub struct Retouch(super::Retouch);

    #[wasm_bindgen]
    impl Retouch {
        #[wasm_bindgen(constructor)]
        pub fn new(width: u32, height: u32) -> Retouch {
            Retouch(super::Retouch::new(width, height))
        }
        #[wasm_bindgen(js_name = loadRgbRows)]
        pub fn load_rgb_rows(&mut self, y: u32, rgb: &[u8]) -> Result<(), JsError> {
            self.0.load_rgb_rows(y, rgb).map_err(err)
        }
        pub fn loaded(&mut self) {
            self.0.loaded();
        }
        pub fn read(&self, x: i32, y: i32, w: u32, h: u32, only_changed: bool) -> Result<Vec<u8>, JsError> {
            self.0.read(x, y, w, h, only_changed).map_err(err)
        }
        pub fn begin(&mut self, cmd: &str, params: &str) -> Result<String, JsError> {
            Ok(self.0.begin(cmd, parse(params)?).map_err(err)?.to_string())
        }
        pub fn push(&mut self, points: &str) -> Result<String, JsError> {
            let v = parse(points)?;
            Ok(self.0.push(v.as_array().map_or(&[][..], Vec::as_slice)).map_err(err)?.to_string())
        }
        pub fn end(&mut self) -> Result<String, JsError> {
            Ok(self.0.end().map_err(err)?.to_string())
        }
        pub fn cancel(&mut self) -> String {
            self.0.cancel().to_string()
        }
        pub fn run(&mut self, cmd: &str, params: &str) -> Result<String, JsError> {
            Ok(self.0.run(cmd, parse(params)?).map_err(err)?.to_string())
        }
        pub fn undo(&mut self) -> String {
            self.0.undo().to_string()
        }
        pub fn redo(&mut self) -> String {
            self.0.redo().to_string()
        }
    }
}

#[cfg(test)]
mod tests;
