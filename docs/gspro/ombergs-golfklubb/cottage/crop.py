"""Read-only evidence crop for the house group by the rocks south-west of the course; run with bun run py <absolute path to this file>.

Writes data/omberg-cottage/: ortho-2023.png / ortho-2025.png (0.16 m, north up), lidar-crop.npz
(points: E, N, Z abs RH2000, class), crop.json (bounds and the ortho's top-left pixel corner)
and osm-buildings.json (the OSM footprints inside the crop).
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
OUT = ROOT / 'data/omberg-cottage'
BOUNDS = (477350, 6457490, 477700, 6457720)  # the house group by the rocks and the barn to the north-west

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
    # The course terrain and meshes are built from the edited DEM: model.py sets each asset's dz
    # from it so that Unity's centre-on-terrain placement lands at the authored ground height.
    with rasterio.open(SOURCE / 'dem-edited.tif') as src:
        win = from_bounds(*BOUNDS, transform=src.transform).round_offsets().round_lengths()
        z = src.read(1, window=win).astype('float32')
        t = src.window_transform(win)
    np.savez_compressed(OUT / 'dem-edited-crop.npz', z=z, topLeftE=t.c, topLeftN=t.f, pixelE=t.a, pixelN=-t.e)
    crop['demEdited'] = dict(file='dem-edited-crop.npz', shape=list(z.shape), pixelM=t.a)
    feats = json.loads((SOURCE / 'buildings.geojson').read_text())['features']
    keep = [f for f in feats if BOUNDS[0] < f['properties']['rect']['cx'] < BOUNDS[2] and BOUNDS[1] < f['properties']['rect']['cy'] < BOUNDS[3]]
    (OUT / 'osm-buildings.json').write_text(json.dumps(keep, indent=1))
    (OUT / 'crop.json').write_text(json.dumps(crop, indent=2))
    print(json.dumps(crop, indent=2))

if __name__ == '__main__':
    main()
