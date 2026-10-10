# sam-server — editor-assist sidecar (SAM 3 segmentation)

Local FastAPI sidecar behind the **SAM click-to-feature assist** (T45): the
web editor sends a 512 px orthophoto crop centered on a map click, SAM 3
segments the object at the center point, and the contour comes back as pixel
polygons that the editor fits into an editable b-spline course feature.

This is a developer-workstation tool. It is NOT part of the map pipeline
(`pipeline/`) or the API server (`server/`) — the editor works fine without
it (the SAM tool panel just shows a disabled "sidecar offline" state).

## golfpipe import (pythonpath/venv arrangement)

`server.py` puts `<repo>/pipeline` on `sys.path` and imports the torch device
policy (`torch_device`) from `golfpipe.inpaint`. That module imports only
numpy/stdlib at module level, so this venv does **not** need the pipeline's
rasterio/laspy stack; torch is already here because `ultralytics` (SAM)
depends on it. The pipeline venv and this venv stay separate — nothing is
installed across.

## Weights

- SAM 3 checkpoint (`sam3.pt`, ~3.5 GB, **not committed**): point the
  `SAM_WEIGHTS` env var at an existing checkpoint — on this machine one lives
  at `/Users/marcust/dev/SAM-test/sam3.pt`. Without valid weights the server
  falls back to a mock that returns a centered ellipse (`/health` reports
  `"point_model": "mock"`), which is handy for exercising the web flow.

## Run

```sh
cd tools/sam-server
python3 -m venv venv
venv/bin/pip install -r requirements.txt
SAM_WEIGHTS=/Users/marcust/dev/SAM-test/sam3.pt venv/bin/python server.py
```

Listens on `http://127.0.0.1:8000` (override the port with `SAM_PORT`).
First inference loads the model lazily (slow); subsequent clicks are fast.

## Compute device (GPU)

SAM auto-selects a device using golfpipe's shared policy: **Apple MPS if
available → CUDA → CPU**. Force one with `ASSIST_DEVICE=cpu|cuda|mps`. The
resolved device is reported in `/health` (`point_device`) so the UI/logs show
what's actually running.

## API

- `GET /health` → `{ "status": "healthy", "point_model": "loaded" | "mock",
  "point_device": "mps" | "cuda" | "cpu" | null }`
  The web editor gates the SAM tool on the server answering at all.
  `point_device` is null when SAM is running the mock.
- `POST /segment` with `{ "image": "<base64 jpeg>", "offset_x": 0, "offset_y": 0 }`
  → `{ "polygons": [[[x, y], …], …], "confidence": 0.0–1.0 }`
  Segments the object at the crop CENTER (point prompt). Polygons are
  cv2.findContours external contours, lightly approxPolyDP-simplified, with
  `offset_x/offset_y` added to every coordinate.

CORS allows any localhost/127.0.0.1 origin, so the vite dev server (any
port) can call it directly.

## Provenance

Vendored from the `~/dev/SAM-test` prototype's `server.py`. Dropped from the
prototype: the text-prompt semantic mode (`SAM3SemanticPredictor`), the
static demo-page mount, and `python-multipart` (only needed by the demo
page). Point mode, `MAX_INFERENCE_SIZE = 512`, and `mask_to_polygons` are
unchanged.
