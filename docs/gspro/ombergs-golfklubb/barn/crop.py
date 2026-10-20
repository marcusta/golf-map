r"""Read-only evidence crop for the Omberg machine hall and its red outbuilding (not in OSM); run with
D:\golf-map\pipeline\.venv\Scripts\python.exe -I <this file>.

Writes data/omberg-barn/: ortho-2023.png / ortho-2025.png (0.16 m, north up), lidar-crop.npz
(points: E, N, Z abs RH2000, class), dem-edited-crop.npz, crop.json (bounds and the ortho's top-left
pixel corner) and, once footprints.json (the surveyed rectangles, see below) exists,
osm-buildings.json: the footprints in the same shape the other sets read their OSM buildings in
(properties.osm_id + properties.rect {cx, cy, w, h, angleDeg}).

The buildings are missing from OpenStreetMap, so their rectangles are fitted from the lidar roof cells and
the ortho by fit.py (it writes data/omberg-barn/footprints.json); this script only copies them over.
"""
from pathlib import Path
import json
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from PIL import Image
from laspy import CopcReader
from laspy.copc import Bounds

ROOT = Path(__file__).resolve().parents[4]
SOURCE = ROOT / 'data/sources/317d1f83-3ade-431c-8201-605ac0bd2871'
OUT = ROOT / 'data/omberg-barn'
BOUNDS = (477930, 6458085, 478040, 6458185)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    crop = dict(crs='EPSG:3006', bounds=BOUNDS)
    for vintage in ['2023', '2025']:
        with rasterio.open(SOURCE / f'ortho-orto-l2-{vintage}.tif') as src:
            win = from_bounds(*BOUNDS, transform=src.transform).round_offsets().round_lengths()
            a = src.read([1, 2, 3], window=win)
            t = src.window_transform(win)
        Image.fromarray(np.moveaxis(a, 0, -1)).save(OUT / f'ortho-{vintage}.png')
        crop[f'ortho{vintage}'] = dict(file=f'ortho-{vintage}.png', topLeftE=t.c, topLeftN=t.f, pixelM=t.a)
    batches = []
    for path in (SOURCE / 'lidar').glob('*.laz'):
        with CopcReader.open(path) as src:
            lo, hi = src.header.mins, src.header.maxs
            if hi[0] < BOUNDS[0] or lo[0] > BOUNDS[2] or hi[1] < BOUNDS[1] or lo[1] > BOUNDS[3]: continue
            p = src.query(bounds=Bounds(np.array([BOUNDS[0], BOUNDS[1], -100]), np.array([BOUNDS[2], BOUNDS[3], 1000])))
            batches.append(np.column_stack((p.x, p.y, p.z, p.classification)))
    pts = np.concatenate(batches)
    np.savez_compressed(OUT / 'lidar-crop.npz', points=pts)
    crop['lidarPoints'] = int(len(pts))
    crop['lidarClasses'] = {str(int(c)): int(n) for c, n in zip(*np.unique(pts[:, 3], return_counts=True))}
    with rasterio.open(SOURCE / 'dem-edited.tif') as src:
        win = from_bounds(*BOUNDS, transform=src.transform).round_offsets().round_lengths()
        z = src.read(1, window=win).astype('float32')
        t = src.window_transform(win)
    np.savez_compressed(OUT / 'dem-edited-crop.npz', z=z, topLeftE=t.c, topLeftN=t.f, pixelE=t.a, pixelN=-t.e)
    crop['demEdited'] = dict(file='dem-edited-crop.npz', shape=list(z.shape), pixelM=t.a)
    (OUT / 'crop.json').write_text(json.dumps(crop, indent=2))
    fp = OUT / 'footprints.json'
    if fp.exists():
        (OUT / 'osm-buildings.json').write_text(fp.read_text())
    print(json.dumps(crop, indent=2))


if __name__ == '__main__':
    main()
