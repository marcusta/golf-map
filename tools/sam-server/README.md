# sam-server — editor-assist sidecar (SAM 3 segmentation + LaMa inpainting)

Local FastAPI sidecar behind two editor tools, in ONE process for the whole
assist session:

- **SAM click-to-feature assist** (T45): the web editor sends a 512 px
  orthophoto crop centered on a map click, SAM 3 segments the object at the
  center point, and the contour comes back as pixel polygons that the editor
  fits into an editable b-spline course feature.
- **Clean photo** (T55): the editor sends the same kind of crop plus a mask
  (SAM-derived or hand-drawn ellipse) and `/inpaint` returns the crop with
  the masked blemish (player, cart, shadow, stray object) LaMa-inpainted
  away, for preview and (on accept) baking into the course ortho.

This is a developer-workstation tool. It is NOT part of the map pipeline
(`pipeline/`) or the API server (`server/`) — the editor works fine without
it (the SAM/Clean tool panels just show a disabled "sidecar offline" state).

## golfpipe import (pythonpath/venv arrangement)

`/inpaint` reuses the map pipeline's inpaint runner — `server.py` puts
`<repo>/pipeline` on `sys.path` and imports `golfpipe.inpaint` directly
(`inpaint_tiled` + `LamaInpainter`, the exact code behind the batch
`clean-ortho` command). That module imports only numpy/stdlib at module
level, so this venv does **not** need the pipeline's rasterio/laspy stack;
torch is already here because `ultralytics` (SAM) depends on it. The
pipeline venv and this venv stay separate — nothing is installed across.

## Weights

- SAM 3 checkpoint (`sam3.pt`, ~3.5 GB, **not committed**): point the
  `SAM_WEIGHTS` env var at an existing checkpoint — on this machine one lives
  at `/Users/marcust/dev/SAM-test/sam3.pt`. Without valid weights the server
  falls back to a mock that returns a centered ellipse (`/health` reports
  `"point_model": "mock"`), which is handy for exercising the web flow.
- LaMa TorchScript checkpoint (`big-lama.pt`, ~206 MB, **not committed**):
  resolved from `$GOLFPIPE_LAMA_WEIGHTS`, defaulting to
  `<repo>/data/models/big-lama.pt` (already downloaded on this machine;
  download URL in `pipeline/README.md`). Without it `/health` reports
  `"inpaint": {"available": false, …}` and `/inpaint` answers 503 — the
  Clean tool disables itself, SAM keeps working.

## Run

```sh
cd tools/sam-server
python3 -m venv venv
venv/bin/pip install -r requirements.txt
SAM_WEIGHTS=/Users/marcust/dev/SAM-test/sam3.pt venv/bin/python server.py
```

Listens on `http://127.0.0.1:8000` (override the port with `SAM_PORT`).
First inference loads the model lazily (slow); subsequent clicks are fast.

## API

- `GET /health` → `{ "status": "healthy", "point_model": "loaded" | "mock",
  "inpaint": { "available": bool, "weights": "present" | "missing", "detail"?: str } }`
  Per-capability readiness: the web editor gates the SAM tool on the server
  answering at all, and the Clean tool on `inpaint.available`.
- `POST /segment` with `{ "image": "<base64 jpeg>", "offset_x": 0, "offset_y": 0 }`
  → `{ "polygons": [[[x, y], …], …], "confidence": 0.0–1.0 }`
  Segments the object at the crop CENTER (point prompt). Polygons are
  cv2.findContours external contours, lightly approxPolyDP-simplified, with
  `offset_x/offset_y` added to every coordinate.
- `POST /inpaint` with `{ "image": "<base64 png>", "mask": "<base64 png>" }`
  (mask same size, >127 = inpaint) →
  `{ "image": "<base64 png>", "masked_pixels": n, "elapsed_ms": n }`.
  Pixels outside the mask come back byte-identical (golfpipe's
  `inpaint_tiled` invariant). A 512 px crop takes ~8 s on CPU (M-series);
  the first call lazily loads the model. 503 when weights/torch are absent.

CORS allows any localhost/127.0.0.1 origin, so the vite dev server (any
port) can call it directly.

## Provenance

Vendored from the `~/dev/SAM-test` prototype's `server.py`. Dropped from the
prototype: the text-prompt semantic mode (`SAM3SemanticPredictor`), the
static demo-page mount, and `python-multipart` (only needed by the demo
page). Point mode, `MAX_INFERENCE_SIZE = 512`, and `mask_to_polygons` are
unchanged.
