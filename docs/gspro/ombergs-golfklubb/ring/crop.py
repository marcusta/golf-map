"""Read-only evidence crops for the ring of buildings 1-2 km round the course (plus two nearer ones).

Run with bun run py <absolute path to this file>. Writes data/omberg-ring/: per cluster an ortho crop
ortho-<name>.png (2025, 0.16 m), all clusters' lidar in one lidar-crop.npz (E, N, Z, class), the
outer and inner edited DEMs over the clusters' bounding box (dem-outer.npz, dem-inner.npz),
osm-buildings.json and crop.json (clusters with bounds and each ortho's top-left corner).
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
OUT = ROOT / 'data/omberg-ring'
# name: (west, south, east, north); "near" clusters lie within 1 km of the clubhouse
CLUSTERS = {
    'near_range': (477815, 6457530, 477870, 6457580),     # driving-range bay shelter
    'range': (477770, 6457480, 478140, 6457720),          # the whole driving range: shelter, lane, targets, nets
    'near_north': (477610, 6458600, 477655, 6458640),     # small hut north of the course
    'c1_east': (479040, 6457630, 479140, 6457770),
    'c2_east_south': (478950, 6456980, 479080, 6457100),
    'c3_south': (478200, 6456260, 478290, 6456380),
    'c4_south_west': (477500, 6456160, 477860, 6456230),
    'c5_north_east': (478850, 6458660, 479200, 6458930),
    'c6_east_far': (479390, 6457690, 479530, 6457970),
    'c7_north': (478120, 6459190, 478500, 6459390),
    'c8_north_east2': (479230, 6458560, 479300, 6458620),
    'c9_south_east': (479540, 6456940, 479700, 6457090),
    'c10_south_far': (478150, 6455690, 478240, 6455800),
}

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    crop = dict(crs='EPSG:3006', clusters={})
    with rasterio.open(SOURCE / 'outer-ortho-orto-l2-2025.tif') as src:
        for name, b in CLUSTERS.items():
            win = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
            a = src.read([1, 2, 3], window=win); t = src.window_transform(win)
            Image.fromarray(np.moveaxis(a, 0, -1)).save(OUT / f'ortho-{name}.png')
            crop['clusters'][name] = dict(bounds=b, ortho=dict(file=f'ortho-{name}.png', topLeftE=t.c, topLeftN=t.f, pixelM=t.a))
    # The inner 2023 ortho (leaf-off) for the range, where it reaches.
    with rasterio.open(SOURCE / 'ortho-orto-l2-2023.tif') as src:
        b = CLUSTERS['range']
        win = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
        a = src.read([1, 2, 3], window=win); t = src.window_transform(win)
        Image.fromarray(np.moveaxis(a, 0, -1)).save(OUT / 'ortho-range-2023.png')
        crop['clusters']['range']['ortho2023'] = dict(file='ortho-range-2023.png', topLeftE=t.c, topLeftN=t.f, pixelM=t.a)
    bb = (min(b[0] for b in CLUSTERS.values()) - 20, min(b[1] for b in CLUSTERS.values()) - 20,
          max(b[2] for b in CLUSTERS.values()) + 20, max(b[3] for b in CLUSTERS.values()) + 20)
    crop['bounds'] = bb
    batches = []
    for path in (p for p in (SOURCE / 'outer-lidar').glob('*.laz') if '_25.' in p.name):  # the newer 2.5 km tiles
        with CopcReader.open(path) as src:
            lo, hi = src.header.mins, src.header.maxs
            for b in CLUSTERS.values():
                if hi[0] < b[0] or lo[0] > b[2] or hi[1] < b[1] or lo[1] > b[3]: continue
                p = src.query(bounds=Bounds(np.array([b[0], b[1], -100]), np.array([b[2], b[3], 1000])))
                batches.append(np.column_stack((p.x, p.y, p.z, p.classification)))
    pts = np.concatenate(batches)
    np.savez_compressed(OUT / 'lidar-crop.npz', points=pts)
    crop['lidarPoints'] = int(len(pts))
    # Unity's ground: the inner terrain where it exists, else the outer one (sunk uniformly, so a dz
    # taken against the outer DEM lands on it all the same).
    for key, f in [('outer', 'outer-dem-edited.tif'), ('inner', 'dem-edited.tif')]:
        with rasterio.open(SOURCE / f) as src:
            win = from_bounds(*bb, transform=src.transform).round_offsets().round_lengths()
            z = src.read(1, window=win, boundless=True, fill_value=np.nan).astype('float32'); t = src.window_transform(win)
            ib = src.bounds
        np.savez_compressed(OUT / f'dem-{key}.npz', z=z, topLeftE=t.c, topLeftN=t.f, pixelE=t.a, pixelN=-t.e,
                            valid=np.array([ib.left, ib.bottom, ib.right, ib.top]))
    feats = json.loads((SOURCE / 'buildings.geojson').read_text())['features']
    keep = [f for f in feats if any(b[0] < f['properties']['rect']['cx'] < b[2] and b[1] < f['properties']['rect']['cy'] < b[3] for b in CLUSTERS.values())]
    (OUT / 'osm-buildings.json').write_text(json.dumps(keep, indent=1))
    (OUT / 'crop.json').write_text(json.dumps(crop, indent=2))
    print(json.dumps(dict(clusters=len(CLUSTERS), lidarPoints=crop['lidarPoints'], osm=len(keep)), indent=1))

if __name__ == '__main__':
    main()
