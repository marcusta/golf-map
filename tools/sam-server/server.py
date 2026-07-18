# Editor-assist sidecar: SAM 3 segmentation (T45 click-to-feature) + LaMa
# inpainting (T55 interactive photo cleaning). ONE process serves the whole
# assist session — /segment and /inpaint share the torch runtime the venv
# already carries (ultralytics pulls torch in), and /health reports
# per-capability readiness so the web editor can gate each tool separately.
#
# Vendored from the SAM-test prototype (~/dev/SAM-test/server.py), trimmed to
# what the editor uses: POINT mode only (segment the object at the crop
# center), /segment + /health, localhost CORS. The text-prompt semantic mode
# and the static demo mount were dropped. Weights are NOT committed — point
# SAM_WEIGHTS at a sam3.pt checkpoint (see README.md).
#
# Inpainting imports golfpipe.inpaint (pipeline/) directly — the pipeline dir
# is put on sys.path below, and golfpipe/inpaint.py deliberately imports only
# numpy/stdlib at module level, so this venv does not need the pipeline's
# rasterio/laspy stack. LaMa weights resolve from $GOLFPIPE_LAMA_WEIGHTS,
# defaulting to <repo>/data/models/big-lama.pt (see README.md).
#
# This is a developer-workstation tool, not part of the map pipeline
# (pipeline/) or the API server (server/). The web editor health-gates on it:
# when this process isn't running, the SAM/Clean tool panels show a disabled
# state.

import base64
import io
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# tools/sam-server/ -> repo root; golfpipe lives under pipeline/.
REPO_ROOT = Path(__file__).resolve().parents[2]
_PIPELINE_DIR = str(REPO_ROOT / "pipeline")
if _PIPELINE_DIR not in sys.path:
    sys.path.insert(0, _PIPELINE_DIR)

from golfpipe.inpaint import (  # noqa: E402  (needs the sys.path insert above)
    InpaintError,
    LamaInpainter,
    WEIGHTS_ENV_VAR,
    inpaint_tiled,
    torch_device,
)

app = FastAPI(title="Golf Course Segmentation Sidecar")

# CORS - allow all localhost ports (the vite dev server port varies).
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Max dimension for inference - resize larger images. The web client sends
# 512 px crops, so this normally never engages.
MAX_INFERENCE_SIZE = 512

# Path to the SAM 3 checkpoint (3.5 GB, never committed).
WEIGHTS_PATH = os.environ.get("SAM_WEIGHTS", "sam3.pt")

# LaMa TorchScript weights for /inpaint (206 MB, never committed):
# $GOLFPIPE_LAMA_WEIGHTS wins, else the conventional repo location.
LAMA_WEIGHTS_PATH = os.environ.get(WEIGHTS_ENV_VAR) or str(REPO_ROOT / "data" / "models" / "big-lama.pt")

# Compute device for BOTH capabilities (SAM + LaMa). $ASSIST_DEVICE forces one
# (cpu/cuda/mps); otherwise auto per golfpipe's shared policy: mps > cuda > cpu.
ASSIST_DEVICE = os.environ.get("ASSIST_DEVICE") or None

# Global model instances (lazy loaded).
_point_model = None
_lama = None
_resolved_device = None


def resolved_device() -> str:
    """Resolved torch device for assist inference ($ASSIST_DEVICE override,
    else mps > cuda > cpu). Cached; if torch can't be imported at all we report
    the requested override or 'cpu' so /health still answers."""
    global _resolved_device
    if _resolved_device is None:
        try:
            _resolved_device = torch_device(ASSIST_DEVICE)
        except Exception:
            _resolved_device = ASSIST_DEVICE or "cpu"
    return _resolved_device


def get_lama() -> LamaInpainter:
    """Lazy LamaInpainter on the resolved device. Raises InpaintError when
    weights are missing or torch is not installed — /health reports the same
    conditions up front."""
    global _lama
    if _lama is None:
        _lama = LamaInpainter(weights=LAMA_WEIGHTS_PATH, device=resolved_device())
    return _lama


def get_point_model():
    """Lazy load the SAM 3 model for point prompts, moved to the resolved
    device (mps/cuda/cpu)."""
    global _point_model
    if _point_model is None:
        try:
            from ultralytics import SAM
            _point_model = SAM(WEIGHTS_PATH)
            _point_model.to(resolved_device())
            print(f"SAM 3 point model loaded from {WEIGHTS_PATH} on {resolved_device()}")
        except Exception as e:
            print(f"Failed to load SAM 3 point model from {WEIGHTS_PATH}: {e}")
            _point_model = "mock"
    return _point_model


class SegmentRequest(BaseModel):
    image: str  # Base64 encoded image (the 512 px ortho crop)
    offset_x: int = 0  # X offset in the caller's canvas (echoed into polygons)
    offset_y: int = 0  # Y offset in the caller's canvas


class SegmentResponse(BaseModel):
    polygons: list[list[list[int]]]  # List of polygons, each a list of [x, y]
    confidence: float


def decode_image(base64_string: str) -> np.ndarray:
    """Decode base64 image to numpy array."""
    # Remove data URL prefix if present
    if "," in base64_string:
        base64_string = base64_string.split(",")[1]

    image_bytes = base64.b64decode(base64_string)
    image = Image.open(io.BytesIO(image_bytes))
    return np.array(image.convert("RGB"))


def mask_to_polygons(mask: np.ndarray, offset_x: int = 0, offset_y: int = 0) -> list[list[list[int]]]:
    """Convert binary mask to polygon coordinates."""
    # Ensure mask is uint8
    if mask.dtype != np.uint8:
        mask = (mask * 255).astype(np.uint8)

    # Find contours
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    polygons = []
    for contour in contours:
        # Filter out tiny contours (noise)
        if cv2.contourArea(contour) < 100:
            continue

        # Simplify contour slightly for cleaner output
        epsilon = 0.002 * cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, epsilon, True)

        # Convert to list of [x, y] points with offset applied
        points = [[int(pt[0][0]) + offset_x, int(pt[0][1]) + offset_y] for pt in approx]

        if len(points) >= 3:  # Valid polygon needs at least 3 points
            polygons.append(points)

    return polygons


def segment_with_point(image: np.ndarray) -> tuple[list[np.ndarray], float]:
    """Run SAM 3 segmentation using a center point prompt."""
    model = get_point_model()
    orig_h, orig_w = image.shape[:2]

    if model == "mock":
        mask = np.zeros((orig_h, orig_w), dtype=np.uint8)
        center = (orig_w // 2, orig_h // 2)
        axes = (orig_w // 3, orig_h // 3)
        cv2.ellipse(mask, center, axes, 0, 0, 360, 255, -1)
        return [mask], 0.85

    # Resize if image is too large
    scale = 1.0
    if max(orig_h, orig_w) > MAX_INFERENCE_SIZE:
        scale = MAX_INFERENCE_SIZE / max(orig_h, orig_w)
        new_w, new_h = int(orig_w * scale), int(orig_h * scale)
        image = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)
        print(f"[point] Resized {orig_w}x{orig_h} -> {new_w}x{new_h}")

    h, w = image.shape[:2]
    center_x, center_y = w // 2, h // 2

    temp_path = "/tmp/sam_input.jpg"
    Image.fromarray(image).save(temp_path, quality=85)

    t0 = time.time()
    results = model.predict(
        source=temp_path,
        points=[[center_x, center_y]],
        labels=[1],
        device=resolved_device(),
        verbose=False
    )
    print(f"[point] Inference: {time.time()-t0:.3f}s")

    masks = []
    confidence = 0.0

    if results and len(results) > 0:
        result = results[0]
        if result.masks is not None:
            for i, mask in enumerate(result.masks.data):
                mask_np = mask.cpu().numpy().astype(np.uint8)
                if scale != 1.0:
                    mask_np = cv2.resize(mask_np, (orig_w, orig_h), interpolation=cv2.INTER_NEAREST)
                masks.append(mask_np)
                if result.boxes is not None and i < len(result.boxes.conf):
                    confidence = max(confidence, float(result.boxes.conf[i]))

    return masks, confidence if confidence > 0 else 0.9


@app.post("/segment", response_model=SegmentResponse)
async def segment_image(request: SegmentRequest):
    """
    Segment the object at the center of an image crop using SAM 3.

    - image: Base64 encoded image (the ortho crop centered on the click)
    - offset_x, offset_y: Position of the crop in the caller's canvas,
      added to every returned polygon coordinate
    """
    try:
        image = decode_image(request.image)
        masks, confidence = segment_with_point(image)

        if not masks:
            return SegmentResponse(polygons=[], confidence=0.0)

        all_polygons = []
        for mask in masks:
            polygons = mask_to_polygons(mask, request.offset_x, request.offset_y)
            all_polygons.extend(polygons)

        return SegmentResponse(polygons=all_polygons, confidence=confidence)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class InpaintRequest(BaseModel):
    image: str  # Base64 RGB image (the ortho crop; PNG preferred — lossless)
    mask: str  # Base64 grayscale/RGB mask image, same size; >127 = inpaint


class InpaintResponse(BaseModel):
    image: str  # Base64 PNG, same size as the input; unmasked pixels byte-identical
    masked_pixels: int
    elapsed_ms: int


@app.post("/inpaint", response_model=InpaintResponse)
async def inpaint_image(request: InpaintRequest):
    """LaMa-inpaint the masked pixels of an image crop (T55 photo cleaning).

    Runs golfpipe's inpaint_tiled + LamaInpainter — the exact same runner as
    the batch clean-ortho command — so pixels OUTSIDE the mask come back
    byte-identical (the web preview can overlay the whole result).
    """
    try:
        lama = get_lama()
    except InpaintError as e:
        raise HTTPException(status_code=503, detail=str(e))

    try:
        image = decode_image(request.image)
        mask_img = decode_image(request.mask)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"could not decode image/mask: {e}")
    mask = mask_img[:, :, 0] > 127
    if mask.shape != image.shape[:2]:
        raise HTTPException(
            status_code=400,
            detail=f"mask size {mask.shape[::-1]} does not match image {image.shape[1::-1]}",
        )

    t0 = time.time()
    try:
        result = inpaint_tiled(image, mask, lama)
    except InpaintError as e:
        raise HTTPException(status_code=503, detail=str(e))
    elapsed_ms = int((time.time() - t0) * 1000)
    print(f"[inpaint] {int(mask.sum())} px in {elapsed_ms} ms")

    buf = io.BytesIO()
    Image.fromarray(result).save(buf, format="PNG")
    return InpaintResponse(
        image=base64.b64encode(buf.getvalue()).decode("ascii"),
        masked_pixels=int(mask.sum()),
        elapsed_ms=elapsed_ms,
    )


def _inpaint_readiness() -> dict:
    """Weights/torch presence WITHOUT loading the model (cheap health)."""
    if not Path(LAMA_WEIGHTS_PATH).is_file():
        return {"available": False, "weights": "missing", "detail": f"no LaMa weights at {LAMA_WEIGHTS_PATH}"}
    try:
        import importlib.util

        if importlib.util.find_spec("torch") is None:
            return {"available": False, "weights": "present", "detail": "torch is not installed in this venv"}
    except Exception:
        return {"available": False, "weights": "present", "detail": "torch is not importable"}
    return {"available": True, "weights": "present", "device": resolved_device()}


@app.get("/health")
async def health_check():
    """Per-capability readiness: SAM point model (T45) + LaMa inpaint (T55).
    Each capability reports the resolved compute device (mps/cuda/cpu) so the
    UI/logs show what's actually running."""
    point_model = get_point_model()
    real_sam = point_model != "mock"
    return {
        "status": "healthy",
        "point_model": "loaded" if real_sam else "mock",
        "point_device": resolved_device() if real_sam else None,
        "inpaint": _inpaint_readiness(),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("SAM_PORT", "8000")))
