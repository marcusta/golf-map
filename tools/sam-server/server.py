# SAM 3 segmentation sidecar for the editor's click-to-feature assist (T45).
#
# Vendored from the SAM-test prototype (~/dev/SAM-test/server.py), trimmed to
# what the editor uses: POINT mode only (segment the object at the crop
# center), /segment + /health, localhost CORS. The text-prompt semantic mode
# and the static demo mount were dropped. Weights are NOT committed — point
# SAM_WEIGHTS at a sam3.pt checkpoint (see README.md).
#
# This is a developer-workstation tool, not part of the map pipeline
# (pipeline/) or the API server (server/). The web editor health-gates on it:
# when this process isn't running, the SAM tool panel shows a disabled state.

import base64
import io
import os
import time

import cv2
import numpy as np
from PIL import Image
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

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

# Global model instance (lazy loaded).
_point_model = None


def get_point_model():
    """Lazy load the SAM 3 model for point prompts."""
    global _point_model
    if _point_model is None:
        try:
            from ultralytics import SAM
            _point_model = SAM(WEIGHTS_PATH)
            print(f"SAM 3 point model loaded from {WEIGHTS_PATH}")
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


@app.get("/health")
async def health_check():
    """Check if the server and model are ready."""
    point_model = get_point_model()
    return {
        "status": "healthy",
        "point_model": "loaded" if point_model != "mock" else "mock",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("SAM_PORT", "8000")))
